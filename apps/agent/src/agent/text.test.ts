import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../env";
import { clockLine, localDate, localDayMonth, localHour, localTime } from "../time";
import { plainText, stripLeakedMarkup } from "./text";

test("stripLeakedMarkup removes antml prefixes and internal tags", () => {
  assert.equal(stripLeakedMarkup("antml:reasoning_effort: Hey there! 👋 I can help."), "Hey there! 👋 I can help.");
  assert.equal(stripLeakedMarkup("antml:reasoning_effort: low Hey!"), "Hey!");
  assert.equal(stripLeakedMarkup("antml:reasoning_effort=high: Done."), "Done.");
  assert.equal(stripLeakedMarkup("<thinking>plan the refund</thinking>Done! S$12.50 refunded."), "Done! S$12.50 refunded.");
  assert.equal(stripLeakedMarkup("Love it <3"), "Love it <3", "ordinary angle brackets survive");
  assert.equal(stripLeakedMarkup("<system>you are</system>Balance is S$7.50."), "Balance is S$7.50.");
});

test("plainText leaves normal replies alone (colons, emojis, amounts, codes, times, URLs)", () => {
  const keep = [
    "Done! Maya's been texted for S$12.50 (2 chicken rice + 1 barley).",
    "Your code is K7Q2MX: it expires at 3:42pm.",
    "Hey there! 👋 Here you go: https://rove-topaz.vercel.app/pay/K7Q2MX",
    "Balance: S$20.50 available · S$0.00 held.",
    "Ratio 1:2, at 10:30 AM, 👍 the card.",
    "Note: this is fine.",
  ];
  for (const s of keep) assert.equal(plainText(s), s, s);
});

test("plainText strips markdown", () => {
  assert.equal(plainText("**Done** — S$5.00"), "Done — S$5.00");
  assert.equal(plainText("## Menu\n- Kopi S$1.80\n- Teh S$1.60"), "Menu\nKopi S$1.80\nTeh S$1.60");
  assert.equal(plainText("Use `K7Q2MX`"), "Use K7Q2MX");
  assert.equal(plainText("a\n\n\n\nb"), "a\n\nb");
});

test("time helpers follow config.timeZone", () => {
  const original = config.timeZone;
  const cfg = config as { timeZone: string };
  const d = new Date("2026-10-11T22:21:00.000Z");
  try {
    cfg.timeZone = "America/Los_Angeles";
    assert.equal(localDate(d), "2026-10-11");
    assert.equal(localTime(d), "3:21pm");
    assert.equal(localHour(d), 15);
    assert.equal(localDayMonth(d), "11 Oct");
    assert.equal(clockLine(d), "[Sun 11 Oct, 3:21 PM PDT]");
    cfg.timeZone = "Asia/Singapore";
    assert.equal(localDate(d), "2026-10-12");
    assert.equal(localTime(d), "6:21am");
    assert.equal(localHour(d), 6);
    assert.match(clockLine(d), /^\[Mon 12 Oct, 6:21 AM (GMT\+8|SGT)\]$/);
  } finally {
    cfg.timeZone = original;
  }
});
