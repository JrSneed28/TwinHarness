/**
 * context-coldstore-policy.test.ts — issue #4 (metadata-only default) and
 * issue #5 (retention caps + usage report).
 *
 * #4: the on-by-default OBSERVE hook must NOT copy raw tool output to the
 *     plaintext cold store. Raw bytes are persisted only when a consumer needs
 *     them: exact suppression (to rehydrate) or an explicit TH_CONTEXT_RAW_STORE.
 * #5: cold-store retention enforces age + size caps (oldest-first), a usage
 *     report is surfaced via page-status, and gc applies the caps.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { hashContent } from "../src/core/hash";
import {
  coldStorePut,
  coldStoreGet,
  coldStoreUsage,
  coldStoreEnforceRetention,
  contextPagesRoot,
} from "../src/core/context-page";
import { runHookPostToolContext } from "../src/commands/hook";
import { runContextPagesCommand } from "../src/commands/context-pages";

function makeTmp(): { paths: ProjectPaths; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-coldstore-"));
  return { paths: resolveProjectPaths(root), root };
}

function objPathFor(paths: ProjectPaths, content: string): string {
  const h = hashContent(content);
  return path.join(contextPagesRoot(paths), "objects", h.slice(0, 2), h);
}

function readInput(filePath: string, content: string, root: string) {
  return {
    session_id: "s",
    agent_type: "claude",
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: content,
    cwd: root,
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

// ---------------------------------------------------------------------------
// #4 — metadata-only default
// ---------------------------------------------------------------------------

describe("issue #4 — raw cold-store persistence is opt-in (metadata-only default)", () => {
  it("coldStorePut with persistRaw:false returns the hash but writes no bytes", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const content = "secret-ish but unclassified content";

    const ref = coldStorePut(paths, content, false, { persistRaw: false });
    expect(ref).toBe(hashContent(content));      // objref still returned
    expect(coldStoreGet(paths, ref!)).toBeUndefined(); // but no bytes on disk
  });

  it("coldStorePut default (no opts) still persists raw bytes (back-compat for delta/fingerprint)", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const content = "delta base content";

    const ref = coldStorePut(paths, content, false);
    expect(coldStoreGet(paths, ref!)).toBe(content);
  });

  it("OBSERVE hook (no suppression / no opt-in) does NOT persist raw tool output", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const content = "file body the hook observed";

    const result = runHookPostToolContext(root, readInput("src/a.ts", content, root), {});
    expect(JSON.parse(result.stdout)).toEqual({}); // passthrough
    // No raw object on disk — only the hash lives in the ledger.
    expect(fs.existsSync(objPathFor(paths, content))).toBe(false);
  });

  it("hook with TH_CONTEXT_RAW_STORE=1 DOES persist raw output (explicit opt-in)", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const content = "file body to persist on opt-in";

    runHookPostToolContext(root, readInput("src/b.ts", content, root), { TH_CONTEXT_RAW_STORE: "1" });
    expect(coldStoreGet(paths, hashContent(content))).toBe(content);
  });

  it("hook with TH_EXACT_SUPPRESS=1 persists raw output (suppression needs it to rehydrate)", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const content = "file body under suppression";

    runHookPostToolContext(root, readInput("src/c.ts", content, root), { TH_EXACT_SUPPRESS: "1" });
    expect(coldStoreGet(paths, hashContent(content))).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// #5 — retention caps + usage report
// ---------------------------------------------------------------------------

describe("issue #5 — cold-store retention caps and usage report", () => {
  it("coldStoreUsage reports object count and total bytes", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    coldStorePut(paths, "aaaa", false);
    coldStorePut(paths, "bbbbbb", false);

    const u = coldStoreUsage(paths);
    expect(u.object_count).toBe(2);
    expect(u.total_bytes).toBe(Buffer.byteLength("aaaa") + Buffer.byteLength("bbbbbb"));
  });

  it("age cap removes objects older than maxAgeMs (oldest cleared, fresh kept)", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    coldStorePut(paths, "old-object", false);
    coldStorePut(paths, "fresh-object", false);

    // Age the first object 30 days into the past.
    const old = objPathFor(paths, "old-object");
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, past, past);

    const r = coldStoreEnforceRetention(paths, { maxBytes: 0, maxAgeMs: 14 * 24 * 60 * 60 * 1000 });
    expect(r.removed_count).toBe(1);
    expect(coldStoreGet(paths, hashContent("old-object"))).toBeUndefined();
    expect(coldStoreGet(paths, hashContent("fresh-object"))).toBe("fresh-object");
  });

  it("size cap evicts oldest-first until under the byte budget", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    // Three ~100-byte objects with increasing mtimes (o1 oldest).
    const bodies = ["1".repeat(100), "2".repeat(100), "3".repeat(100)];
    bodies.forEach((b, i) => {
      coldStorePut(paths, b, false);
      const t = new Date(Date.now() - (bodies.length - i) * 60_000); // o1 oldest
      fs.utimesSync(objPathFor(paths, b), t, t);
    });

    // Cap at 250 bytes → must drop the single oldest (o1) to fit ~200.
    const r = coldStoreEnforceRetention(paths, { maxBytes: 250, maxAgeMs: 0 });
    expect(r.removed_count).toBe(1);
    expect(r.remaining_bytes).toBeLessThanOrEqual(250);
    expect(coldStoreGet(paths, hashContent(bodies[0]!))).toBeUndefined(); // oldest gone
    expect(coldStoreGet(paths, hashContent(bodies[2]!))).toBe(bodies[2]); // newest kept
  });

  it("page-status surfaces a storage report block", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    coldStorePut(paths, "some object", false);

    const res = runContextPagesCommand("page-status", {}, paths);
    const data = res.data as { storage?: Record<string, unknown> };
    expect(data.storage).toBeDefined();
    expect(data.storage!.cold_objects).toBe(1);
    expect(typeof data.storage!.max_bytes).toBe("number");
    expect(data.storage!.raw_store_enabled).toBe(false); // default
    expect(res.human).toContain("Cold objects");
  });

  it("gc enforces the configured size cap (TH_CONTEXT_MAX_BYTES)", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const prev = process.env.TH_CONTEXT_MAX_BYTES;
    process.env.TH_CONTEXT_MAX_BYTES = "150";
    try {
      const bodies = ["x".repeat(100), "y".repeat(100)];
      bodies.forEach((b, i) => {
        coldStorePut(paths, b, false);
        const t = new Date(Date.now() - (bodies.length - i) * 60_000);
        fs.utimesSync(objPathFor(paths, b), t, t);
      });
      // age_days large so the age sweep is a no-op; the size cap drives eviction.
      const res = runContextPagesCommand("gc", { age_days: 365 }, paths);
      const data = res.data as { removed_count: number; remaining_bytes: number };
      expect(data.removed_count).toBe(1);
      expect(data.remaining_bytes).toBeLessThanOrEqual(150);
    } finally {
      if (prev === undefined) delete process.env.TH_CONTEXT_MAX_BYTES;
      else process.env.TH_CONTEXT_MAX_BYTES = prev;
    }
  });
});
