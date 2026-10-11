"use client";
// Silently re-runs the server component every `ms` (no spinner, no layout shift). Pauses while the tab is hidden
// and refreshes as soon as it becomes visible again (e.g. switching back to the Messages thread).
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AutoRefresh({ ms = 10_000 }: { ms?: number }) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = window.setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, ms]);

  return null;
}
