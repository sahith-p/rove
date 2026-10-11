import assert from "node:assert/strict";
import { test } from "node:test";
import { money, WithdrawalViewZ, type Withdrawal } from "@rove/shared";
import { createMockSettlement } from "@rove/shared/mocks";
import { createFakeDb } from "../test-fakes";
import { toWithdrawalView, walletLabel } from "./view";

const base: Withdrawal = {
  id: "wd_1",
  merchantId: "ahseng",
  amount: money("118.40", "SGD"),
  fee: money("0", "SGD"),
  destination: { kind: "bank", bankAccountId: "bank_1" },
  status: "requested",
  needsStepUp: true,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
};

test("bank withdrawal: 'DBS ••••1234', no explorer link before the sweep", async () => {
  const fake = createFakeDb();
  fake.bankAccounts.set("bank_1", {
    id: "bank_1",
    merchantId: "ahseng",
    type: "bank_account",
    bankName: "DBS",
    last4: "1234",
    holderName: "AH SENG FOOD PTE LTD",
    beneficiaryId: "sx_bene_1",
    status: "verified",
    isDefault: true,
    createdAt: base.createdAt,
  });
  const view = await toWithdrawalView({ db: fake.db, settlement: createMockSettlement() }, base);
  assert.deepEqual(view.destination, { kind: "bank", label: "DBS ••••1234" });
  assert.equal(view.explorerUrl, undefined);
  assert.ok(!("sweepTxHash" in view));
  WithdrawalViewZ.parse(view);
});

test("wallet withdrawal after the sweep: short address + explorer link", async () => {
  const fake = createFakeDb();
  const w: Withdrawal = {
    ...base,
    destination: { kind: "xrpl_wallet", address: "rP4xQnF1mGkS8TzQvB2cWdK7Y9Kd" },
    status: "completed",
    sweepTxHash: "ABC123",
  };
  const view = await toWithdrawalView({ db: fake.db, settlement: createMockSettlement() }, w);
  assert.equal(view.destination.label, "rP4x…9Kd");
  assert.equal(view.explorerUrl, "https://testnet.xrpl.org/transactions/ABC123");
  WithdrawalViewZ.parse(view);
  assert.equal(walletLabel("rShort"), "rShort");
});
