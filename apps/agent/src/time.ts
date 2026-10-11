// The agent's local clock: every time it shows ("expires 3:42pm", "11 Oct") and every "today" it reports
// uses config.timeZone (AGENT_TIMEZONE, default Asia/Singapore), so replies match where the shop really is.

import { config } from "./env";

const zone = () => config.timeZone;
const part = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find((p) => p.type === type)?.value ?? "";

/** "2026-10-11" */
export function localDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "3:42pm" */
export function localTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone(), hour: "numeric", minute: "2-digit", hour12: true })
    .format(d)
    .replace(/\s/g, "")
    .toLowerCase();
}

/** 0–23 */
export function localHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone(), hour: "2-digit", hourCycle: "h23" }).format(d));
}

/** "11 Oct" */
export function localDayMonth(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone(), day: "numeric", month: "short" }).format(d);
}

/** "[Sun 11 Oct, 3:21 PM PDT]": prefixed to each user message so Claude knows the shop's local time. */
export function clockLine(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone(),
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(d);
  const p = (t: string) => part(parts, t);
  return `[${p("weekday")} ${p("day")} ${p("month")}, ${p("hour")}:${p("minute")} ${p("dayPeriod")} ${p("timeZoneName")}]`;
}
