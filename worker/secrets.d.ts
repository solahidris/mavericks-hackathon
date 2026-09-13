// Secret bindings are provisioned by scripts/setup-wallets.ts and wrangler secret bulk.
interface Env {
  GATEWAY_PRIVATE_KEY: string;
  AGENT_A_PRIVATE_KEY: string;
  AGENT_B_PRIVATE_KEY: string;
}
