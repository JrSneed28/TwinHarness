import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli";

/**
 * The table-driven arg parser (the deferred "G11"). Pins the corrected behavior:
 * unknown `--flags` and value-less flags are recorded for rejection rather than
 * silently swallowed as positionals / coerced to NaN (the old behavior).
 */
describe("parseArgs", () => {
  it("parses boolean, string (both forms), and numeric flags", () => {
    expect(parseArgs(["--json"]).flags.json).toBe(true);
    expect(parseArgs(["--cwd", "/tmp/x"]).flags.cwd).toBe("/tmp/x");
    expect(parseArgs(["--cwd=/tmp/y"]).flags.cwd).toBe("/tmp/y");
    expect(parseArgs(["--cap", "5"]).flags.cap).toBe(5);
    expect(parseArgs(["--cap=7"]).flags.cap).toBe(7);
  });

  it("parses --components as a recognized string flag (build sub-claim), both forms", () => {
    // The handler splits this on commas; the parser only needs to capture the value
    // (and NOT record it as an unknown flag — the wiring guard for sub-claim).
    const p1 = parseArgs(["build", "sub-claim", "SLICE-1", "--components", "api,db"]);
    expect(p1.flags.components).toBe("api,db");
    expect(p1.unknownFlags).toEqual([]);
    expect(parseArgs(["--components=ui"]).flags.components).toBe("ui");
  });

  it("collects positionals and leaves flags clean", () => {
    const p = parseArgs(["state", "get", "slices"]);
    expect(p.positionals).toEqual(["state", "get", "slices"]);
    expect(p.unknownFlags).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it("records an unknown flag instead of swallowing it as a positional (was the bug)", () => {
    const p = parseArgs(["revise", "bump", "architecture", "--capp", "3"]);
    expect(p.unknownFlags).toContain("--capp");
    // The typo'd flag does not consume "3"; "3" falls through as a positional.
    expect(p.positionals).toEqual(["revise", "bump", "architecture", "3"]);
    expect(p.flags.cap).toBeUndefined();
  });

  it("records a missing value for a flag at end of argv (was NaN/undefined)", () => {
    expect(parseArgs(["--cap"]).errors).toContain("flag --cap requires a value");
    expect(parseArgs(["--cwd"]).errors).toContain("flag --cwd requires a value");
    expect(parseArgs(["--cap"]).flags.cap).toBeUndefined();
  });

  it("records a non-numeric value for a numeric flag (was silent NaN)", () => {
    const p = parseArgs(["--cap", "abc"]);
    expect(p.errors.some((e) => /--cap requires a number/.test(e))).toBe(true);
    expect(p.flags.cap).toBeUndefined();
  });

  it("treats everything after `--` as positional (escape hatch for `--`-like values)", () => {
    const p = parseArgs(["state", "set", "rationale", "--", "--looks-like-a-flag"]);
    expect(p.positionals).toEqual(["state", "set", "rationale", "--looks-like-a-flag"]);
    expect(p.unknownFlags).toEqual([]);
    expect(p.errors).toEqual([]);
  });
});
