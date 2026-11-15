import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.mjs";
test("units", () => { assert.equal(parseDuration("250ms"), 250); assert.equal(parseDuration("3s"), 3000); assert.equal(parseDuration("2h"), 7_200_000); });
test("fractions + compound", () => { assert.equal(parseDuration("1.5m"), 90_000); assert.equal(parseDuration("1h30m"), 5_400_000); assert.equal(parseDuration("1d 2h"), 93_600_000); });
test("invalid", () => { for (const bad of ["", "5x", "h", "1h x"]) assert.throws(() => parseDuration(bad), bad); });
