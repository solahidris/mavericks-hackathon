import type { Connection } from "@solana/web3.js";
import { HttpError } from "./common";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const SANDBOX_RPC = "https://demo.helius.dev/api/rpc?network=devnet";
/**
 * Helius's public sandbox restricts RPC methods, excluding getGenesisHash.
 * For that exact endpoint verify a finalized checkpoint, independently read from
 * both Solana's canonical devnet RPC and Helius on 2026-09-13. Never infer the
 * network from a hostname alone. Missing/pruned checkpoints fail closed.
 */
export async function assertDevnet(connection: Connection) {
  if (connection.rpcEndpoint === SANDBOX_RPC) {
    const block = await connection.getBlock(497595000, {
      commitment: "finalized",
      transactionDetails: "none",
      rewards: false,
      maxSupportedTransactionVersion: 0,
    });
    if (block?.blockhash !== "G2PSGN2r4uxyanfCsmJdcVnL5EhCgT4bpzVWLh1NNXxy")
      throw new HttpError(
        503,
        "RPC did not match the Solana devnet checkpoint.",
      );
  } else if ((await connection.getGenesisHash()) !== DEVNET_GENESIS)
    throw new HttpError(503, "RPC must be Solana devnet.");
}
