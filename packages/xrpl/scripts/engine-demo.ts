// pnpm --filter @rove/xrpl engine:demo — the whole engine on XRPL testnet (NI-A4 + NI-A5 evidence).
//  1. createMerchantAccount for a fresh merchant (funding, trust lines, Credential); a second call is a no-op
//  2. isVerifiedMerchant from a READ-ONLY engine (public config, no seeds)
//  3. settle S$20.00 (USD → AMM → XSGD); replaying the same paymentId returns the same tx
//  4. refund S$5.00 (merchant → treasury, XSGD)
//  5. sweep S$7.50 to REDEMPTION (bank withdrawal, on-chain half); replay returns the same tx
//  6. settle S$3.00 from the treasury's XSGD float (SGD payer / bounced-withdrawal path)
//  7. sendToWallet: clear errors for an unactivated wallet and one without an XSGD line, then S$2.00 to a wallet
//  8. balances add up: merchant 20 − 5 − 7.50 + 3 − 2 = 8.50, plus the counterparties' deltas
// Loads .env.seed (run `pnpm seed` first). The fresh merchant's seed lives in memory only (testnet, discarded).

import { add, money, sub, type Money } from "@rove/shared";
import { Wallet } from "xrpl";
import { xsgdBalance } from "../src/balance";
import { currencyFromHex, plainDecimal } from "../src/currency";
import {
  createXrplSettlement,
  explorerAccountUrl,
  memorySeedStore,
  XrplDestinationError,
  xrplConfigFromEnv,
  type XrplConfig,
} from "../src/index";
import { findLine, getTrustLines } from "../src/ledger";
import { submitTx } from "../src/submit";
import { buildTrustSet, buildXrpPayment } from "../src/tx";
import { loadScriptEnv, testnetWss } from "./_env";

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
}
const sgd = (v: string) => money(v, "SGD");
const id = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  loadScriptEnv();
  testnetWss();
  const full = xrplConfigFromEnv();
  const publicOnly: XrplConfig = {
    wss: full.wss,
    usdIssuer: full.usdIssuer,
    sgdIssuer: full.sgdIssuer,
    treasuryAddress: full.treasuryAddress,
    redemptionAddress: full.redemptionAddress,
    credentialIssuerAddress: full.credentialIssuerAddress,
  };
  const txs: { label: string; hash: string }[] = [];
  const seeds = memorySeedStore();
  const engine = createXrplSettlement(full, { seedStore: seeds, onTx: (label, o) => txs.push({ label, hash: o.hash }) });
  const web = createXrplSettlement(publicOnly); // what the web app has: no seeds at all
  const ctx = engine.context;
  const redemption = ctx.redemptionAddress();
  const treasury = ctx.treasuryAddress();
  const rlusd = async (addr: string) => plainDecimal(findLine(await getTrustLines(ctx.conn, addr, ctx.usd().issuer), ctx.usd().currency, ctx.usd().issuer)?.balance ?? "0");

  try {
    // 1. Fresh merchant.
    const merchantId = `demo-${Date.now().toString(36)}`;
    console.log(`\n1. createMerchantAccount(${merchantId})`);
    const m = await engine.createMerchantAccount({ merchantId });
    const merchant = m.xrplAddress;
    const lines = await getTrustLines(ctx.conn, merchant);
    console.log(`   ${explorerAccountUrl(merchant)}`);
    console.log(`   credentialStatus=${m.credentialStatus} · trust lines: ${lines.map((l) => `${currencyFromHex(l.currency)}@${l.account}`).join(", ")}`);
    check(m.credentialStatus === "accepted", "credential accepted");
    check(lines.length === 2, "two trust lines");
    check((await seeds.get(merchant))?.startsWith("v1:"), "seed stored encrypted");
    let before = txs.length;
    const again = await engine.createMerchantAccount({ merchantId });
    check(again.xrplAddress === merchant && txs.length === before, "second create is a no-op");
    console.log("   second createMerchantAccount: same address, 0 new txs");

    // 2. Verification, read-only.
    const ahseng = process.env.DEMO_MERCHANT_XRPL_ADDRESS;
    const v = {
      fresh: await web.isVerifiedMerchant(merchant),
      ahseng: ahseng ? await web.isVerifiedMerchant(ahseng) : false,
      treasury: await web.isVerifiedMerchant(treasury),
      garbage: await web.isVerifiedMerchant("not-an-address"),
    };
    console.log(`\n2. isVerifiedMerchant (read-only engine): ${JSON.stringify(v)}`);
    check(v.fresh && v.ahseng && !v.treasury && !v.garbage, "verification");

    const start = {
      treasuryXsgd: await xsgdBalance(ctx, treasury),
      treasuryRlusd: await rlusd(treasury),
      redemption: await xsgdBalance(ctx, redemption),
    };

    // 3. Settle S$20.00 from USD; replay is idempotent.
    const pay1 = id("pay");
    const q = await web.quote({ local: sgd("20.00") }); // quotes come from the web app, read-only
    console.log(`\n3. quote S$20.00 ← US$${q.usd.amount} @ ${q.rate} (SendMax ${q.sendMaxUsd}) · settle ${pay1}`);
    const s1 = await engine.settle({ paymentId: pay1, merchantAddress: merchant, local: q.local, sendMaxUsd: q.sendMaxUsd, from: "USD" });
    console.log(`   delivered ${s1.delivered} XSGD ${engine.explorerUrl(s1.txHash)}`);
    check(s1.delivered === "20.00", "delivered 20.00");
    before = txs.length;
    const s1again = await engine.settle({ paymentId: pay1, merchantAddress: merchant, local: q.local, sendMaxUsd: q.sendMaxUsd });
    check(s1again.txHash === s1.txHash && txs.length === before, "settle replay returns the same tx");
    console.log("   replay of the same paymentId: same tx, nothing paid twice");

    // 4. Refund S$5.00.
    const r = await engine.refund({ paymentId: pay1, merchantAddress: merchant, local: sgd("5.00") });
    console.log(`\n4. refund S$5.00 → treasury ${engine.explorerUrl(r.txHash)}`);

    // 5. Sweep S$7.50 to REDEMPTION; replay is idempotent.
    const wd1 = id("wd");
    const sw = await engine.sweepToRedemption({ withdrawalId: wd1, merchantAddress: merchant, local: sgd("7.50") });
    console.log(`\n5. sweep ${wd1} S$7.50 → REDEMPTION ${engine.explorerUrl(sw.txHash)}`);
    before = txs.length;
    const swAgain = await engine.sweepToRedemption({ withdrawalId: wd1, merchantAddress: merchant, local: sgd("7.50") });
    check(swAgain.txHash === sw.txHash && txs.length === before, "sweep replay returns the same tx");
    console.log("   replay of the same withdrawalId: same tx");

    // 6. Settle S$3.00 from the XSGD float (also the bounced-withdrawal return path: any id string works).
    const wdBounce = id("wd");
    const s2 = await engine.settle({ paymentId: wdBounce, merchantAddress: merchant, local: sgd("3.00"), sendMaxUsd: "0", from: "SGD" });
    console.log(`\n6. settle from SGD float S$3.00 (id ${wdBounce}) delivered ${s2.delivered} ${engine.explorerUrl(s2.txHash)}`);
    check(s2.delivered === "3.00", "delivered 3.00");

    // 7. sendToWallet.
    console.log("\n7. sendToWallet");
    const unactivated = Wallet.generate().address;
    const e1 = await engine.sendToWallet({ withdrawalId: id("wd"), merchantAddress: merchant, local: sgd("2.00"), address: unactivated }).catch((e) => e);
    check(e1 instanceof XrplDestinationError && e1.reason === "no_account", "unactivated wallet error");
    console.log(`   unactivated wallet → "${e1.message}"`);
    const own = Wallet.generate(); // stands in for the merchant's self-custody wallet
    await submitTx(ctx, ctx.treasuryWallet(), buildXrpPayment({ account: treasury, destination: own.address, drops: "2000000" }), { label: "activate test wallet (2 XRP)" });
    const wdNoLine = id("wd");
    const e2 = await engine.sendToWallet({ withdrawalId: wdNoLine, merchantAddress: merchant, local: sgd("2.00"), address: own.address }).catch((e) => e);
    check(e2 instanceof XrplDestinationError && e2.reason === "no_trust_line", "no trust line error");
    console.log(`   wallet without XSGD line → "${e2.message}"`);
    await submitTx(ctx, own, buildTrustSet({ account: own.address, ...ctx.sgd() }), { label: "test wallet TrustSet XSGD" });
    check((await engine.checkWalletDestination({ address: own.address, local: sgd("2.00") })) === null, "pre-check passes after trust line");
    const sent = await engine.sendToWallet({ withdrawalId: wdNoLine, merchantAddress: merchant, local: sgd("2.00"), address: own.address });
    console.log(`   S$2.00 → ${own.address} ${engine.explorerUrl(sent.txHash)}`);

    // 8. Balances add up.
    const merchantBal = await web.balance({ merchantAddress: merchant }); // read-only
    const expected: Money = sub(add(sub(sub(sgd("20.00"), sgd("5.00")), sgd("7.50")), sgd("3.00")), sgd("2.00"));
    const end = {
      treasuryXsgd: await xsgdBalance(ctx, treasury),
      treasuryRlusd: await rlusd(treasury),
      redemption: await xsgdBalance(ctx, redemption),
      wallet: await xsgdBalance(ctx, own.address),
    };
    const dTreasuryXsgd = sub(end.treasuryXsgd, start.treasuryXsgd);
    const dRedemption = sub(end.redemption, start.redemption);
    console.log("\n8. balances (XSGD)");
    console.log(`   merchant   ${merchantBal.amount}  (expected 20.00 − 5.00 − 7.50 + 3.00 − 2.00 = ${expected.amount})`);
    console.log(`   treasury   ${start.treasuryXsgd.amount} → ${end.treasuryXsgd.amount}  (Δ ${dTreasuryXsgd.amount}: +5.00 refund − 3.00 SGD settle)`);
    console.log(`   redemption ${start.redemption.amount} → ${end.redemption.amount}  (Δ ${dRedemption.amount})`);
    console.log(`   wallet     ${end.wallet.amount}`);
    console.log(`   treasury RLUSD ${start.treasuryRlusd} → ${end.treasuryRlusd} (paid the AMM for the S$20.00 settle)`);
    check(merchantBal.amount === expected.amount, "merchant balance");
    check(dTreasuryXsgd.amount === "2.00", "treasury XSGD delta");
    check(dRedemption.amount === "7.50", "redemption delta");
    check(end.wallet.amount === "2.00", "wallet balance");
    // Conservation: every XSGD that left the treasury float or arrived from the AMM is accounted for.
    const xsgdIn = add(sgd("20.00"), sgd("3.00")); // AMM swap + float
    const xsgdOut = add(add(sgd("5.00"), dRedemption), end.wallet);
    check(sub(xsgdIn, xsgdOut).amount === merchantBal.amount, "conservation");
    console.log(`   conservation: in ${xsgdIn.amount} − out ${xsgdOut.amount} = merchant ${merchantBal.amount} ✓`);

    console.log(`\nTransactions (${txs.length}):`);
    for (const t of txs) console.log(`   ${t.label}: ${engine.explorerUrl(t.hash)}`);
    console.log("\nengine:demo PASS");
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error("engine:demo failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});
