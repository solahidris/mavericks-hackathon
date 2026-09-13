import { PublicKey } from "@solana/web3.js";
import type { Shape } from "../lib/types";
export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
export const now = () => new Date().toISOString();
export const isDemo = (env: Env) => String(env.PAYMENT_MODE) === "demo";
export function validWallet(value: string) {
  try {
    return PublicKey.isOnCurve(new PublicKey(value).toBytes());
  } catch {
    return false;
  }
}
export function checkShape(input: unknown, shape: Shape): boolean {
  if (shape === "string")
    return (
      typeof input === "string" && input.length > 0 && input.length <= 4096
    );
  if (shape === "number")
    return typeof input === "number" && Number.isFinite(input);
  if (shape === "number[]")
    return (
      Array.isArray(input) &&
      input.length > 0 &&
      input.length <= 256 &&
      input.every((n) => typeof n === "number" && Number.isFinite(n))
    );
  return (
    input !== null &&
    input !== undefined &&
    JSON.stringify(input).length <= 16384
  );
}
export async function digest(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hash)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function boundedJson(
  request: Request | Response,
): Promise<unknown> {
  if (!request.body) throw new HttpError(400, "Expected a JSON body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 32768) {
      await reader.cancel();
      throw new HttpError(413, "JSON body exceeds 32 KB.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "Expected valid JSON.");
  }
}
/** Cloudflare also rejects private-address fetches; reject literals and redirects here. */
export function endpointUrl(raw: string, env: Env) {
  const url = new URL(raw);
  const local =
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    (isDemo(env) ||
      (url.origin === env.PUBLIC_ORIGIN &&
        /^\/agents\/(letters|sum)$/.test(url.pathname)));
  if (
    !local &&
    (url.protocol !== "https:" ||
      !url.hostname.includes(".") ||
      /^[\d.[\]:]+$/.test(url.hostname) ||
      /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname))
  )
    throw new HttpError(
      400,
      "Agent endpoints must use a public HTTPS hostname.",
    );
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && !local && url.port !== "443")
  )
    throw new HttpError(
      400,
      "Endpoint URLs cannot contain credentials, queries, fragments, or custom ports.",
    );
  return url.toString();
}
