import { test } from "node:test";
import assert from "node:assert/strict";
import { merchantFundingDrops, MIN_MERCHANT_FUNDING_DROPS } from "./merchant";

test("merchant funding: at least 3 XRP, more if reserves demand it", () => {
  // Today's testnet: 1 XRP base + 0.2 XRP per object → 1 + 0.6 + 1 buffer = 2.6 XRP → 3 XRP floor.
  assert.equal(merchantFundingDrops({ baseDrops: 1_000_000n, incDrops: 200_000n }), MIN_MERCHANT_FUNDING_DROPS);
  assert.equal(MIN_MERCHANT_FUNDING_DROPS, 3_000_000n);
  // Old reserves (10 + 3×2 + 1 buffer) = 17 XRP.
  assert.equal(merchantFundingDrops({ baseDrops: 10_000_000n, incDrops: 2_000_000n }), 17_000_000n);
});
