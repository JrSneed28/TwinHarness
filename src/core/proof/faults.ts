/**
 * Component 6 (Failure-injection / negative proof) — plan Step 6. Each enumerated
 * fault is injected into a real, isolated temp project and the spine is asserted to
 * fail SAFELY: a structured rejection (never an uncaught crash) and the correct
 * gate-block. The faults exercise the REAL validators / lock / integrity / wave /
 * gate functions — no SUT mocking.
 *
 * Faults (plan Step 6):
 *   - corrupt-state          → `validateState`/`readState` reject; stop-gate blocks
 *   - stale-lock             → `withStateLock` steals a >STALE_MS lock and runs fn
 *   - artifact-hash-mismatch → `artifactIntegrity` reports `changed`
 *   - dangling-cyclic-deps   → `validateDeps` reports dangling+cycles; `computeWave` stalls
 *   - open-drift-debate      → stop-gate blocks on open blocking drift/debate
 *   - unapproved-decision    → `gatingObligations` blocks; stop-gate blocks
 *
 * Every injector is wrapped so a thrown error becomes a FAILED {@link FaultResult}
 * (`observed:"threw: …"`, `pass:false`) rather than propagating — a fault proof must
 * itself never crash the suite.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../paths";
import { readState, writeState, withStateLock, STALE_MS } from "../state-store";
import { artifactIntegrity } from "../health";
import { validateDeps, computeWave } from "../wave";
import { appendDecisionEvent, reduceDecisions, readDecisionEvents, gatingObligations, canonicalStageLink } from "../decisions";
import { shortHashPath } from "../hash";
import { runInit } from "../../commands/init";
import { evaluateStopGate } from "../../commands/hook";
import type { SliceState } from "../state-schema";
import type { FaultResult } from "./types";

/** The enumerated fault identifiers (plan Step 6). */
export type FaultId =
  | "corrupt-state"
  | "stale-lock"
  | "artifact-hash-mismatch"
  | "dangling-cyclic-deps"
  | "open-drift-debate"
  | "unapproved-decision";

/** Every enumerated fault, in proof order. */
export const ALL_FAULTS: readonly FaultId[] = [
  "corrupt-state",
  "stale-lock",
  "artifact-hash-mismatch",
  "dangling-cyclic-deps",
  "open-drift-debate",
  "unapproved-decision",
] as const;

