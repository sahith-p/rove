// Agent service (port 4002). Owner: Saran. Specs: docs/specs/agent.md, onboarding.md, channels.md, voice.md.
// Boot: load .env → Spectrum (iMessage / terminal, whichever are configured) → outbox → agent modules
// → internal HTTP server, reminders, action expiry sweep → inbound message loop (runtime.ts).
// Card handles live in memory: don't restart the agent during the demo.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// .env must load before ./env reads process.env, so everything else is imported dynamically below.
for (const path of [fileURLToPath(new URL("../../../.env", import.meta.url)), "../../.env", ".env"]) {
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

const { config } = await import("./env");
const { buildAgent } = await import("./app");
const { createConsoleOutbox } = await import("./outbox");
const { createRuntimeOutbox, createSpectrum, runMessageLoop } = await import("./runtime");
const { startServer } = await import("./server");
const { startReminders } = await import("./reminders");

const log = (...args: unknown[]) => console.log("[agent]", ...args);
const setup = await createSpectrum(config);
const outbox =
  config.mockCards || !setup ? createConsoleOutbox({ log: (line) => console.log("[out]", line) }) : createRuntimeOutbox(setup, config, log);

const agent = buildAgent({ outbox, log });
startServer(agent.deps, { events: agent.events, actions: agent.actions });
startReminders(agent.deps, { voice: agent.voice });
setInterval(() => void agent.actions.sweep().catch((err) => log("action sweep failed", err)), 30_000);

log(`store=${config.offline ? "memory (offline)" : "supabase"} cards=${config.mockCards || !setup ? "console" : "spectrum"}`);
if (!setup) {
  log("no Spectrum providers configured (SPECTRUM_PROJECT_ID / USE_TERMINAL_PROVIDER=1): internal HTTP only");
} else {
  log("providers:", Object.entries(setup.providers).filter(([, on]) => on).map(([name]) => name).join(", "));
  await runMessageLoop(setup, agent);
}
