import assert from "node:assert/strict";
import test from "node:test";
import { runQueue } from "../src/queue.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("results keep input order regardless of completion order", async () => {
  const rs = await runQueue([30, 5, 15], async (ms) => { await sleep(ms); return ms * 2; }, { concurrency: 3 });
  assert.deepEqual(rs.map((r) => r.result), [60, 10, 30]);
  assert.ok(rs.every((r) => r.status === "succeeded"));
});

for (const [asked, bound] of [[0, 1], [-3, 1], [2, 2], [4, 4], [99, 4], [undefined, 1]] as const) {
  test(`concurrency ${asked} never exceeds ${bound} in flight (and reaches it)`, async () => {
    let inFlight = 0;
    let max = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    await runQueue(items, async () => {
      max = Math.max(max, ++inFlight);
      await sleep(5);
      inFlight--;
    }, { concurrency: asked });
    assert.equal(max, bound);
  });
}

test("stopOnFailure defaults to true: remaining items are skipped", async () => {
  const started: number[] = [];
  const rs = await runQueue([1, 2, 3, 4], async (n) => {
    started.push(n);
    if (n === 2) throw new Error("boom");
    return n;
  });
  assert.deepEqual(rs.map((r) => r.status), ["succeeded", "failed", "skipped", "skipped"]);
  assert.equal(rs[1].error, "boom");
  assert.deepEqual(started, [1, 2]);
});

test("stopOnFailure:false continues past failures; non-Error throws are stringified", async () => {
  const rs = await runQueue([1, 2, 3], async (n) => {
    if (n === 1) throw "str";
    return n;
  }, { stopOnFailure: false });
  assert.deepEqual(rs.map((r) => r.status), ["failed", "succeeded", "succeeded"]);
  assert.equal(rs[0].error, "str");
});

test("isCancelled stops starting new items; in-flight one finishes", async () => {
  let cancelled = false;
  const rs = await runQueue([1, 2, 3], async (n) => {
    if (n === 1) cancelled = true;
    return n;
  }, { isCancelled: () => cancelled });
  assert.deepEqual(rs.map((r) => r.status), ["succeeded", "skipped", "skipped"]);
});

test("onDone is called per finished item (not skipped) and its throw is ignored", async () => {
  const seen: Array<[number, string]> = [];
  const rs = await runQueue([1, 2, 3], async (n) => {
    if (n === 2) throw new Error("x");
    return n;
  }, {
    stopOnFailure: false,
    onDone: (r, i) => { seen.push([i, r.status]); throw new Error("reporter broke"); },
  });
  assert.deepEqual(seen, [[0, "succeeded"], [1, "failed"], [2, "succeeded"]]);
  assert.deepEqual(rs.map((r) => r.status), ["succeeded", "failed", "succeeded"]);
});

test("empty input resolves to empty results", async () => {
  assert.deepEqual(await runQueue([], async () => 1), []);
});
