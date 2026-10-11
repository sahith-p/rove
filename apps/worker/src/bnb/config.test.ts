import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bnbConfigFromEnv, DEFAULT_BSC_RPC_URL } from "./config";

const TOKEN = "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd";

describe("bnbConfigFromEnv", () => {
  test("off without a token", () => {
    assert.equal(bnbConfigFromEnv({}), null);
  });

  test("defaults: 18 decimals, 3 confirmations, publicnode RPC, 3 s polls, 10k-block boot rescan, 1 h late grace", () => {
    const cfg = bnbConfigFromEnv({ BSC_TOKEN_ADDRESS: TOKEN });
    assert.ok(cfg);
    assert.equal(cfg.token, "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd");
    assert.equal(cfg.decimals, 18);
    assert.equal(cfg.confirmations, 3);
    assert.equal(cfg.rpcUrl, DEFAULT_BSC_RPC_URL);
    assert.equal(cfg.pollMs, 3000);
    assert.equal(cfg.rescanBlocks, 10_000n);
    assert.equal(cfg.maxBlockRange, 5_000n);
    assert.equal(cfg.lateGraceMs, 3_600_000);
    assert.equal(cfg.mnemonic, null);
  });

  test("the bnbchain.org data-seed RPCs (no eth_getLogs) are swapped for the default; others are kept", () => {
    const seed = bnbConfigFromEnv({ BSC_TOKEN_ADDRESS: TOKEN, BSC_RPC_URL: "https://data-seed-prebsc-1-s1.bnbchain.org:8545" });
    assert.equal(seed?.rpcUrl, DEFAULT_BSC_RPC_URL);
    assert.equal(seed?.rpcReplaced, "https://data-seed-prebsc-1-s1.bnbchain.org:8545");
    const own = bnbConfigFromEnv({ BSC_TOKEN_ADDRESS: TOKEN, BSC_RPC_URL: "https://bsc-testnet.example/rpc" });
    assert.equal(own?.rpcUrl, "https://bsc-testnet.example/rpc");
    assert.equal(own?.rpcReplaced, null);
  });

  test("malformed values throw", () => {
    assert.throws(() => bnbConfigFromEnv({ BSC_TOKEN_ADDRESS: "0x12" }), /not an EVM address/);
    assert.throws(() => bnbConfigFromEnv({ BSC_TOKEN_ADDRESS: TOKEN, BSC_TOKEN_DECIMALS: "1" }), /2\.\.36/);
    assert.throws(() => bnbConfigFromEnv({ BSC_TOKEN_ADDRESS: TOKEN, BSC_POLL_MS: "-5" }), /positive integer/);
  });
});
