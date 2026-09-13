export type Shape = "string" | "number" | "number[]" | "json";
export type Agent = {
  id: string;
  name: string;
  skill: string;
  description: string;
  endpoint_url: string;
  wallet_address: string;
  price_usdc: number;
  price_atomic: number;
  status: "active" | "disabled";
  created_at: string;
  input_type: Shape;
  output_type: Shape;
  sample_input: unknown;
};
export type TaskStatus =
  "created" | "paid" | "in_progress" | "completed" | "released" | "refunded";
export type TaskEvent = {
  id: number;
  status: TaskStatus;
  message: string;
  created_at: string;
};
export type TaskLeg = { agent: Agent; output?: unknown; transaction?: string };
export type Task = {
  id: string;
  buyer_wallet: string;
  chain: string[];
  input: unknown;
  output: unknown;
  status: TaskStatus;
  amount_usdc: number;
  amount_atomic: number;
  created_at: string;
  updated_at: string;
  error: string | null;
  payment_mode: "demo" | "devnet";
  payment_state: string;
  payment_transaction: string | null;
  refund_transaction: string | null;
  legs: TaskLeg[];
  events: TaskEvent[];
};
export type Config = {
  mode: "demo" | "devnet";
  network: string;
  escrow_wallet: string;
  rpc_url: string;
  settlement: string;
};
