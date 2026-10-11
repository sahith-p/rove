// Landing: one line + "Text us to open a shop". Owner: Sahith (SH-A1). Keep tiny: no dashboard, no nav.
import { Button } from "../components";

const roveNumber = process.env.NEXT_PUBLIC_ROVE_NUMBER?.trim();

export default function Home() {
  return (
    <main className="stack" style={{ paddingTop: "16vh" }}>
      <h1>
        Rove
        <br />
        <span className="muted">Your shop, invoices and payouts, all in a text thread.</span>
      </h1>
      {roveNumber ? (
        <Button href={`sms:${roveNumber}`} fullWidth>
          Text us to open a shop
        </Button>
      ) : (
        <p className="muted">Text us to open a shop. Our number is coming soon.</p>
      )}
    </main>
  );
}
