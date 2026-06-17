/**
 * #11 — the shared tolerant-JSONL primitives (core/jsonl.ts) that the decision
 * ledger, gate ledger, and telemetry log now share. The modules' own tolerant-read
 * tests (ledger / decision-store / telemetry / ledger-chain) prove the refactor is
 * behavior-preserving end-to-end; this pins the extracted helpers DIRECTLY.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeParseJson, readJsonlValues, scanTailValid } from "../src/core/jsonl";

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tmpFile(contents: string): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "th-jsonl-"));
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const isObj = (p: unknown): p is { n: number } => typeof p === "object" && p !== null;

describe("#11 safeParseJson: tolerant parse", () => {
  it("returns the parsed value for valid JSON", () => {
    expect(safeParseJson('{"n":1}')).toEqual({ n: 1 });
    expect(safeParseJson("42")).toBe(42);
    expect(safeParseJson("null")).toBe(null); // valid JSON null, distinct from a parse error
  });

  it("returns undefined for invalid JSON (never throws)", () => {
    expect(safeParseJson("{ not json")).toBeUndefined();
    expect(safeParseJson("")).toBeUndefined();
    expect(safeParseJson("{,}")).toBeUndefined();
  });
});

describe("#11 readJsonlValues: tolerant full forward read", () => {
  it("missing file → []", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "th-jsonl-"));
    expect(readJsonlValues(path.join(dir, "absent.jsonl"), isObj)).toEqual([]);
  });

  it("returns valid lines in file order, skipping blank / malformed / non-matching", () => {
    const file = tmpFile(
      [
        '{"n":1}',
        "", // blank
        "{ not json", // malformed
        "42", // valid JSON but fails isObj predicate
        '{"n":2}',
        '   ', // whitespace only
        '{"n":3}',
      ].join("\n") + "\n",
    );
    expect(readJsonlValues(file, isObj)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe("#11 scanTailValid: tolerant tail scan (last valid line)", () => {
  it("missing file → undefined", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "th-jsonl-"));
    expect(scanTailValid(path.join(dir, "absent.jsonl"), isObj)).toBeUndefined();
  });

  it("returns the LAST valid line, skipping a torn / non-JSON partial tail", () => {
    // The final line is a torn partial write; the scan must skip it and return the
    // last VALID object above it (n:2), NOT the earlier n:1.
    const file = tmpFile(['{"n":1}', '{"n":2}', '{"par'].join("\n") + "\n");
    expect(scanTailValid(file, isObj)).toEqual({ n: 2 });
  });

  it("skips trailing blank lines and trailing non-matching lines", () => {
    const file = tmpFile(['{"n":1}', "99", "", ""].join("\n") + "\n"); // 99 parses but fails isObj
    expect(scanTailValid(file, isObj)).toEqual({ n: 1 });
  });

  it("no valid line at all → undefined", () => {
    const file = tmpFile(["nope", "{bad", "  "].join("\n"));
    expect(scanTailValid(file, isObj)).toBeUndefined();
  });
});
