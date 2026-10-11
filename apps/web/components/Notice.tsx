// Inline message: info · success · error · simulated (label demo-only parts, e.g. "Bank payout simulated (demo)").
import type { ReactNode } from "react";
import styles from "./Notice.module.css";

export type NoticeVariant = "info" | "success" | "error" | "simulated";

export interface NoticeProps {
  variant?: NoticeVariant;
  title?: string;
  children?: ReactNode;
  className?: string;
}

const ICON: Record<NoticeVariant, string> = { info: "i", success: "✓", error: "!", simulated: "◇" };

export function Notice({ variant = "info", title, children, className }: NoticeProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={[styles.notice, styles[variant], className].filter(Boolean).join(" ")}
    >
      <span className={styles.icon} aria-hidden="true">
        {ICON[variant]}
      </span>
      <div className={styles.body}>
        {title ? <div className={styles.title}>{title}</div> : null}
        {children ? <div className={styles.text}>{children}</div> : null}
      </div>
    </div>
  );
}
