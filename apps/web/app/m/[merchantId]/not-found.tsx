// /m/<unknown shop code> (404).
import { SearchX } from "lucide-react";
import { PageFooter, StateBlock } from "../../../components";
import payStyles from "../../pay/[code]/pay.module.css";

export default function ShopNotFound() {
  return (
    <main className={payStyles.page}>
      <StateBlock
        tone="muted"
        icon={<SearchX size={22} strokeWidth={1.5} />}
        title="Shop not found"
        line="Check the QR code, or ask the shop for their Rove link."
      />
      <PageFooter className={payStyles.footer}>Settles on XRPL</PageFooter>
    </main>
  );
}
