import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getAddress, hashDomain, keccak256, stringToHex, type Hex } from "viem";
import { money, type Payment } from "@rove/shared";
import {
  ausdCharge,
  ausdConfigFromEnv,
  ausdNonce,
  buildAusdCheckout,
  expectedAuthorization,
  isValidAusdSignature,
  usdToAusdUnits,
  verifyAusdAuthorization,
} from "./ausd";
import { createFakeAusdChain, signAuthorization, TEST_AUSD_CONFIG, testPayer } from "./ausd-testing";

const EXPIRES = "2026-10-11T12:00:00.000Z";
const EXPIRES_SEC = Date.parse(EXPIRES) / 1000;

function payment(id = "pay_0123456789abcdef", usd = "9.69"): Pick<Payment, "id" | "quote" | "charge"> {
  return {
    id,
    quote: { local: money("12.50", "SGD"), usd: money(usd, "USD"), rate: "1.29", sendMaxUsd: "9.79", expiresAt: EXPIRES },
    charge: money(usd, "USD"),
  };
}

describe("buildAusdCheckout", () => {
  test("value is the USD charge in AUSD base units (6 decimals), to = AUSD_PAY_TO, validAfter 0", () => {
    const res = buildAusdCheckout(payment(), TEST_AUSD_CONFIG);
    assert.equal(res.amount, "9.69");
    assert.equal(res.authorization.value, "9690000");
    assert.equal(res.authorization.to, TEST_AUSD_CONFIG.payTo);
    assert.equal(res.authorization.validAfter, "0");
    assert.equal(res.chainId, 84532);
    assert.equal(res.decimals, 6);
    assert.equal(res.token, getAddress("0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC"));
  });

  test("validBefore = quote expiry + 10 minutes (unix seconds)", () => {
    assert.equal(buildAusdCheckout(payment(), TEST_AUSD_CONFIG).authorization.validBefore, String(EXPIRES_SEC + 600));
  });

  test("nonce = keccak256(paymentId): deterministic per payment, distinct across payments", () => {
    const a = buildAusdCheckout(payment("pay_a"), TEST_AUSD_CONFIG).authorization.nonce;
    assert.equal(a, keccak256(stringToHex("pay_a")));
    assert.equal(buildAusdCheckout(payment("pay_a"), TEST_AUSD_CONFIG).authorization.nonce, a);
    assert.notEqual(buildAusdCheckout(payment("pay_b"), TEST_AUSD_CONFIG).authorization.nonce, a);
    assert.equal(ausdNonce("pay_a"), a);
  });

  test("domain is the token's verified EIP-712 domain: Agora Dollar / 1 / 84532 / token", () => {
    const { domain } = buildAusdCheckout(payment(), TEST_AUSD_CONFIG);
    assert.deepEqual(domain, { name: "Agora Dollar", version: "1", chainId: 84532, verifyingContract: TEST_AUSD_CONFIG.token });
    // DOMAIN_SEPARATOR() read from the token on Base Sepolia (docs/specs/ausd-lane.md).
    const separator = hashDomain({
      domain: { ...domain, chainId: BigInt(domain.chainId), verifyingContract: domain.verifyingContract as Hex },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    });
    assert.equal(separator, "0x5a85328c8aae02b57a5bc1fb1848cb2fb9ccbdc204c554a4db199b13fed1e8bb");
  });

  test("money: exact bigint conversion, never floats; a non-USD charge is refused", () => {
    assert.equal(usdToAusdUnits(money("0.01", "USD"), 6), 10_000n);
    assert.equal(usdToAusdUnits(money("123456.78", "USD"), 6), 123_456_780_000n);
    assert.throws(() => usdToAusdUnits(money("12.50", "SGD"), 6), /AUSD is a dollar/);
    assert.deepEqual(ausdCharge({ usd: { amount: "9.691", currency: "USD" } }), money("9.70", "USD"));
  });

  test("config from env: off without AUSD_PAY_TO; defaults to the verified token", () => {
    assert.equal(ausdConfigFromEnv({}), null);
    const c = ausdConfigFromEnv({ AUSD_PAY_TO: "0xad0e193bcd9a035acb383681bb21f7c3099f584b" })!;
    assert.equal(c.payTo, TEST_AUSD_CONFIG.payTo);
    assert.equal(c.token, TEST_AUSD_CONFIG.token);
    assert.equal(c.decimals, 6);
    assert.equal(c.rpcUrl, "https://sepolia.base.org");
    assert.throws(() => ausdConfigFromEnv({ AUSD_PAY_TO: TEST_AUSD_CONFIG.payTo, AUSD_DECIMALS: "1" }), /AUSD_DECIMALS/);
  });
});

