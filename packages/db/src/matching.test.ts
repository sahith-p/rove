// findMenuItems / findShop / getContactByName: exact → prefix → word prefix → fuzzy, suggestions, ambiguity.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Db } from "./index";
import { levenshtein, matchName, normalizeName } from "./match";
import { liveMerchant, openTestDb } from "./testkit";

let db: Db;
before(async () => {
  ({ db } = await openTestDb({ demo: true })); // ahseng (live, +15555550100) with DEMO_MENU and Maya
  await liveMerchant(db, "kopi-uncle", "Kopi Uncle", "+6591234567");
  await liveMerchant(db, "ahsengnoodle", "Ah Seng Noodles", "+6598765432");
  await db.upsertDraftMerchant({ id: "draftshop", name: "Draft Kitchen", phone: "+6597770000", channel: "whatsapp" });
});
after(() => db.close());

describe("matcher", () => {
  it("normalizes and measures", () => {
    assert.equal(normalizeName("  Ah Seng's  Chicken-Rice "), "ah sengs chicken rice");
    assert.equal(normalizeName("Café Olé"), "cafe ole");
    assert.equal(normalizeName("鸡饭 Stall"), "鸡饭 stall");
    assert.equal(levenshtein("kitten", "sitting"), 3);
    assert.equal(levenshtein("", "abc"), 3);
    assert.equal(levenshtein("鸡饭", "鸭饭"), 1);
  });

  it("prefers the unique closest fuzzy hit, else reports ambiguity", () => {
    const names = ["Teh", "Tea", "Kopi O", "Kopi C"];
    assert.equal(matchName("kopi", names, (n) => n).match, null); // two prefixes
    assert.deepEqual(matchName("kopi", names, (n) => n).ambiguous, ["Kopi C", "Kopi O"]);
    assert.equal(matchName("kopi oo", names, (n) => n).match, "Kopi O"); // both fuzzy hits, unique closest wins
    assert.equal(matchName("kopi 0", names, (n) => n).match, null); // equally close to Kopi O and Kopi C
    assert.equal(matchName("tex", names, (n) => n).match, null); // 3 letters: 1 edit allowed, two at distance 1
  });
});

describe("findMenuItems", () => {
  it("exact, prefix, word prefix and fuzzy; suggestions when unsure", async () => {
    const queries = ["chicken rice", "CHICKEN RICE", "roasted", "chicken", "egg", "chiken rice", "barly", "rice", "pizza"];
    const r = await db.findMenuItems("ahseng", queries);
    const got = Object.fromEntries(r.map((m) => [m.query, m.item?.name ?? null]));
    assert.deepEqual(got, {
      "chicken rice": "Chicken rice",
      "CHICKEN RICE": "Chicken rice",
      roasted: "Roasted chicken rice",
      chicken: "Chicken rice",
      egg: "Add egg",
      "chiken rice": "Chicken rice",
      barly: null,
      rice: null,
      pizza: null,
    });
    const sugg = Object.fromEntries(r.map((m) => [m.query, m.suggestions]));
    assert.deepEqual(sugg["chicken rice"], []);
    assert.deepEqual(sugg.barly, ["Barley drink"]);
    assert.deepEqual(sugg.rice, ["Chicken rice", "Roasted chicken rice"]); // ambiguous → ask which
    assert.deepEqual(sugg.pizza, []);
    assert.ok(r.find((m) => m.query === "chicken rice")!.item!.price.amount === "5.50"); // price from the DB
  });

  it("ignores inactive items", async () => {
    await db.upsertMenuItem("ahseng", { name: "Add egg", active: false });
    const [egg] = await db.findMenuItems("ahseng", ["egg"]);
    assert.equal(egg!.item, null);
    await db.upsertMenuItem("ahseng", { name: "add egg" }); // re-adding reactivates (keeps the stored name)
    const [again] = await db.findMenuItems("ahseng", ["egg"]);
    assert.equal(again!.item?.name, "Add egg");
  });
});

