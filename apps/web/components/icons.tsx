// Brand + flag marks lucide-react doesn't ship. Everything else uses lucide (1.5px stroke) directly.
// Static clipPath ids are fine to repeat: every instance defines the same geometry.
import type { Currency } from "@rove/shared";

interface MarkProps {
  size?: number;
  className?: string;
}

/** The Apple logo (for the Apple Pay button). Fills with currentColor. */
export function AppleLogo({ size = 18, className }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M16.37 1.43c0 1.14-.49 2.27-1.18 3.08-.74.9-1.99 1.57-2.99 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.57-2.27 1.21-2.98.8-.94 2.14-1.64 3.25-1.68.03.13.05.28.05.43zm4.56 15.71c-.03.07-.46 1.58-1.52 3.12-.94 1.34-1.94 2.71-3.43 2.71-1.52 0-1.9-.88-3.63-.88-1.7 0-2.3.91-3.67.91-1.38 0-2.33-1.26-3.43-2.8C4 18.38 2.96 15.57 2.96 12.92c0-4.28 2.8-6.55 5.55-6.55 1.45 0 2.68.95 3.6.95.87 0 2.22-1.01 3.9-1.01.61 0 2.89.06 4.37 2.19-.13.09-2.38 1.37-2.38 4.19 0 3.26 2.85 4.42 2.96 4.45z" />
    </svg>
  );
}

/** Simplified monochrome BNB Chain mark: two chevrons + three diamonds. */
export function BnbMark({ size = 18, className }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M12 2.5l5 5-1.9 1.9L12 6.3 8.9 9.4 7 7.5z" />
      <path d="M12 21.5l-5-5 1.9-1.9 3.1 3.1 3.1-3.1 1.9 1.9z" />
      <path d="M12 9.8l2.2 2.2-2.2 2.2L9.8 12z" />
      <path d="M4.9 10.1L6.8 12l-1.9 1.9L3 12z" />
      <path d="M19.1 10.1L21 12l-1.9 1.9L17.2 12z" />
    </svg>
  );
}

/** Round US flag. */
export function FlagUS({ size = 18, className }: MarkProps) {
  const h = 24 / 13;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <clipPath id="rove-flag-clip-us">
          <circle cx="12" cy="12" r="12" />
        </clipPath>
      </defs>
      <g clipPath="url(#rove-flag-clip-us)">
        <rect width="24" height="24" fill="#ffffff" />
        {[0, 2, 4, 6, 8, 10, 12].map((i) => (
          <rect key={i} y={i * h} width="24" height={h} fill="#D22F3C" />
        ))}
        <rect width="11.5" height={h * 7} fill="#2A3D7A" />
        {[
          [2.6, 2.6],
          [5.8, 2.6],
          [9, 2.6],
          [4.2, 5.4],
          [7.4, 5.4],
          [2.6, 8.2],
          [5.8, 8.2],
          [9, 8.2],
          [4.2, 11],
          [7.4, 11],
        ].map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="0.7" fill="#ffffff" />
        ))}
      </g>
      <circle cx="12" cy="12" r="11.5" fill="none" style={{ stroke: "var(--line)" }} strokeWidth="1" />
    </svg>
  );
}

/** Round Singapore flag. */
export function FlagSG({ size = 18, className }: MarkProps) {
  const stars = Array.from({ length: 5 }, (_, i) => {
    const a = (-90 + i * 72) * (Math.PI / 180);
    return [9.7 + 2 * Math.cos(a), 6.4 + 2 * Math.sin(a)] as const;
  });
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <clipPath id="rove-flag-clip-sg">
          <circle cx="12" cy="12" r="12" />
        </clipPath>
      </defs>
      <g clipPath="url(#rove-flag-clip-sg)">
        <rect width="24" height="24" fill="#ffffff" />
        <rect width="24" height="12" fill="#E8333F" />
        <circle cx="6.4" cy="6.4" r="3.6" fill="#ffffff" />
        <circle cx="7.8" cy="6.4" r="3.4" fill="#E8333F" />
        {stars.map(([cx, cy]) => (
          <circle key={`${cx.toFixed(2)}-${cy.toFixed(2)}`} cx={cx} cy={cy} r="0.65" fill="#ffffff" />
        ))}
      </g>
      <circle cx="12" cy="12" r="11.5" fill="none" style={{ stroke: "var(--line)" }} strokeWidth="1" />
    </svg>
  );
}

/** The flag for a currency: SGD → SG, USD → US; any other code gets a neutral hairline disc with its first letter. */
export function CurrencyFlag({ currency, size = 18, className }: MarkProps & { currency: Currency }) {
  if (currency === "SGD") return <FlagSG size={size} className={className} />;
  if (currency === "USD") return <FlagUS size={size} className={className} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <circle cx="12" cy="12" r="11.5" fill="none" style={{ stroke: "var(--line)" }} strokeWidth="1" />
      <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor" fontFamily="var(--font)">
        {String(currency).charAt(0)}
      </text>
    </svg>
  );
}
