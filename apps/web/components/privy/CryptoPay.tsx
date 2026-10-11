"use client";
// Crypto pay buttons (SH-A4). Loaded lazily by ./lazy.tsx; owns its PrivyProvider so Privy never loads on other pages.
//
// AUSD (Agora, Base Sepolia 84532, gasless; docs/specs/ausd-lane.md):
//   wallet (Privy login: email → embedded wallet, or an injected wallet) → POST /api/checkout {method:"ausd"}
//   → signTypedData ERC-3009 TransferWithAuthorization (domain + authorization from the response, from = the wallet)
//   → POST /api/ausd/authorize {paymentId, from, signature} → page polls. Rove relays and pays the gas.
// BNB Chain (test USDT, BSC testnet 97; docs/specs/bnb-lane.md):
//   POST /api/checkout {method:"bnb"} → panel with the deposit address + amount + EIP-681 QR (any wallet), and
//   "Send from my wallet": ERC-20 transfer(depositAddress, units) from the Privy / injected wallet → page polls.
//   The panel also polls, so a payment sent from another wallet moves the page on by itself.
// Amounts and addresses only ever come from the checkout response.
import { useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { PaymentStatusRes, ROUTES } from "@rove/shared";
import { Check, CircleAlert, Copy, Wallet, X } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { createWalletClient, custom, encodeFunctionData, erc20Abi, getAddress, parseUnits, type Address, type Hex } from "viem";
import { baseSepolia, bscTestnet } from "viem/chains";
import { Button } from "../Button";
import { CryptoButtons } from "./CryptoButtons";
import type { CryptoCheckout, CryptoMethod, CryptoPayProps } from "./config";
import { RovePrivyProvider } from "./RovePrivyProvider";
import styles from "./privy.module.css";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const PANEL_POLL_MS = 3000;
const WALLET_WAIT_MS = 45_000;

type WalletAction = (wallet: ConnectedWallet) => Promise<void>;

export default function CryptoPay(props: CryptoPayProps) {
  return (
    <RovePrivyProvider>
      <CryptoFlow {...props} />
    </RovePrivyProvider>
  );
}

function rejected(err: unknown): boolean {
  const e = err as { code?: number; name?: string; message?: string; shortMessage?: string } | null;
  const text = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return e?.code === 4001 || e?.name === "UserRejectedRequestError" || text.includes("user rejected") || text.includes("rejected the request") || text.includes("denied");
}

function lowGas(err: unknown): boolean {
  const e = err as { message?: string; shortMessage?: string; details?: string } | null;
  const text = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.details ?? ""}`.toLowerCase();
  return text.includes("insufficient funds") || text.includes("exceeds balance") || text.includes("gas required exceeds");
}

/** The wallet the payer logged in with (linked), else the most recently connected one. */
function pickWallet(wallets: ConnectedWallet[], linked: string | undefined): ConnectedWallet | null {
  if (wallets.length === 0) return null;
  const l = linked?.toLowerCase();
  return wallets.find((w) => w.address.toLowerCase() === l) ?? wallets[0] ?? null;
}

function CryptoFlow({ handlers, disabled = false, onBusyChange }: CryptoPayProps) {
  const { ready, authenticated, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [busy, setBusy] = useState<CryptoMethod | null>(null);
  const [busyLabel, setBusyLabel] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);
  const [bnb, setBnb] = useState<CryptoCheckout | null>(null);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pending = useRef<{ action: WalletAction; fail: () => void } | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const linked = user?.wallet?.address;
  const wallet = authenticated ? pickWallet(wallets, linked) : null;

  const cancelPending = useCallback((message: string | null) => {
    const p = pending.current;
    pending.current = null;
    setWaiting(false);
    p?.fail();
    if (message) setError(message);
  }, []);

  const { login } = useLogin({
    onError: (err) => {
      if (pending.current) cancelPending(String(err) === "exited_auth_flow" ? null : "Couldn't sign in to a wallet. Please try again.");
    },
  });

  // Lock the page's other buttons while a crypto step (or the BNB deposit panel) is in progress.
  const locked = busy !== null || sending || bnb !== null;
  useEffect(() => onBusyChange?.(locked), [locked, onBusyChange]);

  // Run the queued action once a wallet is connected (after login, the embedded wallet appears a moment later).
  useEffect(() => {
    if (!waiting || !authenticated || !walletsReady || !wallet) return;
    const p = pending.current;
    pending.current = null;
    setWaiting(false);
    if (p) void p.action(wallet);
  }, [waiting, authenticated, walletsReady, wallet]);

  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => cancelPending("Your wallet took too long to connect. Please try again."), WALLET_WAIT_MS);
    return () => clearTimeout(t);
  }, [waiting, cancelPending]);

  /** Run `action` with a connected wallet, logging in first if needed. `fail` resets the caller's spinner. */
  const withWallet = useCallback(
    (action: WalletAction, fail: () => void) => {
      if (!ready) {
        fail();
        return setError("The wallet is still loading. Try again in a second.");
      }
      if (wallet) return void action(wallet);
      pending.current = { action, fail };
      setWaiting(true);
      if (!authenticated) login();
    },
    [ready, wallet, authenticated, login],
  );

  // ------------------------------------------------------------------ AUSD

  const payAusd = useCallback(
    async (w: ConnectedWallet) => {
      setBusyLabel("Starting…");
      const c = await handlersRef.current.start("ausd");
      if (!c) return setBusy(null);
      const a = c.ausd;
      if (!a) {
        setBusy(null);
        return setError("AUSD isn't available for this payment. Try another method.");
      }
      try {
        setBusyLabel("Confirm in your wallet…");
        await w.switchChain(a.domain.chainId).catch(() => undefined); // injected wallets reject typed data for another chain
        const from = getAddress(w.address);
        const client = createWalletClient({ account: from, chain: baseSepolia, transport: custom(await w.getEthereumProvider()) });
        const signature = await client.signTypedData({
          account: from,
          domain: {
            name: a.domain.name,
            version: a.domain.version,
            chainId: a.domain.chainId,
            verifyingContract: getAddress(a.domain.verifyingContract),
          },
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message: {
            from,
            to: getAddress(a.authorization.to),
            value: BigInt(a.authorization.value),
            validAfter: BigInt(a.authorization.validAfter),
            validBefore: BigInt(a.authorization.validBefore),
            nonce: a.authorization.nonce as Hex,
          },
        });
        setBusyLabel("Sending…");
        const res = await fetch(ROUTES.ausdAuthorize, {
          method: "POST",
          cache: "no-store",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ paymentId: c.paymentId, from, signature }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
          setBusy(null);
          if (body?.error === "insufficient_funds") return setError(`This wallet (${short(from)}) doesn't have ${a.amount} AUSD on Base Sepolia.`);
          return setError(body?.message ?? "Couldn't send the authorization. Please try again.");
        }
        handlersRef.current.submitted(c);
      } catch (err) {
        setBusy(null);
        setError(rejected(err) ? "Cancelled in your wallet." : "Your wallet couldn't sign this. Please try again.");
      }
    },
    [],
  );

  // ------------------------------------------------------------------ BNB

  const startBnb = useCallback(async () => {
    setBusyLabel("Starting…");
    const c = await handlersRef.current.start("bnb");
    setBusy(null);
    if (!c) return;
    if (!c.bnb) return setError("BNB Chain isn't available for this payment. Try another method.");
    setBnb(c);
  }, []);

  const sendBnb = useCallback(
    async (w: ConnectedWallet) => {
      const c = bnb;
      const b = c?.bnb;
      if (!c || !b) return setSending(false);
      try {
        await w.switchChain(b.chainId);
        const account = getAddress(w.address);
        const client = createWalletClient({ account, chain: bscTestnet, transport: custom(await w.getEthereumProvider()) });
        await client.sendTransaction({
          account,
          chain: bscTestnet,
          to: getAddress(b.token),
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [getAddress(b.depositAddress) as Address, parseUnits(b.amount, b.decimals)],
          }),
        });
        handlersRef.current.submitted(c);
      } catch (err) {
        setSending(false);
        setError(
          rejected(err)
            ? "Cancelled in your wallet."
            : lowGas(err)
              ? `This wallet (${short(w.address)}) needs ${b.amount} test USDT plus a little tBNB for gas. Or send from another wallet with the details below.`
              : "Couldn't send from this wallet. Try again, or send from another wallet with the details below.",
        );
      }
    },
    [bnb],
  );

  // The deposit panel polls too: USDT sent from any wallet moves the page to its processing state.
  const bnbId = bnb?.paymentId ?? null;
  useEffect(() => {
    if (!bnbId || !bnb) return;
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch(ROUTES.payment(encodeURIComponent(bnbId)), { cache: "no-store", headers: { accept: "application/json" } });
        if (!res.ok || stopped) return;
        const p = PaymentStatusRes.safeParse(await res.json());
        if (p.success && p.data.status !== "created" && !stopped) handlersRef.current.submitted(bnb);
      } catch {
        /* keep polling */
      }
    }, PANEL_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [bnbId, bnb]);

  // ------------------------------------------------------------------ render

  const onPick = (method: CryptoMethod) => {
    if (locked || disabled) return;
    setError(null);
    setBusy(method);
    if (method === "ausd") {
      setBusyLabel(wallet ? "Starting…" : "Connecting wallet…");
      withWallet(payAusd, () => setBusy(null));
    } else {
      void startBnb();
    }
  };

  const errorLine = error ? (
    <p className={styles.error} role="alert">
      <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
      {error}
    </p>
  ) : null;

  if (bnb?.bnb) {
    return (
      <div className={styles.crypto}>
        <div className={styles.divider} aria-hidden="true">
          <span>or pay with crypto</span>
        </div>
        <BnbPanel
          checkout={bnb}
          sending={sending}
          walletLabel={wallet ? short(wallet.address) : null}
          onSend={() => {
            setError(null);
            setSending(true);
            withWallet(sendBnb, () => setSending(false));
          }}
          onClose={() => {
            setBnb(null);
            setSending(false);
            setError(null);
          }}
        />
        {errorLine}
      </div>
    );
  }

  return (
    <>
      <CryptoButtons onPick={onPick} busy={busy} busyLabel={busyLabel} disabled={disabled} />
      {errorLine}
    </>
  );
}

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function BnbPanel({
  checkout,
  sending,
  walletLabel,
  onSend,
  onClose,
}: {
  checkout: CryptoCheckout;
  sending: boolean;
  walletLabel: string | null;
  onSend: () => void;
  onClose: () => void;
}) {
  const b = checkout.bnb!;
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<"address" | "amount" | null>(null);

  useEffect(() => {
    let alive = true;
    let uri: string;
    try {
      // EIP-681: call transfer(address, uint256) on the token contract, on chain 97.
      uri = `ethereum:${getAddress(b.token)}@${b.chainId}/transfer?address=${getAddress(b.depositAddress)}&uint256=${parseUnits(b.amount, b.decimals).toString()}`;
    } catch {
      return;
    }
    QRCode.toString(uri, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#0a0a0a", light: "#ffffff" } })
      .then((svg) => alive && setQr(svg))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [b.token, b.chainId, b.depositAddress, b.amount, b.decimals]);

  const copy = (what: "address" | "amount", text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
      },
      () => undefined,
    );
  };

  return (
    <section className={styles.panel} aria-label="Pay with a BNB Chain wallet">
      <div className={styles.panelHead}>
        <span className="eyebrow">BNB Chain · test USDT</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Use another method">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <Button fullWidth onClick={onSend} loading={sending} icon={<Wallet size={18} strokeWidth={1.75} />}>
        {sending ? "Confirm in your wallet…" : walletLabel ? `Send from ${walletLabel}` : "Send from my wallet"}
      </Button>
      <p className={styles.or}>or send from any BSC testnet wallet</p>
      {qr ? <div className={styles.qr} role="img" aria-label="QR code for this payment" dangerouslySetInnerHTML={{ __html: qr }} /> : <div className={styles.qr} />}
      <dl className={styles.facts}>
        <div>
          <dt>Amount</dt>
          <dd>
            <span className={styles.mono}>{b.amount} USDT</span>
            <button type="button" className={styles.copy} onClick={() => copy("amount", b.amount)} aria-label="Copy amount">
              {copied === "amount" ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
            </button>
          </dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>
            <span className={`${styles.mono} ${styles.address}`}>{b.depositAddress}</span>
            <button type="button" className={styles.copy} onClick={() => copy("address", b.depositAddress)} aria-label="Copy address">
              {copied === "address" ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
            </button>
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>BSC testnet (chain 97)</dd>
        </div>
      </dl>
      <p className={styles.hint}>This page moves on by itself once the transfer confirms.</p>
    </section>
  );
}
