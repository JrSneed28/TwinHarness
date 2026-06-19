/**
 * SECURITY.md accuracy lint (SEC-001 / GOV-2 / GOV-3).
 *
 * SECURITY.md makes load-bearing claims about what TwinHarness persists and how
 * the gate behaves. These are falsifiable, so we pin them: each assertion checks
 * an EXACT substring of the committed doc — the corrected/accurate wording must
 * be present, and the prior INACCURATE wording must be gone. Paraphrases are not
 * used; only the literal strings that ship.
 *
 * Covered findings:
 *   - SEC-001 (P2-6): the old "no secrets ... written to disk" claim was false —
 *     repo-map.json persists verbatim candidate-command `raw` strings.
 *   - GOV-2 (P3-1b): the gate-ledger is now SHA-256 hash-chained / tamper-evident,
 *     so SECURITY.md is RE-ELEVATED to say so (inverting the P2-4 softening, which
 *     had been correct only while the ledger lacked a hash chain).
 *   - GOV-3 (P2-5): the strict-mode invalid-state fail-closed behaviour is now
 *     documented (default stays fail-open).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const security = fs.readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");

describe("SEC-001 (P2-6): the secrets/persistence claim is accurate", () => {
  it("CONTAINS the corrected verbatim-candidate-command sentence", () => {
    expect(security).toContain(
      "verbatim candidate-command strings are persisted to the local, gitignored repo-map.json",
    );
  });

  it("does NOT contain the stale 'no secrets ... written to disk' claim", () => {
    expect(security).not.toContain(
      "No file contents, no secrets, and no absolute paths are written to disk.",
    );
  });
});

describe("GOV-2 (P3-1b): the gate-ledger is re-elevated to tamper-evident", () => {
  it("does NOT contain the stale softened 'no hash chain / not tamper-evident' claims", () => {
    // These shipped while the ledger was unsealed; the chain now exists, so the
    // doc MUST NOT still claim it lacks one (falsifiable — fails if the doc reverts).
    expect(security).not.toContain("plain append-only log with no hash chain");
    expect(security).not.toContain("not\ntamper-evident");
    expect(security).not.toContain("not an authoritative or\ntamper-proof record");
  });

  it("CONTAINS the re-elevated, accurate hash-chained / tamper-evident wording", () => {
    // Pin wrap-independent phrases (no embedded newline) so a future reflow of the
    // paragraph cannot break the lint for a non-substantive reason.
    expect(security).toContain("tamper-evident");
    expect(security).toContain("SHA-256 hash-chained append-only log");
    expect(security).toContain("breaks the chain detectably");
    // Honest limit (3): wholesale deletion of the sealed run (revert to legacy/empty)
    // is a re-hash-free evasion the doc must disclose, not implicitly deny.
    expect(security).toContain("DELETE the entire");
  });
});

describe("P0-3 (#18): the write-gate Bash-bypass list documents the known gaps", () => {
  // The Bash heuristic is fail-open; SECURITY.md must enumerate the constructs it
  // cannot parse so operators are not misled into treating it as a sandbox. P0-3
  // adds PowerShell and patch/git-apply to the previously-incomplete list.
  it("CONTAINS the patch-application bypass (patch / git apply)", () => {
    expect(security).toContain("patch");
    expect(security).toContain("git apply");
  });

  it("CONTAINS the PowerShell interpreter bypass (powershell / pwsh)", () => {
    expect(security).toContain("powershell -Command");
    expect(security).toContain("pwsh -c");
  });
});

describe("GOV-3 (P2-5): the strict fail-closed-on-invalid-state behaviour is documented", () => {
  it("CONTAINS the default fail-open-on-invalid-state description", () => {
    expect(security).toContain("fails open on a **present-but-invalid**");
  });

  it("CONTAINS the strict opt-in fail-closed description", () => {
    expect(security).toContain("opt into fail-closed");
    expect(security).toContain('write_gate: "strict"');
  });
});
