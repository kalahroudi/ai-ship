import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.mjs";
const xs = [1, 2, 3, 4, 5, 6, 7];
test("first page", () => assert.deepEqual(paginate(xs, 1, 3), [1, 2, 3]));
test("last partial page", () => assert.deepEqual(paginate(xs, 3, 3), [7]));
test("past the end", () => assert.deepEqual(paginate(xs, 4, 3), []));
test("invalid", () => { assert.deepEqual(paginate(xs, 0, 3), []); assert.deepEqual(paginate(xs, 1, 0), []); });
