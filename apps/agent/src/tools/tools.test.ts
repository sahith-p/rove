import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomerToolInputs, MerchantToolInputs, money } from "@rove/shared";
import { defineTool, toJsonSchema, ToolError } from "../agent/tool";
import { makeHarness } from "../harness.test";
import { matchByName, normalize, toE164 } from "./match";
import { describeLines, parseAmount, resolveLines } from "./pricing";

type Json = { type?: string; properties?: Record<string, Json>; required?: string[]; items?: Json; pattern?: string; enum?: string[]; additionalProperties?: boolean };

/** Minimal JSON-schema checker for the subset toJsonSchema emits (type/properties/required/items/enum/pattern). */
function conforms(schema: Json, v: unknown, path = "$"): string[] {
  const errs: string[] = [];
  const t = schema.type;
  if (t === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${path}: not an object`];
    for (const r of schema.required ?? []) if (!(r in (v as object))) errs.push(`${path}.${r}: required`);
    for (const [k, val] of Object.entries(v as object)) {
      const sub = schema.properties?.[k];
      if (!sub) {
        if (schema.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
        continue;
      }
      errs.push(...conforms(sub, val, `${path}.${k}`));
    }
  } else if (t === "array") {
    if (!Array.isArray(v)) return [`${path}: not an array`];
    v.forEach((x, i) => errs.push(...conforms(schema.items ?? {}, x, `${path}[${i}]`)));
  } else if (t === "string") {
    if (typeof v !== "string") return [`${path}: not a string`];
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: pattern`);
    if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: enum`);
  } else if (t === "integer") {
    if (!Number.isInteger(v)) errs.push(`${path}: not an integer`);
  } else if (t === "number") {
    if (typeof v !== "number") errs.push(`${path}: not a number`);
  } else if (t === "boolean") {
    if (typeof v !== "boolean") errs.push(`${path}: not a boolean`);
  }
  return errs;
}

const SAMPLES: Record<string, unknown> = {
  set_shop_profile: { name: "Ah Seng", category: "hawker" },
  open_shop_setup: {},
  add_menu_items: { items: [{ name: "Kopi", price: "1.80" }] },
  update_menu_item: { name: "Kopi", price: "2.00" },
  show_menu: {},
  add_contact: { name: "Maya", phone: "+6591234567" },
  list_contacts: { query: "may" },
  create_invoice: { to: { contactName: "Maya" }, items: [{ name: "chicken rice", qty: 2 }] },
  create_one_time_qr: { amount: "6.50" },
  get_fixed_qr: {},
  list_invoices: { status: "open" },
  remind_invoice: { code: "K7Q2MX" },
  cancel_invoice: { code: "K7Q2MX" },
  get_sales: { range: "today" },
  list_payments: { limit: 5 },
  get_balance: {},
  open_bank_setup: {},
  propose_withdrawal: { amount: "10.00", to: "bank" },
  set_auto_withdraw: { mode: "daily" },
  propose_refund: { paymentId: "pay_1", reason: "overcharged" },
  open_my_shop: {},
  my_open_invoices: {},
  pay_invoice: { code: "K7Q2MX" },
  pay_code: { code: "K7Q2MX" },
  pay_shop: { shop: "ahseng", amount: "6.50" },
  my_receipts: { limit: 5 },
  start_shop: {},
};

test("every tool schema converts to a JSON object schema whose patterns compile, and representative inputs conform to both", () => {
  const all = { ...MerchantToolInputs, ...CustomerToolInputs } as Record<string, import("zod").ZodTypeAny>;
  for (const [name, schema] of Object.entries(all)) {
    const json = toJsonSchema(schema) as Json;
    assert.equal(json.type, "object", name);
    const walk = (s: Json) => {
      if (s.pattern) new RegExp(s.pattern); // throws on a bad pattern
      Object.values(s.properties ?? {}).forEach(walk);
      if (s.items) walk(s.items);
    };
    walk(json);
    const sample = SAMPLES[name];
    assert.ok(sample !== undefined, `no sample for ${name}`);
    assert.deepEqual(conforms(json, sample), [], `${name}: JSON schema`);
    assert.ok(schema.safeParse(sample).success, `${name}: zod`);
  }
});

test("JSON schema rejects what zod rejects (bad decimal, bad phone, bad enum, extra field)", () => {
  const inv = toJsonSchema(MerchantToolInputs.create_one_time_qr) as Json;
  assert.notDeepEqual(conforms(inv, { amount: "6.505.0" }), []);
  const contact = toJsonSchema(MerchantToolInputs.add_contact) as Json;
  assert.notDeepEqual(conforms(contact, { name: "x", phone: "91234567" }), []);
  const sales = toJsonSchema(MerchantToolInputs.get_sales) as Json;
  assert.notDeepEqual(conforms(sales, { range: "month" }), []);
  assert.notDeepEqual(conforms(sales, { range: "today", merchantId: "ahseng" }), []);
});

test("defineTool: validates through zod, logs calls, turns ToolError into an ERROR result and hides internal errors", async () => {
  const calls: { name: string; input: unknown; result: string }[] = [];
  const ok = defineTool("get_sales", "d", MerchantToolInputs.get_sales, async (i) => `range ${i.range}`, calls);
  assert.equal(ok.parse({ range: "today" }).range, "today");
  assert.throws(() => ok.parse({ range: "month" }));
  assert.equal(await ok.run({ range: "7d" }), "range 7d");
  const userErr = defineTool("x", "d", MerchantToolInputs.get_balance, async () => {
    throw new ToolError("No bank yet");
  }, calls);
  assert.equal(await userErr.run({}), "ERROR: No bank yet");
  const origError = console.error;
  console.error = () => undefined;
  try {
    const internal = defineTool("y", "d", MerchantToolInputs.get_balance, async () => {
      throw new Error("db password leaked");
    }, calls);
    assert.equal(await internal.run({}), "ERROR: internal error in y");
  } finally {
    console.error = origError;
  }
  assert.deepEqual(calls.map((c) => c.name), ["get_sales", "x", "y"]);
});

test("matchByName: exact, plural, prefix (shortest-start wins), fuzzy, many, none", () => {
  const menu = ["Chicken rice", "Roasted chicken rice", "Add egg", "Barley drink"].map((name) => ({ name }));
  const one = (q: string) => {
    const r = matchByName(q, menu, (m) => m.name);
    return r.kind === "one" ? r.item.name : r.kind;
  };
  assert.equal(one("chicken rice"), "Chicken rice");
  assert.equal(one("CHICKEN RICE!"), "Chicken rice");
  assert.equal(one("barleys"), "Barley drink");
  assert.equal(one("barley"), "Barley drink");
  assert.equal(one("roasted"), "Roasted chicken rice");
  assert.equal(one("chiken rice"), "Chicken rice");
  assert.equal(one("egg"), "Add egg");
  const many = matchByName("chicken", [{ name: "Chicken rice" }, { name: "Chicken wing" }], (m) => m.name);
  assert.equal(many.kind, "many");
  const vague = matchByName("rice", [{ name: "Chicken rice" }, { name: "Duck rice" }], (m) => m.name);
  assert.ok(vague.kind === "none" && vague.closest.length === 2, "a word inside several names → ask with both as closest");
  const none = matchByName("pizza", menu, (m) => m.name);
  assert.equal(none.kind, "none");
  assert.ok(none.kind === "none" && none.closest.length > 0);
  assert.equal(matchByName("", menu, (m) => m.name).kind, "none");
  assert.equal(normalize("  Uncle's   KOPI! "), "uncle s kopi");
});

test("toE164", () => {
  assert.equal(toE164("+65 9123 4567"), "+6591234567");
  assert.equal(toE164("91234567"), "+6591234567");
  assert.equal(toE164("(470) 820-9753"), "+14708209753");
  assert.equal(toE164("+1 470 820 9753"), "+14708209753");
  assert.equal(toE164("14708209753"), "+14708209753");
  assert.equal(toE164("12345"), null);
  assert.equal(toE164("+12"), null);
  assert.equal(toE164("abc"), null);
  assert.equal(toE164("71234567"), null, "8 digits not starting 3/6/8/9 aren't Singapore");
});

test("resolveLines: menu totals from the DB, merged quantities, free amount line shape, cap, zero, unknown items", async () => {
  const h = makeHarness();
  const m = (await h.agent.deps.store.getMerchant("ahseng"))!;
  const r = await resolveLines(h.agent.deps, m, [
    { name: "chicken rice", qty: 2 },
    { name: "barley", qty: 1 },
    { name: "Chicken Rice", qty: 1 },
  ]);
  assert.ok("lines" in r);
  assert.equal(r.total.amount, "18.00");
  assert.deepEqual(
    r.lines.map((l) => [l.name, l.qty, l.unit.amount]),
    [
      ["Chicken rice", 3, "5.50"],
      ["Barley drink", 1, "1.50"],
    ],
  );
  assert.equal(describeLines(r.lines), "3× Chicken rice, 1× Barley drink");

  const free = await resolveLines(h.agent.deps, m, undefined, "6.5");
  assert.ok("lines" in free);
  assert.deepEqual(free.lines, [{ menuItemId: null, name: "Payment", qty: 1, unit: money("6.50", "SGD") }]);
  assert.equal(free.total.amount, "6.50");

  const cap = await resolveLines(h.agent.deps, m, undefined, "500.01");
  assert.ok("problem" in cap && /limit/.test(cap.problem));
  const atCap = await resolveLines(h.agent.deps, m, undefined, "500.00");
  assert.ok("lines" in atCap);
  const manyItems = await resolveLines(h.agent.deps, m, [{ name: "chicken rice", qty: 91 }]);
  assert.ok("problem" in manyItems, "91 × 5.50 = 500.50 is over the cap");
  const zero = await resolveLines(h.agent.deps, m, undefined, "0");
  assert.ok("problem" in zero);
  const bad = await resolveLines(h.agent.deps, m, undefined, "6.555");
  assert.ok("problem" in bad);
  const unknown = await resolveLines(h.agent.deps, m, [{ name: "pizza", qty: 1 }]);
  assert.ok("problem" in unknown && /No menu item like "pizza"/.test(unknown.problem));
  const nothing = await resolveLines(h.agent.deps, m);
  assert.ok("problem" in nothing);
  assert.equal(parseAmount("1.234", "SGD"), null);
  assert.equal(parseAmount("12", "SGD")?.amount, "12.00");
});
