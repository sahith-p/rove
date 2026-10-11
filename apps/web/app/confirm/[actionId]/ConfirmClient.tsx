"use client";
// Confirm / Cancel buttons + countdown + result. One POST per tap: we render the state the API returns and never
// poll by re-POSTing (confirm isn't something to spam). Rove follows up in chat when the action finishes.
import { useEffect, useRef, useState } from "react";
import { ConfirmActionRes, ROUTES, type PendingActionViewZ } from "@rove/shared";
import type { z } from "zod";
import { Check, Clock, ShieldCheck, X } from "lucide-react";
import {
  Button,
  Card,
  CardFrame,
  CardLine,
  CardTitle,
  IconBadge,
  Notice,
  Row,
  Rows,
  StatusPill,
  StatusStepper,
  type Step,
} from "../../../components";
import { ExpiredView } from "./ExpiredView";
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
  /** Card mode (`?card=1`): compact in-card layout; Confirm / Cancel still work in place. */
  card?: boolean;
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

export function ConfirmClient({ actionId, token, summary, expiresAt, initial, fixtures, unverified, card = false }: ConfirmClientProps) {
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

  if (status === "expired") return <ExpiredView card={card} />;

  const open = status === "proposed";

  if (card) {
    const result =
      status === "done"
        ? { title: "Done", sub: "Rove will message you the details.", icon: <Check size={22} strokeWidth={2.25} />, tone: "success" as const }
        : status === "cancelled"
          ? { title: "Cancelled", sub: "Nothing happened.", icon: <X size={20} strokeWidth={1.5} />, tone: "neutral" as const }
          : status === "failed"
            ? { title: "Didn't go through", sub: "Rove will message you.", icon: <X size={20} strokeWidth={1.75} />, tone: "error" as const }
            : { title: "Working on it…", sub: "Confirmed by you.", icon: <span className={styles.bigSpinner} />, tone: "neutral" as const };
    return (
      <CardFrame
        eyebrow={open ? "Rove needs your OK" : "Your request"}
        status={
          open ? (
            <StatusPill tone="pending" icon={<Clock size={13} strokeWidth={1.75} />}>
              <span className="mono" suppressHydrationWarning>
                {mmss(left)}
              </span>
            </StatusPill>
          ) : undefined
        }
        demo={fixtures && (unverified || simulated)}
        label="Confirm request"
        action={
          open ? (
            <>
              <Button fullWidth onClick={onConfirm} loading={submitting} icon={<Check size={18} strokeWidth={2} />}>
                {submitting ? "Confirming…" : error ? "Try again" : "Confirm"}
              </Button>
              <Button fullWidth variant="secondary" disabled={submitting} onClick={() => setStatus("cancelled")}>
                Cancel
              </Button>
            </>
          ) : undefined
        }
      >
        {open ? (
          <>
            <CardTitle>{summary ?? "Confirm this request"}</CardTitle>
            <CardLine>{error ?? "Nothing happens until you confirm."}</CardLine>
          </>
        ) : (
          <div role="status" aria-live="polite" className={styles.cardResult}>
            <IconBadge tone={result.tone}>{result.icon}</IconBadge>
            <CardTitle sub={result.sub}>{result.title}</CardTitle>
          </div>
        )}
      </CardFrame>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className="eyebrow">{open ? "Rove needs your OK" : "Your request"}</span>
        <h1 className={`twoTone ${styles.headline}`}>
          <span>{summary ?? "Confirm this request"}</span>
          {open ? <span className={styles.headlineSub}>Nothing happens until you confirm.</span> : null}
        </h1>
      </header>

      {open ? (
        <>
          <Rows>
            <Row
              label="Expires in"
              icon={<Clock size={15} strokeWidth={1.5} />}
              mono
              value={
                <strong className={styles.timer} suppressHydrationWarning aria-live="off">
                  {mmss(left)}
                </strong>
              }
            />
          </Rows>

          {error ? <Notice variant="error">{error}</Notice> : null}

          <div className={styles.actions}>
            <Button fullWidth onClick={onConfirm} loading={submitting} icon={<Check size={18} strokeWidth={2} />}>
              {submitting ? "Confirming…" : error ? "Try again" : "Confirm"}
            </Button>
            <Button
              fullWidth
              variant="secondary"
              disabled={submitting}
              onClick={() => setStatus("cancelled")}
              icon={<X size={18} strokeWidth={1.75} />}
            >
              Cancel
            </Button>
          </div>

          <p className={styles.hint}>You can also reply 👍 to the message in chat.</p>
        </>
      ) : (
        <Result status={status} />
      )}

      <p className={styles.security}>
        <ShieldCheck size={15} strokeWidth={1.5} aria-hidden="true" />
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
        <IconBadge>
          <X size={22} strokeWidth={1.5} />
        </IconBadge>
        <h2>Cancelled. Nothing happened.</h2>
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
            <IconBadge>
              <span className={styles.bigSpinner} />
            </IconBadge>
            <h2>Confirmed. Working on it…</h2>
            <p className="muted">Rove will message you when it&apos;s done.</p>
          </>
        ) : status === "done" ? (
          <>
            <IconBadge tone="success">
              <Check size={24} strokeWidth={2.25} />
            </IconBadge>
            <h2>Done</h2>
            <p className="muted">Rove will message you the details in chat.</p>
          </>
        ) : (
          <>
            <IconBadge tone="error">
              <X size={22} strokeWidth={1.75} />
            </IconBadge>
            <h2>That didn&apos;t go through</h2>
            <p className="muted">Rove will message you with what happened. You can ask again in chat.</p>
          </>
        )}
      </div>
      <Card label="Status">
        <StatusStepper steps={steps} />
      </Card>
    </div>
  );
}
