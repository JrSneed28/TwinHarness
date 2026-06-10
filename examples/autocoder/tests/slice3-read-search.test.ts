/**
 * SLICE-3 / TASK-008 — read_file + list_search tools (REQ-006, REQ-007).
 *
 * Drives the REAL tools against temp-dir fixtures through the real PathSandbox.
 * read_file is read-anywhere (succeeds OUTSIDE the root — INV-002/RULE-003);
 * list_search is root-scoped (out-of-root path → PATH_ESCAPE). Both normalize
 * failures to status:"error" ToolResults — never a throw (RULE-008).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPathSandbox } from "../src/path-sandbox.js";
import { createReadTool } from "../src/tool-read.js";
import { createSearchTool } from "../src/tool-search.js";
import type { ToolCall, ToolResult } from "../src/contracts.js";

describe("SLICE-3 read_file + list_search tools (REQ-006 / REQ-007)", () => {
  let root: string;
  let sibling: string;

  beforeEach(async () => {
    // A unique temp-dir root, plus a SIBLING dir OUTSIDE the root (same parent) to
    // prove read-anywhere and search root-scoping.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice3-"));
    root = path.join(base, "root");
    sibling = path.join(base, "sibling");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
  });

  afterEach(async () => {
    // Remove the shared parent of root+sibling.
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  function readTool() {
    return createReadTool(createPathSandbox(root));
  }
  function searchTool() {
    return createSearchTool(createPathSandbox(root));
  }
  function call(toolName: ToolCall["toolName"], args: Record<string, unknown>): ToolCall {
    return { id: "c1", toolName, arguments: args };
  }

  // ---------------------------------------------------------------- REQ-006 ----

  // Anchor: REQ-006.
  it("test_REQ006_read_returns_bounded_range", async () => {
    const file = path.join(root, "lines.txt");
    // 10 content lines (with trailing newline).
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await fs.writeFile(file, body, "utf8");

    // Bounded range: lines 3..5 (startLine=3, lineCount=3).
    const r: ToolResult = await readTool().execute(
      call("read_file", { path: file, startLine: 3, lineCount: 3 }),
    );
    expect(r.status).toBe("ok");
    expect(r.output?.content).toBe("line 3\nline 4\nline 5");
    expect(r.output?.totalLines).toBe(10);
    // There is content beyond line 5 → truncated true (model can fetch the next range).
    expect(r.output?.truncated).toBe(true);

    // Reading the FINAL window reports truncated false (window reaches EOF).
    const tail = await readTool().execute(
      call("read_file", { path: file, startLine: 9, lineCount: 5 }),
    );
    expect(tail.status).toBe("ok");
    expect(tail.output?.content).toBe("line 9\nline 10");
    expect(tail.output?.truncated).toBe(false);
    expect(tail.output?.totalLines).toBe(10);
  });

  // Anchor: REQ-006.
  it("test_REQ006_read_outside_root_allowed", async () => {
    // A file in the SIBLING dir, OUTSIDE the root — read-anywhere must succeed.
    const outside = path.join(sibling, "secret-config.txt");
    await fs.writeFile(outside, "shared = true\n", "utf8");

    const r = await readTool().execute(call("read_file", { path: outside }));
    expect(r.status).toBe("ok");
    expect(r.output?.content).toBe("shared = true");
    expect(r.output?.totalLines).toBe(1);
    expect(r.output?.truncated).toBe(false);
  });

  // Anchor: REQ-006.
  it("test_REQ006_read_failed", async () => {
    // not-found → READ_FAILED.
    const missing = await readTool().execute(
      call("read_file", { path: path.join(root, "nope.txt") }),
    );
    expect(missing.status).toBe("error");
    expect(missing.error?.code).toBe("READ_FAILED");

    // is-a-directory → READ_FAILED.
    const dir = path.join(root, "adir");
    await fs.mkdir(dir, { recursive: true });
    const isDir = await readTool().execute(call("read_file", { path: dir }));
    expect(isDir.status).toBe("error");
    expect(isDir.error?.code).toBe("READ_FAILED");
  });

  // ---------------------------------------------------------------- REQ-007 ----

  // Anchor: REQ-007.
  it("test_REQ007_list_entries_and_search_matches", async () => {
    // Fixture tree: a.ts, b.md, and a sub/ dir with c.ts containing the needle.
    await fs.writeFile(path.join(root, "a.ts"), "const x = 1;\nNEEDLE here\n", "utf8");
    await fs.writeFile(path.join(root, "b.md"), "# title\n", "utf8");
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.writeFile(path.join(root, "sub", "c.ts"), "// nothing\nNEEDLE again\n", "utf8");

    // LIST mode: typed entries for the top-level dir.
    const listed = await searchTool().execute(call("list_search", { mode: "list", path: "." }));
    expect(listed.status).toBe("ok");
    expect(listed.output?.mode).toBe("list");
    const entries = listed.output?.entries as { name: string; type: string }[];
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.type]));
    expect(byName["a.ts"]).toBe("file");
    expect(byName["b.md"]).toBe("file");
    expect(byName["sub"]).toBe("dir");
    expect(listed.output?.count).toBe(entries.length);

    // SEARCH mode: literal substring across the tree → {path,line,text} hits.
    const searched = await searchTool().execute(
      call("list_search", { mode: "search", path: ".", query: "NEEDLE" }),
    );
    expect(searched.status).toBe("ok");
    expect(searched.output?.mode).toBe("search");
    const matches = searched.output?.matches as { path: string; line: number; text: string }[];
    expect(matches.length).toBe(2);
    for (const m of matches) {
      expect(typeof m.path).toBe("string");
      expect(m.line).toBeGreaterThanOrEqual(1);
      expect(m.text).toContain("NEEDLE");
    }
    expect(searched.output?.count).toBe(2);
    expect(searched.output?.truncated).toBe(false);

    // Empty result set is a SUCCESS with count:0 (NOT an error).
    const empty = await searchTool().execute(
      call("list_search", { mode: "search", path: ".", query: "no-such-token-xyz" }),
    );
    expect(empty.status).toBe("ok");
    expect(empty.output?.count).toBe(0);
    expect((empty.output?.matches as unknown[]).length).toBe(0);

    // maxResults truncation: cap at 1 hit → truncated true.
    const capped = await searchTool().execute(
      call("list_search", { mode: "search", path: ".", query: "NEEDLE", maxResults: 1 }),
    );
    expect(capped.status).toBe("ok");
    expect(capped.output?.count).toBe(1);
    expect(capped.output?.truncated).toBe(true);
  });

  // Anchor: REQ-007.
  it("test_REQ007_bad_regex_pattern", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "x\n", "utf8");
    // An invalid regex with isRegex:true → BAD_PATTERN (ERR-007), never a throw.
    const r = await searchTool().execute(
      call("list_search", { mode: "search", path: ".", query: "([unclosed", isRegex: true }),
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("BAD_PATTERN");

    // A VALID regex still works (sanity: the regex path is real).
    await fs.writeFile(path.join(root, "z.ts"), "alpha\nbeta\n", "utf8");
    const ok = await searchTool().execute(
      call("list_search", { mode: "search", path: ".", query: "al.ha", isRegex: true }),
    );
    expect(ok.status).toBe("ok");
    expect((ok.output?.matches as unknown[]).length).toBe(1);
  });

  // Anchor: REQ-007.
  it("test_REQ007_search_path_escape", async () => {
    // An out-of-root search path (the sibling dir OUTSIDE the root) → PATH_ESCAPE.
    // list_search is root-scoped (unlike read_file).
    const escape = await searchTool().execute(
      call("list_search", { mode: "search", path: sibling, query: "anything" }),
    );
    expect(escape.status).toBe("error");
    expect(escape.error?.code).toBe("PATH_ESCAPE");

    // Traversal escape via "..": also PATH_ESCAPE.
    const traversal = await searchTool().execute(
      call("list_search", { mode: "list", path: ".." }),
    );
    expect(traversal.status).toBe("error");
    expect(traversal.error?.code).toBe("PATH_ESCAPE");
  });
});