/** Run `fn` against a fresh, initialized, isolated temp project; always cleans up. */
function withTempProject<T>(fn: (paths: ProjectPaths) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-fault-"));
  const paths = resolveProjectPaths(root);
  runInit(paths, {});
  try {
    return fn(paths);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// --- individual injectors ---------------------------------------------------

/** Corrupt/invalid state.json → structured rejection (not a crash) + stop-gate block. */
function injectCorruptState(): FaultResult {
  return withTempProject((paths) => {
    // Schema-invalid (bad tier + empty current_stage) — must reject, never throw.
    fs.writeFileSync(paths.stateFile, JSON.stringify({ tier: "T9", current_stage: "" }), "utf8");
    const r = readState(paths);
    const rejected = r.exists && r.state === undefined && (r.issues?.length ?? 0) > 0;
    const gate = evaluateStopGate(paths);
    return {
      fault: "corrupt-state",
      expected: "validateState rejects with issues (no crash) and the stop-gate blocks",
      observed: `rejected=${rejected} (issues=${r.issues?.length ?? 0}), stopGate.block=${gate.block}`,
      pass: rejected && gate.block,
      gateBlocked: gate.block ? "stop-gate" : undefined,
    };
  });
}

/** Stale lock (older than STALE_MS) → `withStateLock` steals it and runs fn. */
function injectStaleLock(): FaultResult {
  return withTempProject((paths) => {
    const lockDir = path.join(paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const old = Date.now() - (STALE_MS + 60_000);
    fs.utimesSync(lockDir, new Date(old), new Date(old));

    let ran = false;
    const out = withStateLock(paths, () => {
      ran = true;
      return 42;
    });
    const released = !fs.existsSync(lockDir);
    return {
      fault: "stale-lock",
      expected: "withStateLock steals the stale lock, runs fn, and releases (no deadlock)",
      observed: `ran=${ran}, returned=${out}, released=${released}`,
      pass: ran && out === 42 && released,
    };
  });
}

/** Approved artifact edited after registration → `artifactIntegrity` = `changed`. */
function injectArtifactHashMismatch(): FaultResult {
  return withTempProject((paths) => {
    const rel = "docs/governed.md";
    const abs = path.join(paths.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "approved content v1\n", "utf8");

    // Register the CURRENT hash, then mutate the file → silent drift.
    const r = readState(paths);
    const state = r.state!;
    state.approved_artifacts = [{ file: rel, version: 1, hash: shortHashPath(abs) }];
    writeState(paths, state);
    fs.appendFileSync(abs, "sneaky unregistered edit\n", "utf8");

    const integ = artifactIntegrity(paths, readState(paths).state!);
    const entry = integ.find((i) => i.file === rel);
    return {
      fault: "artifact-hash-mismatch",
      expected: "artifactIntegrity flags the edited governed artifact as 'changed'",
      observed: `status=${entry?.status ?? "absent"}`,
      pass: entry?.status === "changed",
    };
  });
}

/** Dangling reference + a 2-cycle → `validateDeps` reports both; `computeWave` stalls. */
function injectDanglingCyclicDeps(): FaultResult {
  const slices: SliceState[] = [
    { id: "SLICE-A", status: "pending", components: ["c1"], depends_on: ["SLICE-MISSING"] },
    { id: "SLICE-B", status: "pending", components: ["c2"], depends_on: ["SLICE-C"] },
    { id: "SLICE-C", status: "pending", components: ["c3"], depends_on: ["SLICE-B"] },
  ];
  const issues = validateDeps(slices);
  const wave = computeWave(slices, new Map(), false);
  return {
    fault: "dangling-cyclic-deps",
    expected: "validateDeps reports dangling+cycles and computeWave stalls (no infinite spin)",
    observed: `dangling=${issues.dangling.length}, cycles=${issues.cycles.length}, stalled=${wave.stalled}`,
    pass: issues.dangling.length > 0 && issues.cycles.length > 0 && wave.stalled,
  };
}

/** Open blocking drift + debate → the stop-gate blocks completion. */
function injectOpenDriftDebate(): FaultResult {
  return withTempProject((paths) => {
    const state = readState(paths).state!;
    state.drift_open_blocking = 1;
    state.debate_open_blocking = 1;
    writeState(paths, state);
    const gate = evaluateStopGate(paths);
    return {
      fault: "open-drift-debate",
      expected: "stop-gate blocks while blocking drift/debate are open",
      observed: `block=${gate.block}, reasons=${gate.reasons.length}`,
      pass: gate.block && gate.reasons.length > 0,
      gateBlocked: gate.block ? "stop-gate" : undefined,
    };
  });
}

/** Unapproved decision gating the current stage → `gatingObligations` + stop-gate block. */
function injectUnapprovedDecision(): FaultResult {
  return withTempProject((paths) => {
    const state = readState(paths).state!;
    appendDecisionEvent(paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "Unapproved gating decision",
      rationale: "blocks the current stage until approved",
      links: [canonicalStageLink(state.current_stage)],
      proposer: "proof",
      proposedAt: new Date().toISOString(),
    });
    const obligations = gatingObligations(reduceDecisions(readDecisionEvents(paths)), state);
    const gate = evaluateStopGate(paths);
    return {
      fault: "unapproved-decision",
      expected: "gatingObligations + the stop-gate block on an unapproved stage-linked decision",
      observed: `obligations=${obligations.length}, stopGate.block=${gate.block}`,
      pass: obligations.length > 0 && gate.block,
      gateBlocked: gate.block ? "stop-gate" : undefined,
    };
  });
}

const INJECTORS: Record<FaultId, () => FaultResult> = {
  "corrupt-state": injectCorruptState,
  "stale-lock": injectStaleLock,
  "artifact-hash-mismatch": injectArtifactHashMismatch,
  "dangling-cyclic-deps": injectDanglingCyclicDeps,
  "open-drift-debate": injectOpenDriftDebate,
  "unapproved-decision": injectUnapprovedDecision,
};

/**
 * Inject one fault and assert safe failure. A throw from the injector is captured
 * as a FAILED result (the negative proof must never crash the suite itself).
 */
export function injectAndAssert(fault: FaultId): FaultResult {
  try {
    return INJECTORS[fault]();
  } catch (e) {
    return {
      fault,
      expected: "safe, structured failure (no uncaught crash)",
      observed: `threw: ${(e as Error).message}`,
      pass: false,
    };
  }
}

/** Run every enumerated fault, in order. */
export function runAllFaults(): FaultResult[] {
  return ALL_FAULTS.map(injectAndAssert);
}
