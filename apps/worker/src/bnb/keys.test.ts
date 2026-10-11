import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { english, generateMnemonic, HDKey, publicKeyToAddress } from "viem/accounts";
import { bytesToHex } from "viem";
import { depositKeyring, xpubFromMnemonic } from "./keys";

// Public Hardhat/Anvil mnemonic and its well-known accounts m/44'/60'/0'/0/<n>.
const MNEMONIC = "test test test test test test test test test test test junk";
const ANVIL: Record<number, string> = {
  0: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  1: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  2: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  19: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
};
/** Same constant as apps/web/app/api/_lib/bsc.test.ts: the web derives the Anvil addresses from exactly this xpub. */
const ANVIL_ACCOUNT_XPUB =
  "xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4";

/** The compressed public key of xpub child <index> (public derivation only, like the web). The web turns this into an
 *  address (apps/web/app/api/_lib/bsc.ts); here we check it is the key of the account the worker signs with. */
function compressedFromXpub(xpub: string, index: number): string {
  return bytesToHex(HDKey.fromExtendedKey(xpub).deriveChild(index).publicKey!);
}

describe("depositKeyring (worker side of the HD tree)", () => {
  const k = depositKeyring(MNEMONIC);

  test("the account xpub the web gets is m/44'/60'/0'/0 of the mnemonic", () => {
    assert.equal(k.xpub, ANVIL_ACCOUNT_XPUB);
    assert.equal(xpubFromMnemonic(MNEMONIC), ANVIL_ACCOUNT_XPUB);
    assert.equal(HDKey.fromExtendedKey(k.xpub).depth, 4);
    assert.match(k.xpub, /^xpub/); // never an xprv
  });

  test("addresses match the Anvil vectors", () => {
    for (const [i, addr] of Object.entries(ANVIL)) assert.equal(k.address(Number(i)), addr);
  });

  test("xpub-derived public key == mnemonic-derived key, for several indexes (so the worker can sign for what the web hands out)", () => {
    for (const i of [1, 2, 3, 50, 4096, 2 ** 31 - 1]) {
      const acct = k.account(i);
      const fromXpub = compressedFromXpub(k.xpub, i);
      const uncompressed = acct.publicKey; // 0x04 ‖ x ‖ y
      const x = uncompressed.slice(4, 68);
      const yOdd = BigInt(`0x${uncompressed.slice(68)}`) & 1n;
      assert.equal(fromXpub, `0x${yOdd ? "03" : "02"}${x}`, `index ${i}`);
      assert.equal(publicKeyToAddress(uncompressed), acct.address);
    }
  });

  test("distinct per index; indexOf finds a deposit's index (sweeps / manual refunds)", () => {
    const addrs = Array.from({ length: 20 }, (_, i) => k.address(i + 1));
    assert.equal(new Set(addrs).size, 20);
    assert.equal(k.indexOf(ANVIL[19]!.toLowerCase(), 25), 19);
    assert.equal(k.indexOf("0x0000000000000000000000000000000000000001", 25), null);
  });

  test("a fresh mnemonic: xpub is public, depth 4, and differs from Anvil's", () => {
    const m = generateMnemonic(english);
    const fresh = depositKeyring(m);
    assert.notEqual(fresh.xpub, ANVIL_ACCOUNT_XPUB);
    assert.equal(HDKey.fromExtendedKey(fresh.xpub).privateKey, null);
  });

  test("rejects hardened / negative indexes", () => {
    assert.throws(() => k.account(-1), /out of range/);
    assert.throws(() => k.account(2 ** 31), /out of range/);
  });
});