describe("verifyAusdAuthorization", () => {
  const NOW = EXPIRES_SEC - 30;

  async function setup() {
    const payer = testPayer();
    const chain = createFakeAusdChain();
    chain.fund(payer.address, 50_000_000n);
    const message = expectedAuthorization(payment(), payer.address, TEST_AUSD_CONFIG);
    const signature = await signAuthorization(payer, TEST_AUSD_CONFIG, message);
    return { payer, chain, message, signature, deps: { config: TEST_AUSD_CONFIG, chain } };
  }

  test("a valid signature by the payer passes", async () => {
    const { deps, message, signature } = await setup();
    assert.deepEqual(await verifyAusdAuthorization(deps, message, signature, NOW), { ok: true });
  });

  test("tampered value, recipient or nonce, or another signer, fail as invalid_signature", async () => {
    const { deps, message, signature } = await setup();
    const reason = async (m: typeof message, sig: string = signature) => {
      const v = await verifyAusdAuthorization(deps, m, sig, NOW);
      return v.ok ? "ok" : v.reason;
    };
    assert.equal(await reason({ ...message, value: message.value + 1n }), "invalid_signature");
    assert.equal(await reason({ ...message, to: getAddress("0x000000000000000000000000000000000000dEaD") }), "invalid_signature");
    assert.equal(await reason({ ...message, nonce: ausdNonce("pay_other") }), "invalid_signature");
    assert.equal(await reason({ ...message, validBefore: message.validBefore + 1n }), "invalid_signature");
    const other = testPayer();
    assert.equal(await reason(message, await signAuthorization(other, TEST_AUSD_CONFIG, message)), "invalid_signature");
    assert.equal(await reason(message, "0x1234"), "invalid_signature");
    assert.equal(await reason({ ...message, from: other.address }), "invalid_signature");
  });

  test("a high-s (malleated) signature is refused like the contract would", async () => {
    const { message, signature } = await setup();
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = signature.slice(2, 66);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130, 132), 16);
    const flipped = `0x${r}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    assert.equal(await isValidAusdSignature(TEST_AUSD_CONFIG, message, flipped), false);
  });

  test("expired, not yet valid, used nonce, low balance and RPC failure each have their own reason", async () => {
    const { deps, chain, message, signature, payer } = await setup();
    const reason = async (now: number) => {
      const v = await verifyAusdAuthorization(deps, message, signature, now);
      return v.ok ? "ok" : v.reason;
    };
    assert.equal(await reason(EXPIRES_SEC + 600), "authorization_expired");
    assert.equal(await reason(EXPIRES_SEC + 600 - 29), "authorization_expired"); // less than 30s left to relay

    const future = { ...message, validAfter: BigInt(NOW + 3600) };
    const futureSig = await signAuthorization(payer, TEST_AUSD_CONFIG, future);
    const f = await verifyAusdAuthorization(deps, future, futureSig, NOW);
    assert.equal(!f.ok && f.reason, "authorization_not_yet_valid");

    chain.failReads(true);
    assert.equal(await reason(NOW), "chain_unavailable");
    chain.failReads(false);

    const poor = testPayer();
    const poorMsg = expectedAuthorization(payment(), poor.address, TEST_AUSD_CONFIG);
    chain.fund(poor.address, 9_689_999n);
    const p = await verifyAusdAuthorization(deps, poorMsg, await signAuthorization(poor, TEST_AUSD_CONFIG, poorMsg), NOW);
    assert.equal(!p.ok && p.reason, "insufficient_funds");
    assert.match(!p.ok ? p.message : "", /9\.689999 AUSD; the payment needs 9\.690000/);

    chain.markUsed(payer.address, message.nonce);
    assert.equal(await reason(NOW), "authorization_used");
  });
});
