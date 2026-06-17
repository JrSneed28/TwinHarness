"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORBIDDEN_MCP_TOOL = exports.EXPECTED_TOOL_ALLOWLIST = void 0;
exports.assertContainment = assertContainment;
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
const state_fields_1 = require("../state-fields");
/**
 * The 35 base MCP tool names (verified against `TOOL_DEFS`, plan Step 7) PLUS the 3
 * appended proof tools — 38 total. `th_decision_approve` is INTENTIONALLY excluded
 * (RULE-011/INV-005: a human-only TTY gate is never exposed over MCP).
 */
exports.EXPECTED_TOOL_ALLOWLIST = [
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
];
/** The human-only gate that must NEVER appear in the MCP allowlist. */
exports.FORBIDDEN_MCP_TOOL = "th_decision_approve";
/** Default hostile inputs fed to `resolveWithinRoot` — each MUST resolve to null. */
const DEFAULT_HOSTILE_PATHS = [
    "../escape.txt",
    "../../etc/passwd",
    "..\\..\\..\\Windows\\System32\\config",
    "foo/../../bar",
    "../__proto__/polluted", // proto-pollution-style traversal
    "/etc/shadow",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
];
/** Import/require/runtime patterns that would indicate network egress in a module. */
const NETWORK_PATTERNS = [
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
function readTelemetrySource(repoRoot) {
    const candidates = [
        path.resolve(__dirname, "..", "telemetry.ts"),
        path.resolve(__dirname, "..", "telemetry.js"),
        path.resolve(__dirname, "..", "src", "core", "telemetry.ts"),
        ...(repoRoot ? [path.join(repoRoot, "src", "core", "telemetry.ts")] : []),
    ];
    for (const file of candidates) {
        try {
            return fs.readFileSync(file, "utf8");
        }
        catch {
            /* try next candidate */
        }
    }
    return null;
}
/** Whether two string sets are exactly equal. */
function setEquals(a, b) {
    if (a.size !== b.size)
        return false;
    for (const x of a)
        if (!b.has(x))
            return false;
    return true;
}
/**
 * Run the four containment proofs over the injected `toolNames`. Returns the
 * assertions, an AI-actionable diagnostic per failure, and supporting stats. Never
 * throws — a missing telemetry source surfaces as a failed assertion + diagnostic.
 */
function assertContainment(input) {
    const assertions = [];
    const diagnostics = [];
    const component = "containment";
    const add = (a, diag) => {
        assertions.push(a);
        if (!a.pass && diag)
            diagnostics.push({ component, ...diag });
    };
    // (a) exact NAME-SET allowlist equality.
    const expectedSet = new Set(exports.EXPECTED_TOOL_ALLOWLIST);
    const actualSet = new Set(input.toolNames);
    const missing = [...expectedSet].filter((n) => !actualSet.has(n));
    const extra = [...actualSet].filter((n) => !expectedSet.has(n));
    const nameSetEqual = setEquals(actualSet, expectedSet);
    add({
        name: "registry.name_set_equals_allowlist",
        component,
        expected: [...expectedSet].sort(),
        actual: [...actualSet].sort(),
        pass: nameSetEqual,
    }, {
        location: "TOOL_DEFS name-set vs EXPECTED_TOOL_ALLOWLIST",
        severity: "error",
        hint: `tool name-set differs from the allowlist — missing: [${missing.join(", ")}], ` +
            `extra: [${extra.join(", ")}]. Reconcile TOOL_DEFS or EXPECTED_TOOL_ALLOWLIST.`,
    });
    // (a') the human-only gate must be absent.
    const approveAbsent = !actualSet.has(exports.FORBIDDEN_MCP_TOOL);
    add({
        name: "registry.decision_approve_absent",
        component,
        expected: `${exports.FORBIDDEN_MCP_TOOL} absent`,
        actual: approveAbsent ? "absent" : "present",
        pass: approveAbsent,
    }, {
        location: exports.FORBIDDEN_MCP_TOOL,
        severity: "error",
        hint: `${exports.FORBIDDEN_MCP_TOOL} must never be exposed over MCP (RULE-011/INV-005 — human-only TTY gate).`,
    });
    // (b) resolveWithinRoot rejects hostile input.
    const hostilePaths = input.hostilePaths ?? DEFAULT_HOSTILE_PATHS;
    const containmentRoot = input.containmentRoot ?? path.join(os.tmpdir(), "th-proof-containment-root");
    const notRejected = hostilePaths.filter((p) => (0, paths_1.resolveWithinRoot)(containmentRoot, p) !== null);
    add({
        name: "guards.path_traversal_rejected",
        component,
        expected: hostilePaths.length,
        actual: hostilePaths.length - notRejected.length,
        pass: notRejected.length === 0,
    }, {
        location: "resolveWithinRoot",
        severity: "error",
        hint: `hostile path(s) NOT rejected by resolveWithinRoot: [${notRejected.join(", ")}]. Containment is broken.`,
    });
    // (c) GATE_OWNED refusal — the real policy says each is gate-owned.
    const gateOwnedFields = input.gateOwnedFields ?? [...state_fields_1.GATE_OWNED];
    const notGateOwned = gateOwnedFields.filter((f) => (0, state_fields_1.fieldPolicy)(f)?.gateOwned !== true);
    add({
        name: "state.gate_owned_refused",
        component,
        expected: gateOwnedFields.length,
        actual: gateOwnedFields.length - notGateOwned.length,
        pass: notGateOwned.length === 0,
    }, {
        location: "state-fields.GATE_OWNED / fieldPolicy",
        severity: "error",
        hint: `field(s) not marked gate-owned (MCP th_state_set could mutate a gate): [${notGateOwned.join(", ")}].`,
    });
    // The verified 5-field GATE_OWNED set (incl. blast_radius_flags).
    add({
        name: "state.gate_owned_count",
        component,
        expected: 5,
        actual: state_fields_1.GATE_OWNED.size,
        pass: state_fields_1.GATE_OWNED.size === 5,
    }, {
        location: "state-fields.GATE_OWNED",
        severity: "warning",
        hint: `GATE_OWNED should hold exactly 5 fields (implementation_allowed, tier, current_stage, write_gate, blast_radius_flags); found ${state_fields_1.GATE_OWNED.size}.`,
    });
    // (d) telemetry no-network (static source scan).
    const telemetrySource = input.telemetrySource ?? readTelemetrySource(input.repoRoot);
    const networkHits = telemetrySource === null
        ? ["<telemetry source unavailable>"]
        : NETWORK_PATTERNS.filter((re) => re.test(telemetrySource)).map((re) => re.source);
    add({
        name: "telemetry.no_network",
        component,
        expected: "no network import/egress",
        actual: networkHits.length === 0 ? "local-only" : networkHits.join(" | "),
        pass: telemetrySource !== null && networkHits.length === 0,
    }, {
        location: "src/core/telemetry.ts",
        severity: "error",
        hint: telemetrySource === null
            ? "could not read telemetry.ts to prove no-network; pass telemetrySource explicitly."
            : `telemetry.ts matched network pattern(s): [${networkHits.join(", ")}]. Telemetry must stay local-only.`,
    });
    const stats = {
        allowlistSize: exports.EXPECTED_TOOL_ALLOWLIST.length,
        toolCount: input.toolNames.length,
        missing,
        extra,
        hostileInputs: hostilePaths.length,
        hostileRejected: hostilePaths.length - notRejected.length,
        gateOwned: [...state_fields_1.GATE_OWNED],
        telemetryNetworkHits: networkHits,
    };
    return { assertions, diagnostics, stats };
}
