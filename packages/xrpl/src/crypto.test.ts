import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptSeed, encryptSeed, generateEncryptionKey } from "./crypto";

const SEED = "sEdNOTAREALSEEDjustATestString"; // any string; the cipher doesn't care

test("encrypt/decrypt round-trip", () => {
  const key = generateEncryptionKey();
  assert.match(key, /^[0-9a-f]{64}$/);
  const enc = encryptSeed(SEED, key);
  assert.ok(enc.startsWith("v1:"));
  assert.ok(!enc.includes(SEED));
  assert.equal(decryptSeed(enc, key), SEED);
});

test("each encryption uses a fresh IV", () => {
  const key = generateEncryptionKey();
  assert.notEqual(encryptSeed(SEED, key), encryptSeed(SEED, key));
});

test("tampered ciphertext, tag or iv is rejected", () => {
  const key = generateEncryptionKey();
  const enc = encryptSeed(SEED, key);
  const [v, iv, tag, ct] = enc.split(":") as [string, string, string, string];
  const flip = (b64: string) => {
    const buf = Buffer.from(b64, "base64url");
    buf[0] = (buf[0] ?? 0) ^ 0x01;
    return buf.toString("base64url");
  };
  assert.throws(() => decryptSeed([v, iv, tag, flip(ct)].join(":"), key), /authentication failed/);
  assert.throws(() => decryptSeed([v, iv, flip(tag), ct].join(":"), key), /authentication failed/);
  assert.throws(() => decryptSeed([v, flip(iv), tag, ct].join(":"), key), /authentication failed/);
});

test("wrong key is rejected", () => {
  const enc = encryptSeed(SEED, generateEncryptionKey());
  assert.throws(() => decryptSeed(enc, generateEncryptionKey()), /authentication failed/);
});

test("bad key and bad format give clear errors", () => {
  assert.throws(() => encryptSeed(SEED, undefined), /WALLET_ENCRYPTION_KEY is not set/);
  assert.throws(() => encryptSeed(SEED, "abcd"), /64 hex/);
  assert.throws(() => decryptSeed("nope", generateEncryptionKey()), /unknown format/);
});
