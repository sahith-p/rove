import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HDKey, mnemonicToAccount } from "viem/accounts";
import { bscConfigFromEnv, DEPOSIT_ACCOUNT_PATH, depositAddressAt, parseAccountXpub, uncompressPublicKey } from "./bsc";

// The well-known Hardhat/Anvil test mnemonic (public, holds nothing): independent vectors for m/44'/60'/0'/0/<n>.
const MNEMONIC = "test test test test test test test test test test test junk";
const ANVIL = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];

/** What the worker does (apps/worker/src/bnb/keys.ts): the account node's xpub, and accounts straight from the mnemonic. */
const xpubOf = (mnemonic: string) => mnemonicToAccount(mnemonic, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey().publicExtendedKey;
const fromMnemonic = (mnemonic: string, index: number) => mnemonicToAccount(mnemonic, { addressIndex: index }).address;

describe("deposit addresses from the account xpub", () => {
  const xpub = xpubOf(MNEMONIC);

  test("match the Anvil vectors", () => {
    ANVIL.forEach((addr, i) => assert.equal(depositAddressAt(xpub, i), addr));
  });

  test("xpub-derived == mnemonic-derived (what the worker can sweep), for several indexes", () => {
    for (const i of [0, 1, 2, 7, 42, 1000, 65_535, 2 ** 31 - 1]) assert.equal(depositAddressAt(xpub, i), fromMnemonic(MNEMONIC, i), `index ${i}`);
  });

  test("a fresh random mnemonic too", async () => {
    const { generateMnemonic, english } = await import("viem/accounts");
    const m = generateMnemonic(english);
    const x = xpubOf(m);
    for (const i of [1, 2, 3, 99]) assert.equal(depositAddressAt(x, i), fromMnemonic(m, i));
  });

  test("distinct per index, checksummed", () => {
    const addrs = Array.from({ length: 50 }, (_, i) => depositAddressAt(xpub, i + 1));
    assert.equal(new Set(addrs.map((a) => a.toLowerCase())).size, 50);
    for (const a of addrs) assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  });

  test("rejects out-of-range indexes (hardened / negative / fractional)", () => {
    for (const bad of [-1, 2 ** 31, 1.5, Number.NaN]) assert.throws(() => depositAddressAt(xpub, bad), /out of range/);
  });
});

describe("parseAccountXpub", () => {
  test("refuses an xprv: the web never holds a spending key", () => {
    const xprv = mnemonicToAccount(MNEMONIC, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey().privateExtendedKey;
    assert.throws(() => parseAccountXpub(xprv), /private key/);
  });

  test("refuses an xpub at the wrong depth (e.g. a per-address node or the BIP-44 account' node)", () => {
    const leaf = mnemonicToAccount(MNEMONIC, { addressIndex: 0 }).getHdKey().publicExtendedKey; // depth 5
    assert.throws(() => parseAccountXpub(leaf), /depth 4/);
    const coin = HDKey.fromExtendedKey(mnemonicToAccount(MNEMONIC, { path: "m/44'/60'/0'" }).getHdKey().publicExtendedKey);
    assert.equal(coin.depth, 3);
    assert.throws(() => parseAccountXpub(coin.publicExtendedKey), /depth 4/);
  });

  test("refuses garbage", () => {
    assert.throws(() => parseAccountXpub("xpub-not-really"), /not a valid extended public key/);
  });
});

describe("bscConfigFromEnv", () => {
  const xpub = xpubOf(MNEMONIC);
  const token = "0x1111111111111111111111111111111111111111";

  test("null when the lane isn't configured", () => {
    assert.equal(bscConfigFromEnv({}), null);
    assert.equal(bscConfigFromEnv({ BSC_DEPOSIT_XPUB: xpub }), null);
    assert.equal(bscConfigFromEnv({ BSC_TOKEN_ADDRESS: token }), null);
  });

  test("defaults to 18 decimals; checksums the token", () => {
    const cfg = bscConfigFromEnv({ BSC_DEPOSIT_XPUB: xpub, BSC_TOKEN_ADDRESS: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" });
    assert.ok(cfg);
    assert.equal(cfg.decimals, 18);
    assert.equal(cfg.token, "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD");
    assert.equal(bscConfigFromEnv({ BSC_DEPOSIT_XPUB: xpub, BSC_TOKEN_ADDRESS: token, BSC_TOKEN_DECIMALS: "6" })?.decimals, 6);
  });

  test("throws on a malformed config", () => {
    assert.throws(() => bscConfigFromEnv({ BSC_DEPOSIT_XPUB: xpub, BSC_TOKEN_ADDRESS: "0x123" }), /not an EVM address/);
    assert.throws(() => bscConfigFromEnv({ BSC_DEPOSIT_XPUB: xpub, BSC_TOKEN_ADDRESS: token, BSC_TOKEN_DECIMALS: "1.5" }), /DECIMALS/);
    const xprv = mnemonicToAccount(MNEMONIC, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey().privateExtendedKey;
    assert.throws(() => bscConfigFromEnv({ BSC_DEPOSIT_XPUB: xprv, BSC_TOKEN_ADDRESS: token }), /private key/);
  });
});

describe("uncompressPublicKey", () => {
  test("round-trips both parities against the account's own uncompressed key", () => {
    const acct = mnemonicToAccount(MNEMONIC, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey();
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const child = acct.deriveChild(i);
      const compressed = child.publicKey!;
      seen.add(compressed[0]!);
      const account = mnemonicToAccount(MNEMONIC, { addressIndex: i });
      assert.equal(uncompressPublicKey(compressed), account.publicKey); // viem's account.publicKey is 0x04‖x‖y
    }
    assert.deepEqual([...seen].sort(), [2, 3]);
  });

  test("rejects a point that isn't on the curve", () => {
    const bad = new Uint8Array(33);
    bad[0] = 2;
    bad[32] = 5; // x = 5: 5³ + 7 = 132 is not a square mod p
    assert.throws(() => uncompressPublicKey(bad), /not on secp256k1/);
  });
});
