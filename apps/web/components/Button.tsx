// Black rounded primary / outline secondary button. Renders <a> when `href` is given, else <button type="button">.
// No hooks, so it works in server and client components (pass onClick only from client components).
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

interface CommonProps {
  variant?: "primary" | "secondary";
  fullWidth?: boolean;
  disabled?: boolean;
  /** Shows a spinner and blocks clicks; keep the label meaningful (e.g. "Paying…"). */
  loading?: boolean;
  className?: string;
  children: ReactNode;
}

type ButtonElProps = CommonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & { href?: undefined };
type AnchorElProps = CommonProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & { href: string };

export type ButtonProps = ButtonElProps | AnchorElProps;

function classes(p: CommonProps): string {
  return [
    styles.button,
    p.variant === "secondary" ? styles.secondary : styles.primary,
    p.fullWidth && styles.fullWidth,
    p.disabled && styles.disabled,
    p.loading && styles.loading,
    p.className,
  ]
    .filter(Boolean)
    .join(" ");
}

function Label({ loading, children }: { loading?: boolean; children: ReactNode }) {
  return (
    <>
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
      <span>{children}</span>
    </>
  );
}

export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const { variant, fullWidth, disabled, loading, className, children, href, ...anchor } = props;
    const inert = disabled || loading;
    return (
      <a
        {...anchor}
        href={inert ? undefined : href}
        aria-disabled={inert || undefined}
        aria-busy={loading || undefined}
        tabIndex={inert ? -1 : anchor.tabIndex}
        className={classes({ variant, fullWidth, disabled, loading, className, children })}
      >
        <Label loading={loading}>{children}</Label>
      </a>
    );
  }

  const { variant, fullWidth, disabled, loading, className, children, href: _href, type = "button", ...button } = props;
  return (
    <button
      {...button}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes({ variant, fullWidth, disabled, loading, className, children })}
    >
      <Label loading={loading}>{children}</Label>
    </button>
  );
}
