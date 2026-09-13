import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { keypair } from "./payments";
import { HttpError } from "./common";
import { getBase58Decoder } from "@solana/kit";
import { assertDevnet } from "./network";
type RefundTask = {
  id: string;
  buyer_wallet: string;
  amount_atomic: number;
  refund_raw: string | null;
};
export async function refund(env: Env, task: RefundTask) {
  return submitRefund(
    {
      rpcUrl: env.SOLANA_RPC_URL,
      mint: env.USDC_MINT,
      secret: env.GATEWAY_PRIVATE_KEY,
      async saveRaw(raw) {
        await env.DB.prepare(
          "UPDATE tasks SET refund_raw=? WHERE id=? AND refund_raw IS NULL",
        )
          .bind(raw, task.id)
          .run();
        const stored = await env.DB.prepare(
          "SELECT refund_raw FROM tasks WHERE id=?",
        )
          .bind(task.id)
          .first<{ refund_raw: string }>();
        return stored!.refund_raw;
      },
      async saveSignature(signature) {
        await env.DB.prepare("UPDATE tasks SET refund_transaction=? WHERE id=?")
          .bind(signature, task.id)
          .run();
      },
    },
    task,
  );
}
// Shared by the Worker and the operator recovery CLI. Persist before broadcast.
export async function submitRefund(
  options: {
    rpcUrl: string;
    mint: string;
    secret: string;
    saveRaw: (raw: string) => Promise<string>;
    saveSignature: (signature: string) => Promise<void>;
  },
  task: RefundTask,
) {
  const connection = new Connection(options.rpcUrl, "confirmed");
  await assertDevnet(connection);
  const signer = keypair(options.secret);
  let raw = task.refund_raw;
  if (!raw) {
    const mint = new PublicKey(options.mint);
    const buyer = new PublicKey(task.buyer_wallet);
    const source = getAssociatedTokenAddressSync(mint, signer.publicKey);
    const target = getAssociatedTokenAddressSync(mint, buyer);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: blockhash,
    }).add(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        target,
        buyer,
        mint,
      ),
      createTransferCheckedInstruction(
        source,
        mint,
        target,
        signer.publicKey,
        task.amount_atomic,
        6,
      ),
    );
    tx.sign(signer);
    raw = tx.serialize().toString("base64");
    raw = await options.saveRaw(raw);
  }
  const signature = getBase58Decoder().decode(
    Transaction.from(Buffer.from(raw, "base64")).signature!,
  );
  await options.saveSignature(signature);
  const prior = await connection.getSignatureStatus(signature, {
    searchTransactionHistory: true,
  });
  if (prior.value?.err)
    throw new HttpError(
      503,
      "Stored refund failed; operator reconciliation required.",
    );
  if (
    ["confirmed", "finalized"].includes(prior.value?.confirmationStatus || "")
  )
    return signature;
  await connection.sendRawTransaction(Buffer.from(raw, "base64"), {
    maxRetries: 3,
  });
  for (let i = 0; i < 15; i++) {
    const result = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (result.value?.err)
      throw new HttpError(
        503,
        "Refund transaction failed; operator reconciliation required.",
      );
    if (
      ["confirmed", "finalized"].includes(
        result.value?.confirmationStatus || "",
      )
    )
      return signature;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new HttpError(503, "Refund submitted; confirmation is still pending.");
}
