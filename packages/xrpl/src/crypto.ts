// Merchant seed custody (demo): AES-256-GCM with WALLET_ENCRYPTION_KEY (32 bytes, hex).
// Format: "v1:<iv b64url>:<tag b64url>:<ciphertext b64url>". GCM authenticates, so any tampering throws.
// Production would use MPC/KMS or a regulated custodian (docs/specs/withdrawals.md §1).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(keyHex: string | undefined): Buffer {
  if (!keyHex) throw new Error("WALLET_ENCRYPTION_KEY is not set (32-byte hex). Merchant seeds can't be encrypted or decrypted.");
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex.trim())) throw new Error("WALLET_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(keyHex.trim(), "hex");
}

/** A fresh random key, 64 hex characters. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

export function encryptSeed(seed: string, keyHex: string | undefined): string {
  const key = keyBytes(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(seed, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSeed(enc: string, keyHex: string | undefined): string {
  const key = keyBytes(keyHex);
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("encrypted seed: unknown format");
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("encrypted seed: bad iv or tag");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("encrypted seed: authentication failed (wrong WALLET_ENCRYPTION_KEY or tampered data)");
  }
}
