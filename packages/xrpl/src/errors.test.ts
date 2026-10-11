import { test } from "node:test";
import assert from "node:assert/strict";
import { isRequoteError, txErrorFor, XrplNoTrustLineError, XrplPathError, XrplTxError } from "./errors";

test("path errors are typed and ask for a re-quote", () => {
  for (const code of ["tecPATH_PARTIAL", "tecPATH_DRY"]) {
    const e = txErrorFor(code, "settle pay_1", "HASH");
    assert.ok(e instanceof XrplPathError);
    assert.ok(e instanceof XrplTxError);
    assert.equal(e.code, code);
    assert.equal(e.txHash, "HASH");
    assert.equal(e.requote, true);
    assert.equal(isRequoteError(e), true);
  }
});

test("tecNO_LINE is a trust-line error; others are plain XrplTxError", () => {
  assert.ok(txErrorFor("tecNO_LINE", "x") instanceof XrplNoTrustLineError);
  const e = txErrorFor("tecUNFUNDED_PAYMENT", "refund");
  assert.ok(!(e instanceof XrplPathError) && !(e instanceof XrplNoTrustLineError));
  assert.match(e.message, /doesn't hold enough/);
  assert.equal(isRequoteError(e), false);
  assert.equal(isRequoteError(new Error("tecPATH_DRY")), false);
});
