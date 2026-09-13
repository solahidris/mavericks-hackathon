"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { PaymentRequired } from "@x402/core/types";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  ExternalLink,
  GitBranch,
  Globe2,
  LayoutGrid,
  LoaderCircle,
  Plus,
  Radio,
  Search,
  ShieldCheck,
  Terminal,
  Wallet,
  X,
} from "lucide-react";
import type { Agent, Config, Task, TaskStatus } from "../lib/types";
import { signPayment } from "../lib/browser-payment";
const API =
  process.env.NEXT_PUBLIC_GATEWAY_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8787" : "");
const money = (n: number) =>
  n.toLocaleString("en-US", {
    maximumFractionDigits: 6,
    minimumFractionDigits: 3,
  });
type SavedTask = { id: string; token: string };
type Page = "directory" | "workflows" | "activity" | "docs";
const stages: TaskStatus[] = [
  "created",
  "paid",
  "in_progress",
  "completed",
  "released",
];
const stageLabel: Record<TaskStatus, string> = {
  created: "Task created",
  paid: "Payment confirmed",
  in_progress: "Agents working",
  completed: "Output validated",
  released: "Payments released",
  refunded: "Buyer refunded",
};
type ApiResponse = PaymentRequired & {
  task: Task;
  access_token: string;
  agents: Agent[];
  error?: string;
};
async function readResponse<T = ApiResponse>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok && response.status !== 402)
    throw new Error(body.error || `Gateway returned ${response.status}.`);
  return body;
}
function AgentIcon({ kind, small = false }: { kind: string; small?: boolean }) {
  return (
    <span
      className={`agent-icon ${kind === "letter-to-numbers" ? "letters" : "numbers"} ${small ? "small" : ""}`}
    >
      {kind === "letter-to-numbers" ? (
        <span>
          A<span className="icon-sub">1</span>
        </span>
      ) : (
        <span>∑</span>
      )}
    </span>
  );
}
function RelayLogo() {
  return (
    <span className="relay-mark" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
function TxLink({ signature }: { signature?: string | null }) {
  return signature ? (
    <a
      className="transaction-link"
      href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
      target="_blank"
      rel="noreferrer"
    >
      View transaction <ArrowUpRight size={13} />
    </a>
  ) : null;
}
export default function Marketplace() {
  const wallet = useWallet();
  const [page, setPage] = useState<Page>("directory");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [config, setConfig] = useState<Config>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All agents");
  const [selected, setSelected] = useState<Agent[]>([]);
  const [input, setInput] = useState("money");
  const [task, setTask] = useState<Task>();
  const [access, setAccess] = useState("");
  const [quote, setQuote] = useState<PaymentRequired>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Task[]>([]);
  const historyCache = useRef(new Map<string, Task>());
  const [saved, setSaved] = useState<SavedTask[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("relay-tasks") || "[]");
    } catch {
      return [];
    }
  });
  const [registering, setRegistering] = useState(false);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const registrationDialog = useRef<HTMLDialogElement>(null);
  const idempotency = useRef(crypto.randomUUID());
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [directory, settings] = await Promise.all([
        fetch(`${API}/api/agents`).then(readResponse),
        fetch(`${API}/api/config`).then(readResponse<Config>),
      ]);
      setAgents(directory.agents);
      setConfig(settings);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    if (!saved.length) return;
    let cancelled = false;
    async function update() {
      const entries = await Promise.allSettled(
        saved.map(async (item) => {
          const cached = historyCache.current.get(item.id);
          if (cached && ["released", "refunded"].includes(cached.status))
            return { task: cached };
          const result = await fetch(`${API}/api/tasks/${item.id}`, {
            headers: { Authorization: `Bearer ${item.token}` },
          }).then(readResponse);
          historyCache.current.set(item.id, result.task);
          return result;
        }),
      );
      if (!cancelled)
        setHistory(
          entries.flatMap((result) =>
            result.status === "fulfilled" ? [result.value.task as Task] : [],
          ),
        );
    }
    void update();
    const timer = setInterval(update, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [saved]);
  const taskId = task?.id;
  const taskStatus = task?.status;
  useEffect(() => {
    if (
      !taskId ||
      !access ||
      ["released", "refunded"].includes(taskStatus || "")
    )
      return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const result = await fetch(`${API}/api/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${access}` },
        }).then(readResponse);
        if (!cancelled) setTask(result.task);
      } catch (e) {
        if (!cancelled)
          setError(`Status connection interrupted: ${(e as Error).message}`);
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, taskStatus, access]); // Poll persistent server state; the UI never invents progress.
  const chain = [
    agents.find((a) => a.skill === "letter-to-numbers"),
    agents.find((a) => a.skill === "sum-numbers"),
  ].filter((a): a is Agent => !!a);
  const demo = config?.mode === "demo";
  const taskDemo = task ? task.payment_mode === "demo" : demo;
  const visible = agents.filter(
    (agent) =>
      (!search ||
        `${agent.name} ${agent.skill} ${agent.description}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (filter === "All agents" || agent.input_type === filter),
  );
  function openTask(selection: Agent[]) {
    setSelected(selection);
    setInput(
      typeof selection[0]?.sample_input === "string"
        ? selection[0].sample_input
        : JSON.stringify(selection[0]?.sample_input ?? ""),
    );
    setTask(undefined);
    setAccess("");
    setQuote(undefined);
    setError("");
    idempotency.current = crypto.randomUUID();
    dialog.current?.showModal();
  }
  function remember(id: string, token: string) {
    setSaved((current) => {
      const next = [{ id, token }, ...current.filter((t) => t.id !== id)].slice(
        0,
        20,
      );
      sessionStorage.setItem("relay-tasks", JSON.stringify(next));
      return next;
    });
  }
  async function pay(
    current: Task,
    token: string,
    paymentQuote?: PaymentRequired,
  ) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (!demo) {
      if (!config || !paymentQuote)
        throw new Error("Payment quote is unavailable.");
      if (wallet.publicKey?.toBase58() !== current.buyer_wallet)
        throw new Error("Reconnect the wallet that created this task.");
      const req = paymentQuote.accepts[0];
      if (
        req.payTo !== config.escrow_wallet ||
        req.amount !== String(current.amount_atomic) ||
        req.asset !== "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
      )
        throw new Error("Gateway quote does not match this task.");
      headers["PAYMENT-SIGNATURE"] = await signPayment(
        wallet,
        paymentQuote,
        config.rpc_url,
      );
    }
    const response = await fetch(`${API}/api/tasks/${current.id}/pay`, {
      method: "POST",
      headers,
    });
    const result = await readResponse(response);
    if (response.status === 402)
      throw new Error(result.error || "Payment was not accepted.");
    setTask(result.task);
  }
  async function submit() {
    setError("");
    setBusy(true);
    try {
      if (task) {
        await pay(task, access, quote);
        return;
      }
      const parsed =
        selected[0].input_type === "string" ? input.trim() : JSON.parse(input);
      if (!demo && !wallet.publicKey)
        throw new Error("Connect your Phantom wallet to create a paid task.");
      const response = await fetch(`${API}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain: selected.map((a) => a.id),
          input: parsed,
          buyer_wallet: wallet.publicKey?.toBase58() || "demo-buyer",
          idempotency_key: idempotency.current,
        }),
      });
      const data = await readResponse(response);
      setTask(data.task);
      setAccess(data.access_token);
      setQuote(data.accepts ? data : undefined);
      remember(data.task.id, data.access_token);
      if (demo) await pay(data.task, data.access_token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError("");
    try {
      await fetch(`${API}/api/tasks/${task!.id}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}` },
      }).then(readResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(item: Task) {
    setTask(item);
    setAccess(saved.find((s) => s.id === item.id)?.token || "");
    setSelected(item.legs.map((l) => l.agent));
    setInput(
      typeof item.input === "string" ? item.input : JSON.stringify(item.input),
    );
    setError("");
    setQuote(undefined);
    dialog.current?.showModal();
    if (item.status === "created" && config?.mode === "devnet") {
      try {
        const res = await fetch(`${API}/api/tasks/${item.id}/pay`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${saved.find((s) => s.id === item.id)?.token}`,
          },
        });
        if (res.status === 402) setQuote((await res.json()) as PaymentRequired);
      } catch {
        setError("Could not restore the payment quote.");
      }
    }
  }
  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await fetch(`${API}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      }).then(readResponse);
      registrationDialog.current?.close();
      setRegistering(false);
      setNotice("Agent verified and listed. It is ready to receive tasks.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openRegistration() {
    setRegistering(true);
    setError("");
    registrationDialog.current?.showModal();
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Relay home">
          <RelayLogo />
          relay<span className="brand-beta">BETA</span>
        </Link>
        <div className="workspace-label">
          WORKSPACE <span>01</span>
        </div>
        <nav aria-label="Main navigation">
          {(
            [
              { id: "directory", label: "Agent directory", icon: LayoutGrid },
              { id: "workflows", label: "Workflows", icon: GitBranch },
              { id: "activity", label: "Task activity", icon: Radio },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              aria-current={page === item.id ? "page" : undefined}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "directory" && (
                <span className="nav-count">{agents.length}</span>
              )}
              {item.id === "activity" && history.length > 0 && (
                <span className="nav-count">{history.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="seller-prompt">
            <span className="prompt-icon">
              <Blocks size={18} />
            </span>
            <h3>Built an agent?</h3>
            <p>Give your capabilities a place to work.</p>
            <button onClick={openRegistration}>
              List your agent <ArrowUpRight size={16} />
            </button>
          </div>
          <button
            className={`nav-item ${page === "docs" ? "active" : ""}`}
            onClick={() => setPage("docs")}
          >
            <BookOpen size={18} />
            Developer guide
            <ArrowUpRight className="nav-end" size={15} />
          </button>
          <div className="sidebar-footer">
            <span className="status-dot" />
            Solana devnet<span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {
                {
                  directory: "Agent directory",
                  workflows: "Workflows",
                  activity: "Task activity",
                  docs: "Developer guide",
                }[page]
              }
            </strong>
          </div>
          <div className="top-actions">
            <span className="network-pill">
              <span className="status-dot" />
              Devnet
            </span>
            <WalletMultiButton />
          </div>
        </header>
        <main>
          {notice && (
            <div className="notice" role="status">
              <Check size={16} />
              {notice}
              <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
                <X size={16} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div className="eyebrow">
              <span />
              THE AGENT ECONOMY, CONNECTED
            </div>
            <div className="heading-row">
              <div>
                <h1>
                  {
                    {
                      directory: "Good agents. Great together.",
                      workflows: "One task. Multiple agents.",
                      activity: "Every task, accounted for.",
                      docs: "Build once. Connect to Relay.",
                    }[page]
                  }
                </h1>
                <p>
                  {
                    {
                      directory:
                        "Discover specialized agents. Connect their skills. Pay only for the work.",
                      workflows:
                        "Pass work between agents with one request and one buyer payment.",
                      activity:
                        "Follow execution, inspect results, and trace each payment.",
                      docs: "A small HTTP contract is all your agent needs to join the marketplace.",
                    }[page]
                  }
                </p>
              </div>
              {page !== "activity" && (
                <button className="button secondary" onClick={openRegistration}>
                  <Plus size={17} />
                  List an agent
                </button>
              )}
            </div>
          </div>
          <div className="environment-note">
            <ShieldCheck size={15} />
            <span>
              {demo
                ? "Local demo mode. Tasks use real agent endpoints; payments are simulated."
                : "Devnet sandbox. Payments use test USDC on Solana."}
            </span>
            <span className="note-right">
              Powered by x402 <ArrowUpRight size={13} />
            </span>
          </div>
          {loadError && (
            <div className="error-box" role="alert">
              <strong>Couldn’t connect to the gateway</strong>
              <span>{loadError}</span>
              <button className="button secondary" onClick={refresh}>
                Try again
              </button>
            </div>
          )}
          {(page === "directory" || page === "workflows") && (
            <>
              <section
                className="featured-workflow"
                aria-labelledby="workflow-heading"
              >
                <div className="workflow-copy">
                  <div className="feature-tag">
                    <GitBranch size={13} />
                    FEATURED WORKFLOW
                  </div>
                  <h2 id="workflow-heading">
                    A little teamwork. <br />A whole new capability.
                  </h2>
                  <p>
                    Turn a word into a number. Two specialized agents,
                    <br className="desktop-break" /> one seamless workflow.
                  </p>
                  <button
                    className="button mint"
                    disabled={chain.length !== 2 || loading}
                    onClick={() => openTask(chain)}
                  >
                    Try the workflow <ArrowRight size={16} />
                  </button>
                  <span className="workflow-price">
                    {chain.length === 2
                      ? `${money(chain.reduce((s, a) => s + a.price_usdc, 0))} USDC / run`
                      : "Waiting for demo agents"}
                  </span>
                </div>
                <div
                  className="workflow-visual"
                  aria-label="Example: money passes through Letter to Numbers, then Sum the Numbers, producing 72"
                >
                  <div className="diagram-top">
                    <span className="diagram-input">“money”</span>
                    <span className="diagram-line" />
                    <div className="diagram-node">
                      <AgentIcon kind="letter-to-numbers" />
                      <span>Letter to Numbers</span>
                      <small>AGENT A</small>
                    </div>
                    <span className="diagram-line">
                      <ArrowRight size={14} />
                    </span>
                    <div className="diagram-node">
                      <AgentIcon kind="sum-numbers" />
                      <span>Sum the Numbers</span>
                      <small>AGENT B</small>
                    </div>
                    <span className="diagram-line" />
                    <span className="diagram-result">
                      72
                      <Check size={12} />
                    </span>
                  </div>
                  <div className="diagram-caption">
                    <span>[13, 15, 14, 5, 25]</span>
                    <div>
                      <ShieldCheck size={13} />
                      One payment. Every step verified.
                    </div>
                  </div>
                </div>
              </section>
              {page === "directory" && (
                <section className="directory-section">
                  <div className="section-heading">
                    <h2>
                      Explore agents <span>{agents.length}</span>
                    </h2>
                    <span className="verified-label">
                      <span className="status-dot" />
                      Health-checked endpoints
                    </span>
                  </div>
                  <div className="directory-tools">
                    <div
                      className="filter-tabs"
                      aria-label="Filter by input type"
                    >
                      {["All agents", "string", "number[]"].map((f) => (
                        <button
                          aria-pressed={filter === f}
                          className={filter === f ? "selected" : ""}
                          key={f}
                          onClick={() => setFilter(f)}
                        >
                          {f === "string"
                            ? "Text processing"
                            : f === "number[]"
                              ? "Computation"
                              : f}
                        </button>
                      ))}
                    </div>
                    <label className="search">
                      <Search size={16} />
                      <input
                        aria-label="Search agents"
                        placeholder="Search agents or skills…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {search && (
                        <button
                          onClick={() => setSearch("")}
                          aria-label="Clear search"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>
                  </div>
                  <div className="agent-grid">
                    {loading
                      ? [1, 2].map((n) => (
                          <div key={n} className="agent-card skeleton">
                            <span />
                            <span />
                            <span />
                          </div>
                        ))
                      : visible.map((agent) => (
                          <article className="agent-card" key={agent.id}>
                            <div className="agent-card-top">
                              <AgentIcon kind={agent.skill} />
                              <span className="live-tag">
                                <span className="status-dot" />
                                Live
                              </span>
                            </div>
                            <h3>{agent.name}</h3>
                            <span className="skill-tag">{agent.skill}</span>
                            <p>
                              {agent.description ||
                                `A specialized ${agent.skill} agent, available through the Relay gateway.`}
                            </p>
                            <div className="type-flow">
                              <code>{agent.input_type}</code>
                              <ArrowRight size={13} />
                              <code>{agent.output_type}</code>
                            </div>
                            <div className="agent-card-bottom">
                              <div>
                                <strong>
                                  {money(agent.price_usdc)} <span>USDC</span>
                                </strong>
                                <small>per task</small>
                              </div>
                              <button
                                className="use-agent"
                                onClick={() => openTask([agent])}
                              >
                                Use agent <ArrowUpRight size={16} />
                              </button>
                            </div>
                          </article>
                        ))}
                    <button
                      className="register-card"
                      onClick={openRegistration}
                    >
                      <span className="register-icon">
                        <Plus size={22} />
                      </span>
                      <h3>Your agent belongs here.</h3>
                      <p>
                        Publish a skill. Set your price.
                        <br />
                        Let other agents put it to work.
                      </p>
                      <span>
                        List your agent <ArrowRight size={15} />
                      </span>
                    </button>
                  </div>
                  {!loading && !visible.length && (
                    <div className="empty-state">
                      <Search size={24} />
                      <h3>
                        {agents.length
                          ? "No agents match your search"
                          : "Your marketplace starts here"}
                      </h3>
                      <p>
                        {agents.length
                          ? "Try another skill or clear your filters."
                          : "Register an endpoint, or run npm run seed to add the two demo agents."}
                      </p>
                      <button
                        className="button secondary"
                        onClick={() => {
                          setSearch("");
                          setFilter("All agents");
                          if (!agents.length) openRegistration();
                        }}
                      >
                        {agents.length ? "Clear filters" : "Register an agent"}
                      </button>
                    </div>
                  )}
                </section>
              )}
              {page === "workflows" && (
                <section className="custom-chain">
                  <div>
                    <h2>Compose your own workflow</h2>
                    <p>
                      Choose an ordered sequence. The gateway checks
                      compatibility before asking for payment.
                    </p>
                  </div>
                  <ChainBuilder agents={agents} onRun={openTask} />
                </section>
              )}
              <section className="how-it-works">
                <div className="how-title">
                  <span className="eyebrow">
                    SMALL TASKS. BIG POSSIBILITIES.
                  </span>
                  <h2>From capability to completion.</h2>
                  <button onClick={() => setPage("docs")}>
                    How Relay works <ArrowRight size={15} />
                  </button>
                </div>
                <div className="how-step">
                  <span className="step-number">01</span>
                  <Search size={20} />
                  <h3>Find a skill</h3>
                  <p>
                    Pick an agent or connect a few
                    <br />
                    to build something bigger.
                  </p>
                </div>
                <div className="how-step">
                  <span className="step-number">02</span>
                  <Wallet size={20} />
                  <h3>Pay once</h3>
                  <p>
                    Authorize a USDC payment.
                    <br />
                    The gateway handles the rest.
                  </p>
                </div>
                <div className="how-step">
                  <span className="step-number">03</span>
                  <CheckCheck size={20} />
                  <h3>Get your result</h3>
                  <p>
                    Watch your task progress,
                    <br />
                    with payments you can trace.
                  </p>
                </div>
              </section>
            </>
          )}
          {page === "activity" && (
            <section className="activity-section">
              <div className="section-heading">
                <h2>
                  Recent tasks <span>{history.length}</span>
                </h2>
                <span className="muted">This browser session</span>
              </div>
              {!history.length ? (
                <div className="empty-state">
                  <Radio size={32} />
                  <h3>Ready when you are.</h3>
                  <p>Your tasks and payment receipts will appear here.</p>
                  <button
                    className="button primary"
                    onClick={() => setPage("directory")}
                  >
                    Explore agents <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <div className="task-list">
                  {history.map((item) => (
                    <button
                      className="task-row"
                      key={item.id}
                      onClick={() => void inspect(item)}
                    >
                      <span className="task-row-icon">
                        {item.chain.length > 1 ? (
                          <GitBranch size={19} />
                        ) : (
                          <Terminal size={19} />
                        )}
                      </span>
                      <div>
                        <strong>
                          {item.legs.map((l) => l.agent.name).join(" → ")}
                        </strong>
                        <small>
                          {item.id.slice(0, 8)} ·{" "}
                          {new Date(item.created_at).toLocaleTimeString()}
                        </small>
                      </div>
                      <span className={`task-status ${item.status}`}>
                        {item.status.replace("_", " ")}
                      </span>
                      <strong className="task-cost">
                        {money(item.amount_usdc)} USDC
                      </strong>
                      <ChevronRight size={17} />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {page === "docs" && (
            <section className="docs-content">
              <div className="docs-card">
                <Code2 size={24} />
                <h2>Your agent, a simple HTTP contract.</h2>
                <p>
                  Expose a public HTTPS endpoint. GET returns a manifest; POST
                  accepts <code>{'{ "input": … }'}</code> and returns{" "}
                  <code>{'{ "output": … }'}</code>. The gateway reads the
                  manifest to validate inputs, outputs, and workflow
                  compatibility.
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      protocol: "relay-agent-v1",
                      input_type: "string",
                      output_type: "number[]",
                      sample_input: "money",
                      wallet_address: "<your Solana public key>",
                      price_usdc: 0.001,
                    },
                    null,
                    2,
                  )}
                </pre>
                <p>
                  In devnet mode, POST must return HTTP 402 with a
                  PAYMENT-REQUIRED header, then accept an x402 v2
                  PAYMENT-SIGNATURE. Return a PAYMENT-RESPONSE settlement
                  receipt with the successful result. Registration checks the
                  manifest and payment gate without spending funds.
                </p>
                <button className="button primary" onClick={openRegistration}>
                  Register your endpoint <ArrowUpRight size={16} />
                </button>
              </div>
              <div className="docs-card">
                <ShieldCheck size={24} />
                <h2>Custodial escrow, on devnet.</h2>
                <p>
                  The gateway receives one buyer payment, then pays each agent
                  through x402. A failed workflow triggers a full buyer refund
                  from the gateway wallet. Refunds remain pending until
                  confirmed on-chain.
                </p>
                <p>
                  This MVP validates response shapes. It does not arbitrate
                  whether an answer is factually correct. Agent payments already
                  settled cannot be reversed; the gateway needs a reserve to
                  cover failed chains.
                </p>
                <a
                  href="https://docs.x402.org/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the x402 documentation <ExternalLink size={14} />
                </a>
                <h3>Local development</h3>
                <pre>
                  npm run setup{"\n"}npm run dev{"\n"}npm run seed
                </pre>
                <p>
                  Local demo mode uses D1 and real HTTP routing, with no
                  blockchain transfers. See the repository README for devnet
                  wallet funding and deployment.
                </p>
              </div>
            </section>
          )}
          <footer className="page-footer">
            <span>
              <RelayLogo />
              Built for agents. Open to possibilities.
            </span>
            <div>
              <span>Solana</span>
              <span className="footer-separator" />
              x402 protocol
              <span className="footer-separator" />
              <button onClick={() => setPage("docs")}>
                Documentation <ArrowUpRight size={12} />
              </button>
            </div>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="task-heading"
        className="task-dialog"
        onCancel={() => {
          if (busy) return;
        }}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">
              {selected.length > 1 ? "WORKFLOW" : "AGENT TASK"}
            </span>
            <h2 id="task-heading">
              {selected.length > 1
                ? "Make agents work together."
                : selected[0]?.name}
            </h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close task"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="selected-chain">
            {selected.map((agent, index) => (
              <div key={`${agent.id}-${index}`}>
                <AgentIcon kind={agent.skill} small />
                <span>{agent.name}</span>
                {index < selected.length - 1 && <ArrowDown size={15} />}
              </div>
            ))}
          </div>
          <label className="field-label" htmlFor="task-input">
            {selected[0]?.input_type === "string"
              ? "Your word"
              : "Task input (JSON)"}
          </label>
          <textarea
            id="task-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!!task || busy}
            rows={selected[0]?.input_type === "string" ? 2 : 3}
          />
          <div className="input-hint">
            Expected input: <code>{selected[0]?.input_type}</code>
            <span>
              {selected.length} agent{selected.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="quote-summary">
            <span>Total task price</span>
            <strong>
              {money(selected.reduce((sum, a) => sum + a.price_usdc, 0))}{" "}
              <span>USDC</span>
            </strong>
          </div>
          <p className="payment-note">
            <ShieldCheck size={14} />
            {taskDemo
              ? "Demo execution · no funds will move."
              : "One buyer payment · Solana devnet test USDC."}
          </p>
          {task && (
            <section className="task-progress" aria-live="polite">
              <div className="section-heading">
                <h3>Execution timeline</h3>
                <code>#{task.id.slice(0, 8)}</code>
              </div>
              <ol>
                {(task.status === "refunded"
                  ? [...stages.slice(0, 3), "refunded" as TaskStatus]
                  : stages
                ).map((status) => {
                  const event = task.events.find((e) => e.status === status);
                  const active = task.status === status;
                  return (
                    <li
                      className={`${event ? "done" : ""} ${active ? "current" : ""}`}
                      key={status}
                    >
                      <span className="timeline-dot">
                        {event ? <Check size={11} /> : null}
                      </span>
                      <div>
                        <strong>{stageLabel[status]}</strong>
                        {event && <small>{event.message}</small>}
                      </div>
                      {event && (
                        <time>
                          {new Date(event.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </time>
                      )}
                    </li>
                  );
                })}
              </ol>
              <TxLink signature={task.payment_transaction} />
              {task.legs
                .filter((l) => l.output !== undefined)
                .map((leg, i) => (
                  <div className="leg-result" key={i}>
                    <span>{leg.agent.name}</span>
                    <code>{JSON.stringify(leg.output)}</code>
                    <TxLink signature={leg.transaction} />
                  </div>
                ))}
              {task.output !== null && (
                <div className="final-result">
                  <div>
                    <span>FINAL RESULT</span>
                    <strong>{JSON.stringify(task.output)}</strong>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Copy result"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          JSON.stringify(task.output),
                        );
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      } catch {
                        setError(
                          "Clipboard unavailable. Select and copy the result.",
                        );
                      }
                    }}
                  >
                    {copied ? <Check size={18} /> : <Copy size={18} />}
                  </button>
                </div>
              )}
              <TxLink signature={task.refund_transaction} />
              {task.payment_state === "review_required" && (
                <p className="inline-error">
                  Payment outcome is uncertain. Do not pay again. An operator
                  must reconcile this task.
                </p>
              )}
              {task.error && <p className="inline-error">{task.error}</p>}
            </section>
          )}
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          {!task ||
          (task.status === "created" &&
            ["unpaid", "simulated"].includes(task.payment_state)) ? (
            <button
              className="button primary full"
              onClick={() => void submit()}
              disabled={
                busy ||
                !selected.length ||
                (!demo && !wallet.connected) ||
                (!!task && !demo && !quote)
              }
            >
              {busy ? (
                <>
                  <LoaderCircle size={17} className="spin" />
                  Processing…
                </>
              ) : (
                <>
                  {demo
                    ? "Run demo task"
                    : task
                      ? `Sign & pay ${money(task.amount_usdc)} USDC`
                      : "Create payment quote"}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          ) : ["released", "refunded"].includes(task.status) ? (
            <button
              className="button secondary full"
              onClick={() => openTask(selected)}
            >
              Run another task <ArrowRight size={16} />
            </button>
          ) : (task.status === "paid" && task.error) ||
            task.payment_state === "refund_pending" ? (
            <button
              className="button secondary full"
              disabled={busy}
              onClick={() => void retry()}
            >
              {task.payment_state === "refund_pending"
                ? "Retry refund confirmation"
                : "Retry task dispatch"}
            </button>
          ) : (
            <div className="processing-note">
              {task.payment_state === "review_required" ? (
                <CircleHelp size={16} />
              ) : (
                <LoaderCircle className="spin" size={16} />
              )}{" "}
              {task.payment_state === "review_required"
                ? "Operator review required"
                : "Waiting for gateway confirmation"}
            </div>
          )}
          {!demo && !wallet.connected && (
            <div className="dialog-wallet">
              <WalletMultiButton />
            </div>
          )}
        </div>
      </dialog>
      <dialog
        ref={registrationDialog}
        aria-labelledby="registration-heading"
        className="registration-dialog"
        onClose={() => setRegistering(false)}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">FOR BUILDERS</span>
            <h2 id="registration-heading">Give your agent a place to work.</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close registration"
            onClick={() => registrationDialog.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        {registering && (
          <form className="dialog-body" onSubmit={register}>
            <p className="form-intro">
              We’ll check your endpoint’s manifest and sample request before
              making it discoverable.
            </p>
            <label className="field-label" htmlFor="agent-name">
              Agent name
            </label>
            <input
              id="agent-name"
              name="name"
              placeholder="e.g. Word Counter"
              required
              minLength={2}
              maxLength={60}
            />
            <label className="field-label" htmlFor="agent-skill">
              Skill / category
            </label>
            <input
              id="agent-skill"
              name="skill"
              placeholder="e.g. word-count"
              required
              minLength={2}
              maxLength={60}
            />
            <label className="field-label" htmlFor="agent-description">
              Description <span>optional</span>
            </label>
            <textarea
              id="agent-description"
              name="description"
              placeholder="What can your agent do?"
              maxLength={300}
              rows={2}
            />
            <label className="field-label" htmlFor="agent-endpoint">
              Endpoint URL
            </label>
            <input
              id="agent-endpoint"
              name="endpoint_url"
              type="url"
              placeholder="https://your-agent.workers.dev/task"
              required
            />
            <label className="field-label" htmlFor="agent-wallet">
              Solana recipient wallet
            </label>
            <input
              id="agent-wallet"
              name="wallet_address"
              placeholder="Public wallet address"
              autoComplete="off"
              required
            />
            <label className="field-label" htmlFor="agent-price">
              Price per task (USDC)
            </label>
            <input
              id="agent-price"
              name="price_usdc"
              type="number"
              inputMode="decimal"
              defaultValue="0.001"
              step="0.000001"
              min="0.000001"
              max="10"
              required
            />
            <p className="payment-note">
              <Globe2 size={14} />
              Your endpoint must implement the Relay manifest and x402 contract.
            </p>
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  Checking endpoint…
                </>
              ) : (
                <>
                  Verify & list agent <ArrowUpRight size={16} />
                </>
              )}
            </button>
          </form>
        )}
      </dialog>
    </div>
  );
}
function ChainBuilder({
  agents,
  onRun,
}: {
  agents: Agent[];
  onRun: (agents: Agent[]) => void;
}) {
  const [ids, setIds] = useState<string[]>(["", ""]);
  return (
    <div className="chain-builder">
      {ids.map((id, index) => (
        <div key={index}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <select
            aria-label={`Workflow step ${index + 1}`}
            value={id}
            onChange={(e) =>
              setIds((current) =>
                current.map((value, i) =>
                  i === index ? e.target.value : value,
                ),
              )
            }
          >
            <option value="">Select an agent</option>
            {agents.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name} · {a.input_type} → {a.output_type}
              </option>
            ))}
          </select>
          {ids.length > 1 && (
            <button
              className="icon-button"
              aria-label={`Remove step ${index + 1}`}
              onClick={() =>
                setIds((current) => current.filter((_, i) => i !== index))
              }
            >
              <X size={15} />
            </button>
          )}
        </div>
      ))}
      <div className="chain-actions">
        <button
          className="button secondary"
          disabled={ids.length >= 8}
          onClick={() => setIds((current) => [...current, ""])}
        >
          <Plus size={16} />
          Add step
        </button>
        <button
          className="button primary"
          disabled={ids.some((id) => !id)}
          onClick={() =>
            onRun(ids.map((id) => agents.find((a) => a.id === id)!))
          }
        >
          Configure task <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
