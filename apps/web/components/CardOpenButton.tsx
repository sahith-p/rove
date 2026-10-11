"use client";
// The card's one action. Inside an iMessage App card the webview has no new-window handler, so target=_blank does
// nothing: try a new window (Safari / a browser tab), and if the host refuses one, navigate this webview in place.
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "./Button";

export function CardOpenButton({ href, children, icon, variant = "primary" }: { href: string; children: ReactNode; icon?: ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <Button
      href={href}
      fullWidth
      variant={variant}
      icon={icon}
      trailingIcon={<ArrowUpRight size={16} strokeWidth={1.75} />}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        let w: Window | null = null;
        try {
          w = window.open(href, "_blank");
        } catch {
          w = null;
        }
        if (w) w.opener = null;
        else window.location.assign(href);
      }}
    >
      {children}
    </Button>
  );
}
