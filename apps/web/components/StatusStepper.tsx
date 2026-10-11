// Vertical status steps, reused by /pay, /w and /confirm. E.g. Requested ✓ → On XRPL ✓ → Sent to bank … → In your bank.
// `href` links the step's detail (or a "View" link when there's no detail), e.g. to a tx on the XRPL explorer.
import styles from "./StatusStepper.module.css";

export type StepState = "done" | "current" | "todo" | "failed";

export interface Step {
  label: string;
  state: StepState;
  detail?: string;
  href?: string;
}

export interface StatusStepperProps {
  steps: Step[];
  className?: string;
}

const MARK: Record<StepState, string> = { done: "✓", current: "", todo: "", failed: "✕" };
const SR_STATE: Record<StepState, string> = { done: "done", current: "in progress", todo: "not started", failed: "failed" };

export function StatusStepper({ steps, className }: StatusStepperProps) {
  return (
    <ol className={[styles.steps, className].filter(Boolean).join(" ")}>
      {steps.map((step, i) => (
        <li key={`${i}-${step.label}`} className={`${styles.step} ${styles[step.state]}`} aria-current={step.state === "current" ? "step" : undefined}>
          <span className={styles.marker} aria-hidden="true">
            {MARK[step.state]}
          </span>
          <div className={styles.body}>
            <div className={styles.label}>
              {step.label}
              <span className="sr-only"> ({SR_STATE[step.state]})</span>
            </div>
            {step.detail || step.href ? (
              <div className={styles.detail}>
                {step.href ? (
                  <a href={step.href} target="_blank" rel="noopener noreferrer">
                    {step.detail ?? "View"} ↗
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
