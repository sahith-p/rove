import { test } from "node:test";
import assert from "node:assert/strict";
import { SubmitQueue } from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("jobs for one account run one at a time, in order", async () => {
  const q = new SubmitQueue();
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const job = (name: string, ms: number) => async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start ${name}`);
    await sleep(ms);
    events.push(`end ${name}`);
    inFlight--;
    return name;
  };
  const results = await Promise.all([q.run("rA", job("1", 30)), q.run("rA", job("2", 5)), q.run("rA", job("3", 10))]);
  assert.deepEqual(results, ["1", "2", "3"]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(events, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
});

test("different accounts run in parallel", async () => {
  const q = new SubmitQueue();
  let inFlight = 0;
  let maxInFlight = 0;
  const job = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(20);
    inFlight--;
  };
  await Promise.all([q.run("rA", job), q.run("rB", job), q.run("rC", job)]);
  assert.equal(maxInFlight, 3);
});

test("a failing job doesn't block the queue and its error reaches only its caller", async () => {
  const q = new SubmitQueue();
  const order: string[] = [];
  const a = q.run("rA", async () => {
    order.push("a");
    throw new Error("tecPATH_DRY");
  });
  const b = q.run("rA", async () => {
    order.push("b");
    return "ok";
  });
  await assert.rejects(a, /tecPATH_DRY/);
  assert.equal(await b, "ok");
  assert.deepEqual(order, ["a", "b"]);
});

test("the queue forgets an idle account", async () => {
  const q = new SubmitQueue();
  await q.run("rA", async () => 1);
  await sleep(0);
  assert.equal(q.busy("rA"), false);
});
