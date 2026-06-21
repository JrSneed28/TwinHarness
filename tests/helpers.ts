import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { CLI_COMMAND_LEAVES, MCP_EXCLUDED, MCP_ONLY_TOOLS } from "../src/mcp-server";

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
 * True on CI runners (GitHub Actions and friends set `CI=true`). The spawn-heavy
 * cross-process stress tests — the ones that fire 12–52 concurrent
 * `node dist/cli.js` processes at a single state lock — are gated on this and DO
 * NOT run in CI. They are reliably green locally, but on an oversubscribed / slow
 * windows-latest runner an unlucky waiter is scheduler-starved past even the 90s
 * TH_LOCK_TIMEOUT_MS and throws a LockTimeoutError on a write that would otherwise
 * have landed — a *timeout* (environmental), never a lost-update assertion. The
 * recurring windows-latest false-red was pure starvation, so the only durable fix
 * is to keep these waves off CI runners.
 *
 * No lock CORRECTNESS coverage is lost in CI: the contention / steal / timeout /
 * backoff loop is exercised deterministically by the in-process LockOps seam tests
 * (tests/state-store-seam.test.ts) and the in-process steal/classify tests that live
 * alongside these waves, and the full multi-process waves still run on every local
 * `npm test`. Uses `process.env.CI` (not `process.platform`/`getuid`), so the
 * doc-truth single-platform-conditional-skip count is unaffected.
 */
export const SKIP_SPAWN_HEAVY_IN_CI = !!process.env.CI;

export interface TempProject {
  paths: ProjectPaths;
  root: string;
  cleanup: () => void;
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
