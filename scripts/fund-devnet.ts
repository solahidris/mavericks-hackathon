import { readFile } from "node:fs/promises";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(rpc, "confirmed");
if (
  (await connection.getGenesisHash()) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("Refusing to fund or transact outside Solana devnet.");
const buyer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(".secrets/buyer.json", "utf8"))),
);
for (const name of ["buyer", "gateway"]) {
  const account = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(await readFile(`.secrets/${name}.json`, "utf8")),
    ),
  );
  const balance = await connection.getBalance(account.publicKey);
  if (balance < 0.02 * LAMPORTS_PER_SOL) {
    try {
      const signature = await connection.requestAirdrop(
        account.publicKey,
        LAMPORTS_PER_SOL,
      );
      console.log(`${name}: airdrop submitted ${signature}`);
    } catch (error) {
      console.log(`${name}: faucet unavailable: ${(error as Error).message}`);
    }
  }
}
for (const name of ["buyer", "gateway", "agent-a", "agent-b"]) {
  const account = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(await readFile(`.secrets/${name}.json`, "utf8")),
    ),
  );
  try {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      buyer,
      new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
      account.publicKey,
    );
    console.log(
      `${name}: USDC token account ${ata.address.toBase58()}, balance ${Number(ata.amount) / 1e6} USDC`,
    );
  } catch (error) {
    console.log(`${name}: token account pending (${(error as Error).message})`);
  }
}
console.log(
  "Fund buyer and gateway with test USDC at https://faucet.circle.com/ (Solana Devnet). Gateway also needs SOL for refunds and a USDC reserve.",
);
