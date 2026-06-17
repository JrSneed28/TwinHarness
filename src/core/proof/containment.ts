/**
 * Component 7 (Security & containment) — plan Step 7. PURE and DEPENDENCY-INJECTED:
 * the live MCP tool-name list is passed IN (never imported) so this module never
 * pulls in `src/mcp-server.ts` (R7 — no bundle cycle). It asserts four containment
 * invariants:
 *
 *   (a) EXACT NAME-SET allowlist — `new Set(toolNames)` equals
 *       {@link EXPECTED_TOOL_ALLOWLIST} (not count-only) AND `th_decision_approve`
 *       (the HUMAN-ONLY TTY gate, deliberately absent from MCP) is NOT present.
 *   (b) `resolveWithinRoot` rejects path-traversal / proto-pollution hostile input.
 *   (c) the MCP raw setter must refuse every `GATE_OWNED` field (verified via the
 *       real `state-fields.ts` policy: `fieldPolicy(f).gateOwned === true`).
 *   (d) telemetry stays local — a static scan proves `telemetry.ts` imports no
 *       network module and makes no `fetch`/socket call.
 *
 * NOTE (plan Step 7): we do NOT assert against the LIVE `TOOL_DEFS` here — it still
 * carries 35 until the MCP registration phase. The live-registry equality is owned
 * by the three frozen tests updated in Phase C. Callers pass {@link EXPECTED_TOOL_ALLOWLIST}
 * (the post-registration 38) as `toolNames` to prove the allowlist's own integrity.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWithinRoot } from "../paths";
import { GATE_OWNED, fieldPolicy } from "../state-fields";
import type { Assertion, Diagnostic } from "./types";

/**
 * The 35 base MCP tool names (verified against `TOOL_DEFS`, plan Step 7) PLUS the 3
 * appended proof tools — 38 total. `th_decision_approve` is INTENTIONALLY excluded
 * (RULE-011/INV-005: a human-only TTY gate is never exposed over MCP).
 */
export const EXPECTED_TOOL_ALLOWLIST: readonly string[] = [
  // --- 35 base tools ---
  "th_state_get",
  "th_state_set",
  "th_drift_add",
  "th_build_next_wave",
  "th_build_claim",
  "th_build_release",
  "th_build_dispatch",
  "th_build_plan",
  "th_route",
  "th_coverage_check",
  "th_next",
  "th_delegate_plan",
  "th_delegate_pack",
  "th_delegate_check",
  "th_repo_map",
  "th_repo_relevant",
  "th_repo_impact",
  "th_context_pack",
  "th_build_sub_claim",
  "th_build_sub_release",
  "th_repo_check",
  "th_decision_detect",
  "th_decision_add",
  "th_decision_check",
  "th_decision_list",
  "th_artifact_claim",
  "th_artifact_release",
  "th_artifact_leases",
  "th_collab_init",
  "th_collab_fragment",
  "th_collab_list",
  "th_collab_merge",
  "th_debate_add",
  "th_debate_list",
  "th_debate_resolve",
  // --- 3 appended proof tools (read/coordination-only; never gate-mutating) ---
  "th_proof_run",
  "th_proof_component",
  "th_proof_report",
] as const;

/** The human-only gate that must NEVER appear in the MCP allowlist. */
export const FORBIDDEN_MCP_TOOL = "th_decision_approve";

/** Default hostile inputs fed to `resolveWithinRoot` — each MUST resolve to null. */
const DEFAULT_HOSTILE_PATHS: readonly string[] = [
  "../escape.txt",
  "../../etc/passwd",
  "..\\..\\..\\Windows\\System32\\config",
  "foo/../../bar",
  "../__proto__/polluted", // proto-pollution-style traversal
  "/etc/shadow",
  "C:\\Windows\\System32\\drivers\\etc\\hosts",
] as const;

