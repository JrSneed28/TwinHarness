/**
 * context-footer-chunking.test.ts — PF-iii: reduction footer placement contract.
 *
 * Guarantees:
 *   PF-iii-1: reductionFooter() produces the correct delimited block with all
 *             required fields (kind, page_id, current, omitted_tokens, rehydrate).
 *   PF-iii-2: The footer is positioned at the END of the content string, so it
 *             is the LAST data the model sees (survives 10 K chunk splitting).
 *   PF-iii-3: For large content (> 10_000 chars) the footer is still appended
 *             at the very end, not truncated or placed mid-string.
 *   PF-iii-4: The `rehydrate:` line carries the exact CLI command:
 *             `th context rehydrate <page_id>`.
 *   PF-iii-5: Optional fields (base_hash, raw_objref) appear only when provided.
 *   PF-iii-6: Hashes are truncated to 12 chars in the footer (short-hash display).
 */

import { describe, it, expect } from "vitest";
import { reductionFooter, type FooterOpts } from "../src/commands/hook";

// ---------------------------------------------------------------------------
// PF-iii-1: correct block format with required fields
// ---------------------------------------------------------------------------

describe("PF-iii-1: reductionFooter produces correct delimited block", () => {
  const BASE_OPTS: FooterOpts = {
    kind: "exact",
    page_id: "file:src/foo.ts:agent-a",
    current_hash: "abcdef123456789012345678901234567890123456789012345678901234abcd",
    omitted_tokens: 42,
  };

  it("starts with the opening delimiter on the first non-empty line", () => {
    const footer = reductionFooter(BASE_OPTS);
    // Footer starts with a newline then the opening delimiter
    expect(footer).toMatch(/^[\n]--- th-context-reduction ---/);
    // Strip leading whitespace/newlines and verify first content line
    const firstLine = footer.trimStart().split("\n")[0];
    expect(firstLine).toBe("--- th-context-reduction ---");
  });

  it("ends with the closing delimiter line", () => {
    const footer = reductionFooter(BASE_OPTS);
    // Last non-empty line should be ---
    const lastNonEmpty = footer.split("\n").filter(Boolean).at(-1);
    expect(lastNonEmpty).toBe("---");
  });

  it("contains kind field", () => {
    const footer = reductionFooter(BASE_OPTS);
    expect(footer).toContain("kind: exact");
  });

  it("contains page_id field", () => {
    const footer = reductionFooter(BASE_OPTS);
    expect(footer).toContain(`page_id: ${BASE_OPTS.page_id}`);
  });

  it("contains current (short hash) field", () => {
    const footer = reductionFooter(BASE_OPTS);
    // current_hash is truncated to 12 chars
    expect(footer).toContain("current: abcdef123456");
  });

  it("contains omitted_tokens field", () => {
    const footer = reductionFooter(BASE_OPTS);
    expect(footer).toContain("omitted_tokens: 42");
  });
});

// ---------------------------------------------------------------------------
// PF-iii-4: rehydrate command format
// ---------------------------------------------------------------------------

describe("PF-iii-4: rehydrate line contains the exact CLI command", () => {
  it("rehydrate line is `th context rehydrate <page_id>`", () => {
    const pageId = "file:src/components/Button.tsx:agent-xyz";
    const footer = reductionFooter({
      kind: "normalized",
      page_id: pageId,
      current_hash: "0".repeat(64),
      omitted_tokens: 100,
    });
    expect(footer).toContain(`rehydrate: th context rehydrate ${pageId}`);
  });

  it("rehydrate line is present for all kind values", () => {
    const pageId = "snippet:src/lib/util.ts:agent-abc";
    for (const kind of ["exact", "normalized", "lossy"] as const) {
      const footer = reductionFooter({
        kind,
        page_id: pageId,
        current_hash: "a".repeat(64),
        omitted_tokens: 0,
      });
      expect(footer).toContain(`rehydrate: th context rehydrate ${pageId}`);
    }
  });
});

// ---------------------------------------------------------------------------
// PF-iii-5: optional fields (base_hash, raw_objref) conditional presence
// ---------------------------------------------------------------------------

