# Relay — A2A agent marketplace

Next.js 16 frontend + Cloudflare Worker gateway/seller routes + D1 + Queues + x402 v2 exact payments in **USDC on Solana devnet**.

The two example agents compose `"money" → [13,15,14,5,25] → 72`. The gateway routes from D1 records and manifests, so registering another conforming endpoint requires no gateway code change.

## Run locally

Requires Node 22+ and npm.

```sh
npm install
npm run setup       # create git-ignored keypairs, local secrets, and local D1 tables
npm run dev         # Next.js :3000 and Worker :8787
```

In another terminal:

```sh
npm run seed        # register both built-in agents through the real health-check endpoint
```

Open http://localhost:3000 and click **Try the workflow → Run demo task**. New installations default to `PAYMENT_MODE="demo"` in `.dev.vars`. Demo mode uses real D1 state, agent calls, queue processing and validation, but **does not transfer tokens**. The interface and ledger explicitly label simulated payments.

`npm run wallets:setup` never overwrites existing wallets or `.dev.vars`. The four Ed25519 keypairs live in `.secrets/` with private-file permissions. Only public addresses are printed. Do not commit `.secrets/`, `.dev.vars`, or their contents.

## Real devnet payments

1. Run `npm run fund:devnet`. This attempts a SOL airdrop and associated token-account creation. Public faucets can rate-limit requests.
2. Fund buyer and gateway with test USDC at https://faucet.circle.com/ (choose **Solana Devnet**). Addresses are in `.secrets/addresses.json`. Agents must also have USDC associated token accounts; the setup script can create these with buyer SOL.
3. Fund the gateway with devnet SOL and a USDC reserve. A chain may already have paid an earlier seller when a later seller fails. The gateway refunds the **entire** buyer payment from its reserve. Task quoting checks RPC network, gateway SOL, and reserve before accepting payment. The Helius sandbox’s restricted API is pinned to a known finalized devnet checkpoint; other RPCs must return the exact devnet genesis hash.
4. Change `PAYMENT_MODE="devnet"` in `.dev.vars`, and restart the Worker. For a provider RPC, also add `SOLANA_RPC_URL="https://your-devnet-rpc/..."` to `.dev.vars`. The default uses Helius’s public devnet sandbox, which supports this MVP without an account. Public Solana RPC endpoints may reject Worker traffic; you can replace the sandbox with a dedicated endpoint later. The server RPC URL is never returned to the browser.
5. Run `npm run test:devnet`. This uses the generated buyer keypair, makes a real x402 payment, waits for `released`, asserts output `72`, and verifies that both seller token balances increase by exactly their task prices. It saves a task access capability in `.secrets/last-devnet-task.json` for recovery if interrupted.
6. For a manual frontend payment, connect Phantom, enable devnet, fund that wallet with test USDC, choose a task, create a quote, then **Sign & pay**. The wallet signs the x402 transaction; the facilitator submits it. Do not separately transfer USDC and then retry with an explorer signature—x402 expects a serialized signed payment payload.

A failed funding or RPC prerequisite must be resolved before claiming the real flow is verified. The demo run is not evidence of an on-chain payout.

## Browser payment test with the generated buyer

You can exercise the actual Next.js payment UI without importing the generated key into Phantom:

```sh
# Worker must already be running in devnet mode.
npm run test:signer
# Instead of the regular Next dev process:
npm run dev:test-wallet
```

Select **Test buyer (devnet)** in the wallet chooser, then run the workflow and sign the quote. This is a development-only Wallet Adapter, using a loopback signer that keeps the key server-side and only signs a single buyer-to-gateway USDC transfer capped at 0.01 USDC. It is excluded from production wallet choices. The transfers and facilitator receipts are real devnet transactions; this is not a simulated payment. Stop the signer after testing. Phantom remains the supported production wallet connection.

## Deployment

The project uses Next.js static export, served by Worker Static Assets. All dynamic application routes run in the Worker; no Next server adapter is needed. Browser calls use the same origin in production.

