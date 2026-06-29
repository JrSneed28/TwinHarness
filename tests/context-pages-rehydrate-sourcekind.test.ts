/**
 * context-pages-rehydrate-sourcekind.test.ts — finding #8 regression.
 *
 * Rehydration must be SOURCE-KIND-AWARE. When the raw cold object is absent, a
 * file may be re-read, a read-only query may be re-run, but Bash/MCP/web sources
 * must NEVER be auto-replayed (nondeterministic, side-effecting, or credential-
 * bound). A sensitive (hashed) logical key is unrecoverable, and a present cold
 * object whose content does not match the attested hash is reported, not served.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { hashContent } from "../src/core/hash";
import { appendLedgerRecord, type LedgerScope } from "../src/core/context-ledger";
import { contextPagesRoot } from "../src/core/context-page";
import { runContextPagesCommand } from "../src/commands/context-pages";

function makeTmpPaths(): { paths: ProjectPaths; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-rehydrate-sk-"));
  return { paths: resolveProjectPaths(root), root };
}

const SCOPE: LedgerScope = { session_id: "s1", agentOrRoot: "agent-A" };

function seedPage(paths: ProjectPaths, logical_key: string, opts: { reduction_kind?: string; content_hash?: string } = {}) {
  const content_hash = opts.content_hash ?? "a".repeat(64);
  return appendLedgerRecord(paths, SCOPE, {
    seq: 0, ts: "2026-06-27T00:00:00.000Z", session_id: "s1", agent_id: "agent-A",
    agent_type: "claude", epoch: 0, op: "deliver", page_id: `pg-${logical_key.slice(0, 8)}-${content_hash.slice(0, 4)}`,
    logical_key, content_hash, base_hash: undefined, complete: true, est_tokens: 10,
    reduction_kind: opts.reduction_kind ?? "FULL",
  });
}

function rehydrate(paths: ProjectPaths, page_id: string) {
  const res = runContextPagesCommand("rehydrate", { page_id }, paths);
  return res.data as Record<string, any>;
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe("finding #8 — source-kind-aware rehydration", () => {
  it("missing FILE object → reread (safe to replay)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const rec = seedPage(paths, "src/a.ts");

    const d = rehydrate(paths, rec.page_id);
    expect(d.raw_available).toBe(false);
    expect(d.rehydration.source_kind).toBe("file");
    expect(d.rehydration.mode).toBe("reread");
    expect(d.rehydration.safe_to_replay).toBe(true);
  });

  it("missing BASH object → unavailable, never auto-replayed", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const rec = seedPage(paths, "bash|npm test");

    const d = rehydrate(paths, rec.page_id);
    expect(d.rehydration.source_kind).toBe("bash");
    expect(d.rehydration.mode).toBe("unavailable");
    expect(d.rehydration.safe_to_replay).toBe(false);
  });

  it("missing MCP object → requires_confirmation, not auto-replayed", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const rec = seedPage(paths, 'mcp__github__list_issues|{"repo":"x"}');

    const d = rehydrate(paths, rec.page_id);
    expect(d.rehydration.source_kind).toBe("mcp");
    expect(d.rehydration.mode).toBe("requires_confirmation");
    expect(d.rehydration.safe_to_replay).toBe(false);
  });

  it("missing WEBFETCH object → labeled time-variant, not auto-replayed", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const rec = seedPage(paths, "WebFetch|query=https://example.com");

    const d = rehydrate(paths, rec.page_id);
    expect(d.rehydration.source_kind).toBe("web");
    expect(d.rehydration.safe_to_replay).toBe(false);
    expect(String(d.rehydration.reason)).toMatch(/time-variant/i);
  });

  it("missing SEARCH object → requery (read-only, safe)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const rec = seedPage(paths, "Grep|query=TODO");

    const d = rehydrate(paths, rec.page_id);
    expect(d.rehydration.source_kind).toBe("search");
    expect(d.rehydration.mode).toBe("requery");
    expect(d.rehydration.safe_to_replay).toBe(true);
  });

  it("sensitive/hashed logical key → rehydration unavailable", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    // hash-only reduction marks a sensitive page; logical_key is a short hash.
    const rec = seedPage(paths, "ab12cd34ef56", { reduction_kind: "hash-only" });

    const d = rehydrate(paths, rec.page_id);
    expect(d.rehydration.source_kind).toBe("sensitive");
    expect(d.rehydration.mode).toBe("unavailable");
    expect(d.rehydration.safe_to_replay).toBe(false);
  });

  it("present cold object with hash mismatch → detected and not served", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const realHash = hashContent("the original content");
    const rec = seedPage(paths, "src/a.ts", { content_hash: realHash });
    // Write a TAMPERED object at the content-addressed path.
    const objPath = path.join(contextPagesRoot(paths), "objects", realHash.slice(0, 2), realHash);
    fs.mkdirSync(path.dirname(objPath), { recursive: true });
    fs.writeFileSync(objPath, "TAMPERED CONTENT", "utf8");

    const d = rehydrate(paths, rec.page_id);
    expect(d.raw_available).toBe(false);
    expect(d.content_hash_mismatch).toBe(true);
    expect(d.actual_hash).toBe(hashContent("TAMPERED CONTENT"));
    expect(d.content).toBeUndefined();
  });
});
