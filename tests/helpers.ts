import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { CLI_COMMAND_LEAVES, MCP_EXCLUDED, MCP_ONLY_TOOLS } from "../src/mcp-server";
import { stageContract } from "../src/core/stages";
import { appendApprovalReceipt, type HumanApprovalReceipt } from "../src/core/approvals";
import { requiredHumanGateStages } from "../src/core/gate-preconditions";
import type { TwinHarnessState } from "../src/core/state-schema";

/**
 * The SELF-DERIVING MCP tool count, computed from the CLI↔MCP partition rather
 * than pinned to a literal. A real cross-check against `TOOL_DEFS.length`:
 * `TOOL_DEFS` is one source of truth; the {CLI_COMMAND_LEAVES, MCP_EXCLUDED,
 * MCP_ONLY_TOOLS} partition is the independent other. Every CLI leaf that is not
 * excluded mirrors one tool, plus the deliberate MCP-only additions:
 *
 *   expected = (|CLI_COMMAND_LEAVES| − |MCP_EXCLUDED|) + |MCP_ONLY_TOOLS|
 *
 * Adding a tool (a new CLI leaf, or a new MCP-only entry) updates this with zero
 * literal churn — the count today is 62, derived, not hardcoded.
 */
export function expectedToolDefsCount(): number {
  return CLI_COMMAND_LEAVES.length - Object.keys(MCP_EXCLUDED).length + Object.keys(MCP_ONLY_TOOLS).length;
}

/**
 * Subprocess env for the cross-process concurrency stress tests. Silences the run
 * log (TH_NO_LOG) and grants the state-lock generous patience (TH_LOCK_TIMEOUT_MS):
 * these tests spawn 12-40 lock-contending `node dist/cli.js` processes at once, and
 * on an oversubscribed CI runner (2 cores + parallel vitest workers) an unlucky
 * waiter can be scheduler-starved past the default 25s lock deadline and fail a write
 * that would otherwise land — a false red. The longer deadline only adds patience; the
 * no-lost-updates correctness assertions are unchanged. See state-store.ts:lockTimeoutMs.
 */
export function concurrencyEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TH_NO_LOG: "1", TH_LOCK_TIMEOUT_MS: "90000" };
}

/**
 * True on CI runners (GitHub Actions and friends set `CI=true`). The spawn-HEAVY
 * cross-process stress tests — the ones that fire 12–52 concurrent
 * `node dist/cli.js` processes at a single state lock — are gated on this and DO
 * NOT run in CI. They are reliably green locally, but on an oversubscribed / slow
 * windows-latest runner an unlucky waiter is scheduler-starved past even the 90s
 * TH_LOCK_TIMEOUT_MS and throws a LockTimeoutError on a write that would otherwise
 * have landed — a *timeout* (environmental), never a lost-update assertion. The
 * recurring windows-latest false-red was pure starvation, so the only durable fix
 * is to keep the HEAVY waves off CI runners.
 *
 * Cross-process lock coverage is NOT abandoned in CI (audit P2): a LIGHT wave of only
 * {@link LIGHT_SPAWN_CONCURRENCY} concurrent processes still runs EVERYWHERE — low
 * enough that even an oversubscribed runner cannot starve a waiter past the 90s
 * deadline, yet it exercises the COMPILED CLI + real OS file lock + process integration
 * that the in-process LockOps seam tests (tests/state-store-seam.test.ts) cannot. So CI
 * keeps a real compiled-CLI/process-integration regression net; only the starvation-
 * prone heavy waves are local-only. Uses `process.env.CI` (not `process.platform`/
 * `getuid`), so the doc-truth single-platform-conditional-skip count is unaffected.
 */
export const SKIP_SPAWN_HEAVY_IN_CI = !!process.env.CI;

/**
 * The concurrency for the LIGHT cross-process lock wave that runs on EVERY runner
 * (including CI). Kept small (3) so a 2-core/oversubscribed CI runner cannot scheduler-
 * starve a waiter past TH_LOCK_TIMEOUT_MS — three short-lived `node dist/cli.js`
 * contenders with 90s of patience always make progress — while still proving the
 * compiled CLI serializes a real concurrent read-modify-write through the OS file lock.
 */
export const LIGHT_SPAWN_CONCURRENCY = 3;

