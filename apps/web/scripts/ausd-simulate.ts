// Live, read-only proof that Rove's ERC-3009 signing matches the real AUSD contract on Base Sepolia: signs authorizations
// with the agent key through apps/web/app/api/_lib/ausd.ts and eth_call-simulates transferWithAuthorization (no gas, no
// funds, nothing broadcast). A 0-value transfer only succeeds if the contract accepts the EIP-712 signature.
//   pnpm --filter web exec tsx scripts/ausd-simulate.ts
import { createPublicClient, encodeFunctionData, http, parseAbi, parseSignature, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  ausdConfigFromEnv,
  ausdDomain,
  createAusdChainReader,
  isValidAusdSignature,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  verifyAusdAuthorization,
  type TransferWithAuthorization,
} from "../app/api/_lib/ausd";
import { loadRepoEnv } from "./env-file";

const ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

async function main(): Promise<void> {
  loadRepoEnv();
  const config = ausdConfigFromEnv();
  if (!config) throw new Error("AUSD_PAY_TO is not set (run scripts/ausd-keygen.ts)");
  const key = process.env.X402_AGENT_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("X402_AGENT_PRIVATE_KEY is not set");
  const agent = privateKeyToAccount(key);
  const client = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
  const now = Math.floor(Date.now() / 1000);

  const sign = (m: TransferWithAuthorization) =>
    agent.signTypedData({ domain: ausdDomain(config), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: m });

  async function simulate(label: string, m: TransferWithAuthorization, signature: Hex) {
    const { r, s, v, yParity } = parseSignature(signature);
    const data = encodeFunctionData({
      abi: ABI,
      functionName: "transferWithAuthorization",
      args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, Number(v ?? 27n + BigInt(yParity ?? 0)), r, s],
    });
    try {
      await client.call({ to: config!.token, data, account: config!.payTo });
      console.log(`${label}: eth_call SUCCEEDED (the contract accepted the authorization)`);
    } catch (e) {
      const err = e as { shortMessage?: string; walk?: (fn: (x: unknown) => boolean) => unknown };
      const raw = (err.walk?.((x) => typeof (x as { data?: unknown }).data === "string") as { data?: string } | undefined)?.data;
      console.log(`${label}: eth_call reverted (${err.shortMessage ?? "?"})${raw ? ` data=${raw}` : ""}`);
    }
  }

  console.log(`chainId ${await client.getChainId()} token ${config.token} payTo ${config.payTo} agent ${agent.address}`);
  const base: TransferWithAuthorization = {
    from: agent.address,
    to: config.payTo,
    value: 0n,
    validAfter: 0n,
    validBefore: BigInt(now + 600),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const sig0 = await sign(base);
  console.log("local verifyTypedData:", await isValidAusdSignature(config, base, sig0));
  await simulate("value 0, correct signature", base, sig0);
  await simulate("value 0 signature replayed for value 1 (tampered)", { ...base, value: 1n }, sig0);

  const real = { ...base, value: 1_000_000n, nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  const sigReal = await sign(real);
  await simulate("1 AUSD, correct signature", real, sigReal);
  const verdict = await verifyAusdAuthorization({ config, chain: createAusdChainReader(config) }, real, sigReal, now);
  console.log("Rove verifier (real RPC reads) for 1 AUSD:", JSON.stringify(verdict));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
