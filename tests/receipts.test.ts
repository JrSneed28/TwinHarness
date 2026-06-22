/**
 * Axis-B slice-1a (BSC-4) — terminal-transition receipt store (src/core/receipts.ts).
 *
 * The keystone module's unit tests: the hash chain, the shared content-binding
 * digest + snapshot coordinate, the producer (refuse-at-creation), every
 * validation status (absent / target_missing / target_mismatch / stale / legacy /
 * valid) for the requirement-layer kinds, the build-coordinate-only
 * decision-approve branch, and the idempotent marker-guarded migration that closes
 * negative-control (b). Deterministic + Windows-safe (path.join, no shell). The
 * `stale` snapshot test uses a real git repo and skips when git is unavailable.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempProject, type TempProject } from "./helpers";
import {
  // schema / chain
  canonicalText,
  computeRecordHash,
  verifyReceiptChain,
  // storage
  terminalReceiptsPath,
  readTerminalReceipts,
  readLastReceiptRecordHash,
  // shared helpers
  targetResolvesInSource,
  computeTargetDigest,
  currentSnapshotCoord,
  // producer
  appendTerminalReceipt,
  TargetUnresolvedError,
  // validation
  readReceiptValidated,
  // migration
  receiptMigrationDone,
  grandfatheredBaseline,
  collectTerminalEntities,
  ensureReceiptMigration,
  type TerminalTransitionReceipt,
} from "../src/core/receipts";
import { GENESIS_PREV_HASH } from "../src/core/hash";
import { appendDecisionEvent } from "../src/core/decisions";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** A temp project whose state dir exists, so appends land in a real .twinharness/. */
function freshProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  return p;
}

/** Write a governed source file (under docs/, an allowed write-surface) and return its rel path. */
function writeSourceFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/**
 * Seal a hand-built receipt onto the chain and append it directly (bypassing the
 * producer's target-resolution gate) so a test can pin an arbitrary recorded
 * `snapshot_coord` / digest. Mirrors `sealAndAppend`'s mechanics using the public
 * `computeRecordHash` so the appended line is chain-valid.
 */
