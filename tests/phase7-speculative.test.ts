import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-070 / REQ-PCO-071 — Phase 7 speculative-dispatch + concurrent
 * re-verify wiring (PLAYBOOK/PROMPT content).
 *
 * REQ-PCO-070: a downstream slice that needs only an upstream slice's INTERFACE
 *   declares `depends_on_soft`; such a slice may be dispatched SPECULATIVELY
 *   against the published contract before the upstream is `done`.
 * REQ-PCO-071: the diff-scoped cascade stale set (`th stale`) is re-verified
 *   CONCURRENTLY, and multiple Debuggers / Researchers may run in parallel on
 *   independent failures / topics.
 *
 * This test asserts ONLY the playbook/agent prompt wiring — the deterministic
 * soft-deps core (REQ-PCO-070 in tests/soft-deps.test.ts) is a sibling source
 * test, not duplicated here.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("REQ-PCO-070: speculative-dispatch playbook wiring", () => {
  it("REQ-PCO-070: build-and-verify.md documents depends_on_soft / speculative dispatch", () => {
    const doc = read("skills/twinharness/reference/build-and-verify.md");
    expect(doc).toContain("depends_on_soft");
    expect(doc.toLowerCase()).toMatch(/speculative|speculation/);
    expect(doc).toContain("REQ-PCO-070");
  });
});

describe("REQ-PCO-071: concurrent cascade re-verify + multi-instance agents", () => {
  it("REQ-PCO-071: build-and-verify.md documents concurrent cascade re-verify via th stale", () => {
    const doc = read("skills/twinharness/reference/build-and-verify.md");
    expect(doc).toContain("th stale");
    expect(doc.toLowerCase()).toMatch(/concurrent|parallel/);
    expect(doc).toContain("REQ-PCO-071");
  });

  it("REQ-PCO-071: debugger.md notes concurrent / parallel multi-instance operation", () => {
    const doc = read("agents/debugger.md").toLowerCase();
    expect(doc).toMatch(/concurrent|parallel/);
  });

  it("REQ-PCO-071: researcher.md notes concurrent / parallel multi-instance operation", () => {
    const doc = read("agents/researcher.md").toLowerCase();
    expect(doc).toMatch(/concurrent|parallel/);
  });
});