export interface TempProject {
  paths: ProjectPaths;
  root: string;
  cleanup: () => void;
}

/**
 * Mint a VALID in-process human-approval receipt for a `humanGate` `stage` (BSC-7 /
 * Axis-B slice-3a). Used by the warn→enforce fixtures (slice-3a C-3) to make a run pass
 * the human-approval rung in-process, exactly as `th approve` would.
 *
 * It guarantees `readApprovalValidated(paths, stage) === "valid"`: the stage's governing
 * artifact (`produces`) must resolve in source for the digest to bind, so this writes a
 * minimal artifact first when one is not already present (a caller that already authored
 * the real artifact keeps it — the approval then binds the REAL digest). The approval is
 * sealed onto the in-process chain via the production `appendApprovalReceipt` path under
 * the current snapshot coordinate + that artifact's digest, so a later validation re-reads
 * the SAME artifact and matches. NOT wired into any fixture here (slice-3a C-3 does that);
 * defined + smoke-tested only.
 *
 * Single-process temp projects do not need an explicit `withStateLock` span (the test is
 * the only writer) — mirrors how `tests/approvals.test.ts` calls `appendApprovalReceipt`.
 */
export function mintApprovalForFixture(
  paths: ProjectPaths,
  stage: string,
  opts: { producerIdentity?: string } = {},
): HumanApprovalReceipt {
  const contract = stageContract(stage);
  if (!contract || !contract.humanGate) {
    throw new Error(`mintApprovalForFixture: "${stage}" is not a humanGate stage.`);
  }
  // Ensure the governing artifact resolves so the mandatory digest binds (R3). A caller
  // that already wrote the real artifact keeps it; otherwise lay down a minimal placeholder.
  const abs = path.resolve(paths.root, contract.produces.replace(/\/$/, ""));
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# ${stage}\n\n- REQ-001 covered.\n`, "utf8");
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return appendApprovalReceipt(paths, {
    stage,
    producerIdentity: opts.producerIdentity ?? "fixture:mintApprovalForFixture",
  });
}

/**
 * Mint a VALID in-process approval for EVERY stage in the CLOSED required-set of `state`
 * (BSC-7 / Axis-B slice-3a C-2 completion enforcement) — `requiredHumanGateStages(state)`
 * = humanGate ∩ engagedStagesFor ∩ ordinal-≤-current. This is the green-baseline lever the
 * completion rung needs: a green-at-final-verification fixture now BLOCKS with
 * `human_approval_unverified` until its required-set is approved, so every such fixture
 * calls this once after the state + governing artifacts are in place.
 *
 * Each stage is minted via {@link mintApprovalForFixture}, which keeps any real artifact the
 * fixture already authored (binding its true digest) and lays down a minimal placeholder for
 * the rest — so the later validation re-reads the SAME artifact and the approval classifies
 * `valid`. Returns the minted approvals in required-set order.
 */
export function mintRequiredApprovals(
  paths: ProjectPaths,
  state: Pick<TwinHarnessState, "tier" | "has_ui" | "current_stage">,
): HumanApprovalReceipt[] {
  return requiredHumanGateStages(state).map((stage) => mintApprovalForFixture(paths, stage));
}

/** Create an isolated temp project dir so tests never touch the repo root. */
export function makeTempProject(): TempProject {
  const literalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "th-test-"));
  const paths = resolveProjectPaths(literalRoot);
  return {
    paths,
    // Expose the CANONICAL root (paths.root), NOT the raw mkdtemp path. R-13 makes
    // resolveProjectPaths realpath the selected root (macOS /var→/private/var, a
    // Windows 8.3 short name like RUNNER~1→runneradmin, a symlinked $TMPDIR), so on
    // CI the raw mkdtemp path differs from paths.root. Tests routinely thread `root`
    // as a project root while deriving targets from `paths.*`; if the two disagree,
    // a containment check (resolveWithinRoot / the write-gate) lexically rejects an
    // otherwise in-root path. Returning the canonical root keeps the fixture
    // internally consistent — exactly how production derives everything from one
    // resolveProjectPaths() call. Cleanup uses the literal path (same dir on disk).
    root: paths.root,
    cleanup: () => fs.rmSync(literalRoot, { recursive: true, force: true }),
  };
}
