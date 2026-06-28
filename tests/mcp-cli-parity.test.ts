/**
 * Phase 7 / P7-1 — CLI↔MCP command-parity + MCP thinness guard (REQ-PCO-070).
 *
 * The CLI is the source of truth; the MCP server is a THIN adapter exposing a
 * SUBSET of the CLI's commands. This suite realises the never-implemented
 * EXPECTED_TOOL_ALLOWLIST as a real, mechanical partition:
 *
 *   1. Every LIVE CLI command leaf is EITHER mirrored by a `TOOL_DEFS` entry OR
 *      recorded in {@link MCP_EXCLUDED} with a reason — never silently absent.
 *   2. Every excluded leaf is genuinely NOT a tool (the divergence is real).
 *   3. Every MCP-only tool (no CLI leaf) is justified in {@link MCP_ONLY_TOOLS}.
 *   4. The CLI leaf list itself is pinned to the dispatcher's own `HELP` enumeration
 *      so it cannot drift from the CLI's source of truth.
 *   5. THINNESS: every tool closure DELEGATES to a `run*` handler / the shared
 *      locked gate-mutation setter — it must not re-implement command logic or do
 *      raw state I/O. "No orchestration logic" becomes a mechanical guard.
 *
 * A new CLI command with neither a tool nor an exclusion fails (1); the
 * permanently-forbidden `th_decision_approve` (RULE-011) stays absent.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TOOL_DEFS,
  TOOL_ANNOTATIONS,
  MCP_EXCLUDED,
  MCP_ONLY_TOOLS,
  CLI_COMMAND_LEAVES,
  cliCommandToToolName,
  toToolResult,
} from "../src/mcp-server";
import { GATE_OWNED } from "../src/core/state-fields";
import type { CommandResult } from "../src/core/output";
import {
  type ProjectedResult,
  referenceProjection,
  projectionFidelity,
  runProjectionOracle,
  loadProjectionFixtures,
} from "../src/core/projection-oracle";

const ROOT = path.resolve(__dirname, "..");
const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

/** Project the real CallToolResult down to the SDK-free ProjectedResult subset the oracle reads. */
function realProjection(result: CommandResult): ProjectedResult {
  const r = toToolResult(result);
  const first = r.content[0];
  return {
    isError: r.isError === true,
    text: first && first.type === "text" ? first.text : "",
    structuredContent: (r.structuredContent ?? {}) as Record<string, unknown>,
  };
}

const BSC9_FIXTURES_PATH = path.join(ROOT, ".omc", "audit", "probes", "bsc9", "projection-fixtures.json");

