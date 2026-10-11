"use client";
// Live withdrawal status + step-up confirm. Polls GET /api/withdrawals/:id every 1s until a terminal state.
// In fixture mode (data came from _fixtures.ts) it simulates the worker instead: ~1.5s per step after confirming.
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmActionRes, ROUTES, WITHDRAWAL_LIMITS, WithdrawalRes, cmp, money } from "@rove/shared";
import { Check, Fingerprint, Landmark, ShieldCheck, Wallet } from "lucide-react";
import {
  Amount,
  Button,
  Card,
  CardAmount,
  CardDots,
  CardFrame,
  CardLine,
  CardLink,
  CardTitle,
  IconBadge,
  IconTile,
  Notice,
  Row,
  Rows,
  StatusPill,
  StatusStepper,
  type PillTone,
} from "../../../components";
import { format } from "../../../lib/ui/format";
import { sessionHeaders } from "../../../lib/ui/headers";
import { nextFixtureStatus, withdrawalFixture } from "./_fixtures";
import { buildSteps, headline, isProblem, isTerminal, problemText, type Tone, type WithdrawalView as View } from "./steps";
import styles from "./withdrawal.module.css";

const POLL_MS = 1000;
const FIXTURE_STEP_MS = 1500;

export interface WithdrawalViewProps {
  withdrawalId: string;
  initial: View | null;
  /** Merchant session token (`t`) for x-rove-session. */
  token: string | null;
  /** Pending action id + confirm token from the card URL (`?a=&c=`), for the step-up. */
  actionId: string | null;
  confirmToken: string | null;
  fixture: boolean;
  /** Card mode (`?card=1`): render the compact in-card layout; this is the full page's URL for its button. */
  cardHref?: string | null;
}

type ConfirmState = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

