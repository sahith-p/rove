// Proactive messages (docs/specs/agent.md §6). Owner: Saran · Task: SA-C3.
// (a) Unpaid invoices: one nudge to the customer after config.reminderAfterMs (CAS on reminded_at → exactly once).
// (b) Daily recap at config.recapHour (config.timeZone): text + voice note to each live merchant with sales today.
// The recap is the first thing to cut if behind; it is idempotent per merchant per local date (processed table).

import { format } from "@rove/shared";
import type { Deps, Voice } from "./ports";
import { speakable } from "./voice";
import { localDate, localHour } from "./time";

const INTERVAL_MS = 10 * 60 * 1000;


export function startReminders(deps: Deps, m: { voice: Voice }): { stop(): void; runOnce(): Promise<void> } {
  const { store, outbox, builders, config, log } = deps;

  async function nudgeUnpaid(): Promise<void> {
    const before = new Date(deps.now().getTime() - config.reminderAfterMs).toISOString();
    for (const invoice of await store.invoicesDueForReminder(before)) {
      try {
        if (!invoice.to || invoice.status !== "open") continue;
        if (!(await store.markInvoiceReminded(invoice.id))) continue; // someone else got it
        const merchant = await store.getMerchant(invoice.merchantId);
        if (!merchant) continue;
        await outbox.text(invoice.to, `Hi! Friendly reminder from ${merchant.name}: ${format(invoice.total)} is still open. Tap the card whenever you're ready.`);
        await outbox.cards.send(invoice.to, builders.invoice({ invoice, merchant }));
      } catch (err) {
        log("reminders: nudge failed", invoice.code, err);
      }
    }
  }

  async function recap(): Promise<void> {
    const now = deps.now();
    if (localHour(now) < config.recapHour) return;
    const date = localDate(now);
    for (const merchant of await store.listLiveMerchants()) {
      try {
        const summary = await store.daySummary(merchant.id, date);
        if (summary.count === 0) continue;
        if (!(await store.claim(`recap:${merchant.id}:${date}`))) continue;
        const to = { phone: merchant.phone, channel: merchant.channel };
        const body = `${summary.count} sale${summary.count === 1 ? "" : "s"} today, ${format(summary.net)} net.`;
        await outbox.text(to, body);
        const spoken = await m.voice.speak(speakable(`${spellCount(summary.count)} sale${summary.count === 1 ? "" : "s"} today, ${format(summary.net)} net.`));
        if (spoken) await outbox.voice(to, spoken.audio, { name: spoken.name, mimeType: spoken.mimeType, ...(spoken.duration !== undefined ? { duration: spoken.duration } : {}) });
      } catch (err) {
        log("reminders: recap failed", merchant.id, err);
      }
    }
  }

  async function runOnce(): Promise<void> {
    try {
      await nudgeUnpaid();
    } catch (err) {
      log("reminders: nudge sweep failed", err);
    }
    try {
      await recap();
    } catch (err) {
      log("reminders: recap sweep failed", err);
    }
  }

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runOnce().finally(() => {
      running = false;
    });
  }, INTERVAL_MS);
  timer.unref();

  return { stop: () => clearInterval(timer), runOnce };
}

const SMALL = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 14 → "Fourteen", 42 → "Forty-two"; larger counts stay as digits. */
function spellCount(n: number): string {
  if (n < 20) return SMALL[n] ?? String(n);
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${SMALL[n % 10]!.toLowerCase()}` : ""}`;
  return String(n);
}
