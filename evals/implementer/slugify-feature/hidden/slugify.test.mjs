import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.mjs";
test("basic", () => assert.equal(slugify("Hello, World!"), "hello-world"));
test("diacritics", () => assert.equal(slugify("Crème Brûlée"), "creme-brulee"));
test("runs + trim", () => assert.equal(slugify("  --a__b--  "), "a-b"));
test("empty", () => { assert.equal(slugify(""), ""); assert.equal(slugify("!!!"), ""); });
