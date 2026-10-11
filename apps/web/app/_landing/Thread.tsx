// A static, decorative iMessage-style thread for the landing page. Ink bubbles are the merchant, hairline bubbles are Rove.
import type { ReactNode } from "react";
import styles from "./landing.module.css";

export interface ThreadMessage {
  from: "me" | "rove";
  text: ReactNode;
  /** A one-time code rendered in a mono chip after the text. */
  code?: string;
  /** A tapback on the bubble (e.g. 👍 confirming a withdrawal). */
  reaction?: string;
  /** Extra content under the text, inside the bubble (a mini card). */
  attachment?: ReactNode;
}

export function Thread({ messages, label, className }: { messages: ThreadMessage[]; label?: string; className?: string }) {
  return (
    <div className={[styles.phone, className].filter(Boolean).join(" ")}>
      {label ? (
        <div className={styles.phoneTop}>
          <span className={styles.avatar} aria-hidden="true">
            R
          </span>
          <span className={styles.phoneName}>{label}</span>
        </div>
      ) : null}
      <ol className={styles.thread}>
        {messages.map((m, i) => (
          <li
            key={i}
            className={[m.from === "me" ? styles.me : styles.rove, m.reaction ? styles.reacted : ""].filter(Boolean).join(" ")}
          >
            <span className="sr-only">{m.from === "me" ? "Merchant: " : "Rove: "}</span>
            {m.text}
            {m.code ? <span className={styles.code}>{m.code}</span> : null}
            {m.attachment ? <div className={styles.attachment}>{m.attachment}</div> : null}
            {m.reaction ? (
              <span className={styles.reaction} aria-label={`Reacted ${m.reaction}`}>
                {m.reaction}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
