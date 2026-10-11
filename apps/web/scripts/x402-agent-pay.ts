// A minimal "AI agent" that pays a Rove invoice over x402 v2 in AUSD on Base Sepolia. It holds AUSD but no ETH: it only
// signs an ERC-3009 authorization; Rove verifies it and Rove's worker relays it (and pays the gas).
//
//   pnpm --filter web exec tsx scripts/x402-agent-pay.ts <invoice code> [base url]
//   env: X402_AGENT_PRIVATE_KEY (testnet only; read from .env.ausd / .env at the repo root if not set),
//        ROVE_BASE_URL (default http://localhost:3000)
import { privateKeyToAccount } from "viem/accounts";
import { payX402 } from "../app/api/x402/client";
import { loadRepoEnv } from "./env-file";

async function main(): Promise<void> {
  loadRepoEnv();
  const code = process.argv[2];
  if (!code) throw new Error("usage: x402-agent-pay.ts <invoice code> [base url]");
  const base = (process.argv[3] ?? process.env.ROVE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const key = process.env.X402_AGENT_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("X402_AGENT_PRIVATE_KEY is not set (run scripts/ausd-keygen.ts)");
  const agent = privateKeyToAccount(key as `0x${string}`);

  const url = `${base}/api/x402/invoices/${encodeURIComponent(code)}`;
  console.log(`agent ${agent.address} → GET ${url}`);
  const out = await payX402(url, agent, { log: (m) => console.log(m) });

  console.log(`\nHTTP ${out.status}`);
  console.log("receipt:", JSON.stringify(out.body, null, 2));
  if (out.paymentResponse) console.log("PAYMENT-RESPONSE:", JSON.stringify(out.paymentResponse, null, 2));
  if (out.paymentResponse?.transaction) console.log(`Basescan: https://sepolia.basescan.org/tx/${out.paymentResponse.transaction}`);
  if (out.status !== 200) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
