/**
 * Component 9 (the hard coverage gate) — plan Step 9 / §10 pre-mortem #1 / AC #5.
 *
 * {@link buildCoverageMatrix} computes the enforced feature-coverage matrix across
 * THREE dimensions and FAILS (`complete:false`) if ANY item in ANY dimension went
 * unexercised by the proof run:
 *
 *   - subsystems : the real `src/core/*` modules the suite must exercise.
 *   - mcpTools   : the live MCP tool registry (count = `knownToolNames.length`).
 *                  The touched-set derives ONLY from the LIVE dedicated
 *                  `proof-calls.jsonl` trail (`liveMcpCalls`) — NEVER from the
 *                  in-process self-test loop. When `selfTestOnly` (no live trail) or
 *                  `mcpUnverifiable` (no injected registry) is set, the dimension is
 *                  forced untouched + incomplete (a self-test loop and an absent
 *                  registry NEVER satisfy the live MCP dimension — pre-mortem #1).
 *   - gates      : the stop / write / PreToolUse / decision gates.
 *
 * PURE + DEPENDENCY-INJECTED: the known tool-name set and the live call trail are
 * passed IN (never imported), so this module never pulls in `src/mcp-server.ts`
 * (R7 — no bundle cycle). {@link matrixDiagnostics} emits one AI-actionable
 * {@link Diagnostic} (component `runner-report`) per untouched item.
 */

import type {
  CoverageDimension,
  CoverageMatrix,
  Diagnostic,
  ProofCall,
  ProofComponent,
} from "./types";

/**
 * The real `src/core/*` subsystems the suite must exercise (plan Step 9). A run is
 * incomplete if any of these is never touched across the corpus + mechanical proofs.
 */
export const PROOF_SUBSYSTEMS: readonly string[] = [
  "state-store",
  "state-schema",
  "state-fields",
  "schedule",
  "wave",
  "leases",
  "repo-map/scanner",
  "coverage",
  "anchors",
  "ledger",
  "decisions",
  "telemetry",
  "routing",
  "health",
  "guards",
  "paths",
  "sleep",
] as const;

/** The gate kinds the matrix enforces (stop/write/PreToolUse/decision). */
export const PROOF_GATES: readonly string[] = ["stop", "write", "PreToolUse", "decision"] as const;

/** The component every coverage-matrix diagnostic is attributed to. */
const COMPONENT: ProofComponent = "runner-report";

export interface CoverageMatrixInput {
  /** The live MCP tool registry name-set (count = `knownToolNames.length`). Injected — never imported. */
  knownToolNames: readonly string[];
  /** The LIVE dedicated `proof-calls.jsonl` trail — the ONLY source of the MCP touched-set (C1/A1). */
  liveMcpCalls: ProofCall[];
  /** Subsystems the run exercised (intersected with {@link PROOF_SUBSYSTEMS}). */
  subsystemsTouched?: string[];
  /** Gates the run exercised (intersected with {@link PROOF_GATES}). */
  gatesTouched?: string[];
  /**
   * Self-test mode: the in-process mechanical-reachability loop NEVER satisfies the
   * live MCP-tool dimension (pre-mortem #1 / AC #5). When true the mcpTools
   * touched-set is forced empty regardless of `liveMcpCalls`.
   */
  selfTestOnly?: boolean;
  /**
   * No MCP tool registry was injected → the live MCP-tool dimension is UNVERIFIABLE
   * and reported as untouched/incomplete (NOT silently complete). Like
   * {@link selfTestOnly} it forces the mcpTools touched-set empty, but carries a
   * distinct diagnostic reason.
   */
  mcpUnverifiable?: boolean;
}

/** Build one coverage dimension from a known set and the set of touched names. */
function dimension(known: readonly string[], touched: ReadonlySet<string>): CoverageDimension {
  const touchedNames = known.filter((n) => touched.has(n));
  const untouched = known.filter((n) => !touched.has(n));
  return { count: known.length, touched: touchedNames, untouched };
}

/**
 * Compute the enforced feature-coverage matrix. `complete` is true ONLY when every
 * subsystem, every known MCP tool, and every gate is touched. The MCP-tool
 * touched-set is derived from the LIVE trail alone and is forced empty under
 * self-test / unverifiable mode (the live dimension is never satisfied mechanically).
 */
export function buildCoverageMatrix(input: CoverageMatrixInput): CoverageMatrix {
  const subsystems = dimension(PROOF_SUBSYSTEMS, new Set(input.subsystemsTouched ?? []));
  const gates = dimension(PROOF_GATES, new Set(input.gatesTouched ?? []));

  // MCP tools: touched ONLY from the live proof-calls.jsonl trail. A self-test loop
  // or an absent registry can never satisfy this dimension — force it empty.
  const liveSatisfies = !input.selfTestOnly && !input.mcpUnverifiable;
  const liveToolNames = liveSatisfies ? new Set(input.liveMcpCalls.map((c) => c.tool)) : new Set<string>();
  const mcpTools = dimension(input.knownToolNames, liveToolNames);

  const complete =
    subsystems.untouched.length === 0 && mcpTools.untouched.length === 0 && gates.untouched.length === 0;

  return { subsystems, mcpTools, gates, complete };
}

/**
 * Emit one AI-actionable {@link Diagnostic} per untouched item across all three
 * dimensions (component `runner-report`). The mcpTools hint distinguishes a genuine
 * coverage gap from the self-test / unverifiable rejection of the live dimension.
 */
export function matrixDiagnostics(
  matrix: CoverageMatrix,
  opts: { selfTestOnly?: boolean; mcpUnverifiable?: boolean } = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const name of matrix.subsystems.untouched) {
    diagnostics.push({
      component: COMPONENT,
      location: `subsystem:${name}`,
      severity: "error",
      hint: `subsystem "${name}" was never exercised by the proof run; add a brief/sub-proof that touches src/core/${name}.`,
    });
  }

  const mcpHint = (name: string): string => {
    if (opts.selfTestOnly) {
      return `MCP tool "${name}" is NOT satisfied: a --self-test run proves mechanical reachability only and never satisfies the LIVE MCP-tool dimension (it must appear in the dedicated proof-calls.jsonl trail of a real in-session run).`;
    }
    if (opts.mcpUnverifiable) {
      return `MCP tool "${name}" is UNVERIFIABLE: no MCP tool registry was injected, so the live coverage cannot be confirmed. Supply a ProofToolRegistry (and a live proof-calls.jsonl trail) to verify it.`;
    }
    return `MCP tool "${name}" has no entry in the live proof-calls.jsonl trail; drive a brief that invokes it so its call is recorded.`;
  };
  for (const name of matrix.mcpTools.untouched) {
    diagnostics.push({
      component: COMPONENT,
      location: `mcp-tool:${name}`,
      severity: "error",
      hint: mcpHint(name),
    });
  }

  for (const name of matrix.gates.untouched) {
    diagnostics.push({
      component: COMPONENT,
      location: `gate:${name}`,
      severity: "error",
      hint: `gate "${name}" was never exercised by the proof run; add a sub-proof that drives the ${name} gate.`,
    });
  }

  return diagnostics;
}
