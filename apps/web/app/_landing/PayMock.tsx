// A static picture of the customer pay page: shop, amount, items, Apple Pay / card / crypto. Decorative only.
import { CreditCard, Wallet } from "lucide-react";
import { AppleLogo, MerchantHeader } from "../../components";
import styles from "./landing.module.css";

export function PayMock() {
  return (
    <div className={styles.payMock} aria-hidden="true">
      <MerchantHeader name="Ah Seng Chicken Rice" verified />

      <div className={styles.payAmount}>
        <span className="eyebrow">Amount</span>
        <span className={styles.payBig}>S$12.50</span>
        <div className={styles.toggle}>
          <span className={styles.toggleOn}>SGD</span>
          <span>USD</span>
          <span>EUR</span>
        </div>
      </div>

      <ul className={styles.payItems}>
        <li>
          <span>2 × Chicken rice</span>
          <span className="num">S$11.00</span>
        </li>
        <li>
          <span>1 × Barley</span>
          <span className="num">S$1.50</span>
        </li>
      </ul>

      <div className={styles.payButtons}>
        <span className={styles.applePay}>
          <AppleLogo size={18} /> Pay
        </span>
        <span className={styles.payAlt}>
          <CreditCard size={18} strokeWidth={1.75} /> Card
        </span>
        <span className={styles.payAlt}>
          <Wallet size={18} strokeWidth={1.75} /> Crypto · AUSD or USDT
        </span>
      </div>
    </div>
  );
}
