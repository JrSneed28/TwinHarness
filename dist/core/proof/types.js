"use strict";
/**
 * TwinHarness Operational Proof Suite — the versioned domain contract.
 *
 * THE single source of truth for every shared type the `src/core/proof/*`
 * subsystem and `src/commands/proof.ts` use. It is PURE TYPES + CONSTS only: it
 * performs no IO, opens no socket, and imports NOTHING at runtime (every import
 * below is `import type`, fully erased by tsc/esbuild). That keeps `types.ts`
 * importable from any layer with ZERO bundle impact — the harvest contract can be
 * shared by the deterministic engine, the CLI commands, and the (later) MCP tools
 * without dragging mcp-server/cli into the dependency graph.
 *
 * Design tie-back: the entities here mirror the deep-interview Ontology (Proof
 * Run/Scenario, Sample Project Brief, Pipeline Run, Statistics Report,
 * Feature-Coverage Matrix, Baseline, Diagnostic, Assertion/Verdict) and the plan
 * §3/§4 architecture. The harvest contract is VERSIONED ({@link HARVEST_VERSION})
 * so a shape change is detectable across the live-producer / deterministic-engine
 * boundary the suite is built around.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROOF_COMPONENT_NUMBERS = exports.PROOF_COMPONENTS = exports.HARVEST_VERSION = void 0;
// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------
/**
 * The harvest-contract version stamped into every {@link ScenarioArtifacts}. Bump
 * this whenever the harvested shape changes so a stale consumer (engine, golden
 * fixture) can detect the drift instead of silently mis-reading a snapshot.
 */
exports.HARVEST_VERSION = 1;
// ---------------------------------------------------------------------------
// Component identity (the nine proof components)
// ---------------------------------------------------------------------------
/**
 * The nine proof components, in spec topology order (1..9). Used as the stable
 * `component` discriminator on {@link Assertion}, {@link Diagnostic}, and
 * {@link ReportCard}, and as the matrix subsystem key.
 */
exports.PROOF_COMPONENTS = [
    "operational", // 1
    "orchestration", // 2
    "stress", // 3
    "performance", // 4
    "dogfood", // 5
    "failure-injection", // 6
    "containment", // 7
    "cross-platform", // 8
    "runner-report", // 9
];
/** Component → its 1-based topology number (for per-component report cards). */
exports.PROOF_COMPONENT_NUMBERS = {
    operational: 1,
    orchestration: 2,
    stress: 3,
    performance: 4,
    dogfood: 5,
    "failure-injection": 6,
    containment: 7,
    "cross-platform": 8,
    "runner-report": 9,
};
