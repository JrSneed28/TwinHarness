/**
 * context-pages-audit-reader.test.ts — finding #1 regression.
 *
 * `context-pages verify` must use a STRICT audit reader: an unreadable or
 * structurally-invalid store must never be reported as `empty` or `verified`.
 * Corrupt, inaccessible, or malformed evidence is `broken`/`unknown` — never a
 * false-green. The command stays advisory/non-blocking (CommandResult.ok=true,
 * exit 0) in every state.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import {
  appendLedgerRecord,
  contextPagesDir,
  type LedgerScope,
} from "../src/core/context-ledger";
import { runContextPagesCommand } from "../src/commands/context-pages";

function makeTmpPaths(): { paths: ProjectPaths; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-audit-reader-"));
  return { paths: resolveProjectPaths(root), root };
}

function verify(paths: ProjectPaths) {
  const res = runContextPagesCommand("verify", {}, paths);
  return { res, data: res.data as Record<string, unknown> };
}

function appendClean(paths: ProjectPaths): void {
  const scope: LedgerScope = { session_id: "s", agentOrRoot: "root" };
  appendLedgerRecord(paths, scope, {
    seq: 0, ts: "2026-06-27T00:00:00.000Z", session_id: "s", agent_id: "root",
    agent_type: "claude", epoch: 0, op: "deliver", page_id: "p",
    logical_key: "src/a.ts", content_hash: "a".repeat(64), base_hash: undefined,
    complete: true, est_tokens: 10, reduction_kind: "FULL",
  });
}

describe("finding #1 — strict audit reader: no false-green empty/verified", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("context-pages path is a regular file → status:unknown (not empty)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const pagesRoot = contextPagesDir(paths);
    fs.mkdirSync(path.dirname(pagesRoot), { recursive: true });
    // A regular file where the directory is expected → readdirSync throws ENOTDIR.
    fs.writeFileSync(pagesRoot, "not a directory", "utf8");

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true); // advisory
    expect(data.status).toBe("unknown");
    expect(data.verified).toBe(false);
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("pages_root_unreadable");
  });

  it("shard is an unreadable file (a directory) → status:unknown", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const dir = contextPagesDir(paths);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "ledger-s-root.jsonl")); // dir → EISDIR on read

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("unknown");
    expect(data.verified).toBe(false);
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("shard_unreadable");
  });

  it("shard has one malformed JSON line → status:broken (not empty/verified)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const dir = contextPagesDir(paths);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger-s-root.jsonl"), "NOT VALID JSON\n", "utf8");

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("broken");
    expect(data.verified).toBe(false);
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("malformed_json");
    expect((data.diagnostics as Record<string, number>).malformed_lines).toBe(1);
  });

  it("shard has one valid record plus one malformed line → status:broken", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    appendClean(paths); // writes one valid record
    const shard = path.join(contextPagesDir(paths), "ledger-cw-cm9vdA.jsonl");
    // The shard filename is base64url-encoded; find the real shard file instead.
    const files = fs.readdirSync(contextPagesDir(paths)).filter((f) => f.startsWith("ledger-"));
    expect(files.length).toBe(1);
    fs.appendFileSync(path.join(contextPagesDir(paths), files[0]!), "GARBAGE\n", "utf8");
    void shard;

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("broken");
    expect(data.verified).toBe(false);
    expect(data.reason).toBe("malformed_json");
  });

  it("shard has schema-invalid but valid JSON → status:broken", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const dir = contextPagesDir(paths);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger-s-root.jsonl"), JSON.stringify({ foo: "bar" }) + "\n", "utf8");

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("broken");
    expect(data.verified).toBe(false);
    expect(data.reason).toBe("schema_invalid");
  });

  it("shard contains only blank lines → status:empty (nothing corrupt)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const dir = contextPagesDir(paths);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger-s-root.jsonl"), "\n\n   \n", "utf8");

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("empty");
    expect(data.verified).toBe(true);
    expect(data.record_count).toBe(0);
  });

  it("clean empty directory (no shards) → status:empty", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    fs.mkdirSync(contextPagesDir(paths), { recursive: true });

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("empty");
    expect(data.verified).toBe(true);
    expect(data.record_count).toBe(0);
  });

  it("clean, non-empty chain → status:verified", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    appendClean(paths);

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("verified");
    expect(data.verified).toBe(true);
    expect(data.record_count).toBe(1);
  });
});
