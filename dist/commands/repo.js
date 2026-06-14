"use strict";
/**
 * `th repo map` — scan the governed project and write the dual artifacts
 * `.twinharness/repo-map.json` (machine, IF-004) + `docs/00-repo-map.md`
 * (human, IF-005), or, with `--no-write`, build the map in memory only.
 *
 * This handler follows Critical Pattern 1 EXACTLY (REQ-NFR-003):
 *  - named `runRepoMap`, `paths` first, typed opts second defaulting `{}`;
 *  - returns `success()`/`failure()` — NEVER throws, NEVER `process.exit`;
 *  - calls `structuredLog()` exactly once before return.
 *
 * Trust boundary (REQ-RU-040, RULE-004): the scan records discovered commands as
 * inert strings and never executes anything — there is no `child_process` import
 * anywhere in this layer.
 *
 * Determinism (REQ-NFR-001): the serializer is the single normalization point; a
 * second write-mode run on an unchanged repo is byte-identical.
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
exports.runRepoMap = runRepoMap;
exports.runRepoRelevant = runRepoRelevant;
exports.runRepoImpact = runRepoImpact;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
const scanner_1 = require("../core/repo-map/scanner");
const schema_1 = require("../core/repo-map/schema");
const query_1 = require("../core/repo-map/query");
/** `--format` text-rendering values (distinct from the global `--json` envelope). */
const FORMATS = ["summary", "json", "md"];
/** Relative artifact paths (POSIX) reported in `data.artifacts`. */
const REPO_MAP_JSON_REL = ".twinharness/repo-map.json";
const REPO_MAP_MD_REL = "docs/00-repo-map.md";
/** Atomic write: temp file then rename (the `writeState` idiom — REQ-RU-014). */
function atomicWrite(absFile, content) {
    const dir = path.dirname(absFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${path.basename(absFile)}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, absFile);
}
/**
 * `th repo map [--write|--no-write] [--format <summary|json|md>]` — scan, build
 * the deterministic map, and (in write mode) persist the two artifacts.
 *
 * Anchor: REQ-RU-001 — the `th repo map` command, canonical runRepoMap(paths, opts): CommandResult shape.
 * Anchor: REQ-NFR-002 — zero new runtime deps; this module imports only node builtins + core (no MCP SDK).
 * Anchor: REQ-NFR-005 — dist-sync: this compiled output is committed; `npm run verify` enforces it.
 */
