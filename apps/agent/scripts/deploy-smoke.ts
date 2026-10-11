// Deploy smoke test: boots the agent the way Railway does (`pnpm --filter agent start`, NODE_ENV=production, PORT set,
// no .env) and checks the internal HTTP surface. Never touches production: offline store, no Photon, no Claude.
//   pnpm --filter agent deploy-smoke [repoRoot]      (default: this checkout; pass a clean `git archive` copy to test a fresh install)
// Exit code 0 = every check passed.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../..", import.meta.url)));
const PORT = String(20000 + Math.floor(Math.random() * 20000));
const SECRET = "smoke-internal-secret";
const base = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

function boot(extraEnv: Record<string, string>) {
  // Railway gives the process only its own variables: drop anything that could reach production from this shell.
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "SHELL", "COREPACK_HOME", "PNPM_HOME"]) if (process.env[k]) env[k] = process.env[k]!;
  // The agent also loads a repo-root .env if one exists; it never overrides variables that are already set, so blank
  // every production credential here: a smoke run must never connect to Photon, Claude, ElevenLabs or the real DB.
  const blanked = { SPECTRUM_PROJECT_ID: "", SPECTRUM_PROJECT_SECRET: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "", DATABASE_URL: "", WORKER_URL: "http://127.0.0.1:1" };
  Object.assign(env, blanked, { NODE_ENV: "production", PORT, INTERNAL_SECRET: SECRET, TOKEN_SECRET: "smoke-token-secret", ...extraEnv });
  const child = spawn("pnpm", ["--filter", "agent", "start"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, exited, log: () => log };
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return pred();
}

const envelope = {
  id: `evt_smoke_${Date.now()}`,
  at: new Date().toISOString(),
  event: {
    type: "payment.settled",
    paymentId: "pay_demo0001",
    merchantId: "ahseng",
    source: "invoice",
    invoiceId: "inv_demo0001",
    local: { amount: "12.50", currency: "SGD" },
    payer: null,
    txHash: "0".repeat(64),
    delivered: "12.5",
    firstSale: false,
  },
};
const post = (body: unknown, auth = true) =>
  fetch(`${base}/internal/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify(body),
  });

// 1. Offline boot + HTTP surface
{
  const a = boot({ AGENT_OFFLINE: "1" });
  const up = await waitFor(() => a.log().includes("listening"), 60_000);
  check("boots and listens on $PORT", up, up ? `:${PORT}` : a.log().slice(-400));
  if (up) {
    const h = await fetch(`${base}/health`);
    check("GET /health → 200", h.status === 200, String(h.status));
    const r1 = await post(envelope);
    const b1 = (await r1.json().catch(() => ({}))) as { status?: string };
    check("POST /internal/events → 202 handled", r1.status === 202 && b1.status === "handled", `${r1.status} ${JSON.stringify(b1)}`);
    const r2 = await post(envelope);
    const b2 = (await r2.json().catch(() => ({}))) as { status?: string };
    check("resend same envelope → duplicate", r2.status === 202 && b2.status === "duplicate", `${r2.status} ${JSON.stringify(b2)}`);
    const r3 = await post(envelope, false);
    check("no bearer → 401", r3.status === 401, String(r3.status));
    const r4 = await post({ id: "bad" });
    check("malformed envelope → 400", r4.status === 400, String(r4.status));
  }
  const t0 = Date.now();
  process.kill(-a.child.pid!, "SIGTERM");
  const code = await Promise.race([a.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
  check("SIGTERM exits within 10s", code !== "timeout", `${code} after ${Date.now() - t0}ms`);
  if (code === "timeout") process.kill(-a.child.pid!, "SIGKILL");
}

// 2. Unreachable DATABASE_URL: the agent must stay up (health) or fail loudly, not hang silently
{
  const a = boot({ DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" });
  const up = await waitFor(() => a.log().includes("listening") || a.child.exitCode !== null, 60_000);
  const listening = a.log().includes("listening");
  let health = 0;
  if (listening) health = (await fetch(`${base}/health`).catch(() => ({ status: 0 }))).status;
  console.log(`INFO  bad DATABASE_URL: ${listening ? `serves /health ${health}` : `exited ${a.child.exitCode}`}`);
  check("bad DATABASE_URL: boots (store connects lazily)", up && listening && health === 200, a.log().slice(-300).replace(/\n/g, " | "));
  if (listening) {
    const r = await post({ ...envelope, id: `evt_smoke_db_${Date.now()}` });
    console.log(`INFO  bad DATABASE_URL: POST /internal/events → ${r.status}`);
    await new Promise((res) => setTimeout(res, 1000));
    check("bad DATABASE_URL: still alive after a DB error", a.child.exitCode === null, `exit ${a.child.exitCode}`);
  }
  try {
    process.kill(-a.child.pid!, "SIGKILL");
  } catch {}
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
