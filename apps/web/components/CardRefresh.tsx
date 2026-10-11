"use client";
// Card mode: silently re-render the server card every `ms` while it's visible, so an open card flips to
// "Paid" / "Done" without a tap. Renders nothing.
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function CardRefresh({ ms = 3000 }: { ms?: number }) {
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
