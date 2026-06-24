/**
 * BSC-8 / Axis-B slice-7 — tier-correspondence + stage-invalidation gate enforcement.
 *
 * The four enumerated negative-control bypass surfaces (plan §5 Lane BSC-8 step 4), each a
 * 1:1 BLOCKING test against the REAL gate (`checkProductionReality`) + the REAL sensor
 * (`core/tier-classify.classifyBrief` + the tier-correspondence receipt store):
 *
 *   (a) signals require T1+ but the run declares `tier:T0` via `--emergency` → blocked
 *       (`under_declared`).
 *   (b) a T0→T2 upgrade that did NOT rewind `current_stage` (a newly-engaged stage skipped)
 *       → blocked (`stage_unrewound`) UNTIL the skipped stage's artifact is registered.
 *   (c) a stale brief digest (the brief changed after attestation) → blocked (`stale_brief`).
 *   (d) the raw `state set tier` bypass stays blocked (regression guard) — `tier` is GATE_OWNED.
 *
 * Plus a GREEN baseline (correctly-declared tier, fresh brief, no skipped stage → PASS) and the
 * fail-open guard (flag OFF ⇒ a failing verdict is a non-blocking notice, not a block).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeTempProject,
  mintRequiredApprovals,
  mintApprovalForFixture,
  mintAssertionPresenceForFixture,
  ASSERTED_COV_TEST,
  type TempProject,
} from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { runStateSet, applyGateMutation } from "../src/commands/state";
import { checkProductionReality } from "../src/core/gate-preconditions";
import {
  appendTierCorrespondenceReceipt,
  computeBriefDigest,
  TASK_BRIEF_RELPATH,
} from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";
import type { TaskBrief } from "../src/core/brief";

const SAVED = process.env.TH_BSC8_ENFORCE;
let tp: TempProject | undefined;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TH_BSC8_ENFORCE;
  else process.env.TH_BSC8_ENFORCE = SAVED;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** A T0-eligible brief (single-file, no public-interface/dependency, obvious answer, no veto). */
function t0EligibleBrief(): TaskBrief {
  return {
    single_file_or_local: true,
    changes_public_interface: false,
    adds_dependency: false,
    obvious_testable_answer: true,
    blast_radius_flags: [],
  };
}

/** A brief whose blast-radius veto forces ≥T1 (the min-tier is T1, not T0). */
function t1ForcedBrief(): TaskBrief {
  return {
    single_file_or_local: true,
    changes_public_interface: false,
    adds_dependency: false,
    obvious_testable_answer: true,
    blast_radius_flags: ["money"],
  };
}

function writeBrief(paths: ProjectPaths, brief: TaskBrief): void {
  const abs = path.resolve(paths.root, TASK_BRIEF_RELPATH);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(brief, null, 2) + "\n", "utf8");
}

/**
 * A GREEN-at-final-verification project (slices settled, coverage clean, report registered,
 * Tester record attached, the closed human-approval required-set satisfied, an honest
 * assertion-presence receipt minted, no repo-map ⇒ realization grandfathered) at a given tier.
 * Every prior production-reality rung passes, so the BSC-8 tier-correspondence rung is the only
 * remaining lever. Writes the brief FIRST so the correspondence ground is available.
 */
