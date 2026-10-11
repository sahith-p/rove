// Agent configuration, read once from the environment (repo-root .env; see .env.example).
// Offline mode: with no SUPABASE_URL the agent runs on the in-memory store + mock worker (seeded with fixtures),
// so every flow works from the terminal and in evals before the database and worker exist.

import { DEMO_CUSTOMER, DEMO_MERCHANT } from "@rove/shared/mocks";

const env = process.env;
const flag = (name: string, fallback = false) => (env[name] === undefined ? fallback : env[name] === "1");

export const config = {
  port: Number(env.AGENT_PORT ?? 4002),
  publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  internalSecret: env.INTERNAL_SECRET ?? "change-me",
  tokenSecret: env.TOKEN_SECRET ?? "change-me",
  workerUrl: env.WORKER_URL ?? "http://localhost:4001",

  offline: !env.SUPABASE_URL,
  mockCards: flag("USE_MOCK_CARDS", true),
  terminal: flag("USE_TERMINAL_PROVIDER"),
  terminalAs: (env.TERMINAL_AS === "customer" ? "customer" : "merchant") as "merchant" | "customer",
  terminalPhones: { merchant: DEMO_MERCHANT.phone, customer: DEMO_CUSTOMER.phone },

  spectrum: {
    projectId: env.SPECTRUM_PROJECT_ID ?? "",
    projectSecret: env.SPECTRUM_PROJECT_SECRET ?? "",
  },

  anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
  /** Only for API keys not scoped to a workspace (sent as the anthropic-workspace-id header). */
  anthropicWorkspaceId: env.ANTHROPIC_WORKSPACE_ID ?? "",
  elevenLabs: { apiKey: env.ELEVENLABS_API_KEY ?? "", voiceId: env.ELEVENLABS_VOICE_ID ?? "" },

  /** Demo cap on a single invoice / pay request (docs/specs/invoicing-and-qr.md §4). */
  maxInvoiceSgd: "500.00",
  /** Unpaid invoices get one nudge after this long. */
  reminderAfterMs: 24 * 3600 * 1000,
  /** The shop's local timezone: times shown in messages, what "today" means, the recap hour. */
  timeZone: env.AGENT_TIMEZONE || "Asia/Singapore",
  /** Daily voice recap hour, in timeZone. */
  recapHour: 21,
} as const;

export type Config = typeof config;
