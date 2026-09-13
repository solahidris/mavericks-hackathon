/** Loopback-only, devnet-only test signer. Never deploy this service. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  Keypair,
  VersionedTransaction,
  ComputeBudgetProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
const buyer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(".secrets/buyer.json", "utf8"))),
);
const gateway = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(".secrets/gateway.json", "utf8"))),
);
const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const source = getAssociatedTokenAddressSync(mint, buyer.publicKey);
const target = getAssociatedTokenAddressSync(mint, gateway.publicKey);
createServer(async (request, response) => {
  if (request.headers.origin !== "http://localhost:3000") {
    response.writeHead(403);
    response.end();
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url === "/wallet" && request.method === "GET") {
    response.end(JSON.stringify({ address: buyer.publicKey.toBase58() }));
    return;
  }
  try {
    if (request.url !== "/sign" || request.method !== "POST")
      throw new Error("Unknown route");
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 10000) throw new Error("Request too large");
    }
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(JSON.parse(body).transaction, "base64"),
    );
    if (transaction.message.addressTableLookups.length)
      throw new Error("Lookup tables are not allowed");
    const keys = transaction.message.staticAccountKeys;
    let transfers = 0;
    for (const instruction of transaction.message.compiledInstructions) {
      const program = keys[instruction.programIdIndex];
      if (program.equals(ComputeBudgetProgram.programId)) continue;
      // x402 adds a random memo to prevent deterministic transaction collisions.
      if (
        program.toBase58() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" &&
        instruction.data.length <= 128
      )
        continue;
      if (
        !program.equals(TOKEN_PROGRAM_ID) ||
        instruction.data[0] !== 12 ||
        instruction.data.length !== 10
      )
        throw new Error("Only USDC transferChecked is allowed");
      const accounts = instruction.accountKeyIndexes.map((i) => keys[i]);
      if (
        !accounts[0]?.equals(source) ||
        !accounts[1]?.equals(mint) ||
        !accounts[2]?.equals(target) ||
        !accounts[3]?.equals(buyer.publicKey)
      )
        throw new Error("Unexpected payment recipient or asset");
      const amount = Buffer.from(instruction.data).readBigUInt64LE(1);
      if (
        amount <= BigInt(0) ||
        amount > BigInt(10000) ||
        instruction.data[9] !== 6
      )
        throw new Error("Test payment is limited to 0.01 devnet USDC");
      transfers++;
    }
    if (transfers !== 1) throw new Error("Expected one USDC transfer");
    transaction.sign([buyer]);
    response.end(
      JSON.stringify({
        transaction: Buffer.from(transaction.serialize()).toString("base64"),
      }),
    );
  } catch (error) {
    response.writeHead(400);
    response.end(JSON.stringify({ error: (error as Error).message }));
  }
}).listen(9797, "127.0.0.1", () =>
  console.log(
    "Devnet test signer on localhost:9797. Only the generated buyer → gateway transfer is permitted; max 0.01 USDC.",
  ),
);
