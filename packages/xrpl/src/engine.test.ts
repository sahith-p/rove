// Read-only mode, no network: building the engine never connects, and signing methods fail fast and clearly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "@rove/shared";
import { createXrplSettlement } from "./engine";
import { xrplConfigFromEnv } from "./config";
import { XrplSigningUnavailableError } from "./errors";
import { memorySeedStore } from "./seed-store";

// Valid-format testnet-style addresses (no funds needed: nothing here touches the network).
const PUB = {
  XRPL_WSS: "wss://s.altnet.rippletest.net:51233",
  XRPL_USD_ISSUER: "rH15tHofyKyTfoCKHx9C839K2VS55sewLg",
  XRPL_SGD_ISSUER: "rwkaqG93nQBqkSqosVfqUqjLcH5hizMMJd",
  XRPL_TREASURY_ADDRESS: "rDAjoXuxGgqrqfivKWpLCsqCDggaWFcXCS",
  XRPL_CREDENTIAL_ISSUER_ADDRESS: "rUhv2j8yKAa8XoTMihApuUmKJcvBSP8b8f",
};

test("xrplConfigFromEnv reads the documented names and never throws", () => {
  const c = xrplConfigFromEnv({ ...PUB, XRPL_TREASURY_SEED: " ", WALLET_ENCRYPTION_KEY: "" });
  assert.equal(c.usdIssuer, PUB.XRPL_USD_ISSUER);
  assert.equal(c.treasuryAddress, PUB.XRPL_TREASURY_ADDRESS);
  assert.equal(c.treasurySeed, undefined);
  assert.equal(c.walletEncryptionKey, undefined);
  assert.equal(xrplConfigFromEnv({}).wss, "wss://s.altnet.rippletest.net:51233");
});

test("read-only engine: signing methods throw XrplSigningUnavailableError naming the env var", async () => {
  const engine = createXrplSettlement(xrplConfigFromEnv(PUB));
  await assert.rejects(
    engine.settle({ paymentId: "pay_1", merchantAddress: PUB.XRPL_TREASURY_ADDRESS, local: money("12.50", "SGD"), sendMaxUsd: "9.81" }),
    (e: unknown) => e instanceof XrplSigningUnavailableError && /XRPL_TREASURY_SEED/.test(e.message),
  );
  assert.equal(engine.explorerUrl("ABC"), "https://testnet.xrpl.org/transactions/ABC");
});

test("createXrplSettlement accepts a SeedStore as the second argument (worker wiring)", () => {
  const engine = createXrplSettlement(xrplConfigFromEnv(PUB), memorySeedStore());
  assert.ok(engine.context.seedStore);
});

test("missing public config surfaces as a clear error from the method that needs it", async () => {
  const engine = createXrplSettlement(xrplConfigFromEnv({}));
  await assert.rejects(engine.quote({ local: money("1.00", "SGD") }), /XRPL_USD_ISSUER|XRPL_TREASURY_ADDRESS/);
});
