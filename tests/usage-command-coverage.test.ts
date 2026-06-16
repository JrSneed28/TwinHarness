/**
 * USAGE.md live-command coverage (S-D, M-5).
 *
 * Every live `th` command family that appears in `th help` must be documented in
 * USAGE.md. This guard pins the families that were previously undocumented
 * (collab, debate, section-level artifact leases, build dispatch, the
 * SubagentStop hook) so they can't silently fall out of the docs again.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const usage = fs.readFileSync(path.join(ROOT, "USAGE.md"), "utf8");

describe("USAGE.md documents every live command family (M-5)", () => {
  it.each([
    "th collab",
    "th debate",
    "th artifact claim",
    "th artifact release",
    "th artifact leases",
    "build dispatch",
    "subagent-stop",
  ])("documents %j", (token) => {
    expect(usage.includes(token), `USAGE.md must document "${token}"`).toBe(true);
  });

  it("documents each collab verb", () => {
    for (const verb of ["collab init", "collab fragment", "collab list", "collab merge"]) {
      expect(usage.includes(verb), `USAGE.md must document "${verb}"`).toBe(true);
    }
  });

  it("documents each debate verb", () => {
    for (const verb of ["debate add", "debate list", "debate resolve"]) {
      expect(usage.includes(verb), `USAGE.md must document "${verb}"`).toBe(true);
    }
  });
});