/** Import/require/runtime patterns that would indicate network egress in a module. */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /from\s+["']node:(?:http|https|net|tls|dgram|http2|dns)["']/,
  /from\s+["'](?:http|https|net|tls|dgram|http2|dns|axios|node-fetch|undici|got|request|superagent)["']/,
  /require\(\s*["'](?:node:)?(?:http|https|net|tls|dgram|http2|dns|axios|node-fetch|undici|got|request|superagent)["']\s*\)/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
];

/**
 * Best-effort read of the real `telemetry.ts` source. The telemetry module being
 * scanned is the TwinHarness IMPLEMENTATION's own — anchored to the install
 * location (`__dirname`), never to the governed project/scenario root (which, in an
 * isolated live scenario, is an empty temp SUT with no `src/`). Tries, in order:
 *   1. `<__dirname>/../telemetry.ts` — un-bundled source/tests, where `__dirname`
 *      is `src/core/proof`;
 *   2. `<__dirname>/../telemetry.js` — un-bundled `dist/cli.js`, where `__dirname`
 *      is `dist/core/proof`;
 *   3. `<__dirname>/../src/core/telemetry.ts` — the BUNDLED `dist/mcp-server.js`,
 *      where esbuild collapses `__dirname` to `dist/`, so candidates (1)/(2) resolve
 *      to a non-existent `<install>/telemetry.*`;
 *   4. `<repoRoot>/src/core/telemetry.ts` — explicit override, last resort.
 * Returns `null` only when no candidate is readable.
 */
function readTelemetrySource(repoRoot?: string): string | null {
  const candidates = [
    path.resolve(__dirname, "..", "telemetry.ts"),
    path.resolve(__dirname, "..", "telemetry.js"),
    path.resolve(__dirname, "..", "src", "core", "telemetry.ts"),
    ...(repoRoot ? [path.join(repoRoot, "src", "core", "telemetry.ts")] : []),
  ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export interface ContainmentInput {
  /** The MCP tool-name list to assert against the allowlist (INJECTED — never imported). */
  toolNames: readonly string[];
  /** Override the GATE_OWNED field set (defaults to the real `GATE_OWNED` from state-fields.ts). */
  gateOwnedFields?: readonly string[];
  /** Override the hostile-path inputs (defaults to a traversal/proto-pollution set). */
  hostilePaths?: readonly string[];
  /** Root used for the `resolveWithinRoot` containment check (defaults to a synthetic temp root). */
  containmentRoot?: string;
  /** Override the telemetry source for the no-network scan (defaults to reading `telemetry.ts`). */
  telemetrySource?: string;
  /** Repo root used to locate `src/core/telemetry.ts` when running the bundled `dist/cli.js`. */
  repoRoot?: string;
}

export interface ContainmentReport {
  assertions: Assertion[];
  diagnostics: Diagnostic[];
  stats: Record<string, unknown>;
}

/** Whether two string sets are exactly equal. */
function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Run the four containment proofs over the injected `toolNames`. Returns the
 * assertions, an AI-actionable diagnostic per failure, and supporting stats. Never
 * throws — a missing telemetry source surfaces as a failed assertion + diagnostic.
 */
export function assertContainment(input: ContainmentInput): ContainmentReport {
  const assertions: Assertion[] = [];
  const diagnostics: Diagnostic[] = [];
  const component = "containment" as const;

  const add = (a: Assertion, diag?: Omit<Diagnostic, "component">): void => {
    assertions.push(a);
    if (!a.pass && diag) diagnostics.push({ component, ...diag });
  };

  // (a) exact NAME-SET allowlist equality.
  const expectedSet = new Set(EXPECTED_TOOL_ALLOWLIST);
  const actualSet = new Set(input.toolNames);
  const missing = [...expectedSet].filter((n) => !actualSet.has(n));
  const extra = [...actualSet].filter((n) => !expectedSet.has(n));
  const nameSetEqual = setEquals(actualSet, expectedSet);
  add(
    {
      name: "registry.name_set_equals_allowlist",
      component,
      expected: [...expectedSet].sort(),
      actual: [...actualSet].sort(),
      pass: nameSetEqual,
    },
    {
      location: "TOOL_DEFS name-set vs EXPECTED_TOOL_ALLOWLIST",
      severity: "error",
      hint:
        `tool name-set differs from the allowlist — missing: [${missing.join(", ")}], ` +
        `extra: [${extra.join(", ")}]. Reconcile TOOL_DEFS or EXPECTED_TOOL_ALLOWLIST.`,
    },
  );

  // (a') the human-only gate must be absent.
  const approveAbsent = !actualSet.has(FORBIDDEN_MCP_TOOL);
  add(
    {
      name: "registry.decision_approve_absent",
      component,
      expected: `${FORBIDDEN_MCP_TOOL} absent`,
      actual: approveAbsent ? "absent" : "present",
      pass: approveAbsent,
    },
    {
      location: FORBIDDEN_MCP_TOOL,
      severity: "error",
      hint: `${FORBIDDEN_MCP_TOOL} must never be exposed over MCP (RULE-011/INV-005 — human-only TTY gate).`,
    },
  );

  // (b) resolveWithinRoot rejects hostile input.
  const hostilePaths = input.hostilePaths ?? DEFAULT_HOSTILE_PATHS;
  const containmentRoot = input.containmentRoot ?? path.join(os.tmpdir(), "th-proof-containment-root");
  const notRejected = hostilePaths.filter((p) => resolveWithinRoot(containmentRoot, p) !== null);
  add(
    {
      name: "guards.path_traversal_rejected",
      component,
      expected: hostilePaths.length,
      actual: hostilePaths.length - notRejected.length,
      pass: notRejected.length === 0,
    },
    {
      location: "resolveWithinRoot",
      severity: "error",
      hint: `hostile path(s) NOT rejected by resolveWithinRoot: [${notRejected.join(", ")}]. Containment is broken.`,
    },
  );

  // (c) GATE_OWNED refusal — the real policy says each is gate-owned.
  const gateOwnedFields = input.gateOwnedFields ?? [...GATE_OWNED];
  const notGateOwned = gateOwnedFields.filter((f) => fieldPolicy(f)?.gateOwned !== true);
  add(
    {
      name: "state.gate_owned_refused",
      component,
      expected: gateOwnedFields.length,
      actual: gateOwnedFields.length - notGateOwned.length,
      pass: notGateOwned.length === 0,
    },
    {
      location: "state-fields.GATE_OWNED / fieldPolicy",
      severity: "error",
      hint: `field(s) not marked gate-owned (MCP th_state_set could mutate a gate): [${notGateOwned.join(", ")}].`,
    },
  );
  // The verified 5-field GATE_OWNED set (incl. blast_radius_flags).
  add(
    {
      name: "state.gate_owned_count",
      component,
      expected: 5,
      actual: GATE_OWNED.size,
      pass: GATE_OWNED.size === 5,
    },
    {
      location: "state-fields.GATE_OWNED",
      severity: "warning",
      hint: `GATE_OWNED should hold exactly 5 fields (implementation_allowed, tier, current_stage, write_gate, blast_radius_flags); found ${GATE_OWNED.size}.`,
    },
  );

  // (d) telemetry no-network (static source scan).
  const telemetrySource = input.telemetrySource ?? readTelemetrySource(input.repoRoot);
  const networkHits =
    telemetrySource === null
      ? ["<telemetry source unavailable>"]
      : NETWORK_PATTERNS.filter((re) => re.test(telemetrySource)).map((re) => re.source);
  add(
    {
      name: "telemetry.no_network",
      component,
      expected: "no network import/egress",
      actual: networkHits.length === 0 ? "local-only" : networkHits.join(" | "),
      pass: telemetrySource !== null && networkHits.length === 0,
    },
    {
      location: "src/core/telemetry.ts",
      severity: "error",
      hint:
        telemetrySource === null
          ? "could not read telemetry.ts to prove no-network; pass telemetrySource explicitly."
          : `telemetry.ts matched network pattern(s): [${networkHits.join(", ")}]. Telemetry must stay local-only.`,
    },
  );

  const stats: Record<string, unknown> = {
    allowlistSize: EXPECTED_TOOL_ALLOWLIST.length,
    toolCount: input.toolNames.length,
    missing,
    extra,
    hostileInputs: hostilePaths.length,
    hostileRejected: hostilePaths.length - notRejected.length,
    gateOwned: [...GATE_OWNED],
    telemetryNetworkHits: networkHits,
  };

  return { assertions, diagnostics, stats };
}
