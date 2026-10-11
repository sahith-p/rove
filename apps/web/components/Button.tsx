// Primary (solid ink, faint gloss) / secondary (transparent, hairline) button. One height: 52px.
// Renders <a> when `href` is given, else <button type="button">. `icon` sits before the label (a spinner replaces it
// while loading). No hooks, so it works in server and client components (pass onClick only from client components).
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

interface CommonProps {
  variant?: "primary" | "secondary";
  fullWidth?: boolean;
  disabled?: boolean;
  /** Shows a spinner and blocks clicks; keep the label meaningful (e.g. "Paying…"). */
  loading?: boolean;
  /** Leading icon, e.g. a lucide icon at size 18. */
  icon?: ReactNode;
  /** Trailing icon, e.g. ArrowUpRight for external links. */
  trailingIcon?: ReactNode;
  className?: string;
  children: ReactNode;
}

type ButtonElProps = CommonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & { href?: undefined };
type AnchorElProps = CommonProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & { href: string };

export type ButtonProps = ButtonElProps | AnchorElProps;

function classes(p: Pick<CommonProps, "variant" | "fullWidth" | "disabled" | "loading" | "className">): string {
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

function Label({ loading, icon, trailingIcon, children }: Pick<CommonProps, "loading" | "icon" | "trailingIcon" | "children">) {
  return (
    <>
      {loading ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.label}>{children}</span>
      {trailingIcon && !loading ? (
        <span className={styles.icon} aria-hidden="true">
          {trailingIcon}
        </span>
      ) : null}
    </>
  );
}

export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const { variant, fullWidth, disabled, loading, icon, trailingIcon, className, children, href, ...anchor } = props;
    const inert = disabled || loading;
    return (
      <a
        {...anchor}
        href={inert ? undefined : href}
        aria-disabled={inert || undefined}
        aria-busy={loading || undefined}
        tabIndex={inert ? -1 : anchor.tabIndex}
        className={classes({ variant, fullWidth, disabled, loading, className })}
      >
        <Label loading={loading} icon={icon} trailingIcon={trailingIcon}>
          {children}
        </Label>
      </a>
    );
  }

  const { variant, fullWidth, disabled, loading, icon, trailingIcon, className, children, href: _href, type = "button", ...button } = props;
  return (
    <button
      {...button}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes({ variant, fullWidth, disabled, loading, className })}
    >
      <Label loading={loading} icon={icon} trailingIcon={trailingIcon}>
        {children}
      </Label>
    </button>
  );
}
