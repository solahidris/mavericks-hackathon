import { ZodError } from "zod";
import type { Agent } from "../lib/types";
import { seller, registerAgent } from "./agents";
import { boundedJson, HttpError, isDemo, json, NETWORK } from "./common";
import { escrowAddress } from "./payments";
import {
  authorize,
  createTask,
  executeTask,
  getTask,
  payTask,
  publicTask,
  refundTask,
} from "./tasks";
async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/api/config" && request.method === "GET")
    return json({
      mode: isDemo(env) ? "demo" : "devnet",
      network: NETWORK,
      escrow_wallet: escrowAddress(env),
      rpc_url: "https://api.devnet.solana.com",
      settlement: "per-agent x402 settlement",
    });
  if (path === "/api/agents" && request.method === "GET") {
    const query = (url.searchParams.get("q") || "").slice(0, 100);
    const rows = await env.DB.prepare(
      "SELECT * FROM agents WHERE status='active' AND (name LIKE ? OR skill LIKE ?) ORDER BY created_at,id",
    )
      .bind(`%${query}%`, `%${query}%`)
      .all<Agent & { sample_input: string }>();
    return json({
      agents: rows.results.map((row) => ({
        ...row,
        sample_input: JSON.parse(row.sample_input),
      })),
    });
  }
  if (path === "/api/agents" && request.method === "POST")
    return json(
      { agent: await registerAgent(await boundedJson(request), env) },
      201,
    );
  if (path === "/api/tasks" && request.method === "POST")
    return createTask(request, env);
  const match = path.match(/^\/api\/tasks\/([\da-f-]{36})(?:\/(pay|retry))?$/);
  if (match) {
    if (match[2] === "pay" && request.method === "POST")
      return payTask(request, env, match[1]);
    const task = await getTask(env, match[1]);
    authorize(request, task);
    if (!match[2] && request.method === "GET")
      return json({ task: await publicTask(env, task) });
    if (match[2] === "retry" && request.method === "POST") {
      if (task.status === "paid")
        await env.TASK_QUEUE.send({ task_id: task.id });
      else if (task.payment_state === "refund_pending")
        await env.TASK_QUEUE.send({ task_id: task.id, refund: true });
      else
        throw new HttpError(
          409,
          "This task cannot be safely retried automatically.",
        );
      return json({ queued: true }, 202);
    }
  }
  if (path === "/agents/letters" || path === "/agents/sum")
    return seller(request, env, path.endsWith("letters") ? "letters" : "sum");
  if (path.startsWith("/api/") || path.startsWith("/agents/"))
    throw new HttpError(404, "Route not found.");
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors: Record<string, string> =
      origin && (origin === env.CORS_ORIGIN || origin === env.PUBLIC_ORIGIN)
        ? {
            "Access-Control-Allow-Origin": origin,
            Vary: "Origin",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type,Authorization,PAYMENT-SIGNATURE",
            "Access-Control-Expose-Headers":
              "PAYMENT-REQUIRED,PAYMENT-RESPONSE",
          }
        : {};
    let response: Response;
    try {
      if (request.method === "OPTIONS")
        response = new Response(null, { status: 204 });
      else response = await route(request, env);
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof ZodError
            ? 400
            : 500;
      if (status === 500)
        console.error(
          JSON.stringify({ event: "request_error", message: String(error) }),
        );
      response = json(
        {
          error:
            error instanceof ZodError
              ? error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; ")
              : status === 500
                ? "The gateway could not complete the request."
                : (error as Error).message,
        },
        status,
      );
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, { status: response.status, headers });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body as { task_id: string; refund?: boolean };
      try {
        if (body.refund) await refundTask(env, body.task_id);
        else await executeTask(env, body.task_id);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "task_needs_review",
            task_id: body.task_id,
            error: String(error),
          }),
        );
      }
      message.ack(); // Replaying an ambiguous chain could pay a seller twice. Operator reconciliation is explicit.
    }
  },
} satisfies ExportedHandler<Env>;
