/**
 * Terminal-transition receipt store (Axis-B slice-1a / BSC-4 — the keystone the
 * other 8 blind-spot classes copy). An irreversible ledger flip — a drift
 * resolved, a simulation retired, a decision approved — currently clears the
 * completion gate from a marker/attestation alone, with NO correspondence to
 * source. This module mints a schema-registered `TerminalTransitionReceipt` whose
 * *ground* (a content digest of the named source target + the repository snapshot
 * coordinate it was minted at) is recomputable at gate time, so a flip that does
 * not actually resolve in source is mechanically detectable.
 *
 * Storage mirrors `src/core/decisions.ts` EXACTLY: append-only, SHA-256
 * hash-chained `<stateDir>/terminal-receipts.jsonl`, one receipt per line, a
 * tolerant reader that never throws (`readTerminalReceipts`), a tail-scan for the
 * next `prevHash` (`readLastReceiptRecordHash`), an atomic-append writer that runs
 * under the CALLER's `withStateLock` span (`appendTerminalReceipt`), and a
 * tamper-detecting chain walk (`verifyReceiptChain`). A dedicated store gives the
 * gate one validated reader and slice-1b's external (un-writable) producer a
 * distinct location.
 *
 * The shared digest formula (`computeTargetDigest`) is modeled on
 * `tester.ts:computeReceiptDigest` (F8 content-bound-digest) but DOES NOT import
 * or modify it — F8's call path stays byte-identical and F8 tests stay green. It
 * is the SINGLE formula used by BOTH the producer (at creation) and the validator
 * (at gate time), so the two sides can never drift apart on the binding.
 *
 * `producer_identity` carries ZERO trust weight in-process (execution doc §2.4):
 * it is an audit breadcrumb only. The genuine un-forgeable property arrives in
 * slice-1b (an external keyed producer at a write-surface TwinHarness cannot
 * reach). Documented as such so a reviewer never mistakes it for a trust anchor.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface, resolveWithinRoot } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid, safeParseJson } from "./jsonl";
import { gitHead, dirtyTreeDigest } from "./git-revision";
import { parseDriftEntries } from "./drift-log";
import { readDecisionEvents, reduceDecisions } from "./decisions";
import {
  externalKeyId,
  loadExternalPublicKey,
  verifyCanonical,
} from "./receipt-signing";

// ---------------------------------------------------------------------------
// Schema (execution doc §2.5)
// ---------------------------------------------------------------------------

/**
 * Which kind of irreversible ledger flip a receipt grounds. One value per
 * terminal ledger: a resolved requirement-layer drift, a retired simulation
 * entry, an approved decision.
 */
export type TerminalTransitionKind = "drift-resolve" | "sim-retire" | "decision-approve";

/**
 * Axis-B slice-4a / BSC-3 — the discriminator of a {@link DriverDimensionReceipt}.
 * A FIFTH instance of the shipped receipt shape (after BSC-4 terminal, BSC-6 scan,
 * BSC-7 approval): a distinct kind so the driver-dimension store, reader, and gate
 * validator stay single-purpose (the F8 lesson) and never conflate with the
 * terminal-transition domain. Lives in `src/core/verification-driver.ts`, which
 * REUSES the shared shape/helpers here without coupling F8's `tester.ts` call path.
 */
export type DriverDimensionKind = "driver-dimension";

/**
 * One runner-observed verification dimension on a {@link DriverDimensionReceipt}
 * (slice-4a / BSC-3). The receipt's GROUND is *which dimensions a trusted runner
 * actually exercised* — never self-declared by the thing under test. A dimension is
 * recorded ONLY when the VerificationDriver sensor bound it to a real, recomputable
 * artifact (`evidenceRef`), so `observed` is ALWAYS `true` (an unobserved dimension is
 * simply ABSENT, never a `false` row). The seed vocabulary is `{tests-executed,
 * typecheck, build}`; the namespace is open (declared-SET coverage is BSC-5, assertion
 * quality is BSC-2 — this slice builds only the sensor those rows consume).
 */
export interface DriverDimension {
  /** The open-vocabulary dimension name (seed: `tests-executed` / `typecheck` / `build`). */
  name: string;
  /** Always `true` — an unobserved dimension is omitted, never recorded `false`. */
  observed: true;
  /**
   * A recomputable reference to the runner-observation artifact this dimension was
   * bound to — the root-relative `verify-report.json` path whose per-command
   * `{command, exitCode, ok}` exit result evidences the dimension. NEVER
   * `tester-record.json` (an agent-supplied MARKER, not a runner observation —
   * binding there would reproduce BSC-3 inside its own fix). The gate re-reads this
   * artifact at validation time, so the binding is diffable (the F8 lesson).
   */
  evidenceRef: string;
}

/**
 * The content-bound ground: the source path the flip claims to resolve in, and a
 * content digest of that file at mint time. `path` is the project-root-relative
 * path; `digest` is {@link computeTargetDigest} over it. Both are `""` on a
 * build-coordinate-only receipt (a decision-approve with no linked artifact, and
 * the legacy backfill stamp).
 */
export interface TargetResolvesInSource {
  path: string;
  digest: string;
}

/**
 * The repository snapshot coordinate the receipt was minted at (reuses
 * `git-revision.ts`). Both null on a non-git checkout — F8 honesty: a null
 * coordinate is NON-DISCRIMINATING (it cannot prove staleness it has no
 * coordinate for), so the validator only treats a coordinate as stale when BOTH
 * the recorded and the current value are non-null.
 */
export interface SnapshotCoord {
  gitHead: string | null;
  treeDigest: string | null;
}

/**
 * One terminal-transition receipt (execution doc §2.5). Append-only and
 * hash-chained like a {@link import("./decisions").DecisionEvent}: any single
 * field edit breaks `recordHash`, and an insert/delete/reorder breaks the next
 * `prevHash`, so a forged or tampered receipt is detectable by
 * {@link verifyReceiptChain}.
 */
