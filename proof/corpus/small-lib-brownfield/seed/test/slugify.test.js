"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { slugify } = require("../src/slugify");

test("lower-cases and hyphenates", () => {
  assert.strictEqual(slugify("Hello World"), "hello-world");
});

test("collapses runs of punctuation into a single hyphen", () => {
  assert.strictEqual(slugify("a  --  b!!c"), "a-b-c");
});

test("strips leading and trailing separators", () => {
  assert.strictEqual(slugify("  ?Trim Me?  "), "trim-me");
});

test("throws on non-string input", () => {
  assert.throws(() => slugify(42), TypeError);
});
