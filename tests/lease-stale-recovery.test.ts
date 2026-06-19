/**
 * Phase 5 / P5-3 — section-lease + fragment stale-recovery (REQ-PCO-062).
 *
 * A section lease's holder is an agent id, not a slice, so a dead/crashed holder
 * that never ran `th artifact release` would wedge that `<file>#<section>` FOREVER.
 * P5-3 adds a TTL sweep (mirroring `staleLeases`) that recovers such leases, plus a
 * fragment GC/TTL that reaps orphaned blackboard fragments. These tests pin the
 * recovery — clock-injected so they are deterministic.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import {
  appendLeaseEvent,
  activeSectionLeases,
  claimTimestamps,
  staleSectionLeases,
  liveSectionLeases,
  sweepStaleSectionLeases,
  SECTION_LEASE_TTL_MS,
} from "../src/core/leases";
import {
  writeFragment,
  listFragments,
  staleFragments,
  sweepStaleFragments,
  FRAGMENT_TTL_MS,
} from "../src/core/collab";
import * as fs from "node:fs";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

const SECTION = "docs/04-architecture.md#data-model";
/** Inject a claim at a fixed wall-clock instant. */
function claimAt(t: TempProject, section: string, holder: string, at: Date): void {
  appendLeaseEvent(t.paths, { event: "claim", slice: section, components: [holder] }, () => at);
}

describe("REQ-PCO-062: section-lease claim timestamps are recoverable from the ledger", () => {
  it("REQ-PCO-062: activeSectionLeases stays timestamp-free; claimTimestamps carries the ts", () => {
    tp = makeTempProject();
    const at = new Date("2026-06-19T00:00:00.000Z");
    claimAt(tp, SECTION, "builder-a", at);
    const active = activeSectionLeases(tp.paths);
    expect(active).toHaveLength(1);
    // Shape contract: exactly {section, holder} — no timestamp leaks into the active shape.
    expect(active[0]).toEqual({ section: SECTION, holder: "builder-a" });
    // The timestamp is available separately for the TTL sweep.
    expect(claimTimestamps(tp.paths).get(SECTION)).toBe(at.toISOString());
  });
});

describe("REQ-PCO-062: section-lease TTL stale-recovery", () => {
  it("REQ-PCO-062: a fresh lease is LIVE, not stale, within the TTL", () => {
    tp = makeTempProject();
    const at = new Date("2026-06-19T00:00:00.000Z");
    claimAt(tp, SECTION, "builder-a", at);
    // 1 minute later — well within the 2h TTL.
    const now = () => new Date(at.getTime() + 60_000);
    expect(staleSectionLeases(tp.paths, SECTION_LEASE_TTL_MS, now)).toHaveLength(0);
    expect(liveSectionLeases(tp.paths, SECTION_LEASE_TTL_MS, now)).toHaveLength(1);
  });

  it("REQ-PCO-062: a lease past the TTL is STALE (dead holder)", () => {
    tp = makeTempProject();
    const at = new Date("2026-06-19T00:00:00.000Z");
    claimAt(tp, SECTION, "builder-a", at);
    // 3 hours later — past the 2h TTL.
    const now = () => new Date(at.getTime() + 3 * 60 * 60 * 1000);
    const stale = staleSectionLeases(tp.paths, SECTION_LEASE_TTL_MS, now);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.section).toBe(SECTION);
    expect(liveSectionLeases(tp.paths, SECTION_LEASE_TTL_MS, now)).toHaveLength(0);
  });

  it("REQ-PCO-062: sweepStaleSectionLeases releases the dead lease and frees the section", () => {
    tp = makeTempProject();
    const at = new Date("2026-06-19T00:00:00.000Z");
    claimAt(tp, SECTION, "builder-a", at);
    const now = () => new Date(at.getTime() + 3 * 60 * 60 * 1000);

    const swept = sweepStaleSectionLeases(tp.paths, SECTION_LEASE_TTL_MS, now);
    expect(swept).toHaveLength(1);
    expect(swept[0]!.section).toBe(SECTION);

    // After the sweep the section is FREE — no active lease wedging it.
    expect(activeSectionLeases(tp.paths)).toHaveLength(0);
    // Idempotent — a second sweep finds nothing.
    expect(sweepStaleSectionLeases(tp.paths, SECTION_LEASE_TTL_MS, now)).toHaveLength(0);
  });

  it("REQ-PCO-062: a re-claim refreshes the timestamp so the holder stays live", () => {
    tp = makeTempProject();
    const at = new Date("2026-06-19T00:00:00.000Z");
    claimAt(tp, SECTION, "builder-a", at);
    // Re-claim 90 min later (still same holder).
    const reAt = new Date(at.getTime() + 90 * 60 * 1000);
    claimAt(tp, SECTION, "builder-a", reAt);
    // 30 min after the re-claim — within TTL of the LATEST claim.
    const now = () => new Date(reAt.getTime() + 30 * 60 * 1000);
    expect(staleSectionLeases(tp.paths, SECTION_LEASE_TTL_MS, now)).toHaveLength(0);
  });
});

describe("REQ-PCO-062: fragment GC / TTL stale-recovery", () => {
  function dropFragment(t: TempProject, name: string): string {
    return writeFragment(t.paths, {
      stage: "architecture",
      round: "r1",
      name,
      content: "## REQ-001\nproposal\n",
    });
  }

  it("REQ-PCO-062: a recent fragment is NOT stale within the TTL", () => {
    tp = makeTempProject();
    dropFragment(tp, "builder-a.md");
    // now == file mtime ⇒ age 0 ⇒ not stale.
    const stale = staleFragments(tp.paths, "architecture", "r1", FRAGMENT_TTL_MS, () => new Date());
    expect(stale).toHaveLength(0);
  });

  it("REQ-PCO-062: a fragment older than the TTL is stale and sweepable", () => {
    tp = makeTempProject();
    const file = dropFragment(tp, "builder-a.md");
    // Back-date the file mtime to 2 days ago.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);

    const stale = staleFragments(tp.paths, "architecture", "r1");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.name).toBe("builder-a.md");

    // GC removes it; a fresh fragment in the same round is untouched.
    dropFragment(tp, "builder-b.md");
    const swept = sweepStaleFragments(tp.paths, "architecture", "r1");
    expect(swept.map((f) => f.name)).toEqual(["builder-a.md"]);
    expect(fs.existsSync(file)).toBe(false);

    const remaining = listFragments(tp.paths, "architecture", "r1").map((f) => f.name);
    expect(remaining).toEqual(["builder-b.md"]);
    // Idempotent.
    expect(sweepStaleFragments(tp.paths, "architecture", "r1")).toHaveLength(0);
  });
});
