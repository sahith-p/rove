import assert from "node:assert/strict";
import { test } from "node:test";
import { makeHarness, STRANGER, type Harness } from "./harness.test";
import { extractShopName, parseMenu, slugify } from "./onboarding";
import { WorkerError } from "./ports";

const P = STRANGER.phone;

async function step(h: Harness) {
  return (await h.agent.deps.store.getOnboarding(P))?.step;
}

test("full flow: start → name → poll vote → menu text → live (confetti, link, bank card) → bank added → done", async () => {
  const h = makeHarness();
  const ob = h.agent.onboarding;

  await ob.start(STRANGER);
  assert.equal(await step(h), "name");
  assert.ok(h.sentTo(P, "contact").length === 1, "Rove's contact card");
  assert.match(h.texts(P).at(-1)!, /what's your shop called/i);

  h.clear();
  await ob.handle(STRANGER, "it's called Uncle's Kopi!");
  assert.equal(await step(h), "category");
  const draft = await h.agent.deps.store.getMerchantByPhone(P);
  assert.equal(draft?.id, "uncleskopi");
  assert.equal(draft?.name, "Uncle's Kopi");
  assert.equal(draft?.status, "draft");
  assert.equal(h.sentTo(P, "poll").length, 1);

  h.clear();
  await ob.vote(STRANGER, "Drinks");
  assert.equal(await step(h), "menu");
  assert.equal((await h.agent.deps.store.getMerchant("uncleskopi"))!.category, "Drinks");
  assert.equal(h.sentTo(P, "card:setup").length, 1);

  h.clear();
  await ob.handle(STRANGER, "kopi 1.80, teh $1.60 and kaya toast S$2.50");
  const menu = await h.agent.deps.store.listMenu("uncleskopi");
  assert.deepEqual(
    menu.map((i) => [i.name, i.price.amount]),
    [
      ["Kopi", "1.80"],
      ["Teh", "1.60"],
      ["Kaya toast", "2.50"],
    ],
  );
  assert.equal(h.workerCalls.createMerchant, 1);
  // The mock worker emits merchant.live through the events handler → onboarding celebrates.
  assert.equal((await h.agent.deps.store.getMerchant("uncleskopi"))!.status, "live");
  assert.equal(await step(h), "bank");
  assert.equal(h.sentTo(P, "effect").length, 1);
  assert.equal(h.sentTo(P, "card:bank").length, 1);
  assert.equal(h.sentTo(P, "card-edit:setup").length, 1, "setup card edited in place with the new items");

  h.clear();
  await h.emit({ type: "bank_account.added", merchantId: "uncleskopi", bankAccountId: "bank_1", label: "DBS ••••9999" });
  assert.equal(await step(h), "done");
  const t = h.texts(P);
  assert.equal(t.length, 2);
  assert.match(t[0]!, /DBS ••••9999 is saved/);
  assert.match(t[1]!, /all set/);
});

test("numbered category reply works like a poll vote; free text becomes the category", async () => {
  const h = makeHarness();
  await h.agent.onboarding.start(STRANGER);
  await h.agent.onboarding.handle(STRANGER, "Mama's Noodles");
  await h.agent.onboarding.handle(STRANGER, "3");
  assert.equal((await h.agent.deps.store.getMerchantByPhone(P))!.category, "Groceries");

  const h2 = makeHarness();
  await h2.agent.onboarding.start(STRANGER);
  await h2.agent.onboarding.handle(STRANGER, "Mama's Noodles");
  await h2.agent.onboarding.handle(STRANGER, "handmade noodles");
  assert.equal((await h2.agent.deps.store.getMerchantByPhone(P))!.category, "handmade noodles");
});

test("a poll vote outside the category step is ignored", async () => {
  const h = makeHarness();
  await h.agent.onboarding.start(STRANGER);
  h.clear();
  await h.agent.onboarding.vote(STRANGER, "Drinks");
  assert.equal(await step(h), "name");
  assert.equal(h.record.length, 0);
});

test("rename at any step after the name; edits the setup card during menu", async () => {
  const h = makeHarness();
  await h.agent.onboarding.start(STRANGER);
  await h.agent.onboarding.handle(STRANGER, "Mama's Noodles");
  await h.agent.onboarding.vote(STRANGER, "Hawker food");
  h.clear();
  await h.agent.onboarding.handle(STRANGER, "change name to Mama Noodle House");
  assert.equal((await h.agent.deps.store.getMerchantByPhone(P))!.name, "Mama Noodle House");
  assert.match(h.texts(P)[0]!, /Mama Noodle House/);
  assert.equal(h.sentTo(P, "card-edit:setup").length, 1);
  assert.equal(await step(h), "menu");
});

test("worker failure on go-live → snag message; 'retry' tries again and goes live", async () => {
  const h = makeHarness();
  const real = h.agent.deps.worker.createMerchant;
  let fail = true;
  h.agent.deps.worker.createMerchant = async (req) => {
    if (fail) throw new WorkerError("That shop code is taken", 409, "shop_id_taken");
    return real(req);
  };
  await h.agent.onboarding.start(STRANGER);
  await h.agent.onboarding.handle(STRANGER, "Mama's Noodles");
  await h.agent.onboarding.vote(STRANGER, "Hawker food");
  h.clear();
  await h.agent.onboarding.handle(STRANGER, "laksa 6");
  assert.match(h.texts(P).at(-1)!, /snag: That shop code is taken/);
  assert.equal((await h.agent.deps.store.getOnboarding(P))!.data.liveRequested, false);

  fail = false;
  h.clear();
  await h.agent.onboarding.handle(STRANGER, "retry");
  assert.equal(await step(h), "bank");
  assert.equal((await h.agent.deps.store.getMerchantByPhone(P))!.status, "live");
});

test("unparseable menu text gets a hint (no Claude without a key); 'done' with items goes live", async () => {
  const h = makeHarness();
  await h.agent.onboarding.start(STRANGER);
  await h.agent.onboarding.handle(STRANGER, "Mama's Noodles");
  await h.agent.onboarding.vote(STRANGER, "Hawker food");
  h.clear();
  await h.agent.onboarding.handle(STRANGER, "uhh not sure yet");
  assert.match(h.texts(P).at(-1)!, /Text me items like/);
  assert.equal(h.workerCalls.createMerchant, 0);
});

test("menu added through the setup card (shop.updated) goes live", async () => {
  const h = makeHarness();
  await h.agent.onboarding.start(STRANGER);
  await h.agent.onboarding.handle(STRANGER, "Mama's Noodles");
  await h.agent.onboarding.vote(STRANGER, "Hawker food");
  const id = (await h.agent.deps.store.getMerchantByPhone(P))!.id;
  await h.agent.deps.store.upsertMenuItem(id, { name: "Laksa", price: { amount: "6.00", currency: "SGD" } });
  await h.emit({ type: "shop.updated", merchantId: id, fields: ["menu"] });
  assert.equal(h.workerCalls.createMerchant, 1);
  assert.equal(await step(h), "bank");
});

test("'later' at the bank step finishes; start() is a no-op for a live merchant", async () => {
  const h = makeHarness();
  await h.agent.onboarding.start(STRANGER);
  await h.agent.onboarding.handle(STRANGER, "Mama's Noodles");
  await h.agent.onboarding.vote(STRANGER, "Hawker food");
  await h.agent.onboarding.handle(STRANGER, "laksa 6");
  assert.equal(await step(h), "bank");
  await h.agent.onboarding.handle(STRANGER, "later");
  assert.equal(await step(h), "done");
  h.clear();
  await h.agent.onboarding.start(STRANGER);
  assert.equal(h.record.length, 0);
});

test("duplicate shop names get a unique slug", async () => {
  const h = makeHarness();
  await h.agent.onboarding.start(STRANGER);
  await h.agent.onboarding.handle(STRANGER, "Ah Seng Noodles"); // ahseng is taken by the demo shop
  assert.equal((await h.agent.deps.store.getMerchantByPhone(P))!.id, "ahseng2");
});

test("onEvent ignores merchants that aren't onboarding", async () => {
  const h = makeHarness();
  assert.equal(await h.agent.onboarding.onEvent({ type: "merchant.live", merchantId: "ahseng", xrplAddress: "r" }), false);
  assert.equal(await h.agent.onboarding.onEvent({ type: "payment.failed", paymentId: "p", merchantId: "ahseng", reason: "x" }), false);
});

test("parseMenu edge cases", () => {
  assert.deepEqual(parseMenu("chicken rice 5.50, barley 1.50"), [
    { name: "Chicken rice", price: "5.50" },
    { name: "Barley", price: "1.50" },
  ]);
  assert.deepEqual(parseMenu("kopi $5"), [{ name: "Kopi", price: "5.00" }]);
  assert.deepEqual(parseMenu("teh S$5.50"), [{ name: "Teh", price: "5.50" }]);
  assert.deepEqual(parseMenu("5.50 kopi"), [{ name: "Kopi", price: "5.50" }]);
  assert.deepEqual(parseMenu("kopi 1.80 and teh 1.60 & milo 2"), [
    { name: "Kopi", price: "1.80" },
    { name: "Teh", price: "1.60" },
    { name: "Milo", price: "2.00" },
  ]);
  assert.deepEqual(parseMenu("kopi 0"), [], "zero price rejected");
  assert.deepEqual(parseMenu("hello there"), []);
  assert.deepEqual(parseMenu("- laksa: 6\n- mee siam = 5.5"), [
    { name: "Laksa", price: "6.00" },
    { name: "Mee siam", price: "5.50" },
  ]);
});

test("parseMenu rejects a 3-decimal price instead of misreading it", () => {
  assert.deepEqual(parseMenu("kopi 1.805"), []);
});

test("slugify / extractShopName", () => {
  assert.equal(slugify("Ah Seng Chicken Rice"), "ahseng");
  assert.equal(slugify("Uncle's Kopi"), "uncleskopi");
  assert.equal(slugify("Jo"), "joshop");
  assert.match(slugify("A B C D"), /^[a-z0-9]{3,32}$/);
  assert.equal(slugify("x".repeat(80)).length, 32);

  assert.equal(extractShopName("it's called Ah Seng Chicken Rice!"), "Ah Seng Chicken Rice");
  assert.equal(extractShopName("my shop is \"Uncle's Kopi\""), "Uncle's Kopi");
  assert.equal(extractShopName("call it Mama's"), "Mama's");
  assert.equal(extractShopName("x"), null);
  assert.equal(extractShopName("y".repeat(61)), null);
});
