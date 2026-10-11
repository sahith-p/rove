// Deposit keys (worker only). Owner: Nithya · Task: NI-C6.
// The web derives deposit ADDRESSES from the account xpub (apps/web/app/api/_lib/bsc.ts); the worker holds the
// mnemonic, so it can derive the same addresses WITH their keys, to sweep (or hand-refund) a deposit later.
// Path: m/44'/60'/0'/0/<index>; index from db.nextDepositIndex() (starts at 1; 0 is left for a collector).

import { toHex, type Address } from "viem";
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const DEPOSIT_ACCOUNT_PATH = "m/44'/60'/0'/0";

export interface DepositKeyring {
  /** Account xpub (m/44'/60'/0'/0): goes to the web as BSC_DEPOSIT_XPUB. Public. */
  xpub: string;
  /** Signing account for m/44'/60'/0'/0/<index>. */
  account(index: number): PrivateKeyAccount;
  address(index: number): Address;
  /** Index of a deposit address, scanning 0..maxIndex (sweeps / manual refunds look keys up by address). */
  indexOf(address: string, maxIndex: number): number | null;
}

/** Derives the BIP-39 seed once (PBKDF2), then children of the account node. */
export function depositKeyring(mnemonic: string): DepositKeyring {
  const node = mnemonicToAccount(mnemonic, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey();
  const account = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) throw new Error(`deposit index out of range: ${index}`);
    const child = node.deriveChild(index);
    if (!child.privateKey) throw new Error(`no private key at index ${index}`);
    return privateKeyToAccount(toHex(child.privateKey));
  };
  return {
    xpub: node.publicExtendedKey,
    account,
    address: (index) => account(index).address,
    indexOf(address, maxIndex) {
      const want = address.toLowerCase();
      for (let i = 0; i <= maxIndex; i++) if (account(i).address.toLowerCase() === want) return i;
      return null;
    },
  };
}

export const xpubFromMnemonic = (mnemonic: string): string => depositKeyring(mnemonic).xpub;
