// The two crypto buttons, without Privy: rendered as the placeholder while the wallet chunk loads, and by CryptoPay.
import { CircleDollarSign } from "lucide-react";
import { Button } from "../Button";
import { BnbMark } from "../icons";
import type { CryptoMethod } from "./config";
import styles from "./privy.module.css";

export interface CryptoButtonsProps {
  onPick?: (method: CryptoMethod) => void;
  busy?: CryptoMethod | null;
  /** Shown on the busy button. */
  busyLabel?: string;
  disabled?: boolean;
}

export function CryptoButtons({ onPick, busy = null, busyLabel = "Connecting…", disabled = false }: CryptoButtonsProps) {
  const locked = disabled || busy !== null || !onPick;
  return (
    <div className={styles.crypto}>
      <div className={styles.divider} aria-hidden="true">
        <span>or pay with crypto</span>
      </div>
      <Button
        fullWidth
        variant="secondary"
        onClick={() => onPick?.("ausd")}
        loading={busy === "ausd"}
        disabled={locked && busy !== "ausd"}
        icon={<CircleDollarSign size={18} strokeWidth={1.5} />}
        aria-label={busy === "ausd" ? undefined : "Pay with AUSD, no gas needed"}
      >
        {busy === "ausd" ? busyLabel : "Pay with AUSD · no gas"}
      </Button>
      <Button
        fullWidth
        variant="secondary"
        onClick={() => onPick?.("bnb")}
        loading={busy === "bnb"}
        disabled={locked && busy !== "bnb"}
        icon={<BnbMark size={18} />}
        aria-label={busy === "bnb" ? undefined : "Pay with a BNB Chain wallet"}
      >
        {busy === "bnb" ? busyLabel : "Pay with a BNB Chain wallet"}
      </Button>
    </div>
  );
}
