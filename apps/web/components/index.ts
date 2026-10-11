// Shared UI for every page (SH-A1). Keep this to a handful of components.
// Amount and LineItems call @rove/shared at runtime. Its index also re-exports tokens.ts (node:crypto); next.config.mjs
// stubs node:crypto for client bundles, so they're fine in client components too.
// Design rules: one surface color, 1px hairlines in one border color, near-monochrome, Geist + Geist Mono.
export { Amount, type AmountProps } from "./Amount";
export { IconBadge, IconTile, PageFooter, StatusPill, Wordmark, type PillTone } from "./Bits";
export { Button, type ButtonProps } from "./Button";
export { Card, type CardProps } from "./Card";
export { CardAmount, CardDots, CardFrame, CardLine, CardLink, CardTitle, type CardFrameProps } from "./CardFrame";
export { CodeCells, type CodeCellsProps } from "./CodeCells";
export { AppleLogo, BnbMark, CurrencyFlag, FlagSG, FlagUS } from "./icons";
export { LineItems, type LineItemsProps } from "./LineItems";
export { MerchantHeader, type MerchantHeaderProps } from "./MerchantHeader";
export { Notice, type NoticeProps, type NoticeVariant } from "./Notice";
export { Row, Rows, type RowProps, type RowsProps } from "./Rows";
export { StateBlock, type StateBlockProps } from "./StateBlock";
export { StatusStepper, type Step, type StepState, type StatusStepperProps } from "./StatusStepper";