function runRepoMap(paths, opts = {}) {
    const write = opts.write !== false; // default: write (D-CONTRACTS-001).
    const format = (opts.format ?? "summary");
    // Validate --format up front (ERR-008 / REQ-RU-016).
    if (!FORMATS.includes(format)) {
        (0, log_1.structuredLog)({ cmd: "repo map", error: "bad_format", format: opts.format });
        return (0, output_1.failure)({
            human: `invalid --format "${opts.format}". Expected one of: ${FORMATS.join(", ")}.`,
            data: { error: "bad_format", format: opts.format },
        });
    }
    // Scan (best-effort; never throws on repo content — REQ-RU-090).
    const map = (0, scanner_1.scanRepo)(paths.root);
    const json = (0, schema_1.serializeRepoMap)(map);
    const md = (0, schema_1.renderRepoMapMarkdown)(map);
    // Compact summary (NEVER the full map — REQ-NFR-004).
    const counts = {
        languages: map.languages.length,
        packageManagers: map.package_managers.length,
        sourceRoots: map.source_roots.length,
        testRoots: map.test_roots.length,
        docsRoots: map.docs_roots.length,
        components: map.components.length,
        entrypoints: map.entrypoints.length,
        files: map.files.length,
        reqAnchors: map.req_anchors.length,
        candidateCommands: map.candidate_commands.length,
        generatedPaths: map.generated_paths.length,
        blastRadiusSignals: map.blast_radius_signals.length,
    };
    const blastRadiusFlags = [...new Set(map.blast_radius_signals.map((s) => s.flag))].sort();
    let artifacts = [];
    if (write) {
        const jsonAbs = path.join(paths.stateDir, "repo-map.json");
        const mdAbs = path.join(paths.docsDir, "00-repo-map.md");
        try {
            atomicWrite(jsonAbs, json);
        }
        catch {
            (0, log_1.structuredLog)({ cmd: "repo map", error: "write_failed", file: REPO_MAP_JSON_REL });
            return (0, output_1.failure)({ human: `failed to write ${REPO_MAP_JSON_REL}`, data: { error: "write_failed", file: REPO_MAP_JSON_REL } });
        }
        try {
            atomicWrite(mdAbs, md);
        }
        catch {
            (0, log_1.structuredLog)({ cmd: "repo map", error: "write_failed", file: REPO_MAP_MD_REL });
            return (0, output_1.failure)({ human: `failed to write ${REPO_MAP_MD_REL}`, data: { error: "write_failed", file: REPO_MAP_MD_REL } });
        }
        artifacts = [REPO_MAP_JSON_REL, REPO_MAP_MD_REL];
    }
    const data = {
        schemaVersion: map.schema_version,
        wrote: write,
        artifacts,
        counts,
        blastRadiusFlags,
        scanReport: map.scanReport,
    };
    // Text rendering per --format. All views are compact by default (REQ-NFR-004);
    // `md` yields the markdown body; `json` yields the structured data as text.
    let human;
    if (format === "md") {
        human = md;
    }
    else if (format === "json") {
        human = JSON.stringify(data, null, 2);
    }
    else {
        const capLine = map.scanReport.capHit === null
            ? `scanned ${map.scanReport.filesScanned} file(s), skipped ${map.scanReport.filesSkipped}`
            : `PARTIAL scan — cap hit: ${map.scanReport.capHit} (scanned ${map.scanReport.filesScanned})`;
        human = [
            "Repo map:",
            `  languages: ${counts.languages}  package managers: ${counts.packageManagers}`,
            `  roots — source: ${counts.sourceRoots}  test: ${counts.testRoots}  docs: ${counts.docsRoots}`,
            `  components: ${counts.components}  entrypoints: ${counts.entrypoints}  files: ${counts.files}`,
            `  REQ anchors: ${counts.reqAnchors}  candidate commands: ${counts.candidateCommands}  generated dirs: ${counts.generatedPaths}`,
            `  blast-radius flags: ${blastRadiusFlags.length ? blastRadiusFlags.join(", ") : "(none)"}`,
            `  ${capLine}`,
            write ? `wrote ${artifacts.length} artifact(s): ${artifacts.join(", ")}` : "(dry-run — nothing written)",
        ].join("\n");
    }
    (0, log_1.structuredLog)({
        cmd: "repo map",
        wrote: write,
        files: counts.files,
        capHit: map.scanReport.capHit,
        blastRadiusFlags: blastRadiusFlags.length,
    });
    return (0, output_1.success)({ data, human });
}
// ---------------------------------------------------------------------------
// `th repo relevant` (IF-002 / REQ-RU-020..027 / REQ-RU-042 / REQ-RU-043)
// ---------------------------------------------------------------------------
/** Persisted repo-map path (relative to stateDir). */
const REPO_MAP_REL = "repo-map.json";
/** Valid `--format` values for `th repo relevant`. */
const RELEVANT_FORMATS = ["slice", "req", "file", "json"];
/**
 * `th repo relevant` — read the persisted map, run `computeRelevance`, return
 * a compact `RelevanceResult`. Follows Critical Pattern 1 EXACTLY (REQ-NFR-003):
 * - named `runRepoRelevant`, `paths` first, typed opts second defaulting `{}`;
 * - returns `success()`/`failure()` — NEVER throws, NEVER `process.exit`;
 * - calls `structuredLog()` exactly once before return.
 *
 * Handler order (RULE-005/006):
 *   1. path-escape guard FIRST (before ANY read) — REQ-RU-024/042
 *   2. load + parse persisted map (missing/malformed → clean failure) — REQ-RU-025/043
 *   3. selector validation (exactly one) — REQ-RU-020
 *   4. for --slice, read state.slices READ-ONLY — REQ-RU-027
 *   5. computeRelevance — REQ-RU-021/022/023
 *   6. shape result, structuredLog once, return — Critical Pattern 1
 *
 * Read-only with respect to state.json and repo-map.json — no withStateLock,
 * no write (REQ-RU-026).
 *
 * Anchor: REQ-RU-020
 * Anchor: REQ-RU-024
 * Anchor: REQ-RU-025
 * Anchor: REQ-RU-026
 * Anchor: REQ-RU-027
 * Anchor: REQ-RU-042
 * Anchor: REQ-RU-043
 * Anchor: REQ-RU-092
 * Anchor: REQ-RU-093
 */
