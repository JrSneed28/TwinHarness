/**
 * hooks-implementation-state.doc-truth.test.ts — finding #2 guard.
 *
 * The architecture guide groups the seven ContextPages hook events by what the
 * code ACTUALLY does (Implemented / Registered-but-passthrough / Planned). This
 * guard couples those prose claims to the real CLI routing in src/cli.ts, so a
 * stub can never be documented as implemented (or vice-versa):
 *
 *   - The four passthrough events (prompt-context, subagent-context,
 *     subagent-seal, session-end) MUST route to the empty `{}` stub branch in
 *     cli.ts AND be listed under "Registered but currently passthrough" — never
 *     under "Implemented".
 *   - The three implemented events (posttool-context, session-context,
 *     precompact-seal) MUST route to a real runHook* function AND be listed under
 *     "Implemented".
 *
 * Fail CLOSED: a missing section or a mislabeled event throws.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, "src", "cli.ts"), "utf8");
const ARCH_DOC = fs.readFileSync(path.join(REPO_ROOT, "docs", "guide", "architecture.md"), "utf8");

const PASSTHROUGH_EVENTS = ["prompt-context", "subagent-context", "subagent-seal", "session-end"];
const IMPLEMENTED_EVENTS = ["posttool-context", "session-context", "precompact-seal"];

/** Slice the architecture doc into its three labeled status sections. */
function section(label: string): string {
  const start = ARCH_DOC.indexOf(label);
  if (start < 0) return "";
  // Each status group is a bold "**…:**" heading; stop at the next bold heading
  // or the next "###" subsection.
  const rest = ARCH_DOC.slice(start + label.length);
  const next = rest.search(/\n\*\*[A-Z][^*]+\*\*|\n###|\nHook wiring lives/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe("finding #2 — architecture doc hook states match real CLI routing", () => {
  it("the four passthrough events route to the empty {} stub branch in cli.ts", () => {
    // The stub branch is the OR-chain that returns JSON.stringify({}).
    for (const ev of PASSTHROUGH_EVENTS) {
      expect(CLI_SRC, `${ev} must be in the passthrough OR-chain`).toContain(`=== "${ev}"`);
    }
    // And that branch must still emit an empty decision object.
    expect(CLI_SRC).toMatch(/JSON\.stringify\(\{\}\)/);
  });

  it("the three implemented events route to a real runHook* function", () => {
    expect(CLI_SRC).toContain("runHookPostToolContext(");
    expect(CLI_SRC).toContain("runHookSessionContext(");
    expect(CLI_SRC).toContain("runHookPrecompactSeal(");
  });

  it("the doc has the three status sections", () => {
    expect(ARCH_DOC).toContain("**Implemented (active behavior):**");
    expect(ARCH_DOC).toContain("**Registered but currently passthrough");
    expect(ARCH_DOC).toContain("**Planned (not yet implemented):**");
  });

  it("passthrough events are documented as passthrough, NOT implemented", () => {
    const passthroughSection = section("**Registered but currently passthrough");
    const implementedSection = section("**Implemented (active behavior):**");
    for (const ev of PASSTHROUGH_EVENTS) {
      expect(passthroughSection, `${ev} must appear under passthrough`).toContain(ev);
      expect(implementedSection, `${ev} must NOT appear under Implemented`).not.toContain(ev);
    }
  });

  it("implemented events are documented as implemented, NOT passthrough", () => {
    const passthroughSection = section("**Registered but currently passthrough");
    const implementedSection = section("**Implemented (active behavior):**");
    for (const ev of IMPLEMENTED_EVENTS) {
      expect(implementedSection, `${ev} must appear under Implemented`).toContain(ev);
      expect(passthroughSection, `${ev} must NOT appear under passthrough`).not.toContain(ev);
    }
  });
});
