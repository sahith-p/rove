// Shown for a missing / tampered / expired / mismatched confirm token, and when the countdown runs out.
import { Clock } from "lucide-react";
import { CardFrame, CardTitle, IconBadge } from "../../../components";
import styles from "./confirm.module.css";

export function ExpiredView({ card = false }: { card?: boolean }) {
  if (card) {
    return (
      <CardFrame eyebrow="Your request">
        <IconBadge>
          <Clock size={20} strokeWidth={1.5} />
        </IconBadge>
        <CardTitle sub="Ask Rove again. Nothing happened.">This request expired.</CardTitle>
      </CardFrame>
    );
  }
  return (
    <main className={styles.page}>
      <div className={styles.result}>
        <IconBadge>
          <Clock size={22} strokeWidth={1.5} />
        </IconBadge>
        <h1 className={`twoTone ${styles.headline}`}>
          <span>This request expired.</span>
          <span>Ask Rove again.</span>
        </h1>
        <p className="muted">Requests last 5 minutes. Nothing happened, and nothing will until you confirm a new one.</p>
      </div>
    </main>
  );
}