export interface TerminalTransitionReceipt {
  /** The terminal-ledger kind this receipt grounds. */
  kind: TerminalTransitionKind;
  /** The terminal entity id: `DRIFT-NNN` / `SIM-NNN` / `DECISION-NNN`. */
  refId: string;
  /** The content-bound ground (source path + its digest at mint time). */
  target_resolves_in_source: TargetResolvesInSource;
  /** The repository snapshot coordinate at mint time. */
  snapshot_coord: SnapshotCoord;
  /**
   * The producer's self-asserted identity. ZERO trust weight in-process — an
   * audit breadcrumb only (execution doc §2.4). The un-forgeable property arrives
   * via the slice-1b external keyed producer (`producer_kind:"external"` + a
   * verifying `signature`), NOT this field.
   */
  producer_identity: string;
  /**
   * Slice-1b (BSC-4) — which PRODUCER minted this receipt. `"external"` marks a
   * receipt from the keyed out-of-process producer (it MUST carry a verifying
   * `signature`); `"in-process"` (or absent) marks an in-process self-attested
   * receipt (NEVER signed). Optional + omit-when-absent so a slice-1a receipt's
   * canonical text — and therefore its `recordHash` — is byte-identical. Part of
   * the canonical hash input (after `producer_identity`).
   */
  producer_kind?: "external" | "in-process";
  /**
   * Slice-1b — the short, NON-secret id of the public key that verifies an external
   * receipt (`receipt-signing.externalKeyId`), so a verifier knows WHICH key to
   * use and an old key can be rotated out. Absent on in-process receipts. Part of
   * the canonical hash input (after `producer_kind`), so it is signature-bound: a key_id
   * swap changes the canonical text and breaks the signature.
   */
  key_id?: string;
  /**
   * Slice-1b — the base64 Ed25519 signature over this receipt's canonical text.
   * A TRAILER, EXCLUDED from
   * `canonicalText` exactly like `recordHash`: both `recordHash` and `signature`
   * are computed over the IDENTICAL canonical input, so the signature covers every
   * signed field. Absent on in-process receipts. Its presence + verification is
   * what the validator classifies as `valid-grounded`.
   */
  signature?: string;
  /**
   * `true` ONLY on a one-time backfill stamp (migration §4). A `legacy` receipt
   * is grandfathered: the gate ACCEPTS it but the validator reports it as
   * ungrounded-`legacy`. Omit-when-absent so a real receipt's canonical text
   * never carries it.
   */
  legacy?: boolean;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS receipt's canonical text (computed before set). */
  recordHash: string;
}

/**
 * One driver-dimension receipt (Axis-B slice-4a / BSC-3). Append-only and
 * hash-chained like a {@link TerminalTransitionReceipt}: any single field edit breaks
 * `recordHash`, and an insert/delete/reorder breaks the next `prevHash`. Minted +
 * validated by `src/core/verification-driver.ts` (a dedicated module + store), which
 * REUSES the shared digest/snapshot helpers and the slice-1b/3b signing fields here
 * without coupling F8's `tester.ts` call path.
 *
 * The `key_id` field is the short non-secret id of the verifying public key
 * (`receipt-signing.externalKeyId`) — the same field the terminal/approval receipts
 * carry. (The slice spec names it `externalKeyId?`; it is `key_id` here so the slice-4b
 * external producer + gate verifier reuse the IDENTICAL `key_id`/signature mechanism as
 * slices 1b/3b — a single shared verification path, not a parallel one.)
 */
export interface DriverDimensionReceipt {
  /** Fixed discriminator. */
  kind: DriverDimensionKind;
  /**
   * The run/verification identity this receipt grounds — the snapshot coordinate's
   * `gitHead` (or `"no-git"` on a non-git checkout), so a re-run at a new HEAD mints a
   * fresh receipt and the gate can find the LATEST for the current snapshot.
   */
  refId: string;
  /**
   * The runner-observed dimensions (each bound to a recomputable artifact). Empty is
   * legal (a run that observed NOTHING) but the gate treats a CLAIMED-but-absent
   * dimension as the negative-control block (slice-4a).
   */
  dimensions: DriverDimension[];
  /** The repository snapshot coordinate at mint time (reuses `git-revision.ts`). */
  snapshot_coord: SnapshotCoord;
  /**
   * The producer's self-asserted identity. ZERO trust weight in-process — an audit
   * breadcrumb ONLY (consensus §3). The un-forgeable property arrives via the slice-4b
   * external keyed producer (`producer_kind:"external"` + a verifying `signature`), NOT
   * this field. Part of the canonical hash input.
   */
  producer_identity: string;
  /**
   * Slice-4b — which PRODUCER minted this receipt. `"external"` marks a receipt from the
   * keyed out-of-process CI producer (it MUST carry a verifying `signature`);
   * `"in-process"` (or absent) marks an in-process attested receipt (NEVER signed).
   * Optional + omit-when-absent so a 4a receipt's canonical text — and `recordHash` — is
   * byte-stable. Part of the canonical hash input (after `producer_identity`).
   */
  producer_kind?: "external" | "in-process";
  /**
   * Slice-4b — the short, NON-secret id of the public key that verifies an external
   * receipt (`receipt-signing.externalKeyId`). Absent on in-process receipts. Part of
   * the canonical hash input (after `producer_kind`), so a key_id swap breaks the signature.
   */
  key_id?: string;
  /**
   * Slice-4b — the base64 Ed25519 signature over this receipt's canonical text. A
   * TRAILER, EXCLUDED from {@link driverCanonicalText} exactly like `recordHash`: both
   * are computed over the IDENTICAL canonical input, so the signature covers every signed
   * field (including each dimension). Absent on in-process receipts.
   */
  signature?: string;
  /**
   * `true` ONLY on a one-time backfill stamp (migration). A `legacy` receipt is
   * grandfathered: the gate ACCEPTS it but the validator reports it as ungrounded-legacy.
   * Omit-when-absent so a real receipt's canonical text never carries it.
   */
  legacy?: boolean;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS receipt's canonical text (computed before set). */
  recordHash: string;
}

// ---------------------------------------------------------------------------
// Axis-B slice-6 / BSC-2 — assertion-presence + mutation-kill schemas
// ---------------------------------------------------------------------------

/**
 * Axis-B slice-6 / BSC-2 (2a) — the discriminator of an {@link AssertionPresenceReceipt}.
 * THE BLIND SPOT: the coverage gate counts a REQ as "tested" when its anchor appears in a
 * RECOGNIZED test file, but a test file that contains NO non-trivial assertion (an empty
 * `it()`, a smoke test that only constructs a value, or a tautology like
 * `expect(true).toBe(true)`) clears that bar — "tested" is asserted with no executable
 * check that can FAIL. This receipt's GROUND is the recomputable per-REQ assertion-presence
 * summary minted by the regex/lexer-grade sensor in `src/core/assertion-presence.ts`, so a
 * REQ whose tests carry no non-trivial assertion is mechanically detectable at gate time.
 */
