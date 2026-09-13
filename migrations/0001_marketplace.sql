PRAGMA foreign_keys = ON;
CREATE TABLE agents (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, skill TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 endpoint_url TEXT NOT NULL UNIQUE, wallet_address TEXT NOT NULL,
 price_usdc REAL NOT NULL CHECK(price_usdc > 0), price_atomic INTEGER NOT NULL CHECK(price_atomic > 0),
 status TEXT NOT NULL CHECK(status IN ('active','disabled')),
 input_type TEXT NOT NULL, output_type TEXT NOT NULL, sample_input TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX agents_skill ON agents(skill, status);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, buyer_wallet TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), chain TEXT NOT NULL,
 input TEXT NOT NULL, output TEXT, status TEXT NOT NULL CHECK(status IN ('created','paid','in_progress','completed','released','refunded')),
 amount_usdc REAL NOT NULL, amount_atomic INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 legs TEXT NOT NULL, error TEXT, payment_mode TEXT NOT NULL, payment_state TEXT NOT NULL DEFAULT 'unpaid',
 payment_transaction TEXT UNIQUE, refund_transaction TEXT, refund_raw TEXT, requirements TEXT,
 access_token TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL
);
CREATE TABLE task_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL,
 message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events(task_id, id);
CREATE TABLE payments (
 proof_hash TEXT PRIMARY KEY, resource_id TEXT NOT NULL, state TEXT NOT NULL,
 transaction_id TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE payout_ledger (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), leg_index INTEGER NOT NULL,
 agent_id TEXT NOT NULL REFERENCES agents(id), wallet_address TEXT NOT NULL,
 amount_atomic INTEGER NOT NULL, status TEXT NOT NULL, transaction_id TEXT,
 created_at TEXT NOT NULL, UNIQUE(task_id, leg_index)
);