describe("REQ-PCO-070: CLI↔MCP command parity (every CLI leaf covered or excluded)", () => {
  it("REQ-PCO-070: every non-excluded CLI command has a matching TOOL_DEFS entry", () => {
    const uncovered: string[] = [];
    for (const leaf of CLI_COMMAND_LEAVES) {
      if (leaf in MCP_EXCLUDED) continue;
      const tool = cliCommandToToolName(leaf);
      if (!TOOL_NAMES.has(tool)) uncovered.push(`${leaf} -> ${tool}`);
    }
    expect(
      uncovered,
      `CLI commands with no MCP tool and no exclusion (add a tool or record an MCP_EXCLUDED reason): ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("REQ-PCO-070: every EXCLUDED CLI leaf is genuinely NOT exposed as a tool", () => {
    const leaked: string[] = [];
    for (const leaf of Object.keys(MCP_EXCLUDED)) {
      const tool = cliCommandToToolName(leaf);
      if (TOOL_NAMES.has(tool)) leaked.push(`${leaf} -> ${tool}`);
    }
    expect(leaked, `excluded CLI leaves that ARE exposed as tools (divergence is not real): ${leaked.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: every excluded leaf is a real CLI command leaf (no stale exclusions)", () => {
    const stale = Object.keys(MCP_EXCLUDED).filter((leaf) => !CLI_COMMAND_LEAVES.includes(leaf));
    expect(stale, `MCP_EXCLUDED names leaves that are not live CLI commands: ${stale.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: the permanently-forbidden tool (RULE-011) is excluded AND absent", () => {
    expect(MCP_EXCLUDED["decision approve"]).toBeTruthy();
    expect(TOOL_NAMES.has("th_decision_approve")).toBe(false);
  });

  it("REQ-PCO-070: every TOOL_DEFS tool is EITHER a CLI-leaf mirror OR a justified MCP-only tool", () => {
    const leafTools = new Set(
      CLI_COMMAND_LEAVES.filter((l) => !(l in MCP_EXCLUDED)).map(cliCommandToToolName),
    );
    const unjustified: string[] = [];
    for (const name of TOOL_NAMES) {
      if (leafTools.has(name)) continue;
      if (name in MCP_ONLY_TOOLS) continue;
      unjustified.push(name);
    }
    expect(
      unjustified,
      `tools with no CLI leaf and no MCP_ONLY_TOOLS justification: ${unjustified.join(", ")}`,
    ).toEqual([]);
  });

  it("REQ-PCO-070: every MCP_ONLY_TOOLS entry is a real, registered tool", () => {
    const ghosts = Object.keys(MCP_ONLY_TOOLS).filter((n) => !TOOL_NAMES.has(n));
    expect(ghosts, `MCP_ONLY_TOOLS lists tools that are not registered: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: the partition is exhaustive (covered + excluded == all leaves) and 62 tools accounted for", () => {
    const covered = CLI_COMMAND_LEAVES.filter((l) => !(l in MCP_EXCLUDED));
    const excluded = CLI_COMMAND_LEAVES.filter((l) => l in MCP_EXCLUDED);
    expect(covered.length + excluded.length).toBe(CLI_COMMAND_LEAVES.length);
    // The tool count is DERIVED, not pinned to a literal: (CLI-leaf mirrors) +
    // (MCP-only tools) = (|CLI_COMMAND_LEAVES| − |MCP_EXCLUDED|) + |MCP_ONLY_TOOLS|.
    // Adding a tool updates this with zero literal churn (it is 62 today).
    const expected = CLI_COMMAND_LEAVES.length - Object.keys(MCP_EXCLUDED).length + Object.keys(MCP_ONLY_TOOLS).length;
    expect(covered.length + Object.keys(MCP_ONLY_TOOLS).length).toBe(TOOL_DEFS.length);
    expect(TOOL_DEFS.length).toBe(expected);
  });
});

describe("REQ-PCO-070: CLI_COMMAND_LEAVES is pinned to the dispatcher HELP enumeration", () => {
  // The CLI HELP string enumerates every `th <group> <sub>` usage line. We extract
  // the command leaves from HELP and assert CLI_COMMAND_LEAVES covers exactly the
  // SAME set, so the parity list can never silently drift from the CLI's own help.
  const cliSrc = fs.readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
  // The HELP usage block lists lines like:  `  th repo map [...]   Scan ...`.
  // Capture the `th <words>` head of each usage line (stop at the first flag/bracket
  // or 2+ spaces that begin the description).
  const helpMatch = /const HELP = `([\s\S]*?)`;/.exec(cliSrc);
  expect(helpMatch, "cli.ts must define a HELP template literal").toBeTruthy();
  const help = helpMatch![1]!;

  it("REQ-PCO-070: every CLI_COMMAND_LEAVES entry's `th <leaf>` appears in HELP", () => {
    const missing = CLI_COMMAND_LEAVES.filter((leaf) => {
      // The combined `th stage current|describe <s>|list` style line documents
      // multiple leaves on one row; accept either the exact `th <leaf>` token or the
      // group with the sub appearing as an alternation member.
      const exact = help.includes(`th ${leaf}`);
      const [group, sub] = leaf.split(" ");
      const grouped = sub !== undefined && new RegExp(`th ${group}\\b[^\\n]*\\b${sub}\\b`).test(help);
      return !exact && !grouped;
    });
    expect(missing, `CLI_COMMAND_LEAVES entries not found in HELP: ${missing.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: every command GROUP enumerated in HELP is modeled in CLI_COMMAND_LEAVES", () => {
    // Catch a NEW command group added to HELP/dispatch without a parity-list entry.
    // (Exact sub-leaf coverage is asserted in the forward direction above; here we
    // guard the coarser "a whole command family appeared and nobody modeled it".)
    const groups = new Set(CLI_COMMAND_LEAVES.map((l) => l.split(" ")[0]!));
    const helpGroups = new Set<string>();
    for (const line of help.split("\n")) {
      // A command group is the first `th <word>` token; a group name may contain a
      // hyphen (e.g. `assertion-presence`), so the class includes `-` to match how
      // CLI_COMMAND_LEAVES derives a group via `l.split(" ")[0]`.
      const m = /^\s{2}th ([a-z-]+)\b/.exec(line);
      if (m) helpGroups.add(m[1]!);
    }
    const unmodeled = [...helpGroups].filter((g) => !groups.has(g));
    expect(unmodeled, `HELP enumerates command groups absent from CLI_COMMAND_LEAVES: ${unmodeled.join(", ")}`).toEqual([]);
  });
});

describe("REQ-PCO-070: MCP thinness guard (handlers delegate, never re-implement)", () => {
  // The single non-trivial logic in the MCP server is the CommandResult→MCP mapping
  // and arg coercion. Each tool's `run`/`runAsync` MUST delegate to a `run*` handler
  // or the shared locked gate-mutation setter — it must NOT re-implement command
  // logic or do raw state I/O. We assert this mechanically on the stringified
  // closures.
  // NB: the test transform may rewrite imported calls as `_import_.runFoo)(...)`,
  // so match the handler NAME, not an immediately-following `(`.
  const DELEGATION_RE = /\brun[A-Z]\w*\b|\bapplyGateMutation\b|\basyncToolGuard\b|\brepoFreshnessSummary\b/;
  // Raw state/disk I/O that would indicate re-implemented command logic in the
  // adapter (the handlers own all of this; the adapter must not).
  const REIMPL_RE = /\bwriteState\s*\(|\breadFileSync\s*\(|\bwriteFileSync\s*\(|\bmkdirSync\s*\(/;

  for (const def of TOOL_DEFS) {
    it(`REQ-PCO-070: ${def.name} delegates to a handler and does no raw state I/O`, () => {
      const body = def.run.toString() + (def.runAsync ? def.runAsync.toString() : "");
      expect(DELEGATION_RE.test(body), `${def.name} must call a run* handler / applyGateMutation`).toBe(true);
      expect(REIMPL_RE.test(body), `${def.name} must not do raw state/disk I/O (delegate to the handler)`).toBe(false);
    });
  }
});

/* ------------------------------------------------------------------ *
 * AC#5 — CLI/MCP asymmetry drift-guard (REQ-PCO-070).                  *
 *                                                                      *
 * The CLI↔MCP divergence is INTENTIONAL policy, not accident: the MCP  *
 * surface is deliberately narrower (no raw gate flips, tighten-only    *
 * write-gate, ack-gated data-loss ops) AND deliberately wider in a few *
 * agent-only spots (the typed gate setters + the scored interview).    *
 * These tests PIN that asymmetry so it cannot drift silently — a       *
 * change to the policy surface must update a pinned number here and be *
 * reviewed, never slip through unnoticed.                              *
 * ------------------------------------------------------------------ */
describe("REQ-PCO-070: CLI/MCP asymmetry is pinned (intentional, not accidental drift)", () => {
  const TOOL_NAMES_SET = new Set(TOOL_DEFS.map((t) => t.name));
  const mcpSrc = fs.readFileSync(path.join(ROOT, "src", "mcp-server.ts"), "utf8");

  it("AC#5: the MCP-only tool count is pinned to 6", () => {
    // MCP-only = tools with NO mirroring CLI leaf (the typed gate setters
    // th_blast_radius_record/th_write_gate_set + the agent-only interview trio
    // + th_context: S0 context-pages multi-op reader, no 1:1 CLI leaf).
    // A new MCP-only tool must bump this number AND be justified in MCP_ONLY_TOOLS.
    expect(Object.keys(MCP_ONLY_TOOLS).length).toBe(6);
    // Every MCP-only entry is a real registered tool (no ghosts) — re-pinned here
    // so this guard travels with the asymmetry count it protects.
    for (const name of Object.keys(MCP_ONLY_TOOLS)) {
      expect(TOOL_NAMES_SET.has(name), `MCP_ONLY_TOOLS lists unregistered tool ${name}`).toBe(true);
    }
  });

  it("AC#5: the mutating-tool count is SELF-DERIVED from the registry (no per-merge literal)", () => {
    // Mutating = explicitly annotated readOnlyHint:false. This is the write-surface
    // size: every one of these is exercised by the write-surface audit harness (AC#1).
    // SG3: this count used to be a hand-maintained literal (30→32→…) that every new
    // mutating twin had to bump. We now DERIVE it so future mutating twins (P2-A's
    // th_research_write, then P2-C/P3-A) need ZERO literal churn here — the guard
    // still fires, but on the structural invariant, not a stale number.
    const mutating = TOOL_DEFS.filter((t) => TOOL_ANNOTATIONS[t.name]?.readOnlyHint === false);
    const readOnly = TOOL_DEFS.filter((t) => TOOL_ANNOTATIONS[t.name]?.readOnlyHint === true);
    // Independent derivation of the mutating count: the whole registry MINUS the
    // explicitly read-only tools. This is a real cross-check (not a tautology): if any
    // tool were missing/garbled its readOnlyHint, it would land in neither partition
    // and `total − readOnly` would NOT equal the directly-counted `mutating` set.
    const derivedMutating = TOOL_DEFS.length - readOnly.length;
    expect(mutating.length).toBe(derivedMutating);
    // And the two partitions must tile the registry exactly (every tool is annotated
    // as exactly one of read-only / mutating — no un-annotated tool, no overlap).
    expect(readOnly.length + mutating.length).toBe(TOOL_DEFS.length);
    // Derived parity count: (|CLI_COMMAND_LEAVES| − |MCP_EXCLUDED|) + |MCP_ONLY_TOOLS|.
    const expected = CLI_COMMAND_LEAVES.length - Object.keys(MCP_EXCLUDED).length + Object.keys(MCP_ONLY_TOOLS).length;
    expect(TOOL_DEFS.length).toBe(expected);
  });

  it("AC#5: th_state_set refuses every GATE_OWNED field over MCP (no raw gate flip)", () => {
    // The MCP raw setter must refuse to move any gate-security field; the typed
    // gate tools are the only MCP path to them. We assert the refusal is wired to
    // the canonical GATE_OWNED set (state-fields.ts), not a stale local copy, by
    // pinning that the th_state_set closure consults GATE_OWNED, and that the set
    // covers the governing fields it is meant to cover.
    const stateSet = TOOL_DEFS.find((t) => t.name === "th_state_set");
    expect(stateSet, "th_state_set must be registered").toBeTruthy();
    expect(stateSet!.run.toString()).toMatch(/GATE_OWNED/);
    expect(GATE_OWNED.size).toBeGreaterThan(0);
    // The 5 original gate-security fields + the 4 gate-defining config fields (R-04).
    for (const field of [
      "implementation_allowed",
      "tier",
      "current_stage",
      "write_gate",
      "blast_radius_flags",
      "delivery_mode",
      "has_ui",
      "interview_required",
      "interview_cutoff",
    ]) {
      expect(GATE_OWNED.has(field), `GATE_OWNED must cover ${field}`).toBe(true);
    }
  });

  it("AC#5: the set MCP refuses == the set CLI --emergency-gates == 9 fields (R-04 parity)", () => {
    // GATE_OWNED is the single source of truth for BOTH surfaces: MCP th_state_set
    // refuses `GATE_OWNED.has(firstSegment)` and the CLI runStateSetLocked gates the
    // SAME set behind --emergency. After R-04 it is exactly these nine fields.
    expect([...GATE_OWNED].sort()).toEqual(
      [
        "blast_radius_flags",
        "current_stage",
        "implementation_allowed",
        "tier",
        "write_gate",
        "delivery_mode",
        "has_ui",
        "interview_required",
        "interview_cutoff",
      ].sort(),
    );
    expect(GATE_OWNED.size).toBe(9);
  });

  it("AC#5: th_write_gate_set is tighten-only over MCP (cannot loosen the write-gate)", () => {
    // The closure must compare ranks and refuse a strictly-lower target with the
    // stable would_loosen_write_gate error — the pinned proof that an agent can
    // raise but never lower the PreToolUse gate.
    const wgs = TOOL_DEFS.find((t) => t.name === "th_write_gate_set");
    expect(wgs, "th_write_gate_set must be registered").toBeTruthy();
    const body = wgs!.run.toString();
    expect(body, "th_write_gate_set must rank-compare to enforce tighten-only").toMatch(/WRITE_GATE_RANK/);
    expect(body, "th_write_gate_set must refuse with would_loosen_write_gate").toMatch(/would_loosen_write_gate/);
  });

  it("AC#5: the destructive-ack tool set EXACTLY equals the destructiveHint:true set", () => {
    // Two independent signals must agree: (a) the runtime data-loss gate
    // (assertDestructiveAck in the closure) and (b) the advertised destructiveHint
    // annotation. If a tool is annotated destructive it MUST carry the ack gate,
    // and a tool carrying the ack gate MUST be annotated destructive — no silent
    // drift between "what we tell the agent" and "what we actually enforce".
    const ackGated = new Set(
      TOOL_DEFS.filter((t) => {
        const body = t.run.toString() + (t.runAsync ? t.runAsync.toString() : "");
        return /assertDestructiveAck/.test(body);
      }).map((t) => t.name),
    );
    const destructiveAnnotated = new Set(
      TOOL_DEFS.filter((t) => TOOL_ANNOTATIONS[t.name]?.destructiveHint === true).map((t) => t.name),
    );
    expect([...ackGated].sort()).toEqual([...destructiveAnnotated].sort());
    // Pin the current membership so this can't drift to the empty set on both sides
    // (which would vacuously pass the equality above).
    expect([...destructiveAnnotated].sort()).toEqual([
      "th_collab_fragment",
      "th_interview_start",
      "th_verify_clear",
    ]);
  });

  it("AC#5: CLI `state set <gate-field>` requires --emergency (the escape boundary is pinned)", () => {
    // The CLI keeps gate-owned fields settable, but ONLY behind the explicit
    // --emergency escape (audit #11) — the human override the MCP surface lacks.
    // Assert the CLI surface wires this: the dispatcher passes the parsed
    // --emergency flag into runStateSet, and HELP documents the requirement.
    const cliSrc = fs.readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
    // The call spans nested parens (rest.slice(1).join(" ")), so match loosely up
    // to the emergency option, bounded to a single runStateSet(...) statement.
    expect(cliSrc, "cli.ts must pass the --emergency flag into runStateSet").toMatch(
      /runStateSet\([^;]*emergency:\s*parsed\.flags\.emergency/,
    );
    expect(cliSrc, "cli.ts must register the --emergency flag alias").toMatch(/"--emergency":\s*"emergency"/);
    expect(cliSrc, "cli.ts HELP must document that gate-owned fields require --emergency").toMatch(
      /gate-owned fields require --emergency/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * AC#5 — th_repo_map annotation reconcile (Option A).                  *
 *                                                                      *
 * th_repo_map OVERWRITES its two generated artifacts on every write    *
 * run. That overwrite is documented (so an agent is not surprised) but *
 * is NOT flagged destructive: the artifacts are GENERATED_ARTIFACTS    *
 * (derived, idempotently regenerated), so overwriting them is not the  *
 * irreversible data-loss the ack gate guards against. Option B (a      *
 * no-clobber sentinel) is deferred. These tests pin Option A.          *
 * ------------------------------------------------------------------ */
describe("AC#5: th_repo_map overwrite is documented and stays non-destructive (Option A)", () => {
  const repoMap = TOOL_DEFS.find((t) => t.name === "th_repo_map");

  it("AC#5: th_repo_map is a registered tool", () => {
    expect(repoMap, "th_repo_map must be registered").toBeTruthy();
  });

  it("AC#5: the description documents that it OVERWRITES both repo-map artifacts", () => {
    const desc = repoMap!.description ?? "";
    expect(desc, "description must state it overwrites the artifacts").toMatch(/OVERWRIT/i);
    expect(desc, "description must name repo-map.json").toMatch(/repo-map\.json/);
    expect(desc, "description must name docs/00-repo-map.md").toMatch(/docs\/00-repo-map\.md/);
  });

  it("AC#5: th_repo_map stays destructiveHint:false (GENERATED_ARTIFACTS, idempotent regen)", () => {
    // KEEP non-destructive on purpose: regenerating generated content is not
    // data-loss, so th_repo_map deliberately does NOT join the ack-gated set
    // above. This pins the Option-A decision against accidental flips in either
    // direction (annotation flipped to destructive, or the ack gate wired in).
    const ann = TOOL_ANNOTATIONS["th_repo_map"];
    expect(ann, "th_repo_map must be annotated").toBeTruthy();
    expect(ann!.readOnlyHint).toBe(false); // it does write
    expect(ann!.destructiveHint).toBe(false); // but regen is idempotent, not data-loss
    const body = repoMap!.run.toString();
    expect(/assertDestructiveAck/.test(body), "th_repo_map must NOT carry the data-loss ack gate").toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * BSC-9 (Axis-B slice-7) — toToolResult PROJECTION ORACLE.            *
 *                                                                     *
 * Every tool closure delegates to the same `run*` handler the CLI    *
 * dispatches to (the REQ-PCO-070 thinness guard above), so there is   *
 * NO divergent execution path. The ONE authentic CLI↔MCP divergence  *
 * surface is the PROJECTION — `toToolResult` mapping a CommandResult  *
 * onto the MCP CallToolResult. This suite EXTENDS the REQ-PCO-070     *
 * partition with a projection-fidelity oracle:                       *
 *   1. the real `toToolResult` matches the core `referenceProjection` *
 *      contract over the committed twin-call fixture set (so the two  *
 *      can never drift — a regression in the real projector fails);   *
 *   2. the committed fixtures are themselves faithful (the gate-time  *
 *      oracle finds ZERO infidelities on the shipped set).            *
 * ------------------------------------------------------------------ */
describe("REQ-PCO-070: toToolResult projection oracle (the only authentic CLI↔MCP divergence surface)", () => {
  const set = loadProjectionFixtures(BSC9_FIXTURES_PATH);

  it("the committed twin-call fixture set loads and is non-empty", () => {
    expect(set, `BSC-9 fixtures must load from ${BSC9_FIXTURES_PATH}`).toBeTruthy();
    expect(set!.fixtures.length).toBeGreaterThan(0);
  });

  it("the REAL toToolResult matches the core referenceProjection contract over every fixture", () => {
    // Pin the runtime projector (`toToolResult`) to the core gate-time contract
    // (`referenceProjection`) so a change to one without the other is caught.
    for (const f of set!.fixtures) {
      const real = realProjection(f.result);
      const infidelities = projectionFidelity(f.tool, f.result, real);
      expect(infidelities, `${f.tool}: real toToolResult diverged from the contract: ${JSON.stringify(infidelities)}`).toEqual([]);
      // And the real projection equals the reference projection structurally.
      expect(real).toEqual(referenceProjection(f.result));
    }
  });

  it("the gate-time oracle finds ZERO infidelities on the shipped fixture set", () => {
    expect(runProjectionOracle(set!)).toEqual([]);
  });

  it("the fixture set exercises every fidelity axis (ok/exitCode/data/text shapes)", () => {
    // Non-vacuous: the set must include a failing command, a non-1 exit code (the
    // taxonomy isError can't carry), a data-bearing result, a no-data result, and the
    // reserved-key precedence case (data.exitCode shadowed by the envelope exitCode).
    const tools = new Set(set!.fixtures.map((f) => f.tool));
    expect(tools.has("th_repo_check"), "needs a non-1 exit-code (4=stale) failing fixture").toBe(true);
    expect(tools.has("th_state_status"), "needs the reserved-key precedence fixture").toBe(true);
    const precedence = set!.fixtures.find((f) => f.tool === "th_state_status")!;
    // data.exitCode is 999 but the projected exitCode MUST be the envelope's 0.
    expect((precedence.result.data as { exitCode?: number }).exitCode).toBe(999);
    expect(precedence.projected.structuredContent.exitCode).toBe(0);
    const anyFailing = set!.fixtures.some((f) => f.projected.isError === true);
    expect(anyFailing, "needs at least one failing (isError) fixture").toBe(true);
  });
});
