// A payment code as segmented monospace cells (OTP style): [K][7][Q][2][M][X], framed by small corner ticks.
// Screen readers get one label with the characters spaced out so they're read one by one.
import styles from "./CodeCells.module.css";

export interface CodeCellsProps {
  code: string;
  size?: "lg" | "sm";
  className?: string;
}

export function CodeCells({ code, size = "lg", className }: CodeCellsProps) {
  const chars = Array.from(code);
  return (
    <div
      className={[styles.frame, size === "sm" && styles.sm, className].filter(Boolean).join(" ")}
      role="img"
      aria-label={`Code ${chars.join(" ")}`}
    >
      <span className={`${styles.tick} ${styles.tl}`} aria-hidden="true" />
      <span className={`${styles.tick} ${styles.tr}`} aria-hidden="true" />
      <span className={`${styles.tick} ${styles.bl}`} aria-hidden="true" />
      <span className={`${styles.tick} ${styles.br}`} aria-hidden="true" />
      {chars.map((c, i) => (
        <span key={i} className={styles.cell} aria-hidden="true">
          {c}
        </span>
      ))}
    </div>
  );
}
