import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initialState,
  validateState,
  serializeState,
  STATE_FIELD_ORDER,
  CURRENT_SCHEMA_VERSION,
} from "../src/core/state-schema";
import { writeState, SchemaTooNewError } from "../src/core/state-store";

describe("REQ-STATE-SCHEMA: state.json validation (§18)", () => {
  it("accepts the initial state", () => {
    expect(validateState(initialState()).ok).toBe(true);
  });

  it("rejects an invalid tier", () => {
    const r = validateState({ ...initialState(), tier: "T9" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "tier")).toBe(true);
  });

  it("rejects an invalid slice status", () => {
    const r = validateState({ ...initialState(), slices: [{ id: "SLICE-0", status: "wat", components: [] }] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path.startsWith("slices[0]"))).toBe(true);
  });

  it("accepts a slice with a valid depends_on, rejects a non-string-array one", () => {
    const ok = validateState({ ...initialState(), slices: [{ id: "SLICE-1", status: "pending", components: [], depends_on: ["SLICE-0"] }] });
    expect(ok.ok).toBe(true);
    const bad = validateState({ ...initialState(), slices: [{ id: "SLICE-1", status: "pending", components: [], depends_on: [3] }] });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.path === "slices[0].depends_on")).toBe(true);
  });

  it("rejects a negative drift_open_blocking", () => {
    expect(validateState({ ...initialState(), drift_open_blocking: -1 }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(validateState(null).ok).toBe(false);
    expect(validateState(42).ok).toBe(false);
  });

  it("accepts a blast-radius flag from the allowed set", () => {
    expect(validateState({ ...initialState(), tier: "T1", blast_radius_flags: ["authentication"] }).ok).toBe(true);
  });

  it("rejects an unknown blast-radius flag", () => {
    expect(validateState({ ...initialState(), blast_radius_flags: ["bogus"] }).ok).toBe(false);
  });

  it("REQ-VETO-FLOOR: rejects tier T0 when a blast-radius flag is present (§5)", () => {
    const r = validateState({ ...initialState(), tier: "T0", blast_radius_flags: ["money"] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "tier")).toBe(true);
  });

  it("REQ-VETO-FLOOR: accepts tier T1 with the same blast-radius flag", () => {
    expect(validateState({ ...initialState(), tier: "T1", blast_radius_flags: ["money"] }).ok).toBe(true);
  });
});

describe("ARCH-007: unknown top-level keys are a NON-fatal warning (not a hard reject)", () => {
  it("an extra top-level key still validates (ok:true) but surfaces a warning", () => {
    const withExtra = { ...initialState(), some_future_field: 123 };
    const r = validateState(withExtra);
    // Forward-compat / typo: still VALID (does not break existing/forward state files)…
    expect(r.ok).toBe(true);
    expect(r.state).toBeDefined();
    // …but the unknown key is surfaced as a non-fatal warning, NOT an issue.
    expect(r.issues).toEqual([]);
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.some((w) => w.path === "some_future_field")).toBe(true);
  });

  it("a clean state carries no warnings field (additive — absent when empty)", () => {
    const r = validateState(initialState());
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });

  it("warns on EVERY unknown key, deterministically sorted, while known keys never warn", () => {
    const r = validateState({ ...initialState(), zeta: 1, alpha: 2 });
    expect(r.ok).toBe(true);
    const paths = (r.warnings ?? []).map((w) => w.path);
    expect(paths).toEqual(["alpha", "zeta"]); // sorted
  });

  // R-33 / F4 RE-BASELINE — this slot previously asserted that an unknown
  // top-level key is "harmlessly DROPPED" on the next serialize (the warned state
  // round-trips byte-identically WITHOUT the extra key). That premise is now FALSE
  // by design: a state file carrying a future/unknown field written by a NEWER
  // binary must NOT be silently rewritten-and-stripped by an older one. The new
  // guarantee is the OPPOSITE — the mutation is REFUSED at the writeState seam and
  // the on-disk bytes (the future fields) are left BYTE-IDENTICAL.
  it("R-33: mutating a too-new state file is REFUSED and the on-disk bytes (future fields) are byte-IDENTICAL", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-f4-rebaseline-"));
    try {
      const stateDir = path.join(tmp, ".twinharness");
      fs.mkdirSync(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, "state.json");
      // A VALID state file written by a newer binary: schema_version > CURRENT AND a
      // top-level field this binary does not know (validateState treats it as a
      // non-fatal unknown-key warning, so the file still VALIDATES → arm 4).
      const future = {
        ...initialState(),
        schema_version: CURRENT_SCHEMA_VERSION + 1,
        future_field: { nested: "from a newer th" },
      };
      const onDiskBefore = JSON.stringify(future, null, 2) + "\n";
      fs.writeFileSync(stateFile, onDiskBefore, "utf8");

      const paths = {
        root: tmp,
        stateDir,
        stateFile,
        docsDir: path.join(tmp, "docs"),
        driftLog: path.join(tmp, "drift-log.md"),
        interviewFile: path.join(stateDir, "interview.json"),
      };

      // A mutation (writeState) is REFUSED with the stable token…
      expect(() => writeState(paths, initialState())).toThrow(SchemaTooNewError);
      // …and the on-disk file is left BYTE-IDENTICAL — the unknown/future field is
      // PRESERVED, not stripped (the inverse of the old "harmlessly dropped" premise).
      const onDiskAfter = fs.readFileSync(stateFile, "utf8");
      expect(onDiskAfter).toBe(onDiskBefore);
      expect(JSON.parse(onDiskAfter)).toHaveProperty("future_field");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("REQ-STATE-SERIALIZE: deterministic serialization", () => {
  it("serializes in canonical field order with a trailing newline", () => {
    const out = serializeState(initialState());
    expect(out.endsWith("\n")).toBe(true);
    // Only required fields appear (the optional fields are absent from initialState()).
    const OPTIONAL = ["write_gate", "project_mode", "debate_open_blocking", "interview_cutoff", "delivery_mode", "has_ui", "interview_required", "max_tokens"];
    const requiredOrder = STATE_FIELD_ORDER.filter((k) => !OPTIONAL.includes(k));
    expect(Object.keys(JSON.parse(out))).toEqual(requiredOrder);
  });

  it("is stable across calls (clock-free)", () => {
    expect(serializeState(initialState())).toBe(serializeState(initialState()));
  });

  it("REQ-WRITE-GATE-SCHEMA: omits write_gate from serialization when absent (hash-stability)", () => {
    const out = serializeState(initialState());
    expect(Object.keys(JSON.parse(out))).not.toContain("write_gate");
  });

  it("REQ-WRITE-GATE-SCHEMA: includes write_gate in serialization when present", () => {
    const state = { ...initialState(), write_gate: "deny" as const };
    const out = serializeState(state);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["write_gate"]).toBe("deny");
    // write_gate should be the last key (end of STATE_FIELD_ORDER).
    const keys = Object.keys(parsed);
    expect(keys[keys.length - 1]).toBe("write_gate");
  });

  it("REQ-WRITE-GATE-SCHEMA: validates accepted write_gate values", () => {
    for (const v of ["ask", "deny", "off"] as const) {
      expect(validateState({ ...initialState(), write_gate: v }).ok).toBe(true);
    }
  });

  it("REQ-WRITE-GATE-SCHEMA: validates absence of write_gate", () => {
    expect(validateState(initialState()).ok).toBe(true);
  });

  it("REQ-WRITE-GATE-SCHEMA: rejects bogus write_gate values", () => {
    const r = validateState({ ...initialState(), write_gate: "never" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "write_gate")).toBe(true);
  });
});
