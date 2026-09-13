import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { escrowAddress } from "./payments";
import { HttpError } from "./common";
import { assertDevnet } from "./network";
export async function checkReadiness(env: Env, reserveAtomic: number) {
  try {
    const rpc = new Connection(env.SOLANA_RPC_URL, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    });
    const wallet = new PublicKey(escrowAddress(env));
    const [, sol, usdc] = await Promise.all([
      assertDevnet(rpc),
      rpc.getBalance(wallet),
      getAccount(
        rpc,
        getAssociatedTokenAddressSync(new PublicKey(env.USDC_MINT), wallet),
      ),
    ]);
    if (sol < 100000)
      throw new Error(
        "Gateway needs devnet SOL to pay refund transaction fees.",
      );
    if (usdc.amount < BigInt(reserveAtomic))
      throw new Error(
        "Gateway needs a test-USDC reserve to cover failed chains.",
      );
  } catch (error) {
    throw new HttpError(
      503,
      `Gateway is not ready to accept payment: ${(error as Error).message}`,
    );
  }
}
