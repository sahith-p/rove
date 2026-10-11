// One-screen terminal state ("This code has expired", "Already paid", "Code not found"): icon badge, title, one line,
// then the facts that identify it (amount, code) in hairline rows. Used by /pay and /m.
import type { ReactNode } from "react";
import { IconBadge } from "./Bits";
import { Row, Rows } from "./Rows";
import styles from "./StateBlock.module.css";

export interface StateBlockProps {
  tone: "muted" | "success" | "error";
  icon: ReactNode;
  title: string;
  line: string;
  /** Hairline fact rows under the text, e.g. [["Amount", "S$12.50"], ["Code", "K7Q2MX", true]] (third = mono). */
  facts?: [label: string, value: string, mono?: boolean][];
}

export function StateBlock({ tone, icon, title, line, facts }: StateBlockProps) {
  return (
    <section className={styles.state} data-tone={tone}>
      <IconBadge tone={tone === "muted" ? "neutral" : tone}>{icon}</IconBadge>
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.line}>{line}</p>
      </div>
      {facts && facts.length > 0 ? (
        <Rows className={styles.facts}>
          {facts.map(([label, value, mono]) => (
            <Row key={label} label={label} value={value} mono={mono} />
          ))}
        </Rows>
      ) : null}
    </section>
  );
}
