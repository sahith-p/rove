// Mints testnet AUSD from Agora's faucet contract on Base Sepolia to the given addresses (default: the x402 agent).
// The faucet is a plain contract call, requestFunds(address): 10,000 AUSD per call, a global 60s rate limit
// (MaxFrequencyExceeded), at most 100,000 AUSD held per address. The CALLER pays gas, so this uses the relayer key, which
// needs Base Sepolia ETH anyway. Source: https://docs.agora.finance/instant-settlement/guides/getting-testnet-tokens
//   pnpm --filter web exec tsx scripts/ausd-faucet.ts [address ...]
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { loadRepoEnv } from "./env-file";

const FAUCET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C"; // Agora docs, Contract Deployments → Testnet → Base Sepolia
const ABI = parseAbi([
  "function requestFunds(address to)",
  "function lastDripTimestamp() view returns (uint256)",
  "function maxDripFrequency() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

async function main(): Promise<void> {
  loadRepoEnv();
  const key = process.env.AUSD_RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("AUSD_RELAYER_PRIVATE_KEY is not set");
  const token = (process.env.AUSD_TOKEN_ADDRESS || "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC") as Address;
  const caller = privateKeyToAccount(key);
  const transport = http(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org");
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account: caller, chain: baseSepolia, transport });

  const agentKey = process.env.X402_AGENT_PRIVATE_KEY as Hex | undefined;
  const targets = (process.argv.slice(2).length ? process.argv.slice(2) : agentKey ? [privateKeyToAccount(agentKey).address] : []) as Address[];
  if (!targets.length) throw new Error("usage: ausd-faucet.ts <address ...>");

  const gas = await pub.getBalance({ address: caller.address });
  console.log(`caller ${caller.address} has ${formatUnits(gas, 18)} Base Sepolia ETH`);
  if (gas === 0n) throw new Error("the caller has no Base Sepolia ETH for gas: fund it from a Base Sepolia faucet first");

  for (const to of targets) {
    for (let attempt = 1; ; attempt++) {
      const [last, freq] = await Promise.all([
        pub.readContract({ address: FAUCET, abi: ABI, functionName: "lastDripTimestamp" }),
        pub.readContract({ address: FAUCET, abi: ABI, functionName: "maxDripFrequency" }),
      ]);
      const wait = Number(last + freq) - Math.floor(Date.now() / 1000);
      if (wait > 0) {
        console.log(`faucet rate limit: waiting ${wait + 2}s`);
        await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
      }
      try {
        const { request } = await pub.simulateContract({ address: FAUCET, abi: ABI, functionName: "requestFunds", args: [to], account: caller });
        const hash = await wallet.writeContract(request);
        const receipt = await pub.waitForTransactionReceipt({ hash });
        const bal = await pub.readContract({ address: token, abi: ABI, functionName: "balanceOf", args: [to] });
        console.log(`requestFunds(${to}): ${receipt.status} tx ${hash} → ${formatUnits(bal, 6)} AUSD`);
        break;
      } catch (e) {
        const msg = (e as { shortMessage?: string }).shortMessage ?? String(e);
        if (attempt >= 5) throw e;
        console.log(`faucet call failed (${msg}); retrying`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