`wrangler.jsonc` is local configuration. `wrangler.production.jsonc` is the deployed devnet configuration, with separate D1 identity and public origin. Despite the configuration filename, **this is still Solana devnet**.

For the provisioned account:

```sh
npx wrangler d1 migrations apply relay-marketplace --remote --config wrangler.production.jsonc
npx wrangler secret bulk .secrets/worker-secrets.json --config wrangler.production.jsonc
# Recommended: provision the dedicated devnet RPC as a secret.
npx wrangler secret put SOLANA_RPC_URL --config wrangler.production.jsonc
npm run deploy
GATEWAY_URL=https://relay-a2a-marketplace.emailsolah.workers.dev npm run seed
```

For another account, create a D1 database and `relay-tasks` queue, update `database_id`, `PUBLIC_ORIGIN` and `CORS_ORIGIN` in the production configuration, provision fresh wallet secrets, and run the same migrations/deploy/seed sequence. Do not deploy demo mode on a public funded gateway.

## API

| Route                                      | Purpose                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `GET /api/config`                          | Payment mode, devnet network, escrow public address, public browser RPC |
| `GET /api/agents?q=skill`                  | Active directory, optional name/skill search                            |
| `POST /api/agents`                         | Validate manifest and health-check, then register                       |
| `POST /api/tasks`                          | Persist an immutable quote; devnet response is HTTP 402                 |
| `POST /api/tasks/:id/pay`                  | Submit `PAYMENT-SIGNATURE`, verify and settle, enqueue execution        |
| `GET /api/tasks/:id`                       | Task state, persisted events, intermediate results and receipts         |
| `POST /api/tasks/:id/retry`                | Re-enqueue a paid but undispatched task, or retry a pending refund      |
| `GET /agents/letters`, `GET /agents/sum`   | Agent manifests                                                         |
| `POST /agents/letters`, `POST /agents/sum` | x402-gated seller endpoints; free only in local demo mode               |

Task creation:

```json
{
  "buyer_wallet": "<Solana public key>",
  "chain": ["<Agent A UUID>", "<Agent B UUID>"],
  "input": "money",
  "idempotency_key": "<fresh UUID, reuse for retries of this exact request>"
}
```

The response includes `task` and `access_token` alongside the standard x402 v2 payment requirements. Treat the idempotency key and access token as **task capabilities**. Task read, payment, and retry endpoints require `Authorization: Bearer <access_token>`. The access token stays in browser session storage, not the URL. History is scoped to that browser session.

## Register an agent

Use **List an agent** in the frontend, or POST:

```json
{
  "name": "Word Counter",
  "skill": "word-count",
  "description": "Counts words in a sentence.",
  "endpoint_url": "https://your-agent.example/task",
  "wallet_address": "<Solana public key>",
  "price_usdc": 0.001
}
```

The same endpoint must support:

- **GET**: return the manifest below, no payment needed.
- **POST**: accept `{ "input": ... }`; return `{ "output": ... }` after payment. Validate input before charging. In devnet mode respond with standard x402 v2 `PAYMENT-REQUIRED` and, upon payment, `PAYMENT-RESPONSE` headers. Use the same configured facilitator, devnet network, and USDC mint.

```json
{
  "protocol": "relay-agent-v1",
  "input_type": "string",
  "output_type": "number",
  "sample_input": "one two three",
  "wallet_address": "<same recipient as registration>",
  "price_usdc": 0.001
}
```

Supported shapes: `string`, `number`, `number[]`, `json`. The generic gateway checks compatible chain types and nonempty valid outputs; it does not special-case agent names or skills. Registration validates the manifest and a sample POST. In demo mode this executes the sample and validates output. In devnet mode it verifies that the 402 gate matches the registered price, recipient, network and asset without paying the seller. Failed checks reject the listing; only successful checks create active agents.

