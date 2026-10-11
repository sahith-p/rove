// /m/<unknown shop code> (404).
import payStyles from "../../pay/[code]/pay.module.css";

export default function ShopNotFound() {
  return (
    <main className={payStyles.page}>
      <section className={payStyles.state} data-tone="muted">
        <div className={payStyles.stateIcon} aria-hidden="true">
          –
        </div>
        <h1 className={payStyles.stateTitle}>Shop not found</h1>
        <p className={payStyles.stateLine}>Check the QR code, or ask the shop for their Rove link.</p>
      </section>
      <footer className={payStyles.footer}>
        <span>Rove · settles on XRPL</span>
      </footer>
    </main>
  );
}
