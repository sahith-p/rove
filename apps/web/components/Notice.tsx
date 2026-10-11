// Inline message in a hairline frame: info · success · error · simulated (label demo-only parts, e.g. "Bank payout
// simulated (demo)"). Color lives only in the icon (and an error's title); the frame stays one border color.
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, FlaskConical, Info } from "lucide-react";
import styles from "./Notice.module.css";

export type NoticeVariant = "info" | "success" | "error" | "simulated";

export interface NoticeProps {
  variant?: NoticeVariant;
  title?: string;
  children?: ReactNode;
  className?: string;
}

const ICON = { info: Info, success: CircleCheck, error: CircleAlert, simulated: FlaskConical } as const;

export function Notice({ variant = "info", title, children, className }: NoticeProps) {
  const Icon = ICON[variant];
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={[styles.notice, styles[variant], className].filter(Boolean).join(" ")}
    >
      <Icon size={18} strokeWidth={1.5} className={styles.icon} aria-hidden="true" />
      <div className={styles.body}>
        {title ? <div className={styles.title}>{title}</div> : null}
        {children ? <div className={styles.text}>{children}</div> : null}
      </div>
    </div>
  );
}