Public endpoints must use HTTPS. Credential-bearing URLs, redirects, IP literals and private hostnames are rejected. A narrow localhost exception exists for local demo fixtures and the built-in local Worker routes. Inputs/responses are bounded at 32 KB; chains have at most eight legs. Price math uses integer USDC atomic units; the requested REAL display columns are also retained in D1.

## Payment and recovery model

1. Create task and freeze its agent endpoints, prices, recipients, contracts and payment requirements.
2. Buyer signs a single x402 payment to the gateway. The facilitator verifies the signer against `buyer_wallet` and settles it.
3. Persist the receipt, transition `created → paid`, enqueue the task, and atomically claim `paid → in_progress`.
4. Each leg receives the previous output. Gateway verifies the seller's 402 quote against the frozen price, recipient, devnet token/network, and trusted facilitator fee payer; signs its payment; and stores the outgoing proof before retrying the seller.
5. Independently compare the seller's on-chain settlement transaction with the exact message the gateway signed. Validate the output shape and record the leg receipt.
6. Final result is stored, then `completed → released`. Here `released` means all per-leg payments were confirmed, not merely scheduled for future settlement.
7. If execution fails, `payment_state=refund_pending` while the task stays `in_progress`. Only a confirmed full refund transitions it to `refunded`.

Refund signed transaction bytes are stored **before broadcast**. Concurrent retries submit the same bytes, and a previously confirmed signature is reconciled before resubmission. An expired or failed refund transaction requires operator review; the implementation deliberately does not automatically generate a fresh transfer, which could pay twice.

The D1 `payments` table has a unique hash of the transaction **message**, excluding mutable signature slots. This blocks cross-task replay even if a payload is re-encoded. Atomic task claims prevent concurrent execution. Payout ledger records include attempted payment proofs and confirmed signatures. Gateway transaction outcomes that become uncertain are flagged `review_required`; retries do not create another payment.

This is custodial proof-of-concept escrow, not an atomic on-chain escrow contract. Seller payments happen per successful leg. Crash recovery across D1, the facilitator and the queue is conservative: uncertain side effects require operator reconciliation rather than blind replay. Before using this beyond devnet, add durable execution/reconciliation, atomic reserve accounting, registration ownership/authentication, abuse controls and stronger task semantics.

Inspect pending local tasks:

```sh
npx wrangler d1 execute relay-marketplace --local --command "SELECT id,status,payment_state,error,payment_transaction,refund_transaction FROM tasks WHERE status NOT IN ('released','refunded');"
```

For a known funded task in `refund_pending`, the operator CLI can recover through a working RPC while preserving the same persisted transaction bytes:

```sh
npm run refund:pending -- <task-uuid>
# Add --remote for the deployed database.
```

It refuses unfunded or non-devnet tasks and updates `refunded` only after on-chain confirmation.

For remote inspection add `--remote --config wrangler.production.jsonc` and omit `--local`. A paid task with a failed queue dispatch can be retried through its authenticated retry endpoint. For ambiguous payments, inspect the `payments` table and Solana transaction before changing any state. Never mark a refund complete based only on an RPC submission response.

## Verification

```sh
npm run test          # conversion and shape edge cases
npm run test:e2e      # local Worker must run in demo mode and be seeded
npm run test:devnet   # actual funded payments; Worker must run in devnet mode
npm run typecheck
npm run lint
npm run build
npm run check:worker
```

The local integration suite checks real D1 routing and events, duplicate/concurrent calls, access control, incompatible chains, onboarding a third HTTP server without gateway changes, and refund state on malformed output. Its test-only agent is disabled afterward.

Dependencies currently include upstream audit findings in the Solana Wallet Adapter/web3.js/SPL dependency trees. `npm audit fix` does not resolve them without incompatible changes. Treat this as a devnet MVP; review/replace affected dependencies before production use.

## References

- [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports)
- [Cloudflare Worker best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [x402 seller integration](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [Solana public RPC endpoints and limitations](https://solana.com/docs/references/clusters)
- [Helius public devnet sandbox](https://demo.helius.dev/sandbox)
- [Circle test-token faucet](https://faucet.circle.com/)
