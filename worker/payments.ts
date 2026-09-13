import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactSvmScheme as ServerScheme } from "@x402/svm/exact/server";
import { ExactSvmScheme as ClientScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import {
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
} from "@x402/core/types";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { NETWORK, HttpError, digest, now } from "./common";
export function keypair(secret: string) {
  if (!secret)
    throw new HttpError(
      503,
      "Wallet secrets are not configured. Run npm run wallets:setup.",
    );
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
}
export function escrowAddress(env: Env) {
  return keypair(env.GATEWAY_PRIVATE_KEY).publicKey.toBase58();
}
function facilitator(env: Env) {
  return new HTTPFacilitatorClient({
    url: env.FACILITATOR_URL,
    timeoutMs: 25000,
  });
}
export async function requirements(
  env: Env,
  payTo: string,
  amount: number,
  url: string,
): Promise<PaymentRequired> {
  const server = new x402ResourceServer(facilitator(env)).register(
    NETWORK,
    new ServerScheme(),
  );
  await server.initialize();
  const accepts = await server.buildPaymentRequirements({
    scheme: "exact",
    network: NETWORK,
    payTo,
    price: {
      asset: env.USDC_MINT,
      amount: String(amount),
      extra: { decimals: 6 },
    },
    maxTimeoutSeconds: 120,
  });
  return server.createPaymentRequiredResponse(accepts, {
    url,
    description: "Relay agent task · Solana devnet USDC",
    mimeType: "application/json",
  });
}
export async function paymentHeader(env: Env, required: PaymentRequired) {
  const signer = await createKeyPairSignerFromBytes(
    keypair(env.GATEWAY_PRIVATE_KEY).secretKey,
  );
  const partial = await new ClientScheme(signer, {
    rpcUrl: env.SOLANA_RPC_URL,
  }).createPaymentPayload(2, required.accepts[0]);
  return encodePaymentSignatureHeader({
    ...partial,
    accepted: required.accepts[0],
    resource: required.resource,
  });
}
export function assertQuote(
  actual: PaymentRequirements,
  expected: PaymentRequirements,
) {
  if (
    actual.scheme !== "exact" ||
    actual.network !== NETWORK ||
    actual.payTo !== expected.payTo ||
    actual.asset !== expected.asset ||
    actual.amount !== expected.amount ||
    actual.extra?.feePayer !== expected.extra?.feePayer
  )
    throw new HttpError(400, "Payment does not match the stored quote.");
}
export async function settle(
  env: Env,
  header: string,
  required: PaymentRequired,
  resourceId: string,
  payer?: string,
) {
  if (header.length > 16384)
    throw new HttpError(400, "Payment proof is too large.");
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    throw new HttpError(400, "Invalid PAYMENT-SIGNATURE header.");
  }
  if (payload.x402Version !== 2 || !payload.accepted)
    throw new HttpError(400, "x402 v2 is required.");
  assertQuote(payload.accepted, required.accepts[0]);
  const transaction = payload.payload?.transaction;
  if (typeof transaction !== "string")
    throw new HttpError(400, "Missing Solana transaction.");
  // Hash the message, excluding mutable signature slots, to stop cross-task replay.
  let hash: string;
  try {
    hash = await digest(
      Buffer.from(
        VersionedTransaction.deserialize(
          Buffer.from(transaction, "base64"),
        ).message.serialize(),
      ).toString("base64"),
    );
  } catch {
    throw new HttpError(400, "Invalid Solana transaction bytes.");
  }
  const client = facilitator(env);
  const verification = await client.verify(payload, required.accepts[0]);
  if (!verification.isValid || (payer && verification.payer !== payer))
    throw new HttpError(
      402,
      verification.invalidReason ||
        "Payment signer does not match the buyer wallet.",
    );
  const reservation = await env.DB.prepare(
    "INSERT OR IGNORE INTO payments (proof_hash,resource_id,state,created_at) VALUES (?,?,?,?)",
  )
    .bind(hash, resourceId, "settling", now())
    .run();
  if (!reservation.meta.changes)
    throw new HttpError(
      409,
      "This payment is already used or awaiting reconciliation. Do not pay again.",
    );
  try {
    const result = await client.settle(payload, required.accepts[0]);
    if (!result.success || !result.transaction)
      throw new Error(
        result.errorReason || "Facilitator did not confirm settlement.",
      );
    await env.DB.prepare(
      "UPDATE payments SET state=?,transaction_id=? WHERE proof_hash=?",
    )
      .bind("confirmed", result.transaction, hash)
      .run();
    return result;
  } catch (error) {
    await env.DB.prepare("UPDATE payments SET state=? WHERE proof_hash=?")
      .bind("review_required", hash)
      .run();
    throw new HttpError(
      503,
      `Payment outcome needs reconciliation; do not pay again. ${error instanceof Error ? error.message : ""}`,
    );
  }
}