export function WithdrawalView({ withdrawalId, initial, token, actionId, confirmToken, fixture, cardHref = null }: WithdrawalViewProps) {
  const [view, setView] = useState<View | null>(initial);
  const [loadError, setLoadError] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "idle" });
  const failures = useRef(0);

  const status = view?.status;
  const terminal = status ? isTerminal(status) : false;

  // Live polling (real API).
  useEffect(() => {
    if (fixture || !token || terminal) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch(ROUTES.withdrawal(withdrawalId), { headers: sessionHeaders(token), cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = WithdrawalRes.safeParse(await res.json());
        if (!parsed.success) throw new Error("bad response");
        failures.current = 0;
        setLoadError(false);
        if (!stopped) setView(parsed.data);
        if (isTerminal(parsed.data.status)) return;
      } catch {
        failures.current += 1;
        if (failures.current >= 3) setLoadError(true);
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, initial ? POLL_MS : 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [fixture, token, terminal, withdrawalId, initial]);

  // Fixture mode: walk the demo flow. A step-up withdrawal waits on "requested" until confirmed here;
  // one without step-up pretends the 👍 arrived from Messages after a moment.
  useEffect(() => {
    if (!fixture || !view) return;
    if (view.status === "requested" && view.needsStepUp && confirm.kind !== "sent") return;
    const next = nextFixtureStatus(view);
    if (!next) return;
    const delay = view.status === "requested" && !view.needsStepUp ? 3000 : FIXTURE_STEP_MS;
    const timer = setTimeout(() => {
      setView((v) => (v ? withdrawalFixture(v.id, next, v.destination.kind, v.needsStepUp) : v));
    }, delay);
    return () => clearTimeout(timer);
  }, [fixture, view, confirm.kind]);

  const onConfirm = useCallback(async () => {
    setConfirm({ kind: "sending" });
    if (actionId && confirmToken) {
      try {
        const res = await fetch(ROUTES.confirmAction(actionId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: confirmToken }),
        });
        if (res.ok) {
          const parsed = ConfirmActionRes.safeParse(await res.json());
          const st = parsed.success ? parsed.data.action.status : "executing";
          if (st === "expired" || st === "cancelled" || st === "failed") {
            setConfirm({ kind: "error", message: confirmFailure(st) });
            return;
          }
          setConfirm({ kind: "sent" });
          return;
        }
        if (!fixture) {
          setConfirm({
            kind: "error",
            message: res.status === 401 || res.status === 403 || res.status === 410 ? confirmFailure("expired") : "Couldn't confirm. Try again.",
          });
          return;
        }
      } catch {
        if (!fixture) {
          setConfirm({ kind: "error", message: "No connection. Try again." });
          return;
        }
      }
    }
    if (fixture) {
      // Demo: the confirm API isn't live yet, so act as if it accepted.
      await new Promise((r) => setTimeout(r, 600));
      setConfirm({ kind: "sent" });
      return;
    }
    setConfirm({ kind: "error", message: "Open this page from the withdrawal message in Messages to confirm." });
  }, [actionId, confirmToken, fixture]);

  if (!view && cardHref) {
    return (
      <CardFrame eyebrow="Withdrawal" action={<CardLink href={cardHref}>Open withdrawal</CardLink>}>
        <CardTitle sub={loadError ? "We'll keep trying." : undefined}>{loadError ? "Couldn't load this withdrawal" : "Loading…"}</CardTitle>
      </CardFrame>
    );
  }

  if (!view) {
    return (
      <main className={styles.page}>
        {loadError ? (
          <Notice variant="error" title="Couldn't load this withdrawal">
            Check your connection. We'll keep trying.
          </Notice>
        ) : (
          <div className={styles.loading} aria-busy="true">
            <span className={styles.loadingSpinner} aria-hidden="true" />
            Loading withdrawal…
          </div>
        )}
      </main>
    );
  }

  const bank = view.destination.kind === "bank";
  const head = headline(view);
  const needsConfirm = view.needsStepUp && view.status === "requested";
  const canConfirm = fixture || (!!actionId && !!confirmToken);
  const large = cmp(view.amount, money(WITHDRAWAL_LIMITS.stepUpAboveSgd, view.amount.currency)) > 0;
  const feeText = cmp(view.fee, money("0", view.fee.currency)) === 0 ? "Free" : format(view.fee);
  const speed = bank ? "FAST, about a minute" : "XRPL, a few seconds";
  const steps = buildSteps(view);
  if (view.status === "requested" && confirm.kind === "sent" && steps[0]) {
    steps[0] = { ...steps[0], detail: "Confirmed · starting…" };
  }

  if (cardHref) {
    const done = head.tone === "done";
    return (
      <CardFrame
        status={
          <StatusPill tone={PILL_TONE[head.tone]} role="status" live>
            {head.label}
          </StatusPill>
        }
        demo={fixture}
        label="Withdrawal"
        action={
          needsConfirm && canConfirm && confirm.kind !== "sent" ? (
            <Button fullWidth onClick={onConfirm} loading={confirm.kind === "sending"} icon={<Fingerprint size={18} strokeWidth={1.5} />}>
              {confirm.kind === "sending" ? "Confirming…" : "Confirm withdrawal"}
            </Button>
          ) : (
            <CardLink href={cardHref} variant="secondary">
              Details
            </CardLink>
          )
        }
      >
        <CardAmount money={view.amount} struck={head.tone === "problem"} />
        <CardDots steps={steps} />
        {done && view.bankRef ? (
          <CardLine mono icon={<Landmark size={14} strokeWidth={1.5} />}>
            {view.bankRef}
          </CardLine>
        ) : confirm.kind === "error" ? (
          <CardLine>{confirm.message}</CardLine>
        ) : (
          <CardLine icon={bank ? <Landmark size={14} strokeWidth={1.5} /> : <Wallet size={14} strokeWidth={1.5} />}>
            {bank ? view.destination.label : `Wallet ${view.destination.label}`} · {feeText}
          </CardLine>
        )}
      </CardFrame>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headTop}>
          {head.tone === "done" ? (
            <IconBadge tone="success">
              <Check size={24} strokeWidth={2.25} />
            </IconBadge>
          ) : null}
          <StatusPill tone={PILL_TONE[head.tone]} role="status" live className={styles.pill}>
            {head.label}
          </StatusPill>
        </div>
        <Amount label="Withdrawal" money={view.amount} className={head.tone === "problem" ? styles.amountMuted : undefined} />
      </header>

      <Rows>
        <Row
          label="To"
          icon={bank ? <Landmark size={15} strokeWidth={1.5} /> : <Wallet size={15} strokeWidth={1.5} />}
          value={bank ? view.destination.label : `Wallet ${view.destination.label}`}
        />
        <Row
          label="Fee"
          value={
            <>
              {feeText} <span className={styles.speed}>· {speed}</span>
            </>
          }
        />
        {view.bankRef ? <Row label="Reference" value={view.bankRef} mono /> : null}
      </Rows>

      {needsConfirm ? (
        <section className={styles.stepUp} aria-labelledby="stepup-title">
          <div className={styles.stepUpHead}>
            <IconTile>
              <ShieldCheck size={18} strokeWidth={1.5} />
            </IconTile>
            <div className={styles.stepUpText}>
              <div id="stepup-title" className={styles.stepUpTitle}>
                Confirm it&apos;s you
              </div>
              <div className={styles.stepUpLine}>
                {large
                  ? `Withdrawals over ${format(money(WITHDRAWAL_LIMITS.stepUpAboveSgd, view.amount.currency))} need a quick confirm here.`
                  : "First withdrawal to this account. Confirm here."}
              </div>
            </div>
          </div>
          <Button
            fullWidth
            onClick={onConfirm}
            loading={confirm.kind === "sending"}
            disabled={!canConfirm || confirm.kind === "sent"}
            icon={confirm.kind === "sent" ? <Check size={18} strokeWidth={2} /> : <Fingerprint size={18} strokeWidth={1.5} />}
          >
            {confirm.kind === "sending" ? "Confirming…" : confirm.kind === "sent" ? "Confirmed" : `Confirm withdrawal`}
          </Button>
          {confirm.kind === "error" ? <Notice variant="error">{confirm.message}</Notice> : null}
          {!canConfirm ? (
            <p className={styles.hint}>Open this page from the withdrawal message in Messages to confirm.</p>
          ) : null}
        </section>
      ) : null}

      <Card label="Progress">
        <StatusStepper steps={steps} />
      </Card>

      {isProblem(view.status) ? (
        <Notice variant={view.status === "cancelled" ? "info" : "error"} title={view.failureReason ?? head.label}>
          {problemText(view)}
        </Notice>
      ) : null}

      {loadError ? <p className={styles.hint}>Reconnecting…</p> : null}

      {bank ? (
        <Notice variant="simulated" title="Bank payout simulated (demo)">
          Everything before it is live on the XRPL testnet.
        </Notice>
      ) : (
        <p className={styles.hint}>Live on the XRPL testnet.</p>
      )}
    </main>
  );
}

const PILL_TONE: Record<Tone, PillTone> = { waiting: "pending", progress: "progress", done: "success", problem: "error" };

function confirmFailure(status: "expired" | "cancelled" | "failed"): string {
  if (status === "expired") return "This confirm link expired. Say “withdraw” to Rove for a new one.";
  if (status === "cancelled") return "This withdrawal was cancelled.";
  return "Couldn't confirm this withdrawal. Nothing moved.";
}
