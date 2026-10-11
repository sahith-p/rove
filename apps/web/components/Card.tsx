// Soft gray rounded container.
import type { HTMLAttributes } from "react";
import styles from "./Card.module.css";

export type CardProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...rest }: CardProps) {
  return <div {...rest} className={[styles.card, className].filter(Boolean).join(" ")} />;
}