export type AssertionPresenceKind = "assertion-presence";

/**
 * Axis-B slice-6 / BSC-2 (2b) — the discriminator of a {@link MutationKillReceipt}. The
 * stronger, INDEPENDENTLY-grounded form of 2a: a mutation report from a controlled runner
 * proves the test suite actually KILLS injected faults (assertion presence is necessary but
 * not sufficient — a non-trivial assertion can still fail to catch a real mutant). ALWAYS
 * externally produced + signed (`producer_kind:"controlled-runner"`); a 2b line lacking a
 * verifying signature is `forged`, never trusted.
 */
export type MutationKillKind = "mutation-kill";

/**
 * One per-REQ assertion-presence summary — the recomputable ground UNIT (BSC-2 2a). Minted
 * by the sensor `computeAssertionPresenceGround` (regex/lexer-grade, NO AST), so the gate
 * re-derives it at validation time and a tampered/stale receipt is detectable (the F8
 * "diffable ground" lesson). Every field is deterministic: `testFiles` is lexically sorted
 * + POSIX-normalized, the counts come from the pinned `expect(...)` balanced-paren scan, and
 * `assertionFree` is the gate's offender predicate.
 */
export interface AssertionReqSummary {
  /** The REQ-ID this summary grounds (the enumerator/validator key). */
  reqId: string;
  /** The recognized test files anchoring this REQ, lexically sorted + POSIX-normalized. */
  testFiles: string[];
  /** Total `expect(...)` chains across `testFiles` (parseable files only). */
  assertionCount: number;
  /** `assertionCount` minus the trivial (cannot-fail) assertions. */
  nonTrivialAssertions: number;
  /** `true` iff `nonTrivialAssertions === 0` — the gate's per-REQ offender predicate. */
  assertionFree: boolean;
}

/**
 * The recomputable ground of an {@link AssertionPresenceReceipt}: per-REQ summaries, sorted
 * lexically by `reqId`. Serialized byte-identically regardless of `readdirSync` order so the
 * receipt's `recordHash` is stable across runners/platforms (BSC-2 Principle 6).
 */
export type AssertionPresenceGround = AssertionReqSummary[];

/**
 * One assertion-presence receipt (BSC-2 2a). Append-only and hash-chained like a
 * {@link DriverDimensionReceipt}: any single field edit breaks `recordHash`, and an
 * insert/delete/reorder breaks the next `prevHash`. Minted + validated by
 * `src/core/assertion-presence.ts` (a dedicated module + store).
 *
 * IN-PROCESS-ONLY: this receipt carries NO signing fields. `producer_identity` is a ZERO-
 * trust audit breadcrumb (mirrors the in-process driver/realization posture); the in-process
 * pass status is `valid`, NEVER `valid-grounded`. The independently-grounded property for
 * BSC-2 lives in the SEPARATE {@link MutationKillReceipt} (2b), not here.
 */
export interface AssertionPresenceReceipt {
  /** Fixed discriminator. */
  kind: AssertionPresenceKind;
  /**
   * The run identity this receipt grounds — the snapshot coordinate's `gitHead` (or
   * `"no-git"` on a non-git checkout), so a re-run at a new HEAD mints a fresh receipt and
   * the gate finds the LATEST for the current snapshot (mirrors `DriverDimensionReceipt.refId`).
   */
  refId: string;
  /** The recomputable ground: per-REQ assertion-presence summaries, sorted by `reqId`. */
  ground: AssertionPresenceGround;
  /** The repository snapshot coordinate at mint time (reuses `git-revision.ts`). */
  snapshot_coord: SnapshotCoord;
  /**
   * The producer's self-asserted identity. ZERO trust weight in-process — an audit
   * breadcrumb ONLY. This receipt is never signed (the un-forgeable property is 2b's
   * {@link MutationKillReceipt}). Part of the canonical hash input.
   */
  producer_identity: string;
  /**
   * `true` ONLY on a one-time backfill stamp (migration). A `legacy` receipt is
   * grandfathered. Omit-when-absent so a real receipt's canonical text never carries it.
   */
  legacy?: boolean;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS receipt's canonical text (computed before set). */
  recordHash: string;
}

/**
 * The mutation-report ground of a {@link MutationKillReceipt} (BSC-2 2b). Produced by a
 * controlled mutation-testing runner over a SINGLE source module: counts of generated /
 * killed / survived mutants, the derived kill `score`, and the mutated `scope`. The gate
 * re-reads these fields; staleness is bounded by the receipt's snapshot coordinate.
 */
export interface MutationKillGround {
  /** Total mutants the runner generated for `scope`. */
  mutants_generated: number;
  /** Mutants the test suite KILLED (a test failed under the mutant — the desired signal). */
  mutants_killed: number;
  /** Mutants that SURVIVED (no test caught them — the gap the metric exposes). */
  mutants_survived: number;
  /** Kill score `mutants_killed / mutants_generated`, in `0..1`. */
  score: number;
  /** The single source module that was mutated, e.g. `"src/core/hash.ts"`. */
  scope: string;
}

/**
 * One mutation-kill receipt (BSC-2 2b). Append-only and hash-chained like a
 * {@link DriverDimensionReceipt}, with the slice-1b/3b/4b signing TRAILER. Minted ONLY by
 * the external controlled-runner producer (`scripts/th-receipt-producer.mjs --kind
 * mutation-kill`) and validated by `src/core/assertion-presence.ts`.
 *
 * ALWAYS EXTERNALLY PRODUCED + SIGNED: `producer_kind` is the fixed literal
 * `"controlled-runner"`, and the ONLY valid trust label is `valid-grounded` — a line that
 * lacks a verifying Ed25519 `signature` is `forged`, never trusted. There is NO in-process
 * producer for this receipt (unlike 2a's {@link AssertionPresenceReceipt}).
 */
