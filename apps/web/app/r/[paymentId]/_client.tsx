"use client";
// Client bits for /r/[paymentId]: the print button and the 1s "Settling…" poller.
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "../../../components/Button";

export function SaveReceiptButton({ className }: { className?: string }) {
  return (
    <Button variant="secondary" fullWidth className={className} onClick={() => window.print()}>
      Save receipt
    </Button>
  );
}

/**
 * While the payment is pending, re-render the server page every second (router.refresh re-runs the server
 * component, which re-fetches the status). Unmounts, and so stops, once the page renders a final status.
 * Backs off to 5s after two minutes so a stuck payment doesn't hammer the API.
 */
export function SettlingPoller() {
  const router = useRouter();
  useEffect(() => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
      timer = setTimeout(tick, Date.now() - started > 120_000 ? 5_000 : 1_000);
    };
    timer = setTimeout(tick, 1_000);
    return () => clearTimeout(timer);
  }, [router]);
  return null;
}
