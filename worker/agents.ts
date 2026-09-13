import { z } from "zod";
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { Agent, Shape } from "../lib/types";
import { lettersToNumbers, sumNumbers } from "./logic";
import {
  boundedJson,
  checkShape,
  endpointUrl,
  HttpError,
  isDemo,
  json,
  now,
  validWallet,
} from "./common";
import { keypair, requirements, settle } from "./payments";
export const builtins = {
  letters: {
    name: "Letter to Numbers",
    skill: "letter-to-numbers",
    description:
      "Turn any word into its alphabet positions. A small, precise building block for bigger workflows.",
    input_type: "string" as Shape,
    output_type: "number[]" as Shape,
    sample_input: "money",
    run: lettersToNumbers,
  },
  sum: {
    name: "Sum the Numbers",
    skill: "sum-numbers",
    description:
      "Add a sequence of numbers in a single call. Connect it to another agent or bring your own data.",
    input_type: "number[]" as Shape,
    output_type: "number" as Shape,
    sample_input: [13, 15, 14, 5, 25],
    run: sumNumbers,
  },
};
export async function seller(
  request: Request,
  env: Env,
  kind: keyof typeof builtins,
) {
  const definition = builtins[kind];
  const wallet = keypair(
    kind === "letters" ? env.AGENT_A_PRIVATE_KEY : env.AGENT_B_PRIVATE_KEY,
  ).publicKey.toBase58();
  if (request.method === "GET")
    return json({
      protocol: "relay-agent-v1",
      ...definition,
      run: undefined,
      wallet_address: wallet,
      price_usdc: 0.001,
    });
  if (request.method !== "POST")
    throw new HttpError(405, "Use GET for the manifest or POST for a task.");
  const body = z
    .object({ input: z.unknown() })
    .parse(await boundedJson(request));
  let output: unknown;
  try {
    output = definition.run(body.input);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (isDemo(env)) return json({ output, payment_mode: "demo" });
  const quote = await requirements(env, wallet, 1000, request.url);
  const proof = request.headers.get("PAYMENT-SIGNATURE");
  if (!proof)
    return json(quote, 402, {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(quote),
    });
  const receipt = await settle(
    env,
    proof,
    quote,
    `seller:${kind}:${crypto.randomUUID()}`,
  );
  return json({ output }, 200, {
    "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt),
  });
}
export async function callEndpoint(
  url: string,
  init: RequestInit,
  env: Env,
): Promise<Response> {
  endpointUrl(url, env);
  const parsed = new URL(url);
  const own = new URL(env.PUBLIC_ORIGIN);
  // Routes in one Worker are dispatched internally, not fetched through its public URL.
  if (
    parsed.origin === own.origin &&
    /^\/agents\/(letters|sum)$/.test(parsed.pathname)
  )
    return seller(
      new Request(url, init),
      env,
      parsed.pathname.endsWith("letters") ? "letters" : "sum",
    );
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(12000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new HttpError(400, "Agent endpoints cannot redirect.");
  return response;
}
const shape = z.enum(["string", "number", "number[]", "json"]);
const registration = z.object({
  name: z.string().trim().min(2).max(60),
  skill: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(""),
  endpoint_url: z.string().url(),
  wallet_address: z
    .string()
    .refine(validWallet, "Enter a valid Solana wallet address."),
  price_usdc: z.coerce.number().min(0.000001).max(10),
});
const manifestSchema = z.object({
  protocol: z.literal("relay-agent-v1"),
  input_type: shape,
  output_type: shape,
  sample_input: z.unknown(),
  wallet_address: z.string(),
  price_usdc: z.number(),
});
export async function registerAgent(raw: unknown, env: Env) {
  const data = registration.parse(raw);
  const endpoint = endpointUrl(data.endpoint_url, env);
  const atomic = Math.round(data.price_usdc * 1e6);
  if (Math.abs(atomic / 1e6 - data.price_usdc) > 1e-10)
    throw new HttpError(400, "USDC supports at most six decimal places.");
  const manifestResponse = await callEndpoint(endpoint, { method: "GET" }, env);
  if (!manifestResponse.ok)
    throw new HttpError(400, "Endpoint manifest health check failed.");
  const manifest = manifestSchema.parse(await boundedJson(manifestResponse));
  if (
    manifest.wallet_address !== data.wallet_address ||
    Math.round(manifest.price_usdc * 1e6) !== atomic ||
    !checkShape(manifest.sample_input, manifest.input_type)
  )
    throw new HttpError(
      400,
      "Manifest wallet, price, or sample input does not match the registration.",
    );
  const probe = await callEndpoint(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: manifest.sample_input }),
    },
    env,
  );
  if (isDemo(env)) {
    const result = z
      .object({ output: z.unknown() })
      .parse(await boundedJson(probe));
    if (!probe.ok || !checkShape(result.output, manifest.output_type))
      throw new HttpError(400, "Sample task returned an invalid output.");
  } else {
    if (probe.status !== 402)
      throw new HttpError(
        400,
        "Endpoint must respond with an x402 payment requirement.",
      );
    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    const quote = decodePaymentRequiredHeader(
      probe.headers.get("PAYMENT-REQUIRED") || "",
    );
    if (
      !quote.accepts.some(
        (q) =>
          q.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" &&
          q.scheme === "exact" &&
          q.asset === env.USDC_MINT &&
          q.payTo === data.wallet_address &&
          q.amount === String(atomic),
      )
    )
      throw new HttpError(
        400,
        "Endpoint payment requirements do not match its listing.",
      );
  }
  const agent: Agent = {
    ...data,
    endpoint_url: endpoint,
    id: crypto.randomUUID(),
    price_atomic: atomic,
    status: "active",
    created_at: now(),
    input_type: manifest.input_type,
    output_type: manifest.output_type,
    sample_input: manifest.sample_input,
  };
  try {
    await env.DB.prepare(
      "INSERT INTO agents (id,name,skill,description,endpoint_url,wallet_address,price_usdc,price_atomic,status,input_type,output_type,sample_input,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        agent.id,
        agent.name,
        agent.skill,
        agent.description,
        endpoint,
        agent.wallet_address,
        agent.price_usdc,
        atomic,
        "active",
        agent.input_type,
        agent.output_type,
        JSON.stringify(agent.sample_input),
        agent.created_at,
      )
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      throw new HttpError(409, "This endpoint is already registered.");
    throw error;
  }
  return agent;
}