export interface MutationKillReceipt {
  /** Fixed discriminator. */
  kind: MutationKillKind;
  /**
   * The run identity this receipt grounds — the snapshot coordinate's `gitHead` (or
   * `"no-git"`), mirroring {@link AssertionPresenceReceipt.refId}.
   */
  refId: string;
  /** The controlled-runner mutation-report ground. */
  ground: MutationKillGround;
  /** The repository snapshot coordinate at mint time (reuses `git-revision.ts`). */
  snapshot_coord: SnapshotCoord;
  /**
   * ALWAYS `"controlled-runner"` — this receipt has no in-process producer. Part of the
   * canonical (and therefore signature-bound) hash input, so a producer-kind swap breaks
   * the signature.
   */
  producer_kind: "controlled-runner";
  /**
   * The short, NON-secret id of the public key that verifies this receipt
   * (`receipt-signing.externalKeyId`). Part of the canonical hash input (after
   * `producer_kind`), so a key_id swap breaks the signature.
   */
  key_id: string;
  /**
   * The base64 Ed25519 signature over this receipt's canonical text. A TRAILER, EXCLUDED
   * from `mutationKillCanonicalText` exactly like `recordHash`: both are computed over the
   * IDENTICAL canonical input, so the signature covers every signed field. A line lacking a
   * verifying signature is `forged`.
   */
  signature?: string;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS receipt's canonical text (computed before set). */
  recordHash: string;
}

// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors decisions.ts) — the tamper-evidence core
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing. Mirrors decisions.ts: copy fields
 * into a fresh object in THIS order, omit any `undefined` key, omit `recordHash`
 * entirely. The two nested objects (`target_resolves_in_source`, `snapshot_coord`)
 * are re-emitted in a FIXED key order so the canonical text is byte-stable (the
 * `canonicalProvenance` technique from decisions.ts).
 */
const CANONICAL_FIELD_ORDER: ReadonlyArray<keyof TerminalTransitionReceipt> = [
  "kind",
  "refId",
  "target_resolves_in_source",
  "snapshot_coord",
  "producer_identity",
  // Slice-1b — `producer_kind` + `key_id` join the canonical (and therefore signature-
  // bound) input AFTER producer_identity, BEFORE legacy. `signature` is DELIBERATELY
  // absent here: like `recordHash`, it is a TRAILER excluded from canonicalText, so
  // both the recordHash and the signature are computed over the IDENTICAL bytes.
  // canonicalText() skips undefined keys, so a slice-1a receipt (all three new fields
  // absent) produces the byte-identical canonical text — and recordHash — as before.
  "producer_kind",
  "key_id",
  "legacy",
  "prevHash",
];

/** Canonical key order for {@link TargetResolvesInSource} (byte-stable nested JSON). */
const TARGET_FIELD_ORDER: ReadonlyArray<keyof TargetResolvesInSource> = ["path", "digest"];

/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder<T extends object>(obj: T, order: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) out[key as string] = obj[key];
  return out;
}

/**
 * Deterministic canonical text of a receipt for hashing. Field order is fixed;
 * `undefined` keys and `recordHash` are dropped; the two nested objects are
 * re-emitted in their fixed key order; `JSON.stringify` with no indentation.
 * `hashContent` then CRLF→LF normalizes (harmless — the canonical text contains
 * no CRLF).
 */
export function canonicalText(receipt: Omit<TerminalTransitionReceipt, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "target_resolves_in_source") {
      ordered[key] = reorder(val as TargetResolvesInSource, TARGET_FIELD_ORDER);
    } else if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for a receipt = SHA-256 of its canonical text (recordHash omitted). */
export function computeRecordHash(receipt: Omit<TerminalTransitionReceipt, "recordHash">): string {
  return hashContent(canonicalText(receipt));
}

// ---------------------------------------------------------------------------
// Storage (mirrors decisions.ts)
// ---------------------------------------------------------------------------

/** `<stateDir>/terminal-receipts.jsonl` — the in-process terminal-receipt ledger. */
export function terminalReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "terminal-receipts.jsonl");
}

/**
 * `<stateDir>/external-receipts.jsonl` — the EXTERNAL keyed producer's store
 * (slice-1b). A SEPARATE file purely for LOCK-ISOLATION: the out-of-process producer
 * appends here without taking the in-process `withStateLock` span, so it never
 * contends with a running `th`. The SECURITY boundary is NOT this path — it is the
 * private key held only by the producer; a forged line written here is rejected by
 * {@link readReceiptValidated} (no verifying signature ⇒ `forged`), exactly as one
 * written into the in-process store would be.
 *
 * BEST-EFFORT CHAIN (caveat): the external append is UNSYNCHRONIZED (no state lock —
 * that is the whole point of the separate store), so concurrent producers may FORK
 * `prevHash`. This is acceptable because per-candidate SIGNATURE verification — NOT
 * chain order — is what {@link readReceiptValidated} treats as authoritative for the
 * gate; `verifyReceiptChain` is deliberately NOT run on the external store. (An
 * advisory producer-side lock to keep the external chain single-threaded is a
 * deferred P4 follow-up; it is a tidiness, not a security, gap.)
 */
export function externalReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "external-receipts.jsonl");
}

const KIND_VALUES = new Set<TerminalTransitionKind>(["drift-resolve", "sim-retire", "decision-approve"]);
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** Validate the shape of a parsed line; malformed lines are skipped (tolerant). */
function isValidReceipt(parsed: unknown): parsed is TerminalTransitionReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KIND_VALUES.has(r.kind as TerminalTransitionKind)) return false;
  if (typeof r.refId !== "string" || r.refId === "") return false;
  if (typeof r.producer_identity !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (r.legacy !== undefined && typeof r.legacy !== "boolean") return false;
  // Slice-1b OPTIONAL signing fields: accepted when present, NEVER required — an old
  // slice-1a receipt (all three absent) stays valid + hash-identical. A present field
  // must be well-shaped (a malformed signing field makes the line tolerant-skipped,
  // never silently treated as a verifying external receipt).
  if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process") return false;
  if (r.key_id !== undefined && typeof r.key_id !== "string") return false;
  if (
    r.signature !== undefined &&
    (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))
  ) {
    return false;
  }
  // Nested ground objects must be present and shaped.
  const tgt = r.target_resolves_in_source;
  if (typeof tgt !== "object" || tgt === null) return false;
  const t = tgt as Record<string, unknown>;
  if (typeof t.path !== "string" || typeof t.digest !== "string") return false;
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every receipt in file order. Missing file → `[]`. Bad lines
 * (non-JSON, partial-tail, schema-invalid) are silently skipped — tolerant, never
 * throws (mirrors `readDecisionEvents`). Chain breaks surface via
 * {@link verifyReceiptChain}, not here.
 */
export function readTerminalReceipts(paths: ProjectPaths): TerminalTransitionReceipt[] {
  return readJsonlValues(terminalReceiptsPath(paths), isValidReceipt);
}

