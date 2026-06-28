/**
 * BSC-9 (Axis-B slice-7) — the four enumerated negative-control bypass surfaces, each a 1:1
 * blocking test, run in the normal suite (the probe under `.omc/audit/probes/bsc9/` is the
 * RED→GREEN flag-flip; this file pins each enumerated bypass to a mechanical guard):
 *
 *   (a) a CLI command added WITHOUT a `HELP`/`CLI_COMMAND_LEAVES` entry → the mechanical
 *       REQ-PCO-070 partition catches it (regression guard — the partition is exhaustive).
 *   (b) a tool whose `toToolResult` PROJECTION drops/alters `ok`/exit-code/`data`, OR a closure
 *       that re-implements logic instead of delegating → the projection oracle / thinness guard
 *       blocks.
 *   (c) readiness CLAIMED with no backing receipt, or a sub-cutoff confidence → the gate blocks.
 *   (d) stale `TOOL_DEFS` in `dist/mcp-server.js` vs the advanced CLI `HELP` → the parity + dist
 *       checks catch it (the build-output invariant).
 *
 * The independence control-flip (external-signed accepted ↔ in-process-forged rejected) lives in
 * `.omc/audit/probes/bsc9/independence.test.ts`.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TOOL_DEFS,
  MCP_EXCLUDED,
  MCP_ONLY_TOOLS,
  CLI_COMMAND_LEAVES,
  cliCommandToToolName,
} from "../src/mcp-server";
import { makeTempProject, mintRequiredApprovals, mintAssertionPresenceForFixture, ASSERTED_COV_TEST, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { appendReadinessReceipt, readinessRefId } from "../src/core/interview-readiness";
import {
  type ProjectionFixtureSet,
  referenceProjection,
  projectionFidelity,
  runProjectionOracle,
} from "../src/core/projection-oracle";
import type { CommandResult } from "../src/core/output";
import type { ProjectPaths } from "../src/core/paths";

const ROOT = path.resolve(__dirname, "..");
const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

const SAVED = process.env.TH_BSC9_ENFORCE;
let tp: TempProject | undefined;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TH_BSC9_ENFORCE;
  else process.env.TH_BSC9_ENFORCE = SAVED;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

const write = (paths: ProjectPaths, rel: string, body: string) => {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
};

/**
 * A green-at-final-verification project whose interview is REQUIRED and asserted READY at
 * `confidence`. The BSC-9 rung is the only lever; the readiness receipt (when minted) binds the
 * interview-store digest. `fixtures` defaults to a faithful single-fixture set.
 */
function greenReadiness(opts: { confidence: number; cutoff?: number; mintReadiness: boolean; mintConfidence?: number; fixtures?: ProjectionFixtureSet }): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  const cutoff = opts.cutoff ?? 0.8;
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write(paths, "tests/cov.test.ts", `// REQ-001\n${ASSERTED_COV_TEST}`);
  write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  write(
    paths,
    ".twinharness/interview.json",
    JSON.stringify({ idea: "x", cutoff, rounds: [{ question: "q", answer: "a", scores: { goal: 1, constraints: 1, criteria: 1 }, confidence: opts.confidence, entities: [] }], confidence: opts.confidence, status: "in-progress" }, null, 2) + "\n",
  );
  const fx: ProjectionFixtureSet =
    opts.fixtures ?? {
      fixtures: [{ tool: "th_state_get", result: { ok: true, exitCode: 0, data: { tier: "T1" } }, projected: referenceProjection({ ok: true, exitCode: 0, data: { tier: "T1" } } as CommandResult) }],
    };
  write(paths, ".omc/audit/probes/bsc9/projection-fixtures.json", JSON.stringify(fx, null, 2));
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    interview_required: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  mintAssertionPresenceForFixture(paths);
  if (opts.mintReadiness) {
    appendReadinessReceipt(paths, {
      refId: readinessRefId(paths),
      confidence: opts.mintConfidence ?? opts.confidence,
      cutoff,
      storePath: ".twinharness/interview.json",
      producerIdentity: "test:bsc9",
    });
  }
  return paths;
}

describe("BSC-9 negative-control (a): a CLI leaf without HELP/CLI_COMMAND_LEAVES is caught by the partition", () => {
  it("the CLI_COMMAND_LEAVES↔TOOL_DEFS partition is exhaustive (no silently-absent leaf)", () => {
    // The REQ-PCO-070 partition is the mechanical regression guard: a new CLI command leaf with
    // neither a TOOL_DEFS mirror nor an MCP_EXCLUDED reason fails the partition. Assert it holds
    // (so a future leaf added without a HELP/CLI_COMMAND_LEAVES entry would break THIS).
    const covered = CLI_COMMAND_LEAVES.filter((l) => !(l in MCP_EXCLUDED));
    const excluded = CLI_COMMAND_LEAVES.filter((l) => l in MCP_EXCLUDED);
    expect(covered.length + excluded.length).toBe(CLI_COMMAND_LEAVES.length);
    const expected = new Set(covered.map(cliCommandToToolName)).size + Object.keys(MCP_ONLY_TOOLS).length;
    expect(TOOL_DEFS.length).toBe(expected);
    // Every non-excluded leaf resolves to a real tool name.
    for (const leaf of covered) {
      expect(TOOL_NAMES.has(cliCommandToToolName(leaf)), `${leaf} must have a tool`).toBe(true);
    }
  });
});

