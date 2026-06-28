/**
 * D-05 / D-06 — ContextPage identity + locator normalization tests.
 *
 * Coverage:
 *   D-05: computePageId is deterministic; same inputs always yield same page_id;
 *         different inputs yield different page_ids.
 *   D-06: normalizeLocator is deterministic across every source_kind variant;
 *         canonical forms are stable and distinct from raw/un-normalized inputs.
 */

import { describe, it, expect } from "vitest";
import {
  computePageId,
  normalizeLocator,
  CONTEXT_PAGE_SCHEMA_VERSION,
} from "../src/core/context-page";
import { hashContent, shortHash } from "../src/core/hash";

// ---------------------------------------------------------------------------
// D-05: page identity
// ---------------------------------------------------------------------------

describe("D-05: computePageId determinism", () => {
  const base = {
    schema_version: CONTEXT_PAGE_SCHEMA_VERSION,
    source_kind: "file" as const,
    logical_key: "src/core/hash.ts",
    content_hash: hashContent("export function hashContent() {}"),
  };

  it("returns the same id for identical inputs", () => {
    expect(computePageId(base)).toBe(computePageId(base));
  });

  it("produces a 12-character hex string", () => {
    const id = computePageId(base);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs when schema_version changes", () => {
    expect(computePageId(base)).not.toBe(
      computePageId({ ...base, schema_version: "2" }),
    );
  });

  it("differs when source_kind changes", () => {
    expect(computePageId(base)).not.toBe(
      computePageId({ ...base, source_kind: "range" as const }),
    );
  });

  it("differs when logical_key changes", () => {
    expect(computePageId(base)).not.toBe(
      computePageId({ ...base, logical_key: "src/core/other.ts" }),
    );
  });

  it("differs when content_hash changes", () => {
    expect(computePageId(base)).not.toBe(
      computePageId({ ...base, content_hash: hashContent("different content") }),
    );
  });

  it("D-05 formula: shortHash(schema_version + source_kind + logical_key + content_hash)", () => {
    const expected = shortHash(
      base.schema_version + base.source_kind + base.logical_key + base.content_hash,
    );
    expect(computePageId(base)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// D-06: normalizeLocator
// ---------------------------------------------------------------------------

describe("D-06: normalizeLocator — file", () => {
  it("returns the path verbatim", () => {
    expect(normalizeLocator("file", { path: "src/core/hash.ts" })).toBe("src/core/hash.ts");
  });

  it("is deterministic across calls", () => {
    const parts = { path: "src/commands/hook.ts" };
    expect(normalizeLocator("file", parts)).toBe(normalizeLocator("file", parts));
  });
});

describe("D-06: normalizeLocator — range", () => {
  it("produces path:Lα-Lω form", () => {
    expect(
      normalizeLocator("range", { path: "src/core/hash.ts", startLine: 10, endLine: 20 }),
    ).toBe("src/core/hash.ts:L10-L20");
  });

  it("same coords always same key", () => {
    const parts = { path: "src/index.ts", startLine: 1, endLine: 50 };
    expect(normalizeLocator("range", parts)).toBe(normalizeLocator("range", parts));
  });

  it("different line ranges produce different keys", () => {
    const a = normalizeLocator("range", { path: "f.ts", startLine: 1, endLine: 5 });
    const b = normalizeLocator("range", { path: "f.ts", startLine: 1, endLine: 6 });
    expect(a).not.toBe(b);
  });
});

describe("D-06: normalizeLocator — symbol", () => {
  it("produces path#symbol form", () => {
    expect(
      normalizeLocator("symbol", { path: "src/core/hash.ts", symbol: "hashContent" }),
    ).toBe("src/core/hash.ts#hashContent");
  });

  it("different symbols produce different keys", () => {
    const a = normalizeLocator("symbol", { path: "f.ts", symbol: "foo" });
    const b = normalizeLocator("symbol", { path: "f.ts", symbol: "bar" });
    expect(a).not.toBe(b);
  });
});

describe("D-06: normalizeLocator — search", () => {
  it("produces tool|query= form", () => {
    const key = normalizeLocator("search", { tool: "Grep", query: "hashContent" });
    expect(key).toBe("Grep|query=hashContent");
  });

  it("includes sorted flags when present", () => {
    // flags sorted: 'in' → 'in'
    const key = normalizeLocator("search", { tool: "Grep", query: "foo", flags: "ni" });
    expect(key).toContain("flags=in");
  });

  it("flag order is canonicalized (sorted)", () => {
    const a = normalizeLocator("search", { tool: "Grep", query: "q", flags: "ni" });
    const b = normalizeLocator("search", { tool: "Grep", query: "q", flags: "in" });
    expect(a).toBe(b);
  });

  it("includes cwd when present", () => {
    const key = normalizeLocator("search", { tool: "Grep", query: "q", cwd: "/repo" });
    expect(key).toContain("cwd=/repo");
  });

  it("same query always same key", () => {
    const parts = { tool: "Glob", query: "**/*.ts", cwd: "/repo" };
    expect(normalizeLocator("search", parts)).toBe(normalizeLocator("search", parts));
  });
});

describe("D-06: normalizeLocator — bash", () => {
  it("produces bash|<argv> form", () => {
    const key = normalizeLocator("bash", { argv: ["npm", "run", "test"] });
    expect(key).toBe("bash|npm run test");
  });

  it("strips /tmp/ tokens from argv", () => {
    const key = normalizeLocator("bash", { argv: ["cat", "/tmp/abc123/file.txt"] });
    expect(key).toContain("<tmp>");
    expect(key).not.toContain("/tmp/abc123");
  });

  it("strips env-var assignments from argv", () => {
    const key = normalizeLocator("bash", { argv: ["NODE_ENV=production", "node", "server.js"] });
    expect(key).not.toContain("NODE_ENV=production");
  });

  it("includes cwd when present", () => {
    const key = normalizeLocator("bash", { argv: ["ls"], cwd: "/repo" });
    expect(key).toContain("cwd=/repo");
  });

  it("accepts a single string argv", () => {
    const key = normalizeLocator("bash", { argv: "git status" });
    expect(key).toBe("bash|git status");
  });
});

describe("D-06: normalizeLocator — mcp", () => {
  it("produces tool|{...params} form with canonical JSON", () => {
    const key = normalizeLocator("mcp", {
      tool: "mcp__github__get_file",
      params: { repo: "foo", path: "bar.ts" },
    });
    expect(key).toContain("mcp__github__get_file|");
    expect(key).toContain('"path"');
    expect(key).toContain('"repo"');
  });

  it("param key order is canonical (sorted)", () => {
    const a = normalizeLocator("mcp", {
      tool: "t",
      params: { z: 1, a: 2 },
    });
    const b = normalizeLocator("mcp", {
      tool: "t",
      params: { a: 2, z: 1 },
    });
    expect(a).toBe(b);
  });

  it("same params always same key", () => {
    const parts = { tool: "mcp__x__y", params: { k: "v" } };
    expect(normalizeLocator("mcp", parts)).toBe(normalizeLocator("mcp", parts));
  });
});

describe("D-06: normalizeLocator — test", () => {
  it("produces test|<cmd> form", () => {
    const key = normalizeLocator("test", { cmd: "npx vitest run tests/hash.test.ts" });
    expect(key).toBe("test|npx vitest run tests/hash.test.ts");
  });

  it("accepts array cmd", () => {
    const key = normalizeLocator("test", { cmd: ["npx", "vitest", "run"] });
    expect(key).toBe("test|npx vitest run");
  });

  it("includes cwd when present", () => {
    const key = normalizeLocator("test", { cmd: "npm test", cwd: "/repo" });
    expect(key).toContain("cwd=/repo");
  });
});

// ---------------------------------------------------------------------------
// Cross-kind: distinct source_kinds produce distinct keys for same raw input
// ---------------------------------------------------------------------------

describe("D-06: source_kind is part of the key (no cross-kind collisions)", () => {
  it("file and range keys differ even with same path", () => {
    const file = normalizeLocator("file", { path: "src/foo.ts" });
    const range = normalizeLocator("range", { path: "src/foo.ts", startLine: 1, endLine: 10 });
    expect(file).not.toBe(range);
  });
});

// ---------------------------------------------------------------------------
// M1: canonicalJson is recursive — mcp nested params are insertion-order-free
// ---------------------------------------------------------------------------

describe("M1: canonicalJson recursive — mcp nested-object key order does not matter", () => {
  it("flat mcp params: different insertion order → same logical_key", () => {
    const a = normalizeLocator("mcp", {
      tool: "mcp__server__op",
      params: { z: "last", a: "first" },
    });
    const b = normalizeLocator("mcp", {
      tool: "mcp__server__op",
      params: { a: "first", z: "last" },
    });
    expect(a).toBe(b);
  });

  it("nested mcp params: different key insertion order → same logical_key", () => {
    const a = normalizeLocator("mcp", {
      tool: "mcp__server__op",
      params: { z: { nested_b: 2, nested_a: 1 }, a: "val" },
    });
    const b = normalizeLocator("mcp", {
      tool: "mcp__server__op",
      params: { a: "val", z: { nested_a: 1, nested_b: 2 } },
    });
    expect(a).toBe(b);
  });

  it("nested mcp params: same logical_key → same page_id", () => {
    const partsA = { tool: "t", params: { z: { y: 1, x: 2 }, a: 3 } };
    const partsB = { tool: "t", params: { a: 3, z: { x: 2, y: 1 } } };
    const lkA = normalizeLocator("mcp", partsA);
    const lkB = normalizeLocator("mcp", partsB);
    const ch = hashContent("same-content");
    const baseA = {
      schema_version: CONTEXT_PAGE_SCHEMA_VERSION,
      source_kind: "mcp" as const,
      logical_key: lkA,
      content_hash: ch,
    };
    const baseB = {
      schema_version: CONTEXT_PAGE_SCHEMA_VERSION,
      source_kind: "mcp" as const,
      logical_key: lkB,
      content_hash: ch,
    };
    expect(computePageId(baseA)).toBe(computePageId(baseB));
  });

  it("object inside array: nested object keys are also sorted", () => {
    const a = normalizeLocator("mcp", {
      tool: "mcp__x__y",
      params: { items: [{ z: 2, a: 1 }, { b: 3, aa: 4 }] },
    });
    const b = normalizeLocator("mcp", {
      tool: "mcp__x__y",
      params: { items: [{ a: 1, z: 2 }, { aa: 4, b: 3 }] },
    });
    expect(a).toBe(b);
  });
});
