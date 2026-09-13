import { readFile, writeFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { Agent, Config, Task } from "../lib/types";
import assert from "node:assert/strict";
const testRefund = process.argv.includes("--refund");
const origin = process.env.GATEWAY_URL || "http://localhost:8787";
const config = (await fetch(`${origin}/api/config`).then((r) =>
  r.json(),
)) as Config;
assert.equal(
  config.mode,
  "devnet",
  "Set PAYMENT_MODE=devnet before running the funded E2E.",
);
const key = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(".secrets/buyer.json", "utf8"))),
);
const signer = await createKeyPairSignerFromBytes(key.secretKey);
const agents = (
  (await fetch(`${origin}/api/agents`).then((r) => r.json())) as {
    agents: Agent[];
  }
).agents;
const chain = [
  agents.find((a) => a.skill === "letter-to-numbers")!,
  agents.find((a) => a.skill === "sum-numbers")!,
];
assert.ok(chain.every(Boolean), "Seed both agents first.");
const connection = new Connection(config.rpc_url, "confirmed");
assert.equal(
  await connection.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const balances = () =>
  Promise.all(
    chain.map(
      async (a) =>
        (
          await connection.getTokenAccountBalance(
            getAssociatedTokenAddressSync(
              new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
              new PublicKey(a.wallet_address),
            ),
          )
        ).value.amount,
    ),
  );
const before = await balances();
const buyerAta = getAssociatedTokenAddressSync(new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), key.publicKey);
const buyerBefore = (await connection.getTokenAccountBalance(buyerAta)).value.amount;
const response = await fetch(`${origin}/api/tasks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    buyer_wallet: key.publicKey.toBase58(),
    chain: chain.map((a) => a.id),
    input: testRefund ? "money!" : "money",
    idempotency_key: crypto.randomUUID(),
  }),
});
const quote = (await response.json()) as PaymentRequired & {
  task: Task;
  access_token: string;
  error?: string;
};
assert.equal(response.status, 402, JSON.stringify(quote));
await writeFile(
  ".secrets/last-devnet-task.json",
  JSON.stringify({ id: quote.task.id, token: quote.access_token, origin }),
  { mode: 0o600 },
);
const payload = await new ExactSvmScheme(signer, {
  rpcUrl: config.rpc_url,
}).createPaymentPayload(2, quote.accepts[0]);
const paid = await fetch(`${origin}/api/tasks/${quote.task.id}/pay`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${quote.access_token}`,
    "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
      ...payload,
      accepted: quote.accepts[0],
      resource: quote.resource,
    }),
  },
});
assert.ok(paid.ok, await paid.text());
let task = quote.task;
for (let i = 0; i < 120; i++) {
  task = (
    (await fetch(`${origin}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${quote.access_token}` },
    }).then((r) => r.json())) as { task: Task }
  ).task;
  if (["released", "refunded"].includes(task.status) || task.payment_state === "review_required") break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ id: task.id, status: task.status, output: task.output, error: task.error, payment_transaction: task.payment_transaction, refund_transaction: task.refund_transaction, legs: task.legs.map(l=>({ name:l.agent.name, output:l.output, transaction:l.transaction })) }, null, 2));
if (testRefund) {
  assert.equal(task.status, "refunded");
  assert.ok(task.refund_transaction);
  assert.equal((await connection.getTokenAccountBalance(buyerAta)).value.amount, buyerBefore);
  assert.deepEqual(await balances(), before);
  console.log("PASS: failed agent call automatically refunded the full buyer payment; no seller payment occurred.");
  process.exit(0);
}
assert.equal(task.status, "released");
assert.equal(task.output, 72);
assert.ok(task.payment_transaction);
const after = await balances();
chain.forEach((agent, i) =>
  assert.equal(
    BigInt(after[i]) - BigInt(before[i]),
    BigInt(agent.price_atomic),
  ),
);
console.log(
  "PASS: money → 72, one buyer payment, both seller balances increased by their exact task price.",
);
