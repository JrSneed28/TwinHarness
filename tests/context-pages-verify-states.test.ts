/**
 * context-pages-verify-states.test.ts — issue #3 regression.
 *
 * `context-pages verify` must NOT report a read/verify failure as ok:true. The
 * clean, empty, broken, and unknown states must all be distinguishable, and an
 * "unknown" (could-not-read) result must never masquerade as a verified ledger.
 * The command stays advisory/non-blocking in every state (CommandResult.ok=true,
 * exit 0).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-verify-states-"));
  return { paths: resolveProjectPaths(root), root };
}

function verify(paths: ProjectPaths) {
  const res = runContextPagesCommand("verify", {}, paths);
  return { res, data: res.data as Record<string, unknown> };
}

describe("issue #3 — verify reports distinguishable states; read errors are UNKNOWN, not PASS", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("empty store → status:empty, verified:true, ok:true", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true); // advisory, non-blocking
    expect(data.status).toBe("empty");
    expect(data.verified).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.record_count).toBe(0);
  });

  it("clean ledger → status:verified, verified:true, record_count>0", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const scope: LedgerScope = { session_id: "s", agentOrRoot: "root" };
    appendLedgerRecord(paths, scope, {
      seq: 0, ts: "2026-06-27T00:00:00.000Z", session_id: "s", agent_id: "root",
      agent_type: "claude", epoch: 0, op: "deliver", page_id: "p",
      logical_key: "src/a.ts", content_hash: "a".repeat(64), base_hash: undefined,
      complete: true, est_tokens: 10, reduction_kind: "FULL",
    });

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true);
    expect(data.status).toBe("verified");
    expect(data.verified).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.record_count).toBe(1);
  });

  it("broken chain → status:broken, verified:false, ok:false", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const dir = contextPagesDir(paths);
    fs.mkdirSync(dir, { recursive: true });
    // A shape-valid record whose stored recordHash cannot be recomputed → "edited".
    const tampered = {
      seq: 0, ts: "2026-06-27T00:00:00.000Z", session_id: "s", agent_id: "root",
      agent_type: "claude", epoch: 0, op: "deliver", page_id: "p",
      logical_key: "src/a.ts", content_hash: "a".repeat(64),
      complete: true, est_tokens: 10, reduction_kind: "FULL",
      prevHash: "0".repeat(64), recordHash: "0".repeat(64),
    };
    fs.writeFileSync(path.join(dir, "ledger-s-root.jsonl"), JSON.stringify(tampered) + "\n", "utf8");

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true); // still non-blocking
    expect(data.status).toBe("broken");
    expect(data.verified).toBe(false);
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("edited");
  });

  it("unreadable shard (a directory where a shard file is expected) → status:unknown, NOT a false PASS", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const dir = contextPagesDir(paths);
    fs.mkdirSync(dir, { recursive: true });
    // A directory named like a shard makes readJsonlValues throw EISDIR.
    fs.mkdirSync(path.join(dir, "ledger-s-root.jsonl"));

    const { res, data } = verify(paths);
    expect(res.ok).toBe(true); // advisory: exits zero even when unknown
    expect(data.status).toBe("unknown");
    expect(data.verified).toBe(false);
    expect(data.ok).toBe(false); // NOT ok:true — could-not-read is not proof
    expect(data.blocking).toBe(false);
    expect(data.reason).toBe("read_error_passthrough");
  });

  it("all four states carry a distinct `status`", () => {
    expect(new Set(["verified", "empty", "broken", "unknown"]).size).toBe(4);
  });
});