/**
 * Read + parse every receipt in the EXTERNAL store (slice-1b), same tolerant shape
 * as {@link readTerminalReceipts} (same `isValidReceipt`). Missing file → `[]`; bad
 * lines skipped; never throws. The signature on a line is verified at gate time by
 * {@link readReceiptValidated}, NOT here — this reader is shape-only, so a
 * forged-but-well-shaped line is returned and then classified `forged` downstream.
 */
export function readExternalReceipts(paths: ProjectPaths): TerminalTransitionReceipt[] {
  return readJsonlValues(externalReceiptsPath(paths), isValidReceipt);
}

/**
 * The `recordHash` of the EXTERNAL store's last valid receipt — the `prevHash` seed
 * for the external producer's own append-only hash chain (it is its OWN chain,
 * anchored independently of the in-process ledger). Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the standalone producer script (`scripts/
 * th-receipt-producer.mjs`) via the compiled dist.
 */
export function readLastExternalReceiptRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(externalReceiptsPath(paths), isValidReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * The `recordHash` of the ledger's last VALID receipt — the only thing
 * {@link appendTerminalReceipt} needs to seal the next link. Tail-scans the file
 * (parses only down to the last valid line) so N appends stay O(N) total.
 * Missing/empty file, or no valid tail line → `GENESIS_PREV_HASH`.
 */
export function readLastReceiptRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(terminalReceiptsPath(paths), isValidReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

// ---------------------------------------------------------------------------
// verifyChain (mirrors decisions.verifyChain) — tamper-detecting walk
// ---------------------------------------------------------------------------

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk receipts in file order with a running `expectedPrev = GENESIS`. For each
 * receipt: recompute `recordHash` from its canonical text — a mismatch means the
 * record was edited. If `prevHash !== expectedPrev` the line was inserted,
 * deleted, or reordered. Return `{ ok:false, brokenAt:N }` at the FIRST break;
 * else advance `expectedPrev = receipt.recordHash`. Byte-identical posture to
 * `decisions.verifyChain`.
 */
export function verifyReceiptChain(receipts: TerminalTransitionReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeRecordHash(rest);
    if (recomputed !== recordHash) {
      return { ok: false, brokenAt: i, reason: "edited" };
    }
    if (r.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    expectedPrev = r.recordHash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shared digest / snapshot helpers — the SINGLE formula used by producer AND validator
// ---------------------------------------------------------------------------

/**
 * True iff `relPath` resolves to a readable, REGULAR file CONTAINED within
 * `root`. Uses {@link resolveWithinRoot} for the same cross-platform containment
 * posture the rest of TwinHarness takes (rejects absolute-elsewhere, `..`,
 * symlink/junction escape). A directory, a missing path, or a path-escape → false.
 */
export function targetResolvesInSource(root: string, relPath: string): boolean {
  return computeTargetDigest(root, relPath) !== null;
}

/**
 * The SINGLE shared content-binding formula (modeled on
 * `tester.ts:computeReceiptDigest`, NOT importing it). Resolve `relPath` within
 * `root` (path-escape → null), require a readable regular file (else null), and
 * return `hashContent(<file utf8>)` — CRLF-normalized, since these are text
 * targets. Returns `null` whenever the target does not resolve, which is the
 * negative signal both the producer (refuse-at-creation) and the validator
 * (`target_missing`) key on.
 */
export function computeTargetDigest(root: string, relPath: string): string | null {
  if (relPath === "") return null;
  const abs = resolveWithinRoot(root, relPath);
  if (abs === null) return null; // path-escape / absolute-elsewhere / junction escape
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return hashContent(fs.readFileSync(abs, "utf8"));
  } catch {
    return null; // unreadable → does not resolve
  }
}

/**
 * The current repository snapshot coordinate (reuses `git-revision.ts`). Both
 * fields null on a non-git checkout — non-discriminating (F8 honesty). The single
 * helper the producer calls at mint time and the validator calls at gate time.
 */
export function currentSnapshotCoord(root: string): SnapshotCoord {
  return { gitHead: gitHead(root), treeDigest: dirtyTreeDigest(root) };
}

/**
 * Receipt snapshots bind to the source tree, not TwinHarness's own mutable
 * governance ledgers. Excluding the selected state directory and drift log keeps a
 * terminal command from invalidating its receipt merely by recording the flip.
 */
export function currentReceiptSnapshotCoord(paths: ProjectPaths): SnapshotCoord {
  const excludePaths = [paths.stateDir, paths.driftLog]
    .map((p) => path.relative(paths.root, p))
    .filter((p) => p !== "" && !path.isAbsolute(p) && p !== ".." && !p.startsWith(`..${path.sep}`));
  return {
    gitHead: gitHead(paths.root),
    treeDigest: dirtyTreeDigest(paths.root, excludePaths),
  };
}

// ---------------------------------------------------------------------------
// Producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------

/** Input to {@link appendTerminalReceipt}. */
export interface MintReceiptInput {
  kind: TerminalTransitionKind;
  refId: string;
  /**
   * The source path the flip resolves in. REQUIRED for `drift-resolve` &
   * `sim-retire` (the requirement-layer ground). OPTIONAL for `decision-approve`
   * (build-coordinate-only when the decision links no artifact). When supplied it
   * MUST resolve, or {@link appendTerminalReceipt} throws {@link TargetUnresolvedError}.
   */
  targetPath?: string;
  /** Self-asserted producer identity (zero in-process trust weight). */
  producerIdentity: string;
}

/**
 * Thrown by {@link appendTerminalReceipt} when `targetPath` is supplied but does
 * NOT resolve in source (negative-control **c** at creation: a producer refuses
 * to mint a receipt whose ground is already missing).
 */
export class TargetUnresolvedError extends Error {
  /** Stable machine token for the CLI failure envelope. */
  readonly code = "receipt_target_unresolved";
  constructor(
    message: string,
    /** The offending (root-relative) target path. */
    public readonly target: string,
  ) {
    super(message);
    this.name = "TargetUnresolvedError";
  }
}

/**
 * Append one terminal-transition receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there),
 * exactly like `appendDecisionEvent`.
 *
 * If `targetPath` is supplied it MUST resolve in source (negative-control **c**):
 * a non-resolving target throws {@link TargetUnresolvedError} BEFORE any write, so
 * a flip whose ground is already missing cannot be minted. The receipt records the
 * digest of that target and the current snapshot coordinate, then derives
 * `prevHash` from the tail, computes `recordHash`, asserts the write-surface, and
 * atomically appends `JSON.stringify(sealed) + "\n"`. Returns the sealed receipt.
 */
export function appendTerminalReceipt(
  paths: ProjectPaths,
  input: MintReceiptInput,
): TerminalTransitionReceipt {
  let targetPath = "";
  let digest = "";
  if (input.targetPath !== undefined && input.targetPath !== "") {
    const d = computeTargetDigest(paths.root, input.targetPath);
    if (d === null) {
      throw new TargetUnresolvedError(
        `Refusing to mint a ${input.kind} receipt for ${input.refId}: target "${input.targetPath}" does not resolve in source.`,
        input.targetPath,
      );
    }
    targetPath = input.targetPath;
    digest = d;
  }
  return sealAndAppend(paths, {
    kind: input.kind,
    refId: input.refId,
    target_resolves_in_source: { path: targetPath, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: input.producerIdentity,
  });
}

/**
 * Append a one-time `legacy:true` backfill stamp (migration §4). A legacy receipt
 * carries an EMPTY target (it grounds nothing — it is grandfathered), the snapshot
 * coordinate of the moment, and `producer_identity: "legacy-backfill"`. Internal:
 * only {@link ensureReceiptMigration} mints these.
 */
function appendLegacyReceipt(
  paths: ProjectPaths,
  kind: TerminalTransitionKind,
  refId: string,
): TerminalTransitionReceipt {
  return sealAndAppend(paths, {
    kind,
    refId,
    target_resolves_in_source: { path: "", digest: "" },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: "legacy-backfill",
    legacy: true,
  });
}

/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute
 * `recordHash`, assert the governed write-surface, mkdir, atomically append. The
 * single place a receipt line is written, so the real and legacy producers stay
 * byte-consistent on the chain mechanics.
 */
function sealAndAppend(
  paths: ProjectPaths,
  receipt: Omit<TerminalTransitionReceipt, "prevHash" | "recordHash">,
): TerminalTransitionReceipt {
  // AC#1 write-surface chokepoint: terminalReceiptsPath is under stateDir; the
  // guard fires here (propagating, not best-effort) so a non-governed target throws.
  assertGovernedWriteSurface(paths.root, terminalReceiptsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastReceiptRecordHash(paths);
  const withPrev: Omit<TerminalTransitionReceipt, "recordHash"> = { ...receipt, prevHash };
  const recordHash = computeRecordHash(withPrev);
  const sealed: TerminalTransitionReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(terminalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ---------------------------------------------------------------------------
// Validation (execution doc §3) — readReceiptValidated → status
// ---------------------------------------------------------------------------

/**
 * The validated status of the receipt backing a terminal flip (execution doc §3,
 * extended by slice-1b):
 *  - `absent`         — no receipt AND the entity is not grandfathered → BLOCK
 *                       (negative-control **b**: post-upgrade bypass).
 *  - `tampered`       — the receipt hash chain does not verify → BLOCK.
 *  - `target_missing` — recorded `path` no longer resolves in source → BLOCK (c).
 *  - `target_mismatch`— `path` resolves but its digest ≠ recorded → BLOCK.
 *  - `stale`          — `snapshot_coord` diverged (gitHead/treeDigest) → BLOCK (a).
 *  - `legacy`         — a grandfathered backfill stamp → gate ACCEPTS, reported as
 *                       ungrounded-legacy.
 *  - `valid`          — present, non-legacy, in-process/attested receipt whose content
 *                       passes (target resolves + matches, not stale). The gate ACCEPTS
 *                       it; UNCHANGED from slice-1a (every slice-1a test pins this).
 *  - `valid-grounded` — slice-1b: an EXTERNAL keyed receipt whose signature verifies
 *                       under the loaded key AND whose content passes. Independently
 *                       grounded (the in-process surface cannot forge the signature). The
 *                       gate ACCEPTS it; it is the STRONGER form of `valid`.
 *  - `forged`         — slice-1b: a receipt CLAIMS `producer_kind:"external"` but no
 *                       external candidate's signature verifies (key absent, or every
 *                       signature is bad/tampered/replayed) → BLOCK. An unprovable
 *                       independence claim is rejected, never silently downgraded.
 */
export type ReceiptValidationStatus =
  | "absent"
  | "tampered"
  | "target_missing"
  | "target_mismatch"
  | "stale"
  | "legacy"
  | "valid"
  | "valid-grounded"
  | "forged";

/** The validated receipt + its status (and any staleness reasons). */
export interface ValidatedReceipt {
  status: ReceiptValidationStatus;
  /** The latest receipt found for (kind, refId); omitted on `absent`. */
  receipt?: TerminalTransitionReceipt;
  /** On `stale`: which coordinate(s) diverged (`gitHead` / `treeDigest`). */
  staleReasons?: string[];
}

/**
 * Compare a recorded coordinate against the current one under the F8 rule: a
 * coordinate discriminates ONLY when BOTH the recorded and the current value are
 * non-null. A null on either side is non-discriminating (a non-git checkout, or a
 * receipt minted before the coordinate existed) and never contributes staleness.
 * Returns the list of diverged coordinate names (empty = not stale).
 */
function snapshotStaleReasons(recorded: SnapshotCoord, current: SnapshotCoord): string[] {
  const reasons: string[] = [];
  if (recorded.gitHead !== null && current.gitHead !== null && recorded.gitHead !== current.gitHead) {
    reasons.push("gitHead");
  }
  if (
    recorded.treeDigest !== null &&
    current.treeDigest !== null &&
    recorded.treeDigest !== current.treeDigest
  ) {
    reasons.push("treeDigest");
  }
  return reasons;
}

/**
 * Apply the slice-1a CONTENT checks to a present, non-legacy receipt, returning a
 * pass/fail status. On PASS, the caller-supplied `passStatus` is returned —
 * `"valid"` for an in-process/attested receipt (slice-1a, unchanged) or
 * `"valid-grounded"` for a signature-verified external receipt (slice-1b). On FAIL,
 * the specific slice-1a fail token (`target_missing` / `target_mismatch` / `stale`)
 * — IDENTICAL discrimination for both producer kinds, so an external receipt whose
 * target was deleted/edited or whose snapshot drifted blocks exactly like an
 * in-process one.
 *
 * decision-approve is build-coordinate-only (execution doc §6): no target block, no
 * snapshot staleness — a present non-legacy receipt passes.
 */
function classifyReceiptContent(
  paths: ProjectPaths,
  kind: TerminalTransitionKind,
  receipt: TerminalTransitionReceipt,
  passStatus: "valid" | "valid-grounded",
): ValidatedReceipt {
  if (kind === "decision-approve") return { status: passStatus, receipt };

  const recordedPath = receipt.target_resolves_in_source.path;
  const recordedDigest = receipt.target_resolves_in_source.digest;
  const currentDigest = computeTargetDigest(paths.root, recordedPath);
  if (currentDigest === null) return { status: "target_missing", receipt }; // (c)
  if (currentDigest !== recordedDigest) return { status: "target_mismatch", receipt };

  const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, currentReceiptSnapshotCoord(paths));
  if (staleReasons.length > 0) return { status: "stale", receipt, staleReasons }; // (a)

  return { status: passStatus, receipt };
}

/**
 * Validate the receipt backing the terminal flip `(kind, refId)` (execution doc
 * §3 / §6, extended by slice-1b). Reads BOTH stores — the in-process
 * `terminal-receipts.jsonl` AND the external `external-receipts.jsonl` — and gathers
 * every candidate matching `(kind, refId)`.
 *
 * An external CLAIM (`producer_kind:"external"`) is DECISIVE for `(kind, refId)`: a
 * verifying external receipt ⇒ `valid-grounded`; an unverifiable one ⇒ `forged`/BLOCK
 * — REGARDLESS of any in-process candidate for the SAME entity (fail-closed: an
 * unprovable independence claim BLOCKS, it never downgrades to the in-process verdict).
 *
 * SLICE-1B PRECEDENCE (the grounded/forged asymmetry):
 *   1. If ANY candidate CLAIMS `producer_kind:"external"`:
 *      - Load the external key. For each external candidate, re-derive its canonical
 *        text and {@link verifyCanonical} its `signature`. The FIRST that
 *        authentically verifies is run through the slice-1a content checks; if it
 *        passes ⇒ `valid-grounded` (independently grounded — the in-process surface
 *        cannot forge the signature). If it verifies but the CONTENT fails ⇒ the slice-1a
 *        fail token (`target_missing` / `target_mismatch` / `stale`) or `legacy`.
 *      - If NO external candidate verifies (key absent, or every signature is
 *        bad/tampered/replayed) ⇒ `forged` ⇒ BLOCK. An unprovable independence claim
 *        is never silently downgraded to `valid`.
 *   2. Else (no external claim): the EXISTING slice-1a classification on the LATEST
 *      in-process candidate — absent / legacy / target_* / stale / `valid` —
 *      UNCHANGED, so every slice-1a test (and the no-key dev path) stays green.
 *
 * ABSENT classification (the load-bearing negative-control **b** / migration §4):
 * when NO candidate is found anywhere —
 *   - `!receiptMigrationDone(paths)` → `legacy` (genuinely pre-upgrade).
 *   - migrated AND `${kind}:${refId}` in {@link grandfatheredBaseline} → `legacy`.
 *   - migrated AND NOT in the baseline → `absent` → BLOCK.
 */
export function readReceiptValidated(
  paths: ProjectPaths,
  kind: TerminalTransitionKind,
  refId: string,
): ValidatedReceipt {
  const matches = (r: TerminalTransitionReceipt): boolean => r.kind === kind && r.refId === refId;
  const inProcessReceipts = readTerminalReceipts(paths);
  if (!verifyReceiptChain(inProcessReceipts).ok) return { status: "tampered" };
  // LATEST in-process candidate in file order (a re-flip mints a newer receipt).
  let inProcess: TerminalTransitionReceipt | undefined;
  for (const r of inProcessReceipts) {
    if (matches(r)) inProcess = r;
  }
  // ALL external candidates claiming this (kind, refId) — gathered so a verifying one
  // can be preferred over a non-verifying (forged) one regardless of file order.
  const externalCandidates = readExternalReceipts(paths).filter(
    (r) => matches(r) && r.producer_kind === "external",
  );

  // (1) An external CLAIM exists → it must PROVE itself with a verifying signature.
  if (externalCandidates.length > 0) {
    const publicKey = loadExternalPublicKey();
    if (publicKey !== null) {
      const configuredKeyId = externalKeyId(publicKey);
      // The LAST verifying external candidate in file order (a re-mint wins), so a
      // newer grounded receipt supersedes an older one.
      let verified: TerminalTransitionReceipt | undefined;
      for (const cand of externalCandidates) {
        if (typeof cand.signature !== "string") continue; // no trailer ⇒ unverifiable
        if (cand.key_id !== configuredKeyId) continue;
        const { recordHash: _rh, signature: _sig, ...signedView } = cand;
        if (verifyCanonical(canonicalText(signedView), cand.signature, publicKey)) verified = cand;
      }
      if (verified) {
        if (verified.legacy === true) return { status: "legacy", receipt: verified };
        return classifyReceiptContent(paths, kind, verified, "valid-grounded");
      }
    }
    // No external candidate verified (key absent, or all signatures bad) → forged.
    return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
  }

  // (2) No external claim → the UNCHANGED slice-1a classification on the in-process line.
  if (!inProcess) {
    // Negative-control (b) / migration §4 absent-classification.
    if (!receiptMigrationDone(paths)) return { status: "legacy" }; // genuinely pre-upgrade
    if (grandfatheredBaseline(paths).has(baselineKey(kind, refId))) return { status: "legacy" };
    return { status: "absent" }; // migrated + not grandfathered → BLOCK
  }
  if (inProcess.legacy === true) return { status: "legacy", receipt: inProcess };
  return classifyReceiptContent(paths, kind, inProcess, "valid");
}

// ---------------------------------------------------------------------------
// Migration / grandfather (execution doc §4) — closes negative-control (b)
// ---------------------------------------------------------------------------

/** A reference to a currently-terminal ledger entity (kind + its id). */
export interface TerminalEntityRef {
  kind: TerminalTransitionKind;
  refId: string;
}

/** `<stateDir>/.terminal-receipts-migration` — the migration marker file. */
function migrationMarkerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, ".terminal-receipts-migration");
}

/** The grandfathered-baseline membership key for an entity. */
function baselineKey(kind: TerminalTransitionKind, refId: string): string {
  return `${kind}:${refId}`;
}

/** The persisted migration marker shape. */
interface MigrationMarker {
  migratedAt: string;
  baseline: string[];
}

/** Tolerantly read the migration marker, or `undefined` when absent/malformed. */
function readMigrationMarker(paths: ProjectPaths): MigrationMarker | undefined {
  const file = migrationMarkerPath(paths);
  if (!fs.existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = safeParseJson(raw);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const m = parsed as Record<string, unknown>;
  if (typeof m.migratedAt !== "string") return undefined;
  if (!Array.isArray(m.baseline) || !m.baseline.every((x) => typeof x === "string")) return undefined;
  return { migratedAt: m.migratedAt, baseline: m.baseline as string[] };
}

/**
 * True once {@link ensureReceiptMigration} has run for this project (the marker
 * file is present + well-shaped). The gate's absent-classification keys on this to
 * tell "genuinely pre-upgrade" (no marker → grandfather implicitly) from
 * "post-upgrade bypass" (marker present, entity not in baseline → BLOCK).
 */
export function receiptMigrationDone(paths: ProjectPaths): boolean {
  return readMigrationMarker(paths) !== undefined;
}

/**
 * The grandfathered baseline id-set captured at migration time. Members are
 * `${kind}:${refId}`. Empty set when not yet migrated. These entities were already
 * terminal BEFORE the receipt regime began, so an absent receipt for them is
 * grandfathered (`legacy`) rather than a bypass.
 */
export function grandfatheredBaseline(paths: ProjectPaths): Set<string> {
  const marker = readMigrationMarker(paths);
  return new Set(marker ? marker.baseline : []);
}

/**
 * Minimal, tolerant read of `<stateDir>/simulation-ledger.json` for the migration
 * baseline ONLY — reads the RAW file (no `commands/sim.ts` import, which would be
 * an import cycle: commands import receipts.ts, not vice-versa). Returns the ids
 * of every entry whose `status === "retired"`. A missing/corrupt/non-array file
 * yields `[]` (the migration is best-effort; a damaged ledger simply contributes
 * no grandfathered sim ids).
 */
function readRetiredSimIds(paths: ProjectPaths): string[] {
  const file = path.join(paths.stateDir, "simulation-ledger.json");
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const parsed = safeParseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id === "string" && r.id !== "" && r.status === "retired") ids.push(r.id);
  }
  return ids;
}

/**
 * The currently-terminal entities across the three ledgers (execution doc §4),
 * read from the RAW source files (no command imports):
 *   - `drift-resolve` — `paths.driftLog` entries that carry a `## DRIFT-NNN —
 *     resolved` note in the file. refId = the `DRIFT-NNN`.
 *   - `sim-retire`    — `<stateDir>/simulation-ledger.json` entries with
 *     `status === "retired"`. refId = the `SIM-NNN`.
 *   - `decision-approve` — `readDecisionEvents` → `reduceDecisions` decisions with
 *     `status === "approved"`. refId = the `DECISION-NNN`.
 */
export function collectTerminalEntities(paths: ProjectPaths): TerminalEntityRef[] {
  const out: TerminalEntityRef[] = [];

  // drift-resolve: a resolved drift has a `## DRIFT-NNN — resolved` note line
  // (em-dash U+2014, exactly as runDriftResolve writes it). parseDriftEntries
  // gives us the set of known DRIFT ids; the resolution note is what marks them
  // terminal. We scan the raw file lines for the resolution notes directly.
  let driftText = "";
  try {
    driftText = fs.readFileSync(paths.driftLog, "utf8");
  } catch {
    driftText = ""; // no drift log → no resolved drifts
  }
  if (driftText !== "") {
    const blockingDriftIds = new Set(
      parseDriftEntries(driftText)
        .filter((e) => e.layer === "requirement")
        .map((e) => e.id),
    );
    const seen = new Set<string>();
    for (const line of driftText.split(/\r?\n/)) {
      const m = /^##\s+(DRIFT-\d+)\s+—\s+resolved\s*$/.exec(line.trim());
      if (!m) continue;
      const id = m[1]!;
      // Only count a resolution note that corresponds to a real drift entry, and
      // only once per id.
      if (blockingDriftIds.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push({ kind: "drift-resolve", refId: id });
      }
    }
  }

  // sim-retire: retired entries in the simulation ledger.
  for (const id of readRetiredSimIds(paths)) {
    out.push({ kind: "sim-retire", refId: id });
  }

  // decision-approve: approved decisions.
  for (const d of reduceDecisions(readDecisionEvents(paths))) {
    if (d.status === "approved") out.push({ kind: "decision-approve", refId: d.id });
  }

  return out;
}

/**
 * Idempotent, marker-guarded migration (execution doc §4). MUST be called holding
 * the state lock (it appends receipts + writes the marker). On the FIRST call it
 * stamps a `legacy:true` receipt for every currently-terminal ledger entity that
 * lacks ANY receipt, then writes the marker recording the full grandfathered
 * baseline id-set. A re-run is a no-op (the marker is present).
 *
 * Double-stamp guard: even within the first run, an entity that ALREADY has a
 * receipt (found by scanning the receipts file) is skipped — so a partial prior
 * run, or a real receipt minted before migration, is never double-stamped.
 */
export function ensureReceiptMigration(paths: ProjectPaths): void {
  if (receiptMigrationDone(paths)) return; // marker present → already migrated

  const terminalEntities = collectTerminalEntities(paths);

  // The set of (kind:refId) that already have ANY receipt — so we never double-stamp.
  const existing = new Set<string>();
  for (const r of readTerminalReceipts(paths)) existing.add(baselineKey(r.kind, r.refId));

  for (const ent of terminalEntities) {
    const key = baselineKey(ent.kind, ent.refId);
    if (existing.has(key)) continue; // already has a receipt — do not double-stamp
    appendLegacyReceipt(paths, ent.kind, ent.refId);
    existing.add(key);
  }

  // Write the marker LAST, recording the full baseline (every currently-terminal
  // entity id), so a crash mid-stamp leaves no marker and the next run re-attempts
  // (the double-stamp guard makes the retry safe).
  const baseline = terminalEntities.map((e) => baselineKey(e.kind, e.refId));
  const marker: MigrationMarker = { migratedAt: new Date().toISOString(), baseline };
  assertGovernedWriteSurface(paths.root, migrationMarkerPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(migrationMarkerPath(paths), JSON.stringify(marker), "utf8");
}
