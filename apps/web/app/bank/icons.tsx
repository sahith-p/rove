// Icons for /bank: thin wrappers over lucide-react so every page shares one 1.5px-stroke icon set.
import { Check, Lock } from "lucide-react";

export function LockIcon({ size = 16 }: { size?: number }) {
  return <Lock size={size} strokeWidth={1.5} aria-hidden="true" focusable="false" />;
}

export function CheckIcon({ size = 16 }: { size?: number }) {
  return <Check size={size} strokeWidth={2.25} aria-hidden="true" focusable="false" />;
}
