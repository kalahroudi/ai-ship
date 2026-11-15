import test from "node:test";
import assert from "node:assert/strict";
import { memoAsync } from "../src/memo.mjs";
test("shares in-flight", async () => {
  let n = 0;
  const m = memoAsync(async (k) => { n++; await new Promise((r) => setTimeout(r, 10)); return k * 2; });
  const [a, b] = await Promise.all([m(2), m(2)]);
  assert.equal(a, 4); assert.equal(b, 4); assert.equal(n, 1);
  assert.equal(await m(2), 4); assert.equal(n, 1);
});
test("retries after rejection", async () => {
  let n = 0;
  const m = memoAsync(async () => { n++; if (n === 1) throw new Error("flaky"); return "ok"; });
  await assert.rejects(m("k"));
  assert.equal(await m("k"), "ok");
  assert.equal(n, 2);
});