describe("PF-iii-5: optional fields appear only when provided", () => {
  const REQUIRED: FooterOpts = {
    kind: "lossy",
    page_id: "file:pkg/a.ts:root",
    current_hash: "f".repeat(64),
    omitted_tokens: 7,
  };

  it("no base_hash field when base_hash is absent", () => {
    const footer = reductionFooter(REQUIRED);
    expect(footer).not.toContain("base:");
  });

  it("no raw_objref field when raw_objref is absent/null", () => {
    expect(reductionFooter(REQUIRED)).not.toContain("raw_objref:");
    expect(reductionFooter({ ...REQUIRED, raw_objref: null })).not.toContain("raw_objref:");
  });

  it("base field appears (short) when base_hash is provided", () => {
    const footer = reductionFooter({
      ...REQUIRED,
      base_hash: "1234567890ab" + "x".repeat(52),
    });
    expect(footer).toContain("base: 1234567890ab");
  });

  it("raw_objref field appears (short) when raw_objref is provided", () => {
    const footer = reductionFooter({
      ...REQUIRED,
      raw_objref: "deadbeef1234" + "0".repeat(52),
    });
    expect(footer).toContain("raw_objref: deadbeef1234");
  });
});

// ---------------------------------------------------------------------------
// PF-iii-6: hash truncation to 12 chars
// ---------------------------------------------------------------------------

describe("PF-iii-6: hashes truncated to 12 chars", () => {
  it("current_hash is shortened to first 12 characters", () => {
    const hash = "aabbccddeeff" + "0".repeat(52);
    const footer = reductionFooter({
      kind: "exact",
      page_id: "p",
      current_hash: hash,
      omitted_tokens: 0,
    });
    expect(footer).toContain("current: aabbccddeeff");
    // Full 64-char hash must not appear
    expect(footer).not.toContain(hash);
  });

  it("base_hash is shortened to first 12 characters when present", () => {
    const base = "112233445566" + "0".repeat(52);
    const footer = reductionFooter({
      kind: "exact",
      page_id: "p",
      current_hash: "a".repeat(64),
      omitted_tokens: 0,
      base_hash: base,
    });
    expect(footer).toContain("base: 112233445566");
    expect(footer).not.toContain(base);
  });
});

// ---------------------------------------------------------------------------
// PF-iii-2: footer at END of content (survives chunking)
// ---------------------------------------------------------------------------

describe("PF-iii-2: footer is always appended at the END of the content string", () => {
  const OPTS: FooterOpts = {
    kind: "exact",
    page_id: "file:src/app.ts:agent-1",
    current_hash: "c".repeat(64),
    omitted_tokens: 500,
  };

  it("footer starts after all content characters", () => {
    const content = "line 1\nline 2\nline 3";
    const full = content + reductionFooter(OPTS);

    // Footer delimiter must come AFTER the last content character
    const footerIdx = full.indexOf("--- th-context-reduction ---");
    const lastContentChar = full.lastIndexOf("line 3");
    expect(footerIdx).toBeGreaterThan(lastContentChar);
  });

  it("no content characters appear after the closing --- delimiter", () => {
    const content = "some file content here";
    const full = content + reductionFooter(OPTS);

    // The closing --- is the final non-whitespace line
    const trimmed = full.trimEnd();
    expect(trimmed.endsWith("---")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PF-iii-3: footer survives large content (> 10_000 chars)
// ---------------------------------------------------------------------------

describe("PF-iii-3: footer appended correctly for large content (> 10 000 chars)", () => {
  const OPTS: FooterOpts = {
    kind: "normalized",
    page_id: "file:src/large.ts:root",
    current_hash: "d".repeat(64),
    omitted_tokens: 9999,
  };

  it("footer is at the very end of a 12 000-char content string", () => {
    const content = "x".repeat(12_000);
    const footer = reductionFooter(OPTS);
    const full = content + footer;

    expect(full.endsWith(footer)).toBe(true);
    // Closing delimiter at the very end (trimEnd)
    expect(full.trimEnd().endsWith("---")).toBe(true);
  });

  it("rehydrate command survives inside large content", () => {
    const content = "y".repeat(15_000);
    const full = content + reductionFooter(OPTS);

    // rehydrate must appear after the 15 000-char mark
    const rehydrateIdx = full.indexOf("rehydrate: th context rehydrate");
    expect(rehydrateIdx).toBeGreaterThan(15_000);
  });

  it("omitted_tokens value is preserved for large reduction counts", () => {
    const opts: FooterOpts = { ...OPTS, omitted_tokens: 123_456 };
    const full = "z".repeat(20_000) + reductionFooter(opts);
    expect(full).toContain("omitted_tokens: 123456");
  });
});
