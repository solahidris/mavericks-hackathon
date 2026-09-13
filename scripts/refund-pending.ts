import { execFileSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { submitRefund } from "../worker/refunds";
import type { TaskRow } from "../worker/tasks";
const id = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(id || ""))
  throw new Error("Usage: npm run refund:pending -- <task UUID> [--remote]");
const remote = process.argv.includes("--remote");
const flags = remote
  ? ["--remote", "--config", "wrangler.production.jsonc"]
  : ["--local"];
const sqlValue = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function query<T>(sql: string): Promise<T[]> {
  const path = `.secrets/reconcile-${crypto.randomUUID()}.sql`;
  await writeFile(path, sql, { mode: 0o600 });
  try {
    const output = execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "relay-marketplace",
        ...flags,
        "--file",
        path,
        "--json",
      ],
      { encoding: "utf8" },
    );
    return (JSON.parse(output) as { results: T[] }[]).flatMap(
      (item) => item.results,
    );
  } finally {
    await unlink(path);
  }
}
const task = (
  await query<TaskRow>(`SELECT * FROM tasks WHERE id=${sqlValue(id)};`)
)[0];
if (
  !task ||
  task.payment_mode !== "devnet" ||
  task.payment_state !== "refund_pending" ||
  task.status !== "in_progress" ||
  !task.payment_transaction
)
  throw new Error("Task must be a funded devnet task awaiting a refund.");
const signature = await submitRefund(
  {
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    secret: await readFile(".secrets/gateway.json", "utf8"),
    async saveRaw(raw) {
      await query(
        `UPDATE tasks SET refund_raw=${sqlValue(raw)} WHERE id=${sqlValue(id)} AND refund_raw IS NULL;`,
      );
      return (
        await query<{ refund_raw: string }>(
          `SELECT refund_raw FROM tasks WHERE id=${sqlValue(id)};`,
        )
      )[0].refund_raw;
    },
    async saveSignature(sig) {
      await query(
        `UPDATE tasks SET refund_transaction=${sqlValue(sig)} WHERE id=${sqlValue(id)};`,
      );
    },
  },
  task,
);
const date = new Date().toISOString();
await query(
  `UPDATE tasks SET status='refunded',payment_state='refunded',updated_at=${sqlValue(date)} WHERE id=${sqlValue(id)} AND status='in_progress'; INSERT INTO task_events(task_id,status,message,created_at) SELECT ${sqlValue(id)},'refunded','Full buyer refund confirmed by operator recovery.',${sqlValue(date)} WHERE changes()=1;`,
);
console.log(
  `Full refund confirmed: https://explorer.solana.com/tx/${signature}?cluster=devnet`,
);
