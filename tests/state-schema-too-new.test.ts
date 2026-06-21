/**
 * R-33 / finding F4 — the mutation-boundary refuse seam (writeState →
 * assertWriteAllowed) + the validated-state FIRST-WRITE predicate.
 *
 * A state file written by a NEWER binary (schema_version > CURRENT) must NOT be
 * silently clobbered/downgraded by an older one. The seam:
 *   • REFUSES every MUTATION against a too-new (or present-but-corrupt) state with
 *     the stable `schema_too_new` token, leaving the on-disk file BYTE-IDENTICAL;
 *   • lets READS (readState) / `th doctor` WARN, never refuse.
 *
 * The first-write predicate is keyed on the VALIDATED-STATE result, NOT a bare
 * existsSync — so a partially-written future file is taken down the invalid-state
 * (refuse) path and is never misread as an "absent fresh first write".
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initialState,
  serializeState,
  CURRENT_SCHEMA_VERSION,
  type TwinHarnessState,
} from "../src/core/state-schema";
import {
  writeState,
  assertWriteAllowed,
  readState,
  SchemaTooNewError,
  type ReadStateResult,
} from "../src/core/state-store";
import type { ProjectPaths } from "../src/core/paths";
import { runStateSet } from "../src/commands/state";
import { runTierRecord } from "../src/commands/tier";
import { runDriftAdd } from "../src/commands/drift";
import { runMigrate } from "../src/commands/migrate";
import { runDoctor } from "../src/commands/doctor";
import { runInit } from "../src/commands/init";

/** A throwaway project dir + the paths object pointing into its `.twinharness`. */
function mkProject(): { paths: ProjectPaths; stateFile: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-f4-"));
  const stateDir = path.join(root, ".twinharness");
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  const paths: ProjectPaths = {
    root,
    stateDir,
    stateFile,
    docsDir: path.join(root, "docs"),
    driftLog: path.join(root, "drift-log.md"),
    interviewFile: path.join(stateDir, "interview.json"),
  };
  return { paths, stateFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Bytes of a VALID state file one schema version NEWER than this binary, plus a future field. */
function tooNewBytes(): string {
  const future = {
    ...initialState(),
    schema_version: CURRENT_SCHEMA_VERSION + 1,
    // An unknown top-level field a newer binary added. validateState treats it as a
    // non-fatal warning, so the file still VALIDATES → the schema_too_new refuse arm.
    future_field: { nested: true, list: [1, 2, 3] },
  };
  return JSON.stringify(future, null, 2) + "\n";
}

describe("R-33 / F4 — writeState refuses a too-new state and preserves the bytes", () => {
  it("REFUSES (schema_too_new) and leaves the file byte-identical (nested + top-level future fields survive)", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      const before = tooNewBytes();
      fs.writeFileSync(stateFile, before, "utf8");

      let thrown: unknown;
      try {
        writeState(paths, initialState());
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SchemaTooNewError);
      expect((thrown as SchemaTooNewError).code).toBe("schema_too_new");
      expect((thrown as SchemaTooNewError).onDisk).toBe(CURRENT_SCHEMA_VERSION + 1);
      expect((thrown as SchemaTooNewError).current).toBe(CURRENT_SCHEMA_VERSION);

      // Byte-identical: the future_field (nested + list) is PRESERVED, not stripped.
      const after = fs.readFileSync(stateFile, "utf8");
      expect(after).toBe(before);
      expect(JSON.parse(after)).toHaveProperty("future_field");
    } finally {
      cleanup();
    }
  });

  it("assertWriteAllowed throws on a too-new file but is a no-op on an in-range / fresh file", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      // too-new → throws.
      fs.writeFileSync(stateFile, tooNewBytes(), "utf8");
      expect(() => assertWriteAllowed(paths)).toThrow(SchemaTooNewError);

      // current version → allowed (no throw).
      fs.writeFileSync(stateFile, serializeState(initialState()), "utf8");
      expect(() => assertWriteAllowed(paths)).not.toThrow();

      // absent (legacy v1, schema_version omitted) → allowed.
      const legacy: TwinHarnessState = { ...initialState() };
      delete legacy.schema_version;
      fs.writeFileSync(stateFile, serializeState(legacy), "utf8");
      expect(() => assertWriteAllowed(paths)).not.toThrow();

      // no file → allowed (fresh first write).
      fs.rmSync(stateFile);
      expect(() => assertWriteAllowed(paths)).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("R-33 / F4 — every mutating command refuses schema_too_new + leaves state.json byte-identical", () => {
  // Each case writes a too-new state, runs a representative MUTATING command, and
  // asserts (a) the command throws SchemaTooNewError (the CLI boundary maps it to a
  // `schema_too_new` failure) and (b) the on-disk state.json is byte-identical.
  const cases: Array<{ name: string; run: (p: ProjectPaths) => unknown }> = [
    { name: "th state set (non-gate field)", run: (p) => runStateSet(p, "summaries_index", "x.md") },
    { name: "th tier record", run: (p) => runTierRecord(p, "T1") },
    { name: "th drift add --layer requirement", run: (p) => runDriftAdd(p, { layer: "requirement" }) },
  ];

  for (const c of cases) {
    it(`${c.name} → throws schema_too_new, state.json byte-identical`, () => {
      const { paths, stateFile, cleanup } = mkProject();
      try {
        const before = tooNewBytes();
        fs.writeFileSync(stateFile, before, "utf8");

        expect(() => c.run(paths)).toThrow(SchemaTooNewError);

        const after = fs.readFileSync(stateFile, "utf8");
        expect(after).toBe(before);
      } finally {
        cleanup();
      }
    });
  }

  it("th init (re-init max-tokens update path) → refuses on a too-new file, byte-identical", () => {
    // A too-new EXISTING file + an init that would do a targeted max_tokens update is
    // a mutation; writeState must refuse it. (A fresh init with NO file is covered by
    // the first-write-arms suite below.)
    const { paths, stateFile, cleanup } = mkProject();
    try {
      const before = tooNewBytes();
      fs.writeFileSync(stateFile, before, "utf8");
      // The re-init max_tokens update is a MUTATION of the existing state → it reaches
      // the writeState seam, which refuses the too-new file.
      expect(() => runInit(paths, { maxTokens: 150000 })).toThrow(SchemaTooNewError);
      expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  it("th migrate cannot downgrade a too-new file (refused; byte-identical)", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      const before = tooNewBytes();
      fs.writeFileSync(stateFile, before, "utf8");
      // migrate refuses `from > CURRENT` at its own guard BEFORE writeState, returning a
      // structured failure (it never reaches the seam). Either way: no downgrade write.
      const r = runMigrate(paths);
      expect(r.ok).toBe(false);
      expect((r.data as { error?: string }).error).toBe("schema_too_new");
      expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });
});

describe("R-33 / F4 — READS and th doctor WARN, never refuse, on a too-new file", () => {
  it("readState returns a populated, valid state for a too-new file (no refusal on read)", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      fs.writeFileSync(stateFile, tooNewBytes(), "utf8");
      const r: ReadStateResult = readState(paths);
      expect(r.exists).toBe(true);
      // A too-new file is structurally VALID (schema_version 3 is a positive integer);
      // reads do NOT refuse — they surface the state (so doctor can inspect it).
      expect(r.state).toBeDefined();
      expect(r.state!.schema_version).toBe(CURRENT_SCHEMA_VERSION + 1);
    } finally {
      cleanup();
    }
  });

  it("th doctor does NOT throw / refuse on a too-new file (read-only; it reports, never mutates)", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      fs.writeFileSync(stateFile, tooNewBytes(), "utf8");
      // doctor is read-only — it must complete without throwing SchemaTooNewError and
      // must NOT rewrite the file.
      const before = fs.readFileSync(stateFile, "utf8");
      let result: unknown;
      expect(() => {
        result = runDoctor(paths, {});
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });
});

describe("R-33 / F4 — validated-state FIRST-WRITE predicate (Item 1) — all four arms", () => {
  it("(a) a root with NO state file → writeState SUCCEEDS (fresh first write)", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(() => writeState(paths, initialState())).not.toThrow();
      expect(fs.existsSync(stateFile)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("(b) a file that VALIDATES and schema_version === undefined → writeState SUCCEEDS", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      const legacy: TwinHarnessState = { ...initialState() };
      delete legacy.schema_version; // legacy v1: schema_version absent, still valid
      fs.writeFileSync(stateFile, serializeState(legacy), "utf8");
      expect(() => writeState(paths, initialState())).not.toThrow();
      // The write landed (now stamped with CURRENT_SCHEMA_VERSION).
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).schema_version).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      cleanup();
    }
  });

  it("(c) a PRESENT-but-CORRUPT future file is REFUSED via the invalid path — NOT misread as fresh", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      // A partially-written future file: valid JSON shape but schema_version is a
      // NON-integer (e.g. mid-write garbage). validateState hard-rejects a non-integer
      // schema_version, so this is the invalid-state arm — the truncation trap the
      // validated-state predicate exists to defeat. It must REFUSE, not allow-as-fresh.
      const corrupt = JSON.stringify({ ...initialState(), schema_version: "3-partial" }, null, 2) + "\n";
      fs.writeFileSync(stateFile, corrupt, "utf8");
      let thrown: unknown;
      try {
        writeState(paths, initialState());
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SchemaTooNewError);
      // Byte-identical — the corrupt file is NOT clobbered by a "fresh" write.
      expect(fs.readFileSync(stateFile, "utf8")).toBe(corrupt);
    } finally {
      cleanup();
    }
  });

  it("(d) a file that VALIDATES with schema_version > CURRENT is REFUSED schema_too_new", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      const before = tooNewBytes();
      fs.writeFileSync(stateFile, before, "utf8");
      expect(() => writeState(paths, initialState())).toThrow(SchemaTooNewError);
      expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  it("also refuses an UN-PARSEABLE present file (corrupt JSON) rather than overwriting it", () => {
    const { paths, stateFile, cleanup } = mkProject();
    try {
      const garbage = "{ this is not json";
      fs.writeFileSync(stateFile, garbage, "utf8");
      expect(() => writeState(paths, initialState())).toThrow(SchemaTooNewError);
      expect(fs.readFileSync(stateFile, "utf8")).toBe(garbage);
    } finally {
      cleanup();
    }
  });
});
