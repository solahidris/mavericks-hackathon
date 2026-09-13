import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { PaymentRequired } from "@x402/core/types";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import {
  address,
  getTransactionEncoder,
  type TransactionPartialSigner,
  type SignatureBytes,
} from "@solana/kit";
import { VersionedTransaction } from "@solana/web3.js";
export async function signPayment(
  wallet: WalletContextState,
  quote: PaymentRequired,
  rpcUrl: string,
) {
  if (!wallet.publicKey || !wallet.signTransaction)
    throw new Error("Connect a wallet that supports transaction signing.");
  const owner = address(wallet.publicKey.toBase58());
  const sign = wallet.signTransaction;
  const signer: TransactionPartialSigner = {
    address: owner,
    async signTransactions(transactions) {
      const results = [];
      for (const tx of transactions) {
        const versioned = VersionedTransaction.deserialize(
          Uint8Array.from(getTransactionEncoder().encode(tx)),
        );
        const signed = await sign(versioned);
        const index = signed.message.staticAccountKeys.findIndex(
          (key) => key.toBase58() === owner,
        );
        if (index < 0 || !signed.signatures[index]?.some((byte) => byte !== 0))
          throw new Error("Wallet did not sign the payment.");
        results.push({ [owner]: signed.signatures[index] as SignatureBytes });
      }
      return results;
    },
  };
  const selected = quote.accepts[0];
  if (
    selected.network !== "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" ||
    selected.scheme !== "exact"
  )
    throw new Error("Only exact Solana devnet payments are supported.");
  const payload = await new ExactSvmScheme(signer, {
    rpcUrl,
  }).createPaymentPayload(2, selected);
  return encodePaymentSignatureHeader({
    ...payload,
    accepted: selected,
    resource: quote.resource,
  });
}
