import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import type { Agent, Task } from "../lib/types";
const base = process.env.GATEWAY_URL || "http://localhost:8787";
const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${base}${path}`, init);
  return {
    status: response.status,
    body: (await response.json()) as {
      agents: Agent[];
      task: Task;
      access_token: string;
      agent: Agent;
      error?: string;
    },
  };
};
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function quote(
  chain: string[],
  input: unknown,
  key = crypto.randomUUID(),
) {
  return json(
    "/api/tasks",
    post({ chain, input, buyer_wallet: "demo-buyer", idempotency_key: key }),
  );
}
async function finish(task: Task, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const responses = await Promise.all([
    json(`/api/tasks/${task.id}/pay`, { method: "POST", headers }),
    json(`/api/tasks/${task.id}/pay`, { method: "POST", headers }),
  ]);
  assert.ok(responses.some((r) => r.status === 202));
  for (let i = 0; i < 50; i++) {
    const result = await json(`/api/tasks/${task.id}`, { headers });
    if (["released", "refunded"].includes(result.body.task.status))
      return result.body.task;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Task did not finish");
}
test("D1 gateway: routing, idempotency, authorization, chains, third-agent onboarding, refunds", async () => {
  assert.ok(
    ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
    "This integration suite uses a local fixture server.",
  );
  const config = (await fetch(`${base}/api/config`).then((r) => r.json())) as {
    mode: string;
  };
  assert.equal(config.mode, "demo", "Integration suite is local demo only.");
  const { body } = await json("/api/agents");
  const a = body.agents.find((a) => a.skill === "letter-to-numbers")!;
  const b = body.agents.find((a) => a.skill === "sum-numbers")!;
  assert.ok(a && b, "Run npm run seed first.");
  const key = crypto.randomUUID();
  const first = await quote([a.id, b.id], "money", key);
  assert.equal(first.status, 201);
  const second = await quote([a.id, b.id], "money", key);
  assert.equal(first.body.task.id, second.body.task.id);
  assert.equal((await quote([a.id, b.id], "different", key)).status, 409);
  assert.equal((await json(`/api/tasks/${first.body.task.id}`)).status, 403);
  assert.equal((await quote([b.id, a.id], [1, 2])).status, 400);
  const result = await finish(first.body.task, first.body.access_token);
  assert.equal(result.output, 72);
  assert.equal(result.status, "released");
  assert.equal(result.payment_transaction, null);
  assert.deepEqual(
    result.legs.map((l) => l.output),
    [[13, 15, 14, 5, 25], 72],
  );
  assert.deepEqual(
    [...new Set(result.events.map((e) => e.status))],
    ["created", "paid", "in_progress", "completed", "released"],
  );
  assert.equal(result.events.filter((e) => e.status === "paid").length, 1);
  const free = await fetch(`${base}/agents/letters`, post({ input: "money" }));
  assert.deepEqual(
    ((await free.json()) as { output: unknown }).output,
    [13, 15, 14, 5, 25],
  );
  let broken = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET") {
      response.end(
        JSON.stringify({
          protocol: "relay-agent-v1",
          input_type: "string",
          output_type: "number",
          sample_input: "one two",
          wallet_address: a.wallet_address,
          price_usdc: 0.001,
        }),
      );
      return;
    }
    let content = "";
    for await (const chunk of request) content += chunk;
    response.end(
      JSON.stringify({
        output: broken ? null : JSON.parse(content).input.split(/\s+/).length,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const listing = await json(
      "/api/agents",
      post({
        name: "Integration Word Counter",
        skill: "word-count",
        endpoint_url: `http://127.0.0.1:${address.port}/task`,
        wallet_address: a.wallet_address,
        price_usdc: 0.001,
      }),
    );
    assert.equal(listing.status, 201, JSON.stringify(listing.body));
    const third = await quote([listing.body.agent.id], "one two three");
    const counted = await finish(third.body.task, third.body.access_token);
    assert.equal(counted.output, 3);
    broken = true;
    const invalid = await quote([listing.body.agent.id], "one two three");
    const failed = await finish(invalid.body.task, invalid.body.access_token);
    assert.equal(failed.status, "refunded");
    assert.equal(failed.output, null);
    assert.match(failed.error!, /invalid output shape/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "relay-marketplace",
        "--local",
        "--command",
        "UPDATE agents SET status='disabled' WHERE name='Integration Word Counter';",
      ],
      { stdio: "pipe" },
    );
  }
});
