// Test helpers for the AUSD lane (web side): a fake Base Sepolia reader, a test config, and EIP-712 signing with a viem
// test account. Nothing here touches the network.
//
//   const ausd = useAusdTestDeps();                 // installs config + fake chain for getAusdDeps()
//   const payer = testPayer(); ausd.chain.fund(payer.address, 50_000_000n);
//   const signature = await signAuthorization(payer, ausd.config, message);

import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { AUSD_BASE_SEPOLIA, ausdDomain, setAusdDepsForTests, TRANSFER_WITH_AUTHORIZATION_TYPES, type AusdChainReader, type AusdConfig, type TransferWithAuthorization } from "./ausd";

export const TEST_AUSD_CONFIG: AusdConfig = {
  chainId: AUSD_BASE_SEPOLIA.chainId,
  network: AUSD_BASE_SEPOLIA.network,
  rpcUrl: "http://base-sepolia.test",
  token: getAddress(AUSD_BASE_SEPOLIA.token),
  decimals: AUSD_BASE_SEPOLIA.decimals,
  payTo: getAddress("0xaD0E193bcd9A035aCb383681Bb21F7C3099f584B"),
  eip712Name: AUSD_BASE_SEPOLIA.eip712Name,
  eip712Version: AUSD_BASE_SEPOLIA.eip712Version,
};

export type FakeAusdChain = AusdChainReader & {
  fund(account: Address, units: bigint): void;
  markUsed(authorizer: Address, nonce: Hex): void;
  /** Make every read throw (RPC down). */
  failReads(on: boolean): void;
};

export function createFakeAusdChain(): FakeAusdChain {
  const balances = new Map<string, bigint>();
  const used = new Set<string>();
  let failing = false;
  const guard = () => {
    if (failing) throw new Error("fake RPC down");
  };
  return {
    async balanceOf(account) {
      guard();
      return balances.get(account.toLowerCase()) ?? 0n;
    },
    async authorizationState(authorizer, nonce) {
      guard();
      return used.has(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
    },
    fund(account, units) {
      balances.set(account.toLowerCase(), (balances.get(account.toLowerCase()) ?? 0n) + units);
    },
    markUsed(authorizer, nonce) {
      used.add(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
    },
    failReads(on) {
      failing = on;
    },
  };
}

export function useAusdTestDeps(config: AusdConfig = TEST_AUSD_CONFIG): { config: AusdConfig; chain: FakeAusdChain } {
  const chain = createFakeAusdChain();
  setAusdDepsForTests({ config, chain });
  return { config, chain };
}

export function testPayer(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export function signAuthorization(account: PrivateKeyAccount, config: AusdConfig, message: TransferWithAuthorization): Promise<Hex> {
  return account.signTypedData({ domain: ausdDomain(config), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message });
}
