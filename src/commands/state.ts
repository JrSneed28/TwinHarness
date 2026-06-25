import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths, StateLocationCandidates } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock, STALE_MS } from "../core/state-store";
import { validateState, STATE_FIELD_ORDER, TIERS } from "../core/state-schema";
import { structuredLog } from "../core/log";
import { appendLedger, appendHighWater, GATE_LEDGER_KEYS } from "../core/ledger";
import { NOT_INIT, formatIssues } from "../core/guards";
import { fieldPolicy, GATE_OWNED } from "../core/state-fields";
import { canonicalizeStage, STAGE_PIPELINE, engagedStages } from "../core/stages";
import {
  appendTierCorrespondenceReceipt,
  computeBriefDigest,
  TASK_BRIEF_RELPATH,
} from "../core/receipts";
import { loadBriefFromFile } from "../core/brief";
import { classifyBrief } from "../core/tier-classify";
import { gitHead } from "../core/git-revision";

/** Key segments that must never be written through a dotted path (proto-pollution guard, S3). */
const UNSAFE_KEY_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // bare string
  }
}

function getByPath(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (Array.isArray(cur)) {
      // Support numeric array indices, e.g. `approved_artifacts.0.hash`.
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (isRecord(cur)) {
      cur = cur[p];
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isRecord(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** `th state get [dotted.path]` */
export function runStateGet(paths: ProjectPaths, dottedPath?: string): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
  if (!dottedPath) {
    return success({ data: { state: r.state }, human: JSON.stringify(r.state, null, 2) });
  }
  const value = getByPath(r.state as unknown as Record<string, unknown>, dottedPath);
  if (value === undefined) {
    return failure({ human: `Path not found: ${dottedPath}`, data: { error: "path_not_found", path: dottedPath } });
  }
  return success({
    data: { path: dottedPath, value },
    human: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  });
}

/** `th state set <dotted.key> <value>` — refuses to persist an invalid result. */
export function runStateSet(
  paths: ProjectPaths,
  key: string,
  rawValue: string,
  opts: { emergency?: boolean } = {},
): CommandResult {
  return withStateLock(paths, () => runStateSetLocked(paths, key, rawValue, opts));
}

function runStateSetLocked(
  paths: ProjectPaths,
  key: string,
  rawValue: string,
  opts: { emergency?: boolean } = {},
): CommandResult {
  const emergency = opts.emergency === true;
  // Reject paths whose first segment is not a known state field (catches typos
  // like `implementaton_allowed` that would silently write nothing).
  const segments = key.split(".");
  const firstSegment = segments[0] as string;
  if (!(STATE_FIELD_ORDER as string[]).includes(firstSegment)) {
    return failure({
      human: `Unknown state field: "${firstSegment}". Valid top-level keys: ${STATE_FIELD_ORDER.join(", ")}`,
      data: { error: "unknown_field", field: firstSegment, validFields: STATE_FIELD_ORDER },
    });
  }

  // Proto-pollution guard (S3): refuse any dotted segment that could walk into
  // an object's prototype, even under an otherwise-valid first key (e.g.
  // `revise_loop_counts.__proto__.x`). setByPath runs before validation, so this
  // must be rejected up front.
  if (segments.some((s) => UNSAFE_KEY_SEGMENTS.has(s))) {
    return failure({
      human: `Refusing to write: unsafe key segment in "${key}".`,
      data: { error: "unsafe_key", key },
    });
  }

  // Managed-field guard (H-2): refuse writes to fields whose owning command keeps
  // an invariant a raw set would corrupt (the drift/debate counters). Gate-owned
  // fields (implementation_allowed/tier/current_stage/write_gate) are NOT refused by
  // THIS block — they are gated separately just below, behind --emergency (#11), with
  // the typed gate commands as their normal path; the MCP raw setter refuses them
  // outright (F-7) and current_stage is enum-normalized below.
  const policy = fieldPolicy(firstSegment);
  if (policy?.refusedByStateSet) {
    return failure({
      human: `Refusing to set managed field "${firstSegment}". ${policy.owner}`,
      data: { error: "managed_field", field: firstSegment },
    });
  }

  // Gate-owned demotion (#11): a raw `state set` of a gate-owned field
  // (tier / current_stage / implementation_allowed / write_gate / blast_radius_flags)
  // bypasses the typed gate ladder. Refuse it unless the operator passes
  // `--emergency`; the typed commands (`th tier record`, `th stage advance`,
  // `th implementation unlock`) are the gate-checked path. When --emergency IS
  // given, the write proceeds but is flagged LOUDLY in the result and (via the
  // existing GATE_LEDGER_KEYS tail below) audit-ledgered.
  const gateOwned = GATE_OWNED.has(firstSegment);
  if (gateOwned && !emergency) {
    return failure({
      human:
        `Refusing raw 'state set ${firstSegment}': gate-owned field. Use the typed gate command ` +
        `(\`th tier record <T>\`, \`th stage advance\`, or \`th implementation unlock [--lock]\`), ` +
        `which enforces the gate ladder. To force a raw write anyway, re-run with --emergency.`,
      data: { error: "gate_owned_requires_emergency", field: firstSegment },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: `Existing state.json is invalid; fix it before setting values:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });

  let value = parseValue(rawValue);

  // current_stage enum-normalization (C-1 write-path defense): canonicalize the
  // value and reject anything that is not a known pipeline stage, so near-miss /
  // bogus stage strings (done, complete, Final-Verification, 10-final-verification)
  // can never be stored via the CLI — closing the gate-bypass vector at the source
  // while the schema itself stays permissive (existing tests write non-pipeline
  // stages like `stage-05` directly via writeState; plan §F-5: do NOT tighten the
  // schema). Scoped to the exact `current_stage` key only.
  if (key === "current_stage") {
    const canonical = canonicalizeStage(String(value));
    // `canonical` is already canonical, so membership-test directly rather than
    // calling isKnownStage (which would canonicalize a second time).
    if (!STAGE_PIPELINE.some((s) => s.stage === canonical)) {
      return failure({
        human:
          `Refusing to set current_stage to "${String(value)}": not a known pipeline stage. ` +
          `Valid stages: ${STAGE_PIPELINE.map((s) => s.stage).join(", ")}.`,
        data: { error: "unknown_stage", value: String(value), validStages: STAGE_PIPELINE.map((s) => s.stage) },
      });
    }
    value = canonical; // persist the canonical id (e.g. "10-final-verification" → "final-verification")
  }
  const next = JSON.parse(JSON.stringify(r.state)) as Record<string, unknown>;
  setByPath(next, key, value);

  const validation = validateState(next);
  if (!validation.ok) {
    return failure({
      human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
      data: { error: "would_be_invalid", issues: validation.issues },
    });
  }
  writeState(paths, validation.state!);
  structuredLog({ cmd: "state set", key });
  // Audit ledger (F5): record gate-relevant mutations so a human can review when
  // implementation_allowed, the tier, the blast-radius flags, the write_gate, or
  // the blocking-drift count changed. Observability only — never blocks.
  if (GATE_LEDGER_KEYS.has(firstSegment)) {
    appendLedger(paths, { event: "gate-state-change", key, value });
    // Seal an in-chain high-water anchor after the gate flip (#8): a sealed
    // {event:"high-water", count} entry whose count is the sealed-entry count before
    // it. Strengthens edit/reorder/mid-delete evidence for the gate-flip run and
    // keeps the count out of an unsealed sidecar (ADR-001 precedent). It does NOT
    // detect tail truncation (documented residual — see appendHighWater). Best-effort.
    appendHighWater(paths);
  }
  const warning =
    emergency && gateOwned
      ? `⚠️  EMERGENCY raw gate write — set gate-owned field "${firstSegment}" directly, bypassing the typed gate ladder (no precondition check). This override is audit-ledgered.\n`
      : "";
  // P6-7 (#18) — write-gate honesty signal: at the strict opt-in, state plainly
  // that the gate is a GUARDRAIL for a compliant agent, not a security sandbox.
  // strict narrows common accidental Bash redirections but does NOT close the Bash
  // bypass (here-docs/subshells/variable indirection/program-mediated writes).
  const strictCaveat =
    firstSegment === "write_gate" && value === "strict"
      ? `\nNote: write_gate=strict is a GUARDRAIL for a compliant agent, not a security sandbox. ` +
        `It narrows accidental Bash redirections but does NOT close the Bash bypass ` +
        `(here-docs, subshells, variable indirection, \`python -c\`/\`node -e\`). ` +
        `Do not rely on it as containment for untrusted repos.`
      : "";
  return success({
    data: { key, value, ...(emergency && gateOwned ? { emergency: true } : {}), ...(strictCaveat ? { writeGateCaveat: true } : {}) },
    human: `${warning}Set ${key} = ${JSON.stringify(value)}${strictCaveat}`,
  });
}

/**
 * Shared locked + ledgered gate-mutation writer (plan Phase 2 Step 6, AC-B16).
 *
 * The single write path for the typed MCP gate-transition tools (`th_tier_record`,
 * `th_stage_advance`, `th_implementation_unlock`, `th_write_gate_set`,
 * `th_blast_radius_record`). It mirrors `runStateSetLocked`'s persist tail
 * (`withStateLock` → clone → mutate → `validateState` → `writeState` +
 * `appendLedger` + `appendHighWater`) but is GENERIC over the set of gate fields
 * to change, so one call can flip several gate-owned fields atomically under a
 * single lock.
 *
 * SECURITY (AC-B16):
 *  - `source` is supplied by the CALLING TOOL as a hard-coded literal (the tool
 *    name) and is **never** read from tool `args` — an agent cannot spoof
 *    `source="th state set"`. Per `src/core/ledger.ts:5-10` this is observability,
 *    not provenance: it records which entry point fired, not who authorized it.
 *  - One FLAT scalar ledger entry per changed field (`{ event, key, value, source }`),
 *    shaped exactly like the existing `gate-state-change` entries above.
 *    `ledgerCanonicalText` does NOT key-normalize nested objects
 *    (`src/core/ledger.ts:103-105`), so a nested patch blob would break the hash
 *    chain; `blast_radius_flags` is a flat `string[]` and is an acceptable single
 *    value.
 *
 * Preconditions are enforced by the CALLER (the gate-precondition helpers) BEFORE
 * this runs; `applyGateMutation` itself enforces no gate ladder, but it still calls
 * `validateState` and refuses `would_be_invalid`, so an out-of-schema write can
 * never persist through this path.
 */
export function applyGateMutation(
  paths: ProjectPaths,
  fields: Record<string, unknown>,
  source: string,
): CommandResult {
  return withStateLock(paths, () => {
    const r = readState(paths);
    if (!r.exists) return NOT_INIT;
    if (!r.state) {
      return failure({
        human: `Existing state.json is invalid; fix it before mutating gates:\n${formatIssues(r.issues)}`,
        data: { error: "invalid_state", issues: r.issues },
      });
    }

    // #1 — Tier-upgrade stage backfill. When THIS mutation upgrades the tier, a
    // stage the NEW tier engages may sit BEFORE the run's current stage in the
    // pipeline yet was never engaged by the OLD tier — it would be silently
    // skipped. Rewind current_stage to the EARLIEST such newly-engaged,
    // already-passed stage so it is backfilled. Computed from the PRE-mutation
    // state and folded into the SAME atomic write (so it is validated + ledgered
    // alongside the tier flip). Only applied when the caller did not itself pass
    // an explicit current_stage.
    const effective: Record<string, unknown> = { ...fields };
    if (
      Object.prototype.hasOwnProperty.call(fields, "tier") &&
      !Object.prototype.hasOwnProperty.call(fields, "current_stage") &&
      // Defense-in-depth: never rewind the stage once implementation is unlocked.
      // The guarded callers (runTierRecord / th_tier_record) already refuse a tier
      // change post-unlock via validateTierTransition's tier_locked_after_unlock, so
      // a tier mutation should never reach here with implementation_allowed — but if a
      // direct applyGateMutation caller did, a silent stage rewind would be disruptive.
      r.state.implementation_allowed !== true
    ) {
      const backfill = tierUpgradeBackfillStage(r.state.tier, fields.tier, r.state.current_stage);
      if (backfill !== null) effective.current_stage = backfill;
    }

    const next = JSON.parse(JSON.stringify(r.state)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(effective)) {
      next[key] = value;
    }

    const validation = validateState(next);
    if (!validation.ok) {
      return failure({
        human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
        data: { error: "would_be_invalid", issues: validation.issues },
      });
    }
    writeState(paths, validation.state!);
    structuredLog({ cmd: "gate mutation", source, keys: Object.keys(effective) });
    // Audit ledger (F5 / AC-B16): ONE flat scalar entry per changed gate field,
    // tagged with the hard-coded `source` so a human can see which entry point
    // fired. Flat key/value keeps `ledgerCanonicalText` deterministic (no nested
    // blob). Every field passed here is a deliberate gate mutation, so each is
    // audited (no GATE_LEDGER_KEYS filter — the filter on the CLI path screens
    // arbitrary sets; here the caller passes only gate fields). Best-effort:
    // `appendLedger` never throws.
    for (const [key, value] of Object.entries(effective)) {
      appendLedger(paths, { event: "gate-state-change", key, value, source });
    }
    // BSC-8 / Axis-B slice-7 — mint the tier-correspondence receipt when THIS mutation
    // touched `tier`. The receipt is the F8 correspondence artifact the completion gate
    // re-validates (claimed tier vs the brief's computed-min tier vs the brief digest at
    // mint). Minted under the SAME `withStateLock` span as the write, AFTER the write
    // succeeds, over the POST-mutation tier (`validation.state!.tier`). Best-effort: a
    // missing/invalid brief yields a permissive `T0` min + null digest (non-discriminating)
    // and a mint never throws on the happy path, so it never wedges a legitimate tier flip.
    if (Object.prototype.hasOwnProperty.call(effective, "tier")) {
      mintTierCorrespondenceReceipt(paths, validation.state!.tier, validation.state!.current_stage);
    }
    // One in-chain high-water anchor after the batch of gate flips (mirrors
    // `runStateSetLocked`'s post-flip seal).
    appendHighWater(paths);
    return success({
      data: { source, fields: effective },
      human: `Applied gate mutation (${source}): ${Object.keys(effective).join(", ")}`,
    });
  });
}

/**
 * #1 — Compute the tier-upgrade stage backfill.
 *
 * When a tier mutation UPGRADES the tier (old tier is null — a from-unclassified
 * classification — or the new tier is strictly higher by `TIERS` ordinal), some
 * stages the new tier engages may sit at/before the run's current stage in the
 * pipeline yet were NEVER engaged by the old tier. Those stages would be silently
 * skipped. Returns the EARLIEST such "newly-engaged, already-passed" stage id so
 * the caller can rewind `current_stage` to it; returns null when no backfill is
 * needed (not an upgrade, unknown/non-string target tier, pre-pipeline current
 * stage, or nothing was skipped).
 */
function tierUpgradeBackfillStage(
  oldTier: string | null,
  newTierRaw: unknown,
  currentStage: string,
): string | null {
  if (typeof newTierRaw !== "string") return null;
  const tiers = TIERS as readonly string[];
  const newIdx = tiers.indexOf(newTierRaw);
  if (newIdx < 0) return null; // unknown tier — validateState will reject the write
  const oldIdx = oldTier === null ? -1 : tiers.indexOf(oldTier);
  const isUpgrade = oldTier === null || newIdx > oldIdx;
  if (!isUpgrade) return null;

  // Where is the run now? A pre-pipeline stage (init/bypass → -1) means nothing
  // has been passed yet, so nothing can have been skipped.
  const currentOrdinal = STAGE_PIPELINE.findIndex((s) => s.stage === canonicalizeStage(currentStage));
  if (currentOrdinal < 0) return null;

  const oldEngaged = new Set(engagedStages(oldTier).map((s) => s.stage));
  const newEngaged = new Set(engagedStages(newTierRaw).map((s) => s.stage));
  // STAGE_PIPELINE is in canonical pipeline order, so the first match at/before
  // the current stage is the earliest newly-engaged stage.
  for (let i = 0; i <= currentOrdinal; i++) {
    const stage = STAGE_PIPELINE[i]!.stage;
    if (newEngaged.has(stage) && !oldEngaged.has(stage)) return stage;
  }
  return null;
}

/**
 * BSC-8 / Axis-B slice-7 — mint the tier-correspondence receipt for a tier mutation.
 * Called inside the `withStateLock` span of {@link applyGateMutation} (after the write)
 * when `tier` was among the changed fields, so it is serialized with the state write.
 *
 * Derives the computed-min tier from the brief (`classifyBrief` over `docs/00-task-brief.md`)
 * and the brief digest with the SAME shared helper the gate uses, so the recompute is
 * identical at mint + gate. A missing/invalid brief is non-discriminating: `T0` min + null
 * digest. The `refId` is the current snapshot's `gitHead` (or `"no-git"`), mirroring the
 * other snapshot-keyed receipts. Best-effort — never throws on the happy path, so it never
 * wedges a legitimate tier flip.
 */
function mintTierCorrespondenceReceipt(
  paths: ProjectPaths,
  claimedTier: string | null,
  currentStage: string,
): void {
  if (claimedTier === null) return; // an unset tier has no correspondence to record
  const briefFile = path.resolve(paths.root, TASK_BRIEF_RELPATH);
  const loaded = loadBriefFromFile(briefFile);
  const minTier = loaded.ok && loaded.brief && classifyBrief(loaded.brief).tier0_eligible ? "T0" : "T1";
  const computedMinTier = loaded.ok && loaded.brief ? minTier : "T0"; // no brief ⇒ permissive
  appendTierCorrespondenceReceipt(paths, {
    refId: gitHead(paths.root) ?? "no-git",
    claimedTier,
    computedMinTier,
    briefDigest: computeBriefDigest(paths.root),
    // The POST-rewind current_stage (the rewind already folded into the write) — the gate's
    // upgrade witness for the stage-invalidation check (BSC-8b).
    currentStageAtMint: canonicalizeStage(currentStage),
    producerIdentity: "th tier record (in-process)",
  });
}

/** `th state status` — human-readable snapshot of tier/stage/gates. */
export function runStateStatus(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
  const s = r.state;
  const human = [
    `Tier:                ${s.tier ?? "(unclassified)"}`,
    `Current stage:       ${s.current_stage}`,
    `Implementation:      ${s.implementation_allowed ? "allowed" : "not allowed"}`,
    `Blast-radius flags:  ${s.blast_radius_flags.length ? s.blast_radius_flags.join(", ") : "(none)"}`,
    `Open blocking drift: ${s.drift_open_blocking}`,
    `Approved artifacts:  ${s.approved_artifacts.length}`,
    `Slices:              ${s.slices.length ? s.slices.map((sl) => `${sl.id}=${sl.status}`).join(", ") : "(none)"}`,
    `Revise-loop counts:  ${Object.keys(s.revise_loop_counts).length ? Object.entries(s.revise_loop_counts).map(([k, v]) => `${k}:${v}`).join(", ") : "(none)"}`,
    `Open questions:      ${s.open_questions.length}`,
  ].join("\n");
  return success({ data: { status: s }, human });
}

/** `th state verify` — exit 0 if valid, non-zero if not. Wired into the stop-gate. */
export function runStateVerify(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return failure({ human: "No state.json found.", data: { valid: false, error: "not_initialized" } });
  if (!r.state) return failure({ human: `state.json INVALID:\n${formatIssues(r.issues)}`, data: { valid: false, issues: r.issues } });
  // A valid file may still carry non-fatal warnings (ARCH-007) — e.g. an unknown
  // top-level key. Surface them WITHOUT failing: the file is still valid (exit 0),
  // the operator just sees the advisory so a typo/forward-compat field is visible.
  const warnings = r.warnings ?? [];
  if (warnings.length > 0) {
    return success({
      data: { valid: true, warnings },
      human: `state.json is valid (with ${warnings.length} warning(s)):\n${formatIssues(warnings)}`,
    });
  }
  return success({ data: { valid: true }, human: "state.json is valid." });
}

/**
 * `th state unlock [--force]` (R-21) — reclaim a stale `.state.lock` directory.
 *
 * The recovery path for a lock left behind by a crashed `th` process — in particular an
 * OWNER-LESS lock, which is never stealable (R-08) and which the acquire-loop timeout
 * only throws on (never reclaims). R-21's mandatory owner-stamp makes that state
 * transient going forward, but a repo bricked by a pre-R-21 crash still needs a manual
 * reclaim, and this is it.
 *
 * Removal predicate (R-26): a lock is removable without `--force` iff it is STALE by AGE
 * ALONE (`ageMs > STALE_MS`) — the owner stamp is NOT part of the test. This default
 * REFUSES to remove a lock younger than STALE_MS even when it is owner-less, because
 * R-21 acquires the lock in two steps (mkdir, then writeOwner), so a genuinely LIVE lock
 * is transiently owner-less mid-acquire — and the owner read returns null on ANY read
 * error (EACCES/EBUSY), not just ENOENT. The genuine pre-R-21 brick (an OLD owner-less
 * lock) still exceeds STALE_MS and is reclaimed without force. `--force` removes
 * unconditionally (last resort — only when no `th` process is running). The refusal /
 * removal messages print the observed owner + age so the operator can decide.
 *
 * `th doctor` detects the lock and points here. The age is computed identically to
 * doctor's check (`Date.now() - statSync(lockDir).mtimeMs`) — though note doctor only
 * WARNS on any present lock, whereas this applies the STALE_MS threshold to decide
 * removal. This is the ONLY mutating `th state` verb that operates without the state lock
 * (it is the lock's recovery tool) and tolerates a corrupt state.json.
 */
export function runStateUnlock(paths: ProjectPaths, opts: { force?: boolean } = {}): CommandResult {
  const lockDir = path.join(paths.stateDir, ".state.lock");
  if (!fs.existsSync(lockDir)) {
    structuredLog({ cmd: "state unlock", result: "no_lock" });
    return success({ data: { removed: false, reason: "no_lock" }, human: "No state lock present — nothing to unlock." });
  }

  let ageMs = 0;
  try {
    ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    /* stat failed (vanished/denied) — leave age unknown (0); --force can still remove */
  }
  let owner: string | null = null;
  try {
    owner = fs.readFileSync(path.join(lockDir, "owner"), "utf8");
  } catch {
    owner = null; // owner-less (a swallowed-stamp crash) or unreadable
  }
  const ageSec = Math.round(ageMs / 1000);
  const staleSec = Math.round(STALE_MS / 1000);
  const ownerLabel = owner === null ? "owner-less" : `owner ${owner}`;
  // R-26: staleness is decided by AGE ALONE, regardless of the owner stamp. The prior
  // `owner === null || ageMs > STALE_MS` treated ANY owner-less lock as stale at any age,
  // but R-21 made the owner-stamp MANDATORY and acquired in TWO steps (mkdir, then
  // writeOwner), opening a transient owner-less window on a genuinely LIVE lock — and the
  // owner read catch above sets owner=null on ANY read error (EACCES/EBUSY), not just
  // ENOENT. So a fresh, live lock could be removed without `--force`, contradicting this
  // function's own docstring. Now a YOUNG owner-less lock is correctly REFUSED without
  // `--force`; an OLD owner-less lock (the genuine pre-R-21 brick) still exceeds STALE_MS
  // and is removable without force. `--force` still removes unconditionally (last resort).
  const stale = ageMs > STALE_MS;
  const force = opts.force === true;

  if (!force && !stale) {
    structuredLog({ cmd: "state unlock", result: "refused_live", ageMs, ownerLess: owner === null });
    // R-26: a YOUNG lock is refused regardless of the owner stamp — an owner-less lock
    // under STALE_MS is most likely a LIVE holder caught in the transient acquire→stamp
    // window (or whose owner file was momentarily unreadable), NOT a pre-R-21 brick. The
    // genuine brick (an old owner-less lock) exceeds STALE_MS and removes without --force.
    const ownerLessNote =
      owner === null
        ? ` This lock is owner-less but still YOUNG — most likely a live holder mid-acquire (the owner stamp lands a moment after the lock dir), not a crashed one.`
        : ``;
    return failure({
      human:
        `Refusing to remove a lock that looks LIVE: ${lockDir} (${ownerLabel}, ${ageSec}s old, under the ${staleSec}s stale threshold).` +
        ownerLessNote +
        ` A \`th\` process may be holding it. If you are CERTAIN no \`th\` process is running, re-run with --force.`,
      data: { error: "lock_live", lockDir, ageMs, ownerLess: owner === null },
    });
  }

  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (e) {
    return failure({
      human: `Could not remove ${lockDir}: ${(e as Error).message}`,
      data: { error: "unlock_failed", lockDir },
    });
  }
  structuredLog({ cmd: "state unlock", result: "removed", forced: force, ageMs, ownerLess: owner === null });
  return success({
    data: { removed: true, lockDir, forced: force, ageMs, ownerLess: owner === null },
    human:
      `Removed state lock ${lockDir} (${ownerLabel}, ${ageSec}s old${force ? ", forced" : ", stale"}). ` +
      `State mutations can proceed again.`,
  });
}

/** Which of the two state locations to KEEP when adopting (R-34 recovery). */
export type AdoptTarget = "twinharness" | "legacy";

/**
 * `th state adopt --twinharness | --legacy` (R-34, finding F5) — the MUTATING
 * recovery for the {@link StateLocationConflictError} hard conflict.
 *
 * When `resolveProjectPaths` finds BOTH `.twinharness/state.json` and the legacy
 * `.agentic-sdlc/state.json` (valid, the ambiguous case) — or BOTH present-but-invalid
 * (the no-safe-location case) — it refuses to guess and throws. This command
 * consolidates onto ONE location by RETIRING the other location's `state.json`
 * (renamed to a timestamped `state.json.retired-<ts>` backup, never hard-deleted, so
 * the data is recoverable) so the next resolve unambiguously selects the survivor.
 *
 * It operates on the conflict-TOLERANT {@link StateLocationCandidates} (computed via
 * `resolveStateCandidates`, which never throws) rather than a resolved `ProjectPaths`,
 * BECAUSE the normal resolver throws on exactly the conflict this command repairs —
 * so it must be dispatched BEFORE the throwing resolve. This is the ONLY mutating
 * `th state` verb (besides `state unlock`) that does not take a resolved `ProjectPaths`.
 */
export function runStateAdopt(candidates: StateLocationCandidates, target: AdoptTarget): CommandResult {
  const keepFile = target === "twinharness" ? candidates.newStateFile : candidates.legacyStateFile;
  const retireFile = target === "twinharness" ? candidates.legacyStateFile : candidates.newStateFile;
  const keepLabel = target === "twinharness" ? ".twinharness" : ".agentic-sdlc (legacy)";
  const retireLabel = target === "twinharness" ? ".agentic-sdlc (legacy)" : ".twinharness";

  // The location we are KEEPING must actually have a state file to keep — refuse to
  // retire the other side if that would leave NO state file at all (a footgun that
  // would silently turn a recoverable conflict into an empty project).
  if (!fs.existsSync(keepFile)) {
    return failure({
      human:
        `Refusing to adopt ${keepLabel}: no state.json is present there (${keepFile}). ` +
        `Adopt the location that HAS the state you want to keep, or repair it first.`,
      data: { error: "adopt_keep_absent", target, keepFile },
    });
  }

  // Nothing to retire on the other side → the conflict is already resolved; idempotent.
  if (!fs.existsSync(retireFile)) {
    structuredLog({ cmd: "state adopt", target, result: "noop" });
    return success({
      data: { adopted: target, keepFile, retired: false },
      human: `Already consolidated on ${keepLabel}; no ${retireLabel} state.json to retire.`,
    });
  }

  // Retire (rename to a timestamped backup) rather than delete — the conflicting run's
  // state is preserved on disk so the operator can recover it if they chose wrong.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${retireFile}.retired-${ts}`;
  try {
    fs.renameSync(retireFile, backup);
  } catch (e) {
    return failure({
      human: `Could not retire ${retireFile}: ${(e as Error).message}`,
      data: { error: "adopt_retire_failed", target, retireFile },
    });
  }
  structuredLog({ cmd: "state adopt", target, result: "retired", backup });
  return success({
    data: { adopted: target, keepFile, retired: true, retiredFrom: retireFile, backup },
    human:
      `Adopted ${keepLabel}. Retired the ${retireLabel} state.json to:\n  ${backup}\n` +
      `The location conflict is resolved; \`th\` will now use ${keepLabel}.`,
  });
}
