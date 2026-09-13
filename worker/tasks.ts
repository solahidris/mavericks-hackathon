import { z } from "zod";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { Agent, Task, TaskLeg, TaskStatus } from "../lib/types";
import {
  boundedJson,
  checkShape,
  digest,
  HttpError,
  isDemo,
  json,
  now,
  validWallet,
} from "./common";
import {
  assertQuote,
  escrowAddress,
  paymentHeader,
  requirements,
  settle,
} from "./payments";
import { callEndpoint } from "./agents";
import { refund } from "./refunds";
import { checkReadiness } from "./readiness";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { decodePaymentSignatureHeader } from "@x402/core/http";
export type TaskRow = Omit<
  Task,
  "chain" | "input" | "output" | "legs" | "events"
> & {
  chain: string;
  input: string;
  output: string | null;
  legs: string;
  access_token: string;
  requirements: string | null;
  request_hash: string;
  refund_raw: string | null;
};
export async function getTask(env: Env, id: string) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(id)
    .first<TaskRow>();
  if (!task) throw new HttpError(404, "Task not found.");
  return task;
}
export async function publicTask(env: Env, task: TaskRow): Promise<Task> {
  const events = await env.DB.prepare(
    "SELECT id,status,message,created_at FROM task_events WHERE task_id=? ORDER BY id",
  )
    .bind(task.id)
    .all<Task["events"][number]>();
  return {
    id: task.id,
    buyer_wallet: task.buyer_wallet,
    chain: JSON.parse(task.chain),
    input: JSON.parse(task.input),
    output: task.output === null ? null : JSON.parse(task.output),
    status: task.status,
    amount_usdc: task.amount_usdc,
    amount_atomic: task.amount_atomic,
    created_at: task.created_at,
    updated_at: task.updated_at,
    error: task.error,
    payment_mode: task.payment_mode,
    payment_state: task.payment_state,
    payment_transaction: task.payment_transaction,
    refund_transaction: task.refund_transaction,
    legs: JSON.parse(task.legs),
    events: events.results,
  };
}
export function authorize(request: Request, task: TaskRow) {
  if (request.headers.get("Authorization") !== `Bearer ${task.access_token}`)
    throw new HttpError(403, "Task access token required.");
}
export async function transition(
  env: Env,
  id: string,
  from: TaskStatus,
  to: TaskStatus,
  message: string,
) {
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE tasks SET status=?,updated_at=? WHERE id=? AND status=?",
    ).bind(to, now(), id, from),
    env.DB.prepare(
      "INSERT INTO task_events (task_id,status,message,created_at) SELECT ?,?,?,? WHERE changes()=1",
    ).bind(id, to, message, now()),
  ]);
  return result[0].meta.changes === 1;
}
const taskInput = z.object({
  buyer_wallet: z.string().min(1),
  chain: z.array(z.string().uuid()).min(1).max(8),
  input: z.unknown(),
  idempotency_key: z.string().uuid(),
});
export async function createTask(request: Request, env: Env) {
  const data = taskInput.parse(await boundedJson(request));
  if (!isDemo(env) && !validWallet(data.buyer_wallet))
    throw new HttpError(400, "Connect a valid Solana buyer wallet.");
  const hash = await digest(
    JSON.stringify([data.buyer_wallet, data.chain, data.input]),
  );
  const existing = await env.DB.prepare(
    "SELECT * FROM tasks WHERE idempotency_key=?",
  )
    .bind(data.idempotency_key)
    .first<TaskRow>();
  if (existing) {
    if (existing.request_hash !== hash)
      throw new HttpError(
        409,
        "Idempotency key belongs to a different request.",
      );
    return quoteResponse(env, existing);
  }
  const legs: TaskLeg[] = [];
  for (const id of data.chain) {
    const row = await env.DB.prepare(
      "SELECT * FROM agents WHERE id=? AND status='active'",
    )
      .bind(id)
      .first<Agent & { sample_input: string }>();
    if (!row)
      throw new HttpError(
        400,
        "An agent is unavailable. Refresh the directory.",
      );
    legs.push({
      agent: { ...row, sample_input: JSON.parse(row.sample_input) },
    });
  }
  if (!checkShape(data.input, legs[0].agent.input_type))
    throw new HttpError(
      400,
      `First agent expects ${legs[0].agent.input_type}.`,
    );
  for (let i = 1; i < legs.length; i++)
    if (
      legs[i].agent.input_type !== "json" &&
      legs[i - 1].agent.output_type !== legs[i].agent.input_type
    )
      throw new HttpError(
        400,
        `Incompatible chain: ${legs[i].agent.name} expects ${legs[i].agent.input_type}.`,
      );
  const amount = legs.reduce((total, leg) => total + leg.agent.price_atomic, 0);
  if (!isDemo(env)) await checkReadiness(env, amount);
  const id = crypto.randomUUID();
  const access = crypto.randomUUID();
  const date = now();
  const quote = isDemo(env)
    ? null
    : await requirements(
        env,
        escrowAddress(env),
        amount,
        `${env.PUBLIC_ORIGIN}/api/tasks/${id}/pay`,
      );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tasks (id,buyer_wallet,agent_id,chain,input,status,amount_usdc,amount_atomic,created_at,updated_at,legs,payment_mode,access_token,idempotency_key,request_hash,requirements) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      data.buyer_wallet,
      legs.length === 1 ? legs[0].agent.id : null,
      JSON.stringify(data.chain),
      JSON.stringify(data.input),
      "created",
      amount / 1e6,
      amount,
      date,
      date,
      JSON.stringify(legs),
      isDemo(env) ? "demo" : "devnet",
      access,
      data.idempotency_key,
      hash,
      quote ? JSON.stringify(quote) : null,
    ),
    env.DB.prepare(
      "INSERT INTO task_events(task_id,status,message,created_at) VALUES (?,?,?,?)",
    ).bind(
      id,
      "created",
      "Task quoted. Waiting for buyer authorization.",
      date,
    ),
  ]);
  return quoteResponse(env, await getTask(env, id));
}
async function quoteResponse(env: Env, task: TaskRow) {
  const quote = task.requirements
    ? (JSON.parse(task.requirements) as PaymentRequired)
    : null;
  return json(
    {
      ...(quote || {}),
      task: await publicTask(env, task),
      access_token: task.access_token,
    },
    task.status === "created" && !isDemo(env) ? 402 : 201,
    quote ? { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(quote) } : {},
  );
}
export async function payTask(request: Request, env: Env, id: string) {
  const task = await getTask(env, id);
  authorize(request, task);
  if (task.status !== "created")
    return json({ task: await publicTask(env, task) });
  if (task.payment_mode !== (isDemo(env) ? "demo" : "devnet"))
    throw new HttpError(409, "Payment mode changed. Create a new task.");
  const proof = request.headers.get("PAYMENT-SIGNATURE");
  if (!isDemo(env) && !proof)
    return json(JSON.parse(task.requirements!), 402, {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
        JSON.parse(task.requirements!),
      ),
    });
  const claimed = await env.DB.prepare(
    "UPDATE tasks SET payment_state='settling' WHERE id=? AND payment_state='unpaid'",
  )
    .bind(id)
    .run();
  if (!claimed.meta.changes)
    throw new HttpError(
      409,
      "Payment is already processing or needs reconciliation. Do not pay again.",
    );
  let receipt;
  try {
    if (!isDemo(env))
      receipt = await settle(
        env,
        proof!,
        JSON.parse(task.requirements!),
        id,
        task.buyer_wallet,
      );
  } catch (error) {
    const reversible =
      error instanceof HttpError && [400, 402].includes(error.status);
    await env.DB.prepare("UPDATE tasks SET payment_state=?,error=? WHERE id=?")
      .bind(
        reversible ? "unpaid" : "review_required",
        (error as Error).message,
        id,
      )
      .run();
    throw error;
  }
  await env.DB.prepare(
    "UPDATE tasks SET payment_state=?,payment_transaction=?,error=NULL WHERE id=?",
  )
    .bind(
      isDemo(env) ? "simulated" : "confirmed",
      receipt?.transaction || null,
      id,
    )
    .run();
  await transition(
    env,
    id,
    "created",
    "paid",
    isDemo(env)
      ? "Demo payment authorized. No funds moved."
      : "Buyer USDC payment confirmed in gateway escrow.",
  );
  try {
    await env.TASK_QUEUE.send({ task_id: id });
  } catch {
    await env.DB.prepare("UPDATE tasks SET error=? WHERE id=?")
      .bind(
        "Payment confirmed; task dispatch pending. Retry dispatch from the task view.",
        id,
      )
      .run();
  }
  return json(
    { task: await publicTask(env, await getTask(env, id)) },
    202,
    receipt ? { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt) } : {},
  );
}
export async function executeTask(env: Env, id: string) {
  const queuedTask = await getTask(env, id);
  if (queuedTask.payment_mode !== (isDemo(env) ? "demo" : "devnet")) {
    await env.DB.prepare("UPDATE tasks SET error=? WHERE id=?")
      .bind(
        "Task payment mode differs from gateway configuration; restore the mode before retrying dispatch.",
        id,
      )
      .run();
    return;
  }
  if (
    !(await transition(
      env,
      id,
      "paid",
      "in_progress",
      "Gateway is routing your task.",
    ))
  )
    return;
  const task = await getTask(env, id);
  const legs: TaskLeg[] = JSON.parse(task.legs);
  let input = JSON.parse(task.input);
  try {
    for (let index = 0; index < legs.length; index++) {
      const leg = legs[index];
      if (!checkShape(input, leg.agent.input_type))
        throw new Error(`${leg.agent.name}: invalid input shape.`);
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      };
      await env.DB.prepare(
        "INSERT INTO payout_ledger (id,task_id,leg_index,agent_id,wallet_address,amount_atomic,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          id,
          index,
          leg.agent.id,
          leg.agent.wallet_address,
          leg.agent.price_atomic,
          "pending",
          now(),
        )
        .run();
      let response = await callEndpoint(leg.agent.endpoint_url, init, env);
      if (!isDemo(env)) {
        if (response.status !== 402)
          throw new Error(`${leg.agent.name}: expected x402 payment gate.`);
        const quote = decodePaymentRequiredHeader(
          response.headers.get("PAYMENT-REQUIRED") || "",
        );
        const expected = {
          ...quote.accepts[0],
          scheme: "exact",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const,
          asset: env.USDC_MINT,
          payTo: leg.agent.wallet_address,
          amount: String(leg.agent.price_atomic),
        };
        assertQuote(quote.accepts[0], expected);
        // Refuse unknown fee payers. Do not let an untrusted agent choose arbitrary signing instructions.
        const trusted = await requirements(
          env,
          leg.agent.wallet_address,
          leg.agent.price_atomic,
          leg.agent.endpoint_url,
        );
        if (
          quote.accepts[0].extra?.feePayer !==
          trusted.accepts[0].extra?.feePayer
        )
          throw new Error(
            "Agent requested an untrusted facilitator fee payer.",
          );
        const proof = await paymentHeader(env, quote);
        await env.DB.prepare(
          "UPDATE payout_ledger SET payment_signature=? WHERE task_id=? AND leg_index=?",
        )
          .bind(proof, id, index)
          .run();
        response = await callEndpoint(
          leg.agent.endpoint_url,
          { ...init, headers: { ...init.headers, "PAYMENT-SIGNATURE": proof } },
          env,
        );
        const encodedReceipt = response.headers.get("PAYMENT-RESPONSE");
        if (!response.ok || !encodedReceipt)
          throw new Error(`${leg.agent.name}: payment or execution failed.`);
        const receipt = decodePaymentResponseHeader(encodedReceipt);
        if (
          !receipt.success ||
          receipt.network !== expected.network ||
          !receipt.transaction
        )
          throw new Error(
            "Agent did not return a successful settlement receipt.",
          );
        // An external seller's receipt is untrusted: verify the exact signed message landed.
        const rpc = new Connection(env.SOLANA_RPC_URL, "confirmed");
        const onchain = await rpc.getTransaction(receipt.transaction, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        const signed = decodePaymentSignatureHeader(proof).payload
          .transaction as string;
        const expectedMessage = VersionedTransaction.deserialize(
          Buffer.from(signed, "base64"),
        ).message.serialize();
        if (
          !onchain ||
          !onchain.meta ||
          onchain.meta.err ||
          !Buffer.from(onchain.transaction.message.serialize()).equals(
            Buffer.from(expectedMessage),
          )
        )
          throw new Error(
            "Agent settlement could not be independently confirmed.",
          );
        leg.transaction = receipt.transaction;
        await env.DB.prepare(
          "UPDATE payout_ledger SET status=?,transaction_id=? WHERE task_id=? AND leg_index=?",
        )
          .bind("confirmed", leg.transaction, id, index)
          .run();
      }
      if (!response.ok)
        throw new Error(`${leg.agent.name}: ${response.status} response.`);
      const body = z
        .object({ output: z.unknown() })
        .parse(await boundedJson(response));
      if (!checkShape(body.output, leg.agent.output_type))
        throw new Error(`${leg.agent.name}: invalid output shape.`);
      leg.output = body.output;
      input = body.output;
      await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET legs=?,updated_at=? WHERE id=?").bind(
          JSON.stringify(legs),
          now(),
          id,
        ),
        env.DB.prepare(
          "UPDATE payout_ledger SET status=? WHERE task_id=? AND leg_index=?",
        ).bind(isDemo(env) ? "simulated" : "confirmed", id, index),
        env.DB.prepare(
          "INSERT INTO task_events(task_id,status,message,created_at) VALUES (?,?,?,?)",
        ).bind(
          id,
          "in_progress",
          `${leg.agent.name} returned ${JSON.stringify(body.output)}.`,
          now(),
        ),
      ]);
    }
    await env.DB.prepare("UPDATE tasks SET output=?,error=NULL WHERE id=?")
      .bind(JSON.stringify(input), id)
      .run();
    await transition(
      env,
      id,
      "in_progress",
      "completed",
      "All agent responses validated.",
    );
    await transition(
      env,
      id,
      "completed",
      "released",
      isDemo(env)
        ? "Demo complete. Payouts simulated in the ledger."
        : "All agent payments settled and recorded.",
    );
  } catch (error) {
    await env.DB.prepare("UPDATE tasks SET error=?,payment_state=? WHERE id=?")
      .bind((error as Error).message, "refund_pending", id)
      .run();
    await refundTask(env, id);
  }
}
export async function refundTask(env: Env, id: string) {
  const task = await getTask(env, id);
  if (task.payment_state !== "refund_pending") return;
  try {
    if (task.payment_mode !== "demo") await refund(env, task);
    await transition(
      env,
      id,
      "in_progress",
      "refunded",
      task.payment_mode === "demo"
        ? "Demo failure: refund simulated. No funds moved."
        : "Full buyer refund confirmed on Solana devnet.",
    );
    await env.DB.prepare("UPDATE tasks SET payment_state=? WHERE id=?")
      .bind(task.payment_mode === "demo" ? "simulated" : "refunded", id)
      .run();
  } catch (error) {
    await env.DB.prepare("UPDATE tasks SET error=? WHERE id=?")
      .bind(
        `${task.error || "Task failed"} Refund pending: ${(error as Error).message}`,
        id,
      )
      .run();
  }
}