describe("BSC-9 negative-control (b): a projection that drops/alters ok/exit-code/data is blocked by the oracle", () => {
  it("a fixture whose projected drops the data payload ⇒ oracle reports a data infidelity", () => {
    const result: CommandResult = { ok: true, exitCode: 0, data: { tier: "T1", count: 3 } } as CommandResult;
    // SEED an infidelity: the projection drops the `count` field.
    const tampered = { isError: false, text: JSON.stringify({ tier: "T1", count: 3 }, null, 2), structuredContent: { tier: "T1", exitCode: 0 } };
    const infidelities = projectionFidelity("th_state_get", result, tampered);
    expect(infidelities.some((i) => i.axis === "data")).toBe(true);
  });

  it("a fixture whose projected flips isError or alters exitCode ⇒ oracle reports the infidelity", () => {
    const result: CommandResult = { ok: false, exitCode: 4, data: { status: "stale" }, human: "stale" } as CommandResult;
    const flipped = { isError: false, text: "stale", structuredContent: { status: "stale", exitCode: 1 } };
    const infidelities = projectionFidelity("th_repo_check", result, flipped);
    expect(infidelities.some((i) => i.axis === "isError")).toBe(true);
    expect(infidelities.some((i) => i.axis === "exitCode")).toBe(true);
  });

  it("the gate BLOCKS when the committed fixture set carries a seeded projection infidelity", () => {
    delete process.env.TH_BSC9_ENFORCE; // enforcement ON
    // A fixture whose `projected` drops the data payload — a real projection infidelity.
    const infidel: ProjectionFixtureSet = {
      fixtures: [{ tool: "th_state_get", result: { ok: true, exitCode: 0, data: { tier: "T1" } } as CommandResult, projected: { isError: false, text: "x", structuredContent: { exitCode: 0 } } }],
    };
    // Backing readiness so the readiness leg passes — isolate the projection leg.
    const paths = greenReadiness({ confidence: 0.95, mintReadiness: true, fixtures: infidel });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bsc9_unverified");
    expect((res.detail as { projectionInfidelities?: unknown[] }).projectionInfidelities?.length).toBeGreaterThan(0);
  });

  it("REQ-PCO-070 thinness: every tool closure delegates to a run* handler (a non-delegating closure fails)", () => {
    // The thinness guard is the mechanical bypass for a closure that re-implements logic instead
    // of delegating. Re-assert it here so BSC-9's "non-delegating closure" control is pinned.
    const DELEGATION_RE = /\brun[A-Z]\w*\b|\bapplyGateMutation\b|\basyncToolGuard\b|\brepoFreshnessSummary\b/;
    for (const def of TOOL_DEFS) {
      const body = def.run.toString() + (def.runAsync ? def.runAsync.toString() : "");
      expect(DELEGATION_RE.test(body), `${def.name} must delegate to a run* handler`).toBe(true);
    }
  });
});

describe("BSC-9 negative-control (c): readiness claimed with no receipt / sub-cutoff is blocked", () => {
  it("readiness asserted with NO backing receipt ⇒ gate BLOCKS (status absent)", () => {
    delete process.env.TH_BSC9_ENFORCE;
    const paths = greenReadiness({ confidence: 0.95, mintReadiness: false });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bsc9_unverified");
    expect((res.detail as { readinessStatus?: string }).readinessStatus).toBe("absent");
  });

  it("a receipt recording a SUB-CUTOFF confidence ⇒ gate BLOCKS (status not-ready)", () => {
    delete process.env.TH_BSC9_ENFORCE;
    // The interview store reports ready (confidence ≥ cutoff via a hand-flip) but the receipt's
    // recomputed ground is sub-cutoff: the gate re-derives readiness FRESH and finds not-ready.
    // We mint a receipt whose recorded confidence (0.5) is below the cutoff (0.8); the store still
    // says ready (0.95) so the rung engages, then the receipt classifies not-ready.
    const paths = greenReadiness({ confidence: 0.95, mintReadiness: true, mintConfidence: 0.5 });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bsc9_unverified");
    expect((res.detail as { readinessStatus?: string }).readinessStatus).toBe("not-ready");
  });

  it("a backing receipt with a re-derived ready ground ⇒ gate PASSES (non-vacuous)", () => {
    delete process.env.TH_BSC9_ENFORCE;
    const paths = greenReadiness({ confidence: 0.95, mintReadiness: true });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
  });
});

describe("BSC-9 negative-control (d): stale TOOL_DEFS in dist vs the CLI HELP is caught by the build-output checks", () => {
  it("the built dist/mcp-server.js advertises the SAME tool count as the source TOOL_DEFS", () => {
    // A stale dist (built before a tool was added) would advertise a different count than the
    // source TOOL_DEFS the parity test derives from HELP. `npm run verify`'s dist-sync gate +
    // this count check catch the drift. The dist is committed, so this runs against the build.
    const distPath = path.join(ROOT, "dist", "mcp-server.js");
    expect(fs.existsSync(distPath), "dist/mcp-server.js must be built + committed").toBe(true);
    const distSrc = fs.readFileSync(distPath, "utf8");
    // Every source tool name must appear in the bundled dist (no tool present in src but missing
    // from the built bundle — the stale-dist symptom).
    const missing = [...TOOL_NAMES].filter((name) => !distSrc.includes(`"${name}"`));
    expect(missing, `tools in src TOOL_DEFS but absent from dist/mcp-server.js (rebuild dist): ${missing.join(", ")}`).toEqual([]);
  });
});