function greenFixture(opts: {
  tier: "T0" | "T1" | "T2";
  brief: TaskBrief;
  hasUi?: boolean;
}): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  const write = (rel: string, body: string) => {
    const abs = path.resolve(paths.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  };
  writeBrief(paths, opts.brief);
  write("docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write("docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write("docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: opts.tier,
    // has_ui:false drops the UX/UI humanGate stages (lighter approval set ⇒ faster gate).
    has_ui: opts.hasUi ?? false,
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  // The assertion-presence ground is recomputed from tests/** at mint, so write the test LAST.
  write("tests/cov.test.ts", `// REQ-001\n${ASSERTED_COV_TEST}`);
  mintAssertionPresenceForFixture(paths);
  return paths;
}

// ---------------------------------------------------------------------------
// GREEN baseline — a correctly-declared tier with a fresh brief PASSES.
// ---------------------------------------------------------------------------

describe("BSC-8 green baseline: a correctly-declared tier passes the correspondence rung", () => {
  it("T1-declared run over a T1-forced brief, fresh digest, no skipped stage ⇒ gate PASSES", () => {
    delete process.env.TH_BSC8_ENFORCE; // defaults ON
    const paths = greenFixture({ tier: "T1", brief: t1ForcedBrief() });
    // Mint an honest, fresh correspondence receipt (claimed T1 ≥ min T1, current brief digest).
    appendTierCorrespondenceReceipt(paths, {
      refId: "no-git",
      claimedTier: "T1",
      computedMinTier: "T1",
      briefDigest: computeBriefDigest(paths.root),
      producerIdentity: "test:green",
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Negative-control (a) — under-declared tier (T0 over a ≥T1-forcing brief).
// ---------------------------------------------------------------------------

describe("BSC-8 (a): under-declared tier — T0 claimed over a brief whose veto forces T1", () => {
  it("GREEN leg (enforce ON): the gate BLOCKS with tier_correspondence_unverified / under_declared", () => {
    delete process.env.TH_BSC8_ENFORCE; // defaults ON
    // T0 engages no stages, so the closed human-approval required-set is empty and every prior
    // rung passes — the BSC-8 rung is the only lever. The brief's `security` flag forces min T1.
    const paths = greenFixture({ tier: "T0", brief: t1ForcedBrief() });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tier_correspondence_unverified");
    expect((res.detail as { reason?: string }).reason).toBe("under_declared");
    expect((res.detail as { computedMinTier?: string }).computedMinTier).toBe("T1");
  });

  it("RED leg (TH_BSC8_ENFORCE=0): the run COMPLETES — a non-blocking notice (fail-open guard)", () => {
    process.env.TH_BSC8_ENFORCE = "0";
    const paths = greenFixture({ tier: "T0", brief: t1ForcedBrief() });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.notice?.token).toBe("tier_correspondence_unverified");
    expect((res.notice?.detail as { reason?: string } | undefined)?.reason).toBe("under_declared");
  });
});

// ---------------------------------------------------------------------------
// Negative-control (b) — un-rewound tier upgrade (a newly-engaged stage skipped).
// ---------------------------------------------------------------------------

describe("BSC-8 (b): un-rewound upgrade — a newly-engaged stage was skipped, not backfilled", () => {
  it("blocks with stage_unrewound until the skipped stage's artifact is registered", { timeout: 90000 }, () => {
    delete process.env.TH_BSC8_ENFORCE; // defaults ON
    // A T2 run at final-verification engages `domain-model` (docs/03-domain-model.md), a stage
    // T0/T1 do NOT engage. Simulate an un-rewound T0→T2 upgrade by jumping current_stage to
    // final-verification without producing that newly-engaged artifact. A T2 brief is min T1, so
    // the under-declared rung is satisfied (T2 ≥ T1) and the stage-invalidation rung is the lever.
    const paths = greenFixture({ tier: "T2", brief: t1ForcedBrief() });
    // Register every T1-shared engaged ARTIFACT stage that sits before `domain-model` so the
    // ONLY remaining skip is the T2-NEWLY-ENGAGED `domain-model` stage (the precise
    // negative-control b shape). `requirements` (docs/01) already exists from the fixture;
    // `scope` (docs/02) is created here. Both are humanGate, so we re-mint the full required
    // approval set AFTER these writes so the BSC-7 rung (which runs before BSC-8) passes.
    runArtifactRegister(paths, "docs/01-requirements.md", 1);
    const scope = path.resolve(paths.root, "docs/02-scope.md");
    fs.writeFileSync(scope, "# Scope\n\nREQ-001.\n", "utf8");
    runArtifactRegister(paths, "docs/02-scope.md", 1);
    mintRequiredApprovals(paths, state(paths)); // re-bind approvals to the current digests
    // The upgrade WITNESS: the receipt was minted while current_stage was already at
    // final-verification (the rewind never moved the pointer back to the newly-engaged
    // `domain-model` stage) — the un-rewound signature.
    appendTierCorrespondenceReceipt(paths, {
      refId: "no-git",
      claimedTier: "T2",
      computedMinTier: "T1",
      briefDigest: computeBriefDigest(paths.root),
      currentStageAtMint: "final-verification",
      producerIdentity: "test:b",
    });
    const blocked = checkProductionReality(paths, state(paths));
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("tier_correspondence_unverified");
    expect((blocked.detail as { reason?: string }).reason).toBe("stage_unrewound");
    expect((blocked.detail as { stage?: string }).stage).toBe("domain-model");

    // Now register the skipped stage's governing artifact — the `domain-model` skip clears
    // (the gate no longer names domain-model; the un-rewound signature for THAT stage is gone).
    const dm = path.resolve(paths.root, "docs/03-domain-model.md");
    fs.writeFileSync(dm, "# Domain Model\n\nREQ-001 modelled.\n", "utf8");
    runArtifactRegister(paths, "docs/03-domain-model.md", 1);
    const cleared = checkProductionReality(paths, state(paths));
    // The originally-skipped `domain-model` stage is satisfied: the block (if any) no longer
    // names it. (A later engaged artifact stage may now be the first skip — that is a distinct
    // offender, not the domain-model un-rewound signature this control targets.)
    const clearedStage = (cleared.detail as { stage?: string } | undefined)?.stage;
    expect(clearedStage).not.toBe("domain-model");
  });

  it("blocks with upgrade_without_remint when the live tier exceeds the latest receipt's tier (the --emergency bypass)", { timeout: 90000 }, () => {
    delete process.env.TH_BSC8_ENFORCE; // defaults ON
    // The bypass signature: the live tier is T2 but the LATEST correspondence receipt records
    // T1 (a raw `state set tier T2 --emergency` jump skipped both the rewind AND the re-mint, so
    // no fresh T2 receipt exists). A newly-engaged T2 stage (`domain-model`) is skipped.
    const paths = greenFixture({ tier: "T2", brief: t1ForcedBrief() });
    runArtifactRegister(paths, "docs/01-requirements.md", 1);
    const scope = path.resolve(paths.root, "docs/02-scope.md");
    fs.writeFileSync(scope, "# Scope\n\nREQ-001.\n", "utf8");
    runArtifactRegister(paths, "docs/02-scope.md", 1);
    mintRequiredApprovals(paths, state(paths));
    // The witness records the PRIOR tier T1 (minted before the un-rewound upgrade), at a stage
    // BEFORE the skip — so the only blocking signal is the tier delta, not the mint stage.
    appendTierCorrespondenceReceipt(paths, {
      refId: "no-git",
      claimedTier: "T1",
      computedMinTier: "T1",
      briefDigest: computeBriefDigest(paths.root),
      currentStageAtMint: "requirements",
      producerIdentity: "test:b-emergency",
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tier_correspondence_unverified");
    expect((res.detail as { reason?: string }).reason).toBe("stage_unrewound");
    expect((res.detail as { witness?: string }).witness).toBe("upgrade_without_remint");
  });
});

// ---------------------------------------------------------------------------
// Negative-control (c) — stale brief digest (brief changed after attestation).
// ---------------------------------------------------------------------------

describe("BSC-8 (c): stale brief — the brief was edited after the correspondence receipt was minted", () => {
  it("blocks with stale_brief when the recorded digest no longer matches the recomputed digest", () => {
    delete process.env.TH_BSC8_ENFORCE; // defaults ON
    const paths = greenFixture({ tier: "T1", brief: t1ForcedBrief() });
    // Mint over the CURRENT brief digest (claimed T1 ≥ min T1, no stage skip).
    appendTierCorrespondenceReceipt(paths, {
      refId: "no-git",
      claimedTier: "T1",
      computedMinTier: "T1",
      briefDigest: computeBriefDigest(paths.root),
      producerIdentity: "test:c",
    });
    // Now EDIT the brief post-attestation — the digest diverges.
    const stillForcesT1 = { ...t1ForcedBrief(), description: "edited after attestation" };
    writeBrief(paths, stillForcesT1 as TaskBrief);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tier_correspondence_unverified");
    expect((res.detail as { reason?: string }).reason).toBe("stale_brief");
  });
});

// ---------------------------------------------------------------------------
// Negative-control (d) — raw `state set tier` bypass stays blocked (regression guard).
// ---------------------------------------------------------------------------

describe("BSC-8 (d): raw `state set tier` is GATE_OWNED — refused without --emergency (regression guard)", () => {
  it("`th state set tier T0` without --emergency is refused at the source", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1", current_stage: "requirements" });
    const res = runStateSet(paths, "tier", "T0");
    expect(res.exitCode).not.toBe(0);
    expect((res.data as { error?: string }).error).toBe("gate_owned_requires_emergency");
    // The tier did NOT change.
    expect(state(paths).tier).toBe("T1");
  });

  it("the typed `applyGateMutation` path (th tier record) DOES mint a correspondence receipt", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeBrief(paths, t0EligibleBrief());
    writeState(paths, { ...initialState(), tier: null, current_stage: "requirements" });
    applyGateMutation(paths, { tier: "T1" }, "th tier record");
    // The typed path minted a tier-correspondence receipt under the lock.
    const receiptsFile = path.join(paths.stateDir, "tier-correspondence-receipts.jsonl");
    expect(fs.existsSync(receiptsFile)).toBe(true);
    const lines = fs.readFileSync(receiptsFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const r = JSON.parse(lines[0]!);
    expect(r.kind).toBe("tier-correspondence");
    expect(r.claimed_tier).toBe("T1");
  });
});
