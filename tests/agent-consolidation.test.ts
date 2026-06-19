/**
 * Phase 5 / P5-4 — agent consolidation doctrine (REQ-PCO-065).
 *
 * DOC-LINT: this file asserts prose presence in `agents/*.md` — it pins the
 * consolidation decisions so a future prompt edit cannot silently un-consolidate
 * the roster. It verifies documentation, not runtime dispatch.
 *
 * Three consolidations (plan P5-4):
 *   1. test-author is documented as a Builder worktree-mate / triad-mode, NOT a
 *      standalone delegate.
 *   2. reconciler + merge-coordinator share ONE single-writer doctrine (two writers
 *      of two distinct shared results), and each names the other's lane.
 *   3. red-team vs Critic ownership is explicit on BOTH sides: Critic gates
 *      security/failure-modes; red-team supplies adversarial pressure, owns no gate.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const AGENTS = path.resolve(__dirname, "..", "agents");
const read = (name: string) => fs.readFileSync(path.join(AGENTS, `${name}.md`), "utf8");

describe("DOC-LINT: REQ-PCO-065: test-author is a Builder triad-mode, not standalone", () => {
  it("DOC-LINT: REQ-PCO-065: test-author.md states it is not a standalone delegate", () => {
    const md = read("test-author").toLowerCase();
    expect(md).toContain("not a standalone");
    expect(md).toMatch(/triad-mode|worktree-mate/);
  });

  it("DOC-LINT: REQ-PCO-065: builder.md frames the Test-Author as a triad-mode of the Builder", () => {
    const md = read("builder").toLowerCase();
    expect(md).toContain("triad-mode");
    expect(md).toContain("not a standalone delegate");
  });
});

describe("DOC-LINT: REQ-PCO-065: unified single-writer doctrine (reconciler + merge-coordinator)", () => {
  it("DOC-LINT: REQ-PCO-065: reconciler.md names the doctrine and the Merge-Coordinator's lane", () => {
    const md = read("reconciler");
    expect(md.toLowerCase()).toContain("single-deterministic-writer");
    expect(md).toContain("merge-coordinator.md");
    expect(md.toLowerCase()).toContain("two writers");
  });

  it("DOC-LINT: REQ-PCO-065: merge-coordinator.md names the doctrine and the Reconciler's lane", () => {
    const md = read("merge-coordinator");
    expect(md.toLowerCase()).toContain("single-deterministic-writer");
    expect(md).toContain("reconciler.md");
    expect(md.toLowerCase()).toContain("two writers");
  });
});

describe("DOC-LINT: REQ-PCO-065: red-team vs Critic ownership is explicit on both sides", () => {
  it("DOC-LINT: REQ-PCO-065: critic.md owns the security/failure-modes GATE and references the red-team", () => {
    const md = read("critic");
    const lower = md.toLowerCase();
    expect(lower).toContain("red-team");
    // The Critic owns the gate on security + failure-modes.
    expect(lower).toMatch(/gate on security|owns the gate|security \+ failure-modes/);
  });

  it("DOC-LINT: REQ-PCO-065: red-team.md disclaims the gate (attacks, never gates)", () => {
    const md = read("red-team").toLowerCase();
    expect(md).toContain("critic");
    expect(md).toMatch(/own no gate|owning a gate|do not (?:pass|decide)/);
  });
});
