/** Development-only Wallet Adapter. Private keys remain in the local test signer. */
import {
  BaseSignerWalletAdapter,
  WalletReadyState,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
export class TestBuyerAdapter extends BaseSignerWalletAdapter {
  name = "Test buyer (devnet)" as WalletName<"Test buyer (devnet)">;
  url = "http://localhost:9797";
  icon =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCI gZmlsbD0iIzFhNmM1NCIvPjx0ZXh0IHg9IjIwIiB5PSIyNyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiIGZvbnQtc2l6ZT0iMjAiPlQ8L3RleHQ+PC9zdmc+".replaceAll(
      " ",
      "",
    );
  readyState = WalletReadyState.Installed;
  supportedTransactionVersions = new Set<0 | "legacy">([0]);
  publicKey: PublicKey | null = null;
  connecting = false;
  async connect() {
    this.connecting = true;
    try {
      const response = await fetch(`${this.url}/wallet`);
      if (!response.ok) throw new Error("Start npm run test:signer first.");
      const { address } = (await response.json()) as { address: string };
      this.publicKey = new PublicKey(address);
      this.emit("connect", this.publicKey);
    } finally {
      this.connecting = false;
    }
  }
  async disconnect() {
    this.publicKey = null;
    this.emit("disconnect");
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T> {
    if (!(transaction instanceof VersionedTransaction))
      throw new Error("Test buyer supports versioned x402 transactions only.");
    const response = await fetch(`${this.url}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction: btoa(String.fromCharCode(...transaction.serialize())),
      }),
    });
    const result = (await response.json()) as {
      transaction: string;
      error?: string;
    };
    if (!response.ok)
      throw new Error(result.error || "Test signer rejected the transaction.");
    const signed = VersionedTransaction.deserialize(
      Uint8Array.from(atob(result.transaction), (c) => c.charCodeAt(0)),
    );
    transaction.signatures = signed.signatures;
    return transaction;
  }
}
