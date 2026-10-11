import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_MERCHANT } from "@rove/shared/mocks";
import { customerPrompt, merchantPrompt } from "./agent/prompts";
import { countryName, currencyLabel, currencyPlural, exampleAmount, shopCurrencyForPhone, speakAmounts } from "./currency";
import { parseMenu } from "./onboarding";
import { speakable } from "./voice";

test("currency names read naturally", () => {
  assert.equal(currencyPlural("SGD"), "Singapore dollars");
  assert.equal(currencyPlural("EUR"), "euros");
  assert.equal(currencyPlural("USD"), "US dollars");
  assert.equal(currencyPlural("BRL"), "Brazilian reais");
  assert.equal(currencyLabel("EUR"), "euros (€)");
  assert.equal(exampleAmount("EUR"), "€12.50");
  assert.equal(countryName("SG"), "Singapore");
  assert.equal(countryName("DE"), "Germany");
});

test("a new shop is paid in its phone's currency, falling back to SGD", () => {
  assert.equal(shopCurrencyForPhone("+6591234567"), "SGD");
  assert.equal(shopCurrencyForPhone("+14155550123"), "USD");
  assert.equal(shopCurrencyForPhone("+4915112345678"), "EUR");
  assert.equal(shopCurrencyForPhone("+919876543210"), "SGD"); // INR is planned, not enabled
});

test("amounts are spoken in the right currency", () => {
  assert.equal(speakAmounts("S$12.50 today"), "12 dollars 50 today");
  assert.equal(speakAmounts("€4.20 and €1.00"), "4 euros 20 and 1 euro");
  assert.equal(speakAmounts("S$5.00, plus US$3.00"), "5 dollars, plus 3 US dollars");
  assert.equal(speakAmounts("US$1.00", "USD"), "1 dollar");
  assert.equal(speakable("You made €48.00 🎉"), "You made 48 euros");
});

test("menu text parses euro, dollar and coded prices", () => {
  assert.deepEqual(parseMenu("croissant €2.50, latte 3.80 eur", "EUR"), [
    { name: "Croissant", price: "2.50" },
    { name: "Latte", price: "3.80" },
  ]);
  assert.deepEqual(parseMenu("bagel US$4, coffee $2.5", "USD"), [
    { name: "Bagel", price: "4.00" },
    { name: "Coffee", price: "2.50" },
  ]);
  assert.deepEqual(parseMenu("kopi 1.805", "EUR"), []);
});

test("prompts name the shop's country and currency", () => {
  const berlin = { ...DEMO_MERCHANT, id: "cafe-berlin", name: "Café Berlin", country: "DE", currency: "EUR" as const };
  const p = merchantPrompt(berlin);
  assert.match(p, /Germany/);
  assert.match(p, /euros \(€\)/);
  assert.match(p, /€12\.50/);
  assert.doesNotMatch(p, /Singapore|S\$/);
  assert.match(merchantPrompt(DEMO_MERCHANT), /Singapore dollars \(S\$\)/);
  assert.match(customerPrompt({ phone: "+4915112345678", channel: "imessage" }), /pay in euros/);
});