function runRepoRelevant(paths, opts = {}) {
    // ---- Step 1: path-escape guard FIRST (REQ-RU-024/042) ----
    // Guard runs before ANY filesystem read. If --file escapes root, return
    // immediately with no further I/O.
    if (opts.file !== undefined) {
        const resolved = (0, paths_1.resolveWithinRoot)(paths.root, opts.file);
        if (resolved === null) {
            (0, log_1.structuredLog)({ cmd: "repo relevant", error: "path_outside_root", file: opts.file });
            return (0, output_1.failure)({
                human: `--file "${opts.file}" is outside the project root.`,
                data: { error: "path_outside_root", file: opts.file },
            });
        }
    }
    // ---- Step 2: load + parse persisted map (REQ-RU-025 / REQ-RU-043) ----
    const mapJsonPath = path.join(paths.stateDir, REPO_MAP_REL);
    let rawMap = null;
    try {
        rawMap = fs.readFileSync(mapJsonPath, "utf8");
    }
    catch {
        // Missing file → map_missing.
        rawMap = null;
    }
    const parsed = (0, schema_1.parseRepoMap)(rawMap);
    if (!parsed.ok || !parsed.map) {
        const errorCode = rawMap === null ? "map_missing" : (parsed.error ?? "map_missing");
        const human = errorCode === "map_missing"
            ? "No repo-map.json found. Run `th repo map` first."
            : `repo-map.json is invalid: ${errorCode}. Run \`th repo map\` to regenerate.`;
        (0, log_1.structuredLog)({ cmd: "repo relevant", error: errorCode });
        return (0, output_1.failure)({ human, data: { error: errorCode } });
    }
    const map = parsed.map;
    // ---- Step 3: selector validation — exactly one required (REQ-RU-020) ----
    const selectors = [];
    if (opts.slice !== undefined)
        selectors.push({ kind: "slice", value: opts.slice });
    if (opts.req !== undefined)
        selectors.push({ kind: "req", value: opts.req });
    if (opts.file !== undefined)
        selectors.push({ kind: "file", value: opts.file });
    if (opts.query !== undefined)
        selectors.push({ kind: "query", value: opts.query });
    if (selectors.length === 0) {
        (0, log_1.structuredLog)({ cmd: "repo relevant", error: "no_selector" });
        return (0, output_1.failure)({
            human: "Provide exactly one selector: --slice, --req, --file, or --query.\n\nRun `th help` for usage.",
            data: { error: "no_selector" },
        });
    }
    if (selectors.length > 1) {
        const given = selectors.map((s) => `--${s.kind}`);
        (0, log_1.structuredLog)({ cmd: "repo relevant", error: "multiple_selectors", given });
        return (0, output_1.failure)({
            human: `Only one selector is allowed. Got: ${given.join(", ")}.`,
            data: { error: "multiple_selectors", given },
        });
    }
    const selectorEntry = selectors[0];
    // ---- Step 4: for --slice, resolve components from state READ-ONLY (REQ-RU-027) ----
    // No withStateLock, no write — pure read of state.slices.
    const selector = {
        kind: selectorEntry.kind,
        value: selectorEntry.value,
    };
    if (selectorEntry.kind === "slice") {
        const stateResult = (0, guards_1.requireState)(paths);
        if (stateResult.result) {
            // State missing or invalid — can't resolve slice components.
            (0, log_1.structuredLog)({ cmd: "repo relevant", error: "not_initialized" });
            return stateResult.result;
        }
        const state = stateResult.state;
        const sliceEntry = state.slices.find((s) => s.id === selectorEntry.value);
        if (!sliceEntry) {
            const known = state.slices.map((s) => s.id);
            (0, log_1.structuredLog)({ cmd: "repo relevant", error: "unknown_slice", slice: selectorEntry.value });
            return (0, output_1.failure)({
                human: `Unknown slice: ${selectorEntry.value}. Known: ${known.join(", ") || "(none)"}`,
                data: { error: "unknown_slice", slice: selectorEntry.value, known },
            });
        }
        selector.sliceComponents = sliceEntry.components;
    }
    // ---- Step 5: computeRelevance (pure scorer, zero FS access) ----
    const result = (0, query_1.computeRelevance)(map, selector, { maxResults: opts.maxResults });
    // ---- Step 6: shape result, structuredLog once, return ----
    const data = { ...result };
    const human = formatRelevanceHuman(result, opts.format);
    (0, log_1.structuredLog)({
        cmd: "repo relevant",
        selectorKind: result.selectorKind,
        selectorValue: result.selectorValue,
        readFirst: result.readFirst.length,
        related: result.related.length,
        tests: result.tests.length,
        truncated: result.truncated,
    });
    return (0, output_1.success)({ data, human });
}
/**
 * Format the RelevanceResult for human output (compact, no score in text).
 * IF-010: score appears ONLY in structured data, never in human text.
 * REQ-NFR-004: compact by default.
 */