describe("findShop", () => {
  const shop = async (q: string) => {
    const r = await db.findShop(q);
    return { merchant: r.merchant?.id ?? null, candidates: r.candidates.map((m) => m.id) };
  };

  it("shop code first, case-insensitive", async () => {
    assert.deepEqual(await shop("ahseng"), { merchant: "ahseng", candidates: [] });
    assert.deepEqual(await shop("AhSeng"), { merchant: "ahseng", candidates: [] });
    assert.deepEqual(await shop("@kopi-uncle"), { merchant: "kopi-uncle", candidates: [] });
  });

  it("then the merchant's phone, however it's typed", async () => {
    assert.equal((await shop("+65 9123 4567")).merchant, "kopi-uncle");
    assert.equal((await shop("6591234567")).merchant, "kopi-uncle");
    assert.equal((await shop("9123-4567")).merchant, "kopi-uncle"); // local SG number
    assert.equal((await shop("+1 (555) 555-0100")).merchant, "ahseng");
    assert.equal((await shop("555 555 0100")).merchant, "ahseng"); // US number without +1
    assert.deepEqual(await shop("+65 9000 0000"), { merchant: null, candidates: [] });
  });

  it("then the name: exact, prefix, fuzzy; shared prefixes are ambiguous", async () => {
    assert.equal((await shop("Ah Seng Chicken Rice")).merchant, "ahseng");
    assert.equal((await shop("kopi")).merchant, "kopi-uncle");
    assert.equal((await shop("kopi uncel")).merchant, "kopi-uncle");
    assert.equal((await shop("Ah Seng Chiken Rice")).merchant, "ahseng");
    // closest name first: "Ah Seng Noodles" is nearer to "ah seng" than "Ah Seng Chicken Rice"
    assert.deepEqual(await shop("ah seng"), { merchant: null, candidates: ["ahsengnoodle", "ahseng"] });
  });

  it("typo'd shop codes match the closest code", async () => {
    assert.equal((await shop("ahsen")).merchant, "ahseng");
    assert.equal((await shop("kopiuncle")).merchant, "kopi-uncle");
  });

  it("only live shops", async () => {
    assert.equal((await shop("draftshop")).merchant, null);
    assert.equal((await shop("Draft Kitchen")).merchant, null);
    assert.ok(!(await shop("Draft Kitchen")).candidates.includes("draftshop"));
    assert.equal((await shop("+65 9777 0000")).merchant, null);
    assert.deepEqual(await shop("   "), { merchant: null, candidates: [] });
  });
});

describe("contacts", () => {
  it("getContactByName: matches, suggestions, ambiguity, phone", async () => {
    await db.addContact("ahseng", { name: "Maya", phone: "+65 9111 0000" }); // a second Maya
    await db.addContact("ahseng", { name: "John Tan", phone: "+6592223333", channel: "whatsapp" });
    const by = async (q: string) => {
      const r = await db.getContactByName("ahseng", q);
      return { contact: r.contact?.name ?? null, suggestions: r.suggestions.map((c) => c.phone) };
    };
    assert.deepEqual(await by("john"), { contact: "John Tan", suggestions: [] });
    assert.deepEqual(await by("JOHN TAN"), { contact: "John Tan", suggestions: [] });
    assert.deepEqual(await by("tan"), { contact: "John Tan", suggestions: [] });
    assert.deepEqual(await by("jon tan"), { contact: "John Tan", suggestions: [] });
    assert.deepEqual(await by("Jhon"), { contact: null, suggestions: ["+6592223333"] });
    assert.deepEqual(await by("maya"), { contact: null, suggestions: ["+15555550199", "+6591110000"] }); // two Mayas: ask
    assert.deepEqual(await by("+1 555 555 0199"), { contact: "Maya", suggestions: [] });
    assert.deepEqual(await by("zzz"), { contact: null, suggestions: [] });
  });

  it("addContact upserts on (merchant, phone); findContacts searches names and digits", async () => {
    const before = await db.findContacts("ahseng", "9111");
    assert.equal(before.length, 1);
    const renamed = await db.addContact("ahseng", { name: "Maya Lim", phone: "+6591110000" });
    assert.equal(renamed.id, before[0]!.id);
    assert.equal(renamed.name, "Maya Lim");
    assert.deepEqual((await db.findContacts("ahseng", "may")).map((c) => c.name), ["Maya", "Maya Lim"]);
    assert.deepEqual((await db.findContacts("ahseng")).map((c) => c.name), ["John Tan", "Maya", "Maya Lim"]);
    assert.deepEqual(await db.findContacts("kopi-uncle"), []);
  });
});