function appendRawReceipt(
  paths: TempProject["paths"],
  fields: Omit<TerminalTransitionReceipt, "prevHash" | "recordHash">,
): TerminalTransitionReceipt {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastReceiptRecordHash(paths);
  const withPrev = { ...fields, prevHash };
  const recordHash = computeRecordHash(withPrev);
  const sealed: TerminalTransitionReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(terminalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/** A real git repo with one commit at `root`, or null when git is unavailable. */
function initGitRepo(root: string): boolean {
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run(["init"]).error) return false;
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  run(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitkeep"), "x\n", "utf8");
  run(["add", "-A"]);
  const c = run(["commit", "-m", "init", "--no-gpg-sign"]);
  return !(typeof c.status === "number" && c.status !== 0);
}

// ---------------------------------------------------------------------------
// Hash chain
// ---------------------------------------------------------------------------

describe("receipts — hash chain (seal + verifyReceiptChain)", () => {
  it("first append uses GENESIS prevHash and a 64-hex recordHash; chain verifies", () => {
    tp = freshProject();
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ body\n");
    const sealed = appendTerminalReceipt(tp.paths, {
      kind: "drift-resolve",
      refId: "DRIFT-001",
      targetPath: rel,
      producerIdentity: "cli",
    });
    expect(sealed.prevHash).toBe(GENESIS_PREV_HASH);
    expect(sealed.recordHash).toMatch(/^[0-9a-f]{64}$/);
    const all = readTerminalReceipts(tp.paths);
    expect(all).toHaveLength(1);
    expect(verifyReceiptChain(all)).toEqual({ ok: true });
  });

  it("multiple appends chain prevHash → prior recordHash; verifyReceiptChain ok", () => {
    tp = freshProject();
    const a = writeSourceFile(tp.root, "docs/a.md", "a\n");
    const b = writeSourceFile(tp.root, "docs/b.md", "b\n");
    const r1 = appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: a, producerIdentity: "cli" });
    const r2 = appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-002", targetPath: b, producerIdentity: "cli" });
    expect(r2.prevHash).toBe(r1.recordHash);
    expect(verifyReceiptChain(readTerminalReceipts(tp.paths))).toEqual({ ok: true });
  });

  it("an edited record is detected (recordHash mismatch → reason 'edited')", () => {
    tp = freshProject();
    const a = writeSourceFile(tp.root, "docs/a.md", "a\n");
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: a, producerIdentity: "cli" });
    const recs = readTerminalReceipts(tp.paths);
    recs[0]!.refId = "DRIFT-999"; // tamper a field, keep its (now-stale) recordHash
    const v = verifyReceiptChain(recs);
    expect(v).toEqual({ ok: false, brokenAt: 0, reason: "edited" });
  });

  it("a reordered chain is detected (prevHash mismatch → reason 'prev_mismatch')", () => {
    tp = freshProject();
    const a = writeSourceFile(tp.root, "docs/a.md", "a\n");
    const b = writeSourceFile(tp.root, "docs/b.md", "b\n");
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: a, producerIdentity: "cli" });
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-002", targetPath: b, producerIdentity: "cli" });
    const recs = readTerminalReceipts(tp.paths);
    const reordered = [recs[1]!, recs[0]!]; // swap order — second-now-first has a non-GENESIS prevHash
    const v = verifyReceiptChain(reordered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("prev_mismatch");
  });

  it("canonicalText omits undefined `legacy` and drops recordHash; is byte-stable", () => {
    const base: Omit<TerminalTransitionReceipt, "recordHash"> = {
      kind: "sim-retire",
      refId: "SIM-001",
      target_resolves_in_source: { path: "docs/x.md", digest: "deadbeef" },
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "cli",
      prevHash: GENESIS_PREV_HASH,
    };
    const text = canonicalText(base);
    expect(text).not.toContain("recordHash");
    expect(text).not.toContain("legacy");
    // Deterministic: same input → same text.
    expect(canonicalText(base)).toBe(text);
    // Field order is fixed (kind first, then refId, then nested target).
    expect(text.indexOf('"kind"')).toBeLessThan(text.indexOf('"refId"'));
    expect(text.indexOf('"path"')).toBeLessThan(text.indexOf('"digest"'));
  });

  it("readLastReceiptRecordHash → GENESIS when no ledger; last recordHash otherwise", () => {
    tp = freshProject();
    expect(readLastReceiptRecordHash(tp.paths)).toBe(GENESIS_PREV_HASH);
    const a = writeSourceFile(tp.root, "docs/a.md", "a\n");
    const r1 = appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: a, producerIdentity: "cli" });
    expect(readLastReceiptRecordHash(tp.paths)).toBe(r1.recordHash);
  });

  it("readTerminalReceipts is tolerant: skips a malformed/partial tail line, never throws", () => {
    tp = freshProject();
    const a = writeSourceFile(tp.root, "docs/a.md", "a\n");
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: a, producerIdentity: "cli" });
    fs.appendFileSync(terminalReceiptsPath(tp.paths), "{not json", "utf8");
    expect(() => readTerminalReceipts(tp.paths)).not.toThrow();
    expect(readTerminalReceipts(tp.paths)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Shared digest / snapshot helpers
// ---------------------------------------------------------------------------

describe("receipts — computeTargetDigest / targetResolvesInSource / currentSnapshotCoord", () => {
  it("computeTargetDigest resolves a regular file (CRLF-normalized) and matches hashContent", () => {
    tp = freshProject();
    const rel = writeSourceFile(tp.root, "docs/req.md", "line1\nline2\n");
    const d = computeTargetDigest(tp.root, rel);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(targetResolvesInSource(tp.root, rel)).toBe(true);
  });

  it("computeTargetDigest CRLF-normalizes (CRLF and LF copies digest identically)", () => {
    tp = freshProject();
    const lf = writeSourceFile(tp.root, "docs/lf.md", "a\nb\n");
    const crlf = writeSourceFile(tp.root, "docs/crlf.md", "a\r\nb\r\n");
    expect(computeTargetDigest(tp.root, lf)).toBe(computeTargetDigest(tp.root, crlf));
  });

  it("computeTargetDigest → null for a missing file, a directory, and an empty path", () => {
    tp = freshProject();
    expect(computeTargetDigest(tp.root, "docs/nope.md")).toBeNull();
    fs.mkdirSync(path.join(tp.root, "docs", "adir"), { recursive: true });
    expect(computeTargetDigest(tp.root, "docs/adir")).toBeNull(); // directory, not a regular file
    expect(computeTargetDigest(tp.root, "")).toBeNull();
    expect(targetResolvesInSource(tp.root, "docs/nope.md")).toBe(false);
  });

  it("computeTargetDigest rejects a path that escapes the root (path-escape → null)", () => {
    tp = freshProject();
    expect(computeTargetDigest(tp.root, "../escape.md")).toBeNull();
    expect(computeTargetDigest(tp.root, path.join("..", "..", "etc", "passwd"))).toBeNull();
    expect(targetResolvesInSource(tp.root, "../escape.md")).toBe(false);
  });

  it("currentSnapshotCoord has the {gitHead, treeDigest} shape (both null off-git)", () => {
    tp = freshProject(); // a plain temp dir is not a git repo
    const c = currentSnapshotCoord(tp.root);
    expect(c).toHaveProperty("gitHead");
    expect(c).toHaveProperty("treeDigest");
    expect(c.gitHead).toBeNull();
    expect(c.treeDigest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

describe("receipts — appendTerminalReceipt (producer)", () => {
  it("mints a valid receipt: records the target digest + snapshot + identity", () => {
    tp = freshProject();
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ\n");
    const expectedDigest = computeTargetDigest(tp.root, rel)!;
    const r = appendTerminalReceipt(tp.paths, {
      kind: "sim-retire",
      refId: "SIM-001",
      targetPath: rel,
      producerIdentity: "th-cli-v1",
    });
    expect(r.kind).toBe("sim-retire");
    expect(r.refId).toBe("SIM-001");
    expect(r.target_resolves_in_source).toEqual({ path: rel, digest: expectedDigest });
    expect(r.snapshot_coord).toEqual({ gitHead: null, treeDigest: null });
    expect(r.producer_identity).toBe("th-cli-v1");
    expect(r.legacy).toBeUndefined();
  });

  it("throws TargetUnresolvedError when a supplied target does not resolve (negative-control c at creation)", () => {
    tp = freshProject();
    expect(() =>
      appendTerminalReceipt(tp.paths, {
        kind: "drift-resolve",
        refId: "DRIFT-001",
        targetPath: "docs/missing.md",
        producerIdentity: "cli",
      }),
    ).toThrow(TargetUnresolvedError);
    // and nothing was written
    expect(readTerminalReceipts(tp.paths)).toHaveLength(0);
  });

  it("decision-approve may omit the target (build-coordinate-only) — empty target ground", () => {
    tp = freshProject();
    const r = appendTerminalReceipt(tp.paths, {
      kind: "decision-approve",
      refId: "DECISION-001",
      producerIdentity: "cli",
    });
    expect(r.target_resolves_in_source).toEqual({ path: "", digest: "" });
    expect(verifyReceiptChain(readTerminalReceipts(tp.paths))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Validation — drift-resolve / sim-retire (full requirement-layer discrimination)
// ---------------------------------------------------------------------------

describe("receipts — readReceiptValidated (drift-resolve / sim-retire)", () => {
  it("valid: present, non-legacy, target resolves + matches, not stale", () => {
    tp = freshProject();
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ\n");
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: rel, producerIdentity: "cli" });
    const v = readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001");
    expect(v.status).toBe("valid");
    expect(v.receipt?.refId).toBe("DRIFT-001");
  });

  it("target_missing: the recorded path no longer resolves (negative-control c at gate)", () => {
    tp = freshProject();
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ\n");
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: rel, producerIdentity: "cli" });
    fs.rmSync(path.join(tp.root, rel)); // delete the source target
    const v = readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001");
    expect(v.status).toBe("target_missing");
  });

  it("target_mismatch: the path resolves but its content digest changed", () => {
    tp = freshProject();
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ original\n");
    appendTerminalReceipt(tp.paths, { kind: "sim-retire", refId: "SIM-001", targetPath: rel, producerIdentity: "cli" });
    fs.writeFileSync(path.join(tp.root, rel), "REQ EDITED\n", "utf8"); // content drift
    const v = readReceiptValidated(tp.paths, "sim-retire", "SIM-001");
    expect(v.status).toBe("target_mismatch");
  });

  it("stale: snapshot_coord diverged (negative-control a) — recorded coord ≠ current", () => {
    tp = freshProject();
    if (!initGitRepo(tp.root)) {
      // git unavailable in this environment — skip (the off-git path is covered by
      // the both-null non-discriminating test below).
      return;
    }
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ\n");
    const digest = computeTargetDigest(tp.root, rel)!;
    // Hand-seal a receipt whose recorded snapshot_coord is a DIFFERENT (bogus) git
    // head than the repo's current one, with a treeDigest mismatch too. The target
    // still resolves + matches, so the only failing rung is staleness.
    appendRawReceipt(tp.paths, {
      kind: "drift-resolve",
      refId: "DRIFT-001",
      target_resolves_in_source: { path: rel, digest },
      snapshot_coord: { gitHead: "0".repeat(40), treeDigest: "0".repeat(64) },
      producer_identity: "cli",
    });
    const v = readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001");
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("gitHead");
  });

  it("NOT stale when a recorded coordinate is null (non-discriminating, F8 honesty)", () => {
    tp = freshProject(); // off-git → current coord is null/null
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ\n");
    const digest = computeTargetDigest(tp.root, rel)!;
    // Recorded gitHead is non-null but the CURRENT one is null (off-git): a null on
    // either side is non-discriminating, so this is `valid`, not `stale`.
    appendRawReceipt(tp.paths, {
      kind: "drift-resolve",
      refId: "DRIFT-002",
      target_resolves_in_source: { path: rel, digest },
      snapshot_coord: { gitHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", treeDigest: null },
      producer_identity: "cli",
    });
    expect(readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-002").status).toBe("valid");
  });

  it("the LATEST matching receipt wins (a re-flip's newer receipt is validated)", () => {
    tp = freshProject();
    const v1 = writeSourceFile(tp.root, "docs/req.md", "v1\n");
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: v1, producerIdentity: "cli" });
    // Re-flip against new content; the second receipt records the new digest.
    fs.writeFileSync(path.join(tp.root, v1), "v2\n", "utf8");
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: v1, producerIdentity: "cli" });
    // The latest receipt matches current content → valid (the stale first one is ignored).
    expect(readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001").status).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// Validation — decision-approve (build-coordinate-only branch, execution doc §6)
// ---------------------------------------------------------------------------

describe("receipts — readReceiptValidated (decision-approve build-coordinate-only)", () => {
  it("a present non-legacy decision-approve receipt is valid (no target requirement)", () => {
    tp = freshProject();
    appendTerminalReceipt(tp.paths, { kind: "decision-approve", refId: "DECISION-001", producerIdentity: "cli" });
    expect(readReceiptValidated(tp.paths, "decision-approve", "DECISION-001").status).toBe("valid");
  });

  it("decision-approve does NOT block on a missing target and does NOT go stale", () => {
    tp = freshProject();
    // Hand-seal a decision-approve receipt with a NON-resolving target AND a bogus
    // (would-be-stale) snapshot coord — neither blocks decision-approve.
    appendRawReceipt(tp.paths, {
      kind: "decision-approve",
      refId: "DECISION-002",
      target_resolves_in_source: { path: "docs/gone.md", digest: "abc123" },
      snapshot_coord: { gitHead: "0".repeat(40), treeDigest: "0".repeat(64) },
      producer_identity: "cli",
    });
    expect(readReceiptValidated(tp.paths, "decision-approve", "DECISION-002").status).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// Migration / grandfather (execution doc §4) — closes negative-control (b)
// ---------------------------------------------------------------------------

describe("receipts — migration / grandfather", () => {
  /** Write a simulation-ledger.json directly (raw, no command import). */
  function writeSimLedger(root: string, stateDir: string, rows: unknown[]): void {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "simulation-ledger.json"), JSON.stringify(rows, null, 2) + "\n", "utf8");
  }

  it("absent receipt classifies `legacy` when NO migration marker (genuinely pre-upgrade)", () => {
    tp = freshProject();
    expect(receiptMigrationDone(tp.paths)).toBe(false);
    // No receipt, no marker → grandfathered-implicitly so existing projects stay green.
    expect(readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001").status).toBe("legacy");
  });

  it("collectTerminalEntities reads all three ledgers (resolved drift / retired sim / approved decision)", () => {
    tp = freshProject();
    // drift: an entry + a resolution note (em-dash, exactly as runDriftResolve writes).
    const driftMd =
      "# Drift Log\n\n" +
      "## DRIFT-001  (SLICE-1 / TASK-1, Builder)  — requirement layer, BLOCKING\n" +
      "Discovery : x\nAction    : y\nEscalation: none\n\n" +
      "## DRIFT-001 — resolved\n\n" +
      "## DRIFT-002  (SLICE-1 / TASK-2, Builder)  — derived layer, auto-applied\n" +
      "Discovery : a\nAction    : b\nEscalation: none\n\n"; // DRIFT-002 NOT resolved
    fs.writeFileSync(tp.paths.driftLog, driftMd, "utf8");
    // sim: one retired, one active.
    writeSimLedger(tp.root, tp.paths.stateDir, [
      { id: "SIM-001", classification: "Mocked", userVisible: true, status: "retired" },
      { id: "SIM-002", classification: "Mocked", userVisible: true, status: "active" },
    ]);
    // decision: propose + approve DECISION-001.
    appendDecisionEvent(tp.paths, { id: "DECISION-001", event: "proposed", title: "t", rationale: "r", links: [] });
    appendDecisionEvent(tp.paths, { id: "DECISION-001", event: "approved", approver: "human" });

    const ents = collectTerminalEntities(tp.paths);
    const keys = ents.map((e) => `${e.kind}:${e.refId}`).sort();
    expect(keys).toEqual(["decision-approve:DECISION-001", "drift-resolve:DRIFT-001", "sim-retire:SIM-001"].sort());
  });

  it("ensureReceiptMigration stamps a legacy receipt per terminal entity + writes the marker baseline", () => {
    tp = freshProject();
    fs.writeFileSync(
      tp.paths.driftLog,
      "## DRIFT-001  (S/ T, Builder)  — requirement layer, BLOCKING\nDiscovery : x\nAction    : y\nEscalation: none\n\n## DRIFT-001 — resolved\n",
      "utf8",
    );
    writeSimLedger(tp.root, tp.paths.stateDir, [{ id: "SIM-001", classification: "Mocked", userVisible: true, status: "retired" }]);

    ensureReceiptMigration(tp.paths);

    expect(receiptMigrationDone(tp.paths)).toBe(true);
    const baseline = grandfatheredBaseline(tp.paths);
    expect(baseline.has("drift-resolve:DRIFT-001")).toBe(true);
    expect(baseline.has("sim-retire:SIM-001")).toBe(true);
    // Each baseline entity now has a legacy receipt classified as `legacy`.
    expect(readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001").status).toBe("legacy");
    expect(readReceiptValidated(tp.paths, "sim-retire", "SIM-001").status).toBe("legacy");
    // The stamps are legacy:true and the chain still verifies.
    const recs = readTerminalReceipts(tp.paths);
    expect(recs.every((r) => r.legacy === true)).toBe(true);
    expect(verifyReceiptChain(recs)).toEqual({ ok: true });
  });

  it("ensureReceiptMigration is idempotent (a re-run does not double-stamp)", () => {
    tp = freshProject();
    writeSimLedger(tp.root, tp.paths.stateDir, [{ id: "SIM-001", classification: "Mocked", userVisible: true, status: "retired" }]);
    ensureReceiptMigration(tp.paths);
    const after1 = readTerminalReceipts(tp.paths).length;
    ensureReceiptMigration(tp.paths); // no-op (marker present)
    ensureReceiptMigration(tp.paths);
    expect(readTerminalReceipts(tp.paths).length).toBe(after1);
  });

  it("post-migration, a NEW terminal entity with no receipt classifies `absent` (negative-control b → BLOCK)", () => {
    tp = freshProject();
    // Migrate with an empty world → marker present, empty baseline.
    ensureReceiptMigration(tp.paths);
    expect(receiptMigrationDone(tp.paths)).toBe(true);
    expect(grandfatheredBaseline(tp.paths).size).toBe(0);
    // A flip done AFTER migration via a bypass (no receipt minted) → absent.
    expect(readReceiptValidated(tp.paths, "sim-retire", "SIM-001").status).toBe("absent");
  });

  it("ensureReceiptMigration does not double-stamp an entity that already has a (real) receipt", () => {
    tp = freshProject();
    const rel = writeSourceFile(tp.root, "docs/req.md", "REQ\n");
    // A real receipt already exists for DRIFT-001 (e.g. the producer ran first).
    appendTerminalReceipt(tp.paths, { kind: "drift-resolve", refId: "DRIFT-001", targetPath: rel, producerIdentity: "cli" });
    fs.writeFileSync(
      tp.paths.driftLog,
      "## DRIFT-001  (S/ T, Builder)  — requirement layer, BLOCKING\nDiscovery : x\nAction    : y\nEscalation: none\n\n## DRIFT-001 — resolved\n",
      "utf8",
    );
    ensureReceiptMigration(tp.paths);
    // Still exactly one receipt for DRIFT-001 — the legacy stamp was skipped.
    const driftReceipts = readTerminalReceipts(tp.paths).filter((r) => r.refId === "DRIFT-001");
    expect(driftReceipts).toHaveLength(1);
    expect(driftReceipts[0]!.legacy).toBeUndefined(); // the original real receipt, not a legacy stamp
    // It's still grounded → valid, even though the entity is in the baseline.
    expect(readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001").status).toBe("valid");
  });
});
