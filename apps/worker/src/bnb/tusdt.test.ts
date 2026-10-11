import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeEventTopics, toEventSelector } from "viem";
import { TRANSFER_EVENT } from "./source";
import { TUSDT_ABI, TUSDT_BYTECODE, TUSDT_SOLC, TUSDT_SOURCE_FILE, TUSDT_SOURCE_SHA256 } from "./tusdt";

describe("tUSDT (Rove's BSC testnet stablecoin)", () => {
  test("the committed bytecode was built from the committed source (else: bsc-setup.ts compile --write)", () => {
    const source = readFileSync(fileURLToPath(new URL(`./${TUSDT_SOURCE_FILE}`, import.meta.url)), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), TUSDT_SOURCE_SHA256);
    assert.match(source, /pragma solidity 0\.8\.26;/);
    assert.equal(TUSDT_SOLC.version, "0.8.26");
    assert.match(source, /uint8 public constant decimals = 18;/);
  });

  test("bytecode is real init code, not a placeholder, and embeds solc's metadata for 0.8.26", () => {
    assert.match(TUSDT_BYTECODE, /^0x60[0-9a-f]+$/);
    assert.ok(TUSDT_BYTECODE.length > 2000);
    assert.ok(TUSDT_BYTECODE.endsWith("64736f6c634300081a0033"), "CBOR tail: solc 0.8.26"); // "solc" 0x00081a
    // the Transfer event topic the watcher filters on is compiled into the contract
    assert.ok(TUSDT_BYTECODE.includes(toEventSelector(TRANSFER_EVENT).slice(2)));
  });

  test("ABI: ERC-20 + owner-only mint; its Transfer event is the one the watcher reads", () => {
    const fns = TUSDT_ABI.filter((x) => x.type === "function").map((x) => x.name);
    for (const f of ["name", "symbol", "decimals", "totalSupply", "balanceOf", "allowance", "transfer", "approve", "transferFrom", "mint", "owner"]) {
      assert.ok(fns.includes(f as never), f);
    }
    assert.deepEqual(
      encodeEventTopics({ abi: TUSDT_ABI, eventName: "Transfer" }),
      encodeEventTopics({ abi: [TRANSFER_EVENT], eventName: "Transfer" }),
    );
  });
});
