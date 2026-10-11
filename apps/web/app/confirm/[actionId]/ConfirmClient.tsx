"use client";
// Confirm / Cancel buttons + countdown + result. One POST per tap: we render the state the API returns and never
// poll by re-POSTing (confirm isn't something to spam). Rove follows up in chat when the action finishes.
import { useEffect, useRef, useState } from "react";
import { ConfirmActionRes, ROUTES, type PendingActionViewZ } from "@rove/shared";
import type { z } from "zod";
import { Button, Card, Notice, StatusStepper, type Step } from "../../../components";
import { ClockIcon, ExpiredView } from "./ExpiredView";
import styles from "./confirm.module.css";

export type InitialState = "proposed" | "done";
type PendingActionView = z.infer<typeof PendingActionViewZ>;
type Status = PendingActionView["status"];

export interface ConfirmClientProps {
  actionId: string;
  token: string;
  summary: string | null;
  /** Epoch ms, from the confirm token's `exp`. */
  expiresAt: number;
  initial: InitialState;
  /** NEXT_PUBLIC_DEMO_FIXTURES=1: simulate the API while it returns 501. */
  fixtures: boolean;
  /** Fixture mode rendered without a valid token. */
  unverified: boolean;
}

const SIMULATED_EXEC_MS = 1500;

function remainingMs(expiresAt: number): number {
  return Math.max(0, expiresAt - Date.now());
}

function mmss(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ConfirmClient({ actionId, token, summary, expiresAt, initial, fixtures, unverified }: ConfirmClientProps) {
  const [status, setStatus] = useState<Status>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simulated, setSimulated] = useState(false);
  const [left, setLeft] = useState(() => remainingMs(expiresAt));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Countdown only matters while the request is still open.
  useEffect(() => {
    if (status !== "proposed" || submitting) return;
    const tick = () => {
      const ms = remainingMs(expiresAt);
      setLeft(ms);
      if (ms === 0) setStatus("expired");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, status, submitting]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function simulate() {
    setSimulated(true);
    setStatus("executing");
    timer.current = setTimeout(() => setStatus("done"), SIMULATED_EXEC_MS);
  }

  async function onConfirm() {
    if (submitting || status !== "proposed") return;
    setSubmitting(true);
    setError(null);
    let action: PendingActionView | null = null;
    try {
      const res = await fetch(ROUTES.confirmAction(actionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        cache: "no-store",
      });
      if (res.ok) {
        const parsed = ConfirmActionRes.safeParse(await res.json());
        if (parsed.success) action = parsed.data.action;
      }
    } catch {
      // network error: handled below
    }
    setSubmitting(false);

    if (action) {
      setStatus(action.status);
      return;
    }
    if (fixtures) {
      simulate();
      return;
    }
    // Nothing was claimed as far as we know. The API claims atomically, so one more deliberate tap is safe.
    setError("Couldn't reach Rove. Try again, or reply 👍 to the message in chat.");
  }

  if (status === "expired") return <ExpiredView />;

  const open = status === "proposed";

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{open ? "Rove needs your OK" : "Your request"}</p>
        <h1 className={styles.headline}>
          {summary ?? "Confirm this request"}
          {open ? <span className={styles.headlineSub}>Nothing happens until you confirm.</span> : null}
        </h1>
      </header>

      {open ? (
        <>
          <Card className={styles.timerCard}>
            <span className={styles.timerIcon} aria-hidden="true">
              <ClockIcon />
            </span>
            <span className={styles.timerText}>
              Expires in{" "}
              <strong className={styles.timer} suppressHydrationWarning aria-live="off">
                {mmss(left)}
              </strong>
            </span>
          </Card>

          {error ? <Notice variant="error">{error}</Notice> : null}

          <div className={styles.actions}>
            <Button fullWidth onClick={onConfirm} loading={submitting}>
              {submitting ? "Confirming…" : error ? "Try again" : "Confirm"}
            </Button>
            <Button fullWidth variant="secondary" disabled={submitting} onClick={() => setStatus("cancelled")}>
              Cancel
            </Button>
          </div>

          <p className={styles.hint}>You can also reply 👍 to the message in chat.</p>
        </>
      ) : (
        <Result status={status} />
      )}

      <p className={styles.security}>
        <LockIcon />
        <span>Only confirm requests you asked for.</span>
      </p>

      {fixtures && (unverified || simulated) ? (
        <Notice variant="simulated" title="Demo">
          {unverified ? "Link not verified (demo fixtures). " : null}
          {simulated ? "Confirmation simulated; no money moved." : null}
        </Notice>
      ) : null}
    </main>
  );
}

function Result({ status }: { status: Exclude<Status, "proposed" | "expired"> }) {
  if (status === "cancelled") {
    return (
      <div className={styles.result} role="status">
        <span className={`${styles.badge} ${styles.badgeMuted}`} aria-hidden="true">
          <XIcon />
        </span>
        <h2>Cancelled — nothing happened</h2>
        <p className="muted">You can close this. Ask Rove again any time.</p>
      </div>
    );
  }

  const steps: Step[] = [
    { label: "Requested", state: "done" },
    { label: "Confirmed by you", state: "done" },
    {
      label: status === "done" ? "Done" : status === "failed" ? "Didn't go through" : "Working on it",
      state: status === "done" ? "done" : status === "failed" ? "failed" : "current",
    },
  ];

  return (
    <div className={styles.resultBlock}>
      <div className={styles.result} role="status" aria-live="polite">
        {status === "executing" ? (
          <>
            <span className={`${styles.badge} ${styles.badgeBusy}`} aria-hidden="true">
              <span className={styles.bigSpinner} />
            </span>
            <h2>Confirmed. Working on it…</h2>
            <p className="muted">Rove will message you when it&apos;s done.</p>
          </>
        ) : status === "done" ? (
          <>
            <span className={`${styles.badge} ${styles.badgeSuccess}`} aria-hidden="true">
              <CheckIcon />
            </span>
            <h2>Done</h2>
            <p className="muted">Rove will message you the details in chat.</p>
          </>
        ) : (
          <>
            <span className={`${styles.badge} ${styles.badgeError}`} aria-hidden="true">
              <XIcon />
            </span>
            <h2>That didn&apos;t go through</h2>
            <p className="muted">Rove will message you with what happened. You can ask again in chat.</p>
          </>
        )}
      </div>
      <Card>
        <StatusStepper steps={steps} />
      </Card>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
