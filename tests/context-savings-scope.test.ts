/**
 * context-savings-scope.test.ts — issue #7.
 *
 * When a session filter is active, the savings command must display that
 * session's totals next to its session-scoped percentage — not all-store
 * aggregates. Two sessions with very different token profiles are seeded; a
 * scoped request must show only the requested session's numbers, and the
 * response must carry an explicit `scope`.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { telemetryFilePath } from "../src/core/context-telemetry";
import { runContextPagesCommand } from "../src/commands/context-pages";

function makeTmp(): { paths: ProjectPaths; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-savings-scope-"));
  return { paths: resolveProjectPaths(root), root };
}

/** Seed telemetry records (one per session) with distinct token profiles. */
function seed(paths: ProjectPaths): void {
  const f = telemetryFilePath(paths);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const recs = [
    { ts: "2026-06-27T00:00:00.000Z", session_id: "A", epoch: 0, orig_tokens: 100, returned_tokens: 100, delta_tokens: 0 },
    { ts: "2026-06-27T00:00:01.000Z", session_id: "B", epoch: 0, orig_tokens: 1000, returned_tokens: 1000, delta_tokens: 0 },
  ];
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe("issue #7 — session-scoped savings shows that session's totals", () => {
  it("scoped request: every displayed total belongs to the requested session", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    seed(paths);

    const res = runContextPagesCommand("savings", { session_id: "A" }, paths);
    const data = res.data as { scope: string; savings: { baseline_tokens: number; record_count: number } };

    expect(data.scope).toBe("session");
    // The scoped sub-object reflects session A only (100 tok, 1 record) — not 1100/2.
    expect(data.savings.baseline_tokens).toBe(100);
    expect(data.savings.record_count).toBe(1);

    // Human display shows session A's totals, and NONE of the all-store numbers.
    expect(res.human).toContain("session A");
    expect(res.human).toContain("Baseline tokens : 100");
    expect(res.human).toContain("Records         : 1");
    expect(res.human).not.toContain("1100");        // all-store baseline must not leak
    expect(res.human).not.toContain("Records         : 2");
  });

  it("unscoped request: scope is 'all' and the human shows all-store totals", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    seed(paths);

    const res = runContextPagesCommand("savings", {}, paths);
    const data = res.data as { scope: string };

    expect(data.scope).toBe("all");
    expect(res.human).toContain("all sessions");
    expect(res.human).toContain("Original tokens : 1100");
    expect(res.human).toContain("Records         : 2");
  });

  it("savings-detail carries an explicit scope field too", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    seed(paths);

    const scoped = runContextPagesCommand("savings-detail", { session_id: "B" }, paths);
    expect((scoped.data as { scope: string }).scope).toBe("session");
    expect((scoped.data as { savings: { baseline_tokens: number } }).savings.baseline_tokens).toBe(1000);

    const all = runContextPagesCommand("savings-detail", {}, paths);
    expect((all.data as { scope: string }).scope).toBe("all");
  });
});
