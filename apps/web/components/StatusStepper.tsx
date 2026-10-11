// Vertical status steps, reused by /pay, /w and /confirm. E.g. Requested ✓ → On XRPL ✓ → Sent to bank … → In your bank.
// A thin rail with small nodes: filled ink = done, ring with a pulsing dot = current, hollow = todo, red × = failed.
// `href` links the step's detail (or a "View" link when there's no detail), e.g. to a tx on the XRPL explorer;
// linked details and `mono` details (hashes, references) render in Geist Mono.
import { ArrowUpRight, Check, X } from "lucide-react";
import styles from "./StatusStepper.module.css";

export type StepState = "done" | "current" | "todo" | "failed";

export interface Step {
  label: string;
  state: StepState;
  detail?: string;
  href?: string;
  /** Render the detail in monospace (a reference like FAST-881245). Linked details are always mono. */
  mono?: boolean;
}

export interface StatusStepperProps {
  steps: Step[];
  className?: string;
}

const SR_STATE: Record<StepState, string> = { done: "done", current: "in progress", todo: "not started", failed: "failed" };

export function StatusStepper({ steps, className }: StatusStepperProps) {
  return (
    <ol className={[styles.steps, className].filter(Boolean).join(" ")}>
      {steps.map((step, i) => (
        <li
          key={`${i}-${step.label}`}
          className={`${styles.step} ${styles[step.state]}`}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span className={styles.node} aria-hidden="true">
            {step.state === "done" ? <Check size={11} strokeWidth={3} /> : step.state === "failed" ? <X size={11} strokeWidth={3} /> : null}
          </span>
          <div className={styles.body}>
            <div className={styles.label}>
              {step.label}
              <span className="sr-only"> ({SR_STATE[step.state]})</span>
            </div>
            {step.detail || step.href ? (
              <div className={`${styles.detail} ${step.href || step.mono ? styles.mono : ""}`}>
                {step.href ? (
                  <a href={step.href} target="_blank" rel="noopener noreferrer" className={styles.link}>
                    {step.detail ?? "View"}
                    <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
                  </a>
                ) : (
                  step.detail
                )}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
