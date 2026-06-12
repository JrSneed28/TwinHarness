/**
 * REQ-ANCHOR-CONV-001: Anchor round-trip test — pins F2 (test-naming convention).
 *
 * Documents and verifies WHY the canonical hyphenated form (REQ-001, REQ-NFR-002)
 * is required in test descriptions/comments, and why the old bare-identifier form
 * (test_REQ001_...) contributes no matchable anchor.
 *
 * `extractReqIds` uses the regex REQ-[A-Z0-9]+(?:-[A-Z0-9]+)* — the hyphen
 * after "REQ" is mandatory. A bare identifier like `test_REQ001_offline_sync`
 * contains "REQ001" which has no hyphen and will never match.
 */

import { describe, it, expect } from "vitest";
import { extractReqIds } from "../src/core/anchors";

describe("REQ-ANCHOR-CONV-001: corrected convention produces matchable anchors", () => {
  it("a comment anchor plus an it() description both yield their REQ-IDs", () => {
    // This is the corrected convention: the matchable anchor appears in the
    // description string or in a // Anchor: comment immediately above the test.
    const snippet = `
// Anchor: REQ-001
it("REQ-NFR-002 determinism: same input always same output", () => {});
`;
    const ids = extractReqIds(snippet);
    expect(ids).toContain("REQ-001");
    expect(ids).toContain("REQ-NFR-002");
  });

  it("anchor in it() description alone is sufficient", () => {
    const snippet = `it("REQ-001: offline sync queues a write when offline", () => {});`;
    const ids = extractReqIds(snippet);
    expect(ids).toContain("REQ-001");
  });

  it("multiple anchors in a describe/it tree are all found", () => {
    const snippet = `
describe("REQ-001 offline sync", () => {
  // Anchor: REQ-NFR-002
  it("queues a write", () => {});
  it("REQ-007: export CSV produces valid header", () => {});
});
`;
    const ids = extractReqIds(snippet);
    expect(ids).toContain("REQ-001");
    expect(ids).toContain("REQ-NFR-002");
    expect(ids).toContain("REQ-007");
  });
});

describe("REQ-ANCHOR-CONV-001: old broken form (bare identifier only) yields no REQ-IDs", () => {
  it("a bare function name test_REQ001_offline_sync has no hyphen and extracts nothing", () => {
    // WHY this is broken: the extractor requires REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*.
    // "REQ001" has no hyphen after "REQ" — it does NOT match.
    // A Builder following the old convention literally gets a false green from
    // `th anchors scan` (scan sees no anchor) and fails `th coverage check`
    // for "no test" even though the test exists. The fix is to embed the
    // canonical hyphenated form in the description or a comment.
    const bareIdentifierOnly = `function test_REQ001_offline_sync_queues_write() {}`;
    const ids = extractReqIds(bareIdentifierOnly);
    expect(ids).toHaveLength(0);
    expect(ids).not.toContain("REQ-001");
  });

  it("REQ001 without a hyphen never matches even when embedded in prose", () => {
    const noHyphen = `// covers REQ001 and REQ007 behavior`;
    const ids = extractReqIds(noHyphen);
    expect(ids).toHaveLength(0);
  });

  it("the fix: adding the hyphenated anchor alongside the function name makes it matchable", () => {
    // Correct form: bare name for readability, hyphenated anchor for the extractor.
    const corrected = `
// Anchor: REQ-001
function test_req001_offline_sync_queues_write() {}
`;
    const ids = extractReqIds(corrected);
    expect(ids).toContain("REQ-001");
    expect(ids).toHaveLength(1);
  });
});
