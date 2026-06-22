/**
 * DOC-TRUTH guard for the Axis-B BSC matrix-status ledger
 * (`.omc/audit/axisb-matrix-status.json`) — Lane D, slice-4a.
 *
 * On-thesis with the project premise (mechanical truths are CODE, not prose): the
 * matrix ledger is the machine-readable scorecard of the nine BSC remediation rows.
 * This guard turns that premise on the ledger itself so a row can never silently
 * claim more than it has shipped:
 *
 *   - the file parses and is an array of exactly the 9 BSC rows (1..9);
 *   - every row carries the required keys with the right shapes;
 *   - every `pr` entry is a POSITIVE integer (no 0 / negative / float / string);
 *   - every NON-NULL `probe` path EXISTS on disk (null permitted; a dangling path
 *     fails — a probe row must point at real evidence);
 *   - NO row claims phase `done-final` unless its `independence === "full"` (the
 *     independence invariant: a fully-done row must have provably-independent
 *     grounding, not just a phase stamp).
 *
 * Fail CLOSED: a malformed or missing ledger throws, never silently passes. The
 * ledger ALREADY EXISTS with all 9 rows well-formed (BSC-3 is `phase:"todo"`,
 * `independence:0` today), so this guard's first run is GREEN — exactly the
 * build-order posture the slice-4a plan requires.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const LEDGER_PATH = path.join(REPO_ROOT, ".omc", "audit", "axisb-matrix-status.json");

/** The allowed phase + independence vocabularies (kept narrow so a typo fails closed). */
const PHASES = new Set(["todo", "in-progress", "done-phase", "done-final"]);
const INDEPENDENCE = new Set<unknown>([0, ">0", "full"]);

interface MatrixRow {
  bsc: number;
  title: string;
  phase: string;
  independence: unknown;
  pr: unknown;
  probe: unknown;
  anchors: unknown;
  updatedAt: string;
}

/** Read + parse the ledger, failing CLOSED on absence / malformed JSON / wrong root shape. */
function readLedger(): MatrixRow[] {
  expect(fs.existsSync(LEDGER_PATH), `ledger missing: ${LEDGER_PATH}`).toBe(true);
  const raw = fs.readFileSync(LEDGER_PATH, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`axisb-matrix-status.json is not valid JSON: ${(e as Error).message}`);
  }
  expect(Array.isArray(parsed), "ledger root must be an array").toBe(true);
  return parsed as MatrixRow[];
}

describe("axisb-matrix-status.json — doc-truth ledger guard (fail-closed)", () => {
  it("parses to an array of exactly the 9 BSC rows (bsc 1..9, each once)", () => {
    const rows = readLedger();
    expect(rows).toHaveLength(9);
    const bscs = rows.map((r) => r.bsc).sort((a, b) => a - b);
    expect(bscs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("every row carries the required keys with the right shapes", () => {
    for (const row of readLedger()) {
      const where = `bsc ${row.bsc}`;
      expect(typeof row.bsc, `${where}: bsc number`).toBe("number");
      expect(typeof row.title, `${where}: title string`).toBe("string");
      expect(row.title.length, `${where}: title non-empty`).toBeGreaterThan(0);
      expect(PHASES.has(row.phase), `${where}: phase "${row.phase}" in ${[...PHASES].join("/")}`).toBe(true);
      expect(INDEPENDENCE.has(row.independence), `${where}: independence "${String(row.independence)}"`).toBe(true);
      expect(Array.isArray(row.pr), `${where}: pr array`).toBe(true);
      expect(Array.isArray(row.anchors), `${where}: anchors array`).toBe(true);
      expect(row.probe === null || typeof row.probe === "string", `${where}: probe null|string`).toBe(true);
      expect(typeof row.updatedAt, `${where}: updatedAt string`).toBe("string");
    }
  });

  it("every `pr` entry is a POSITIVE integer", () => {
    for (const row of readLedger()) {
      for (const pr of row.pr as unknown[]) {
        expect(typeof pr, `bsc ${row.bsc}: pr entry must be a number`).toBe("number");
        expect(Number.isInteger(pr) && (pr as number) > 0, `bsc ${row.bsc}: pr ${String(pr)} must be a positive integer`).toBe(true);
      }
    }
  });

  it("every NON-NULL `probe` path exists on disk (null permitted; dangling path fails)", () => {
    for (const row of readLedger()) {
      if (row.probe === null) continue;
      const probeRel = row.probe as string;
      const abs = path.resolve(REPO_ROOT, probeRel);
      expect(fs.existsSync(abs), `bsc ${row.bsc}: probe path does not exist: ${probeRel}`).toBe(true);
    }
  });

  it("NO row claims phase 'done-final' unless independence === 'full'", () => {
    for (const row of readLedger()) {
      if (row.phase === "done-final") {
        expect(row.independence, `bsc ${row.bsc}: done-final requires independence "full"`).toBe("full");
      }
    }
  });
});
