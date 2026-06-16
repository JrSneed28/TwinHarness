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
 *   - GOV-2 (P2-4): the old "primary accountability mechanism" claim overstated
 *     tamper-evidence the gate-ledger lacks (it is not hash-chained).
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

describe("GOV-2 (P2-4): the gate-ledger accountability claim is softened", () => {
  it("does NOT contain the stale tamper/authoritative claim", () => {
    expect(security).not.toContain("This is the primary accountability mechanism");
  });

  it("CONTAINS the softened, accurate wording acknowledging it is not tamper-evident", () => {
    // Pin wrap-independent phrases (no embedded newline) so a future reflow of the
    // paragraph cannot break the lint for a non-substantive reason.
    expect(security).toContain("plain append-only log with no hash chain");
    expect(security).toContain("tamper-proof record");
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