function formatRelevanceHuman(result, format) {
    // `json` format: the structured payload as text.
    if (format === "json") {
        return JSON.stringify(result, null, 2);
    }
    const lines = [];
    lines.push(`Relevant context for ${result.selectorKind}: ${result.selectorValue}`);
    if (result.readFirst.length > 0) {
        lines.push("\nRead first:");
        for (const item of result.readFirst) {
            // REQ-RU-022: WHY on every item; score NOT in human text (IF-010).
            lines.push(`  ${item.path}  [${item.why}]`);
        }
    }
    if (result.related.length > 0) {
        lines.push("\nRelated:");
        for (const item of result.related) {
            lines.push(`  ${item.path}  [${item.why}]`);
        }
    }
    if (result.tests.length > 0) {
        lines.push("\nLikely tests:");
        for (const item of result.tests) {
            lines.push(`  ${item.path}  [${item.why}]`);
        }
    }
    if (result.owningComponents.length > 0) {
        lines.push(`\nOwning components: ${result.owningComponents.join(", ")}`);
    }
    if (result.doNotTouch.length > 0) {
        lines.push(`\nDo not touch (generated): ${result.doNotTouch.join(", ")}`);
    }
    if (result.risks.length > 0) {
        lines.push("\nRisks:");
        for (const sig of result.risks) {
            lines.push(`  ${sig.flag}: ${sig.matchingPaths.length} match(es)`);
        }
    }
    if (result.verifyCandidates.length > 0) {
        lines.push("\nVerify candidates (suggestions only — never executed):");
        for (const cmd of result.verifyCandidates) {
            lines.push(`  [${cmd.kind}] ${cmd.label}: ${cmd.raw}`);
        }
    }
    if (result.truncated) {
        lines.push("\n(Results truncated by maxResults — use --maxResults to see more.)");
    }
    if (result.readFirst.length === 0 &&
        result.related.length === 0 &&
        result.tests.length === 0) {
        lines.push("\n(No matching files found — selector matches nothing. This is not an error.)");
    }
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// `th repo impact` (IF-003 / REQ-RU-030..034 / REQ-RU-042 / REQ-RU-092)
// ---------------------------------------------------------------------------
/** Valid `--format` values for `th repo impact`. */
const IMPACT_FORMATS = ["file", "json"];
/**
 * `th repo impact` — read the persisted map, run `computeImpact`, return an
 * `ImpactResult`. Follows Critical Pattern 1 EXACTLY (REQ-NFR-003):
 * - named `runRepoImpact`, `paths` first, typed opts second defaulting `{}`;
 * - returns `success()`/`failure()` — NEVER throws, NEVER `process.exit`;
 * - calls `structuredLog()` exactly once before return.
 *
 * Handler order (RULE-005/006):
 *   1. path-escape guard FIRST (before ANY read) — REQ-RU-032/042
 *   2. load + parse persisted map (missing/malformed → clean failure) — REQ-RU-034
 *   3. selector validation (exactly one of --file/--component) — REQ-RU-030
 *   4. computeImpact — REQ-RU-031/022
 *   5. shape result, structuredLog once, return — Critical Pattern 1
 *
 * Read-only with respect to state.json — th repo impact reads NO state at all
 * (REQ-RU-033). Simpler than runRepoRelevant: no requireState call.
 *
 * Anchor: REQ-RU-030
 * Anchor: REQ-RU-031
 * Anchor: REQ-RU-032
 * Anchor: REQ-RU-033
 * Anchor: REQ-RU-034
 * Anchor: REQ-RU-042
 * Anchor: REQ-RU-092
 */
function runRepoImpact(paths, opts = {}) {
    // ---- Step 1: path-escape guard FIRST (REQ-RU-032/042) ----
    // Guard runs before ANY filesystem read. If --file escapes root, return
    // immediately with no further I/O.
    if (opts.file !== undefined) {
        const resolved = (0, paths_1.resolveWithinRoot)(paths.root, opts.file);
        if (resolved === null) {
            (0, log_1.structuredLog)({ cmd: "repo impact", error: "path_outside_root", file: opts.file });
            return (0, output_1.failure)({
                human: `--file "${opts.file}" is outside the project root.`,
                data: { error: "path_outside_root", file: opts.file },
            });
        }
    }
    // Guard also applies to --component when it looks like a path (contains a slash).
    if (opts.component !== undefined && (opts.component.includes("/") || opts.component.includes("\\"))) {
        const resolved = (0, paths_1.resolveWithinRoot)(paths.root, opts.component);
        if (resolved === null) {
            (0, log_1.structuredLog)({ cmd: "repo impact", error: "path_outside_root", component: opts.component });
            return (0, output_1.failure)({
                human: `--component "${opts.component}" is outside the project root.`,
                data: { error: "path_outside_root", component: opts.component },
            });
        }
    }
    // ---- Step 2: load + parse persisted map (REQ-RU-034) ----
    const mapJsonPath = path.join(paths.stateDir, REPO_MAP_REL);
    let rawMap = null;
    try {
        rawMap = fs.readFileSync(mapJsonPath, "utf8");
    }
    catch {
        // Missing file → map_missing.
        rawMap = null;
    }
    const parsed = (0, schema_1.parseRepoMap)(rawMap);
    if (!parsed.ok || !parsed.map) {
        const errorCode = rawMap === null ? "map_missing" : (parsed.error ?? "map_missing");
        const human = errorCode === "map_missing"
            ? "No repo-map.json found. Run `th repo map` first."
            : `repo-map.json is invalid: ${errorCode}. Run \`th repo map\` to regenerate.`;
        (0, log_1.structuredLog)({ cmd: "repo impact", error: errorCode });
        return (0, output_1.failure)({ human, data: { error: errorCode } });
    }
    const map = parsed.map;
    // ---- Step 3: selector validation — exactly one required (REQ-RU-030) ----
    const selectors = [];
    if (opts.file !== undefined)
        selectors.push({ kind: "file", value: opts.file });
    if (opts.component !== undefined)
        selectors.push({ kind: "component", value: opts.component });
    if (selectors.length === 0) {
        (0, log_1.structuredLog)({ cmd: "repo impact", error: "no_selector" });
        return (0, output_1.failure)({
            human: "Provide exactly one selector: --file or --component.\n\nRun `th help` for usage.",
            data: { error: "no_selector" },
        });
    }
    if (selectors.length > 1) {
        const given = selectors.map((s) => `--${s.kind}`);
        (0, log_1.structuredLog)({ cmd: "repo impact", error: "multiple_selectors", given });
        return (0, output_1.failure)({
            human: `Only one selector is allowed. Got: ${given.join(", ")}.`,
            data: { error: "multiple_selectors", given },
        });
    }
    const selectorEntry = selectors[0];
    const selector = {
        kind: selectorEntry.kind,
        value: selectorEntry.value,
    };
    // ---- Step 4: computeImpact (pure scorer, zero FS access) ----
    const result = (0, query_1.computeImpact)(map, selector);
    // ---- Step 5: shape result, structuredLog once, return ----
    const data = { ...result };
    const human = formatImpactHuman(result, opts.format);
    (0, log_1.structuredLog)({
        cmd: "repo impact",
        selectorKind: result.selectorKind,
        selectorValue: result.selectorValue,
        impactedComponents: result.impactedComponents.length,
        relatedTests: result.relatedTests.length,
        riskFlags: result.riskFlags.length,
    });
    return (0, output_1.success)({ data, human });
}
/**
 * Format the ImpactResult for human output (compact).
 */
function formatImpactHuman(result, format) {
    // `json` format: the structured payload as text.
    if (format === "json") {
        return JSON.stringify(result, null, 2);
    }
    const lines = [];
    lines.push(`Impact analysis for ${result.selectorKind}: ${result.selectorValue}`);
    if (result.impactedComponents.length > 0) {
        lines.push("\nImpacted components:");
        for (const item of result.impactedComponents) {
            // REQ-RU-022: WHY on every item.
            lines.push(`  ${item.name}  [${item.why}]`);
        }
    }
    if (result.relatedTests.length > 0) {
        lines.push("\nRelated tests:");
        for (const item of result.relatedTests) {
            lines.push(`  ${item.name}  [${item.why}]`);
        }
    }
    if (result.downstreamFeatures.length > 0) {
        lines.push("\nDownstream features:");
        for (const item of result.downstreamFeatures) {
            lines.push(`  ${item.name}  [${item.why}]`);
        }
    }
    if (result.reqAnchors.length > 0) {
        lines.push(`\nREQ anchors in scope: ${result.reqAnchors.join(", ")}`);
    }
    if (result.artifactStageImplications.length > 0) {
        lines.push("\nArtifact/stage implications:");
        for (const impl of result.artifactStageImplications) {
            lines.push(`  - ${impl}`);
        }
    }
    if (result.riskFlags.length > 0) {
        lines.push("\nRisk flags (blast radius):");
        for (const sig of result.riskFlags) {
            lines.push(`  ${sig.flag}: ${sig.matchingPaths.length} match(es)`);
        }
    }
    if (result.verifyCandidates.length > 0) {
        lines.push("\nVerify candidates (suggestions only — never executed):");
        for (const cmd of result.verifyCandidates) {
            lines.push(`  [${cmd.kind}] ${cmd.label}: ${cmd.raw}`);
        }
    }
    if (result.impactedComponents.length === 0 &&
        result.relatedTests.length === 0 &&
        result.downstreamFeatures.length === 0) {
        lines.push("\n(Selector matches nothing in the map — no impact found. This is not an error.)");
    }
    return lines.join("\n");
}
