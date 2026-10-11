// The test adapter behaves like postgres.js where the two drivers differ, so these tests guard production SQL.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DbConflictError } from "./index";
import type { Pool } from "./executor";
import { trimDecimal } from "./map";
import { openTestDb } from "./testkit";

let pool: Pool;
before(async () => ({ pool } = await openTestDb()));
after(() => pool.end());

describe("driver parity", () => {
  it("a JSON string bound to a jsonb parameter is double-encoded (postgres.js does this); ::text::jsonb isn't", async () => {
    const [bad] = await pool.query(`select $1::jsonb as j`, ['{"a":1}']);
    assert.equal(bad!.j, '{"a":1}'); // a jsonb *string*, not an object: the production bug this guards against
    const [good] = await pool.query(`select $1::text::jsonb as j`, ['{"a":1}']);
    assert.deepEqual(good!.j, { a: 1 });
  });

  it("numerics come back as strings, never floats", async () => {
    const [r] = await pool.query(`select 0.1::numeric(18,2) + 0.2::numeric(18,2) as n, 9.79::numeric(18,6) as m`);
    assert.equal(r!.n, "0.30");
    assert.equal(trimDecimal(r!.m), "9.79");
  });

  it("unique violations surface as DbConflictError with the constraint name, also inside a transaction", async () => {
    await pool.query(`insert into processed (key) values ('k')`);
    await assert.rejects(
      () => pool.query(`insert into processed (key) values ('k')`),
      (e: unknown) => e instanceof DbConflictError && e.constraint === "processed_pkey",
    );
    await assert.rejects(
      () => pool.tx(async (q) => q.query(`insert into processed (key) values ('k')`)),
      (e: unknown) => e instanceof DbConflictError && e.constraint === "processed_pkey",
    );
  });

  it("a throwing transaction rolls back", async () => {
    await assert.rejects(() =>
      pool.tx(async (q) => {
        await q.query(`insert into processed (key) values ('rolled-back')`);
        throw new Error("boom");
      }),
    );
    assert.deepEqual(await pool.query(`select key from processed where key = 'rolled-back'`), []);
  });
});

describe("trimDecimal", () => {
  it("drops numeric scale padding but keeps 2 places", () => {
    assert.equal(trimDecimal("1.28600000"), "1.286");
    assert.equal(trimDecimal("12.500000"), "12.50");
    assert.equal(trimDecimal("12"), "12.00");
    assert.equal(trimDecimal("0.00000100"), "0.000001");
  });
});
