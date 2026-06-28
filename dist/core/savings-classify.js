"use strict";
/**
 * Savings workload classification (Savings UI — Phase B2).
 *
 * Pure, deterministic, clock-free. Two entry points:
 *
 *  - {@link classify} runs at WRITE time inside `hook.ts`, where the raw Bash
 *    command string is in scope. Only the resulting 8-value category label is
 *    persisted onto the telemetry record — the command text is NEVER stored
 *    (privacy by construction). Rules 5 and 6-bash require the command and are
 *    therefore only computable here.
 *
 *  - {@link resolveCategory} runs at READ time inside the savings calc. New
 *    records already carry an 8-value category; legacy records (suppress /
 *    observe / planning / absent) are mapped from their persisted fields. Rules
 *    that key on persisted fields (3 mcp tool_type, 6 source_kind=search, 7
 *    reduction_kind=lossy) stay reproducible; bash-command rules degrade to the
 *    safe fallback. Returns `undefined` when nothing is known ⇒ `[incomplete]`.
 *
 * Classification contract (spec §Categories, top-down, FIRST MATCH WINS):
 *   1. op=rehydrate / full_rehydration            → rehydration
 *   2. compaction / epoch-reset record            → compaction
 *   3. tool_type startswith "mcp__"               → mcp-result
 *   4. Read/Grep/Glob on a file or range          → file-read
 *   5. Bash matching (vitest|jest|pytest|go test
 *      |cargo test|npm t(est)?)                   → test-output
 *   6. Bash/search matching git|rg|grep|find|ls
 *      |tree, or source_kind=search               → repo-analysis
 *   7. agent/explore summary, or reduction_kind
 *      =lossy summary page                        → artifact-summary
 *   8. everything else                            → debug-output
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELEMETRY_WORKLOAD_CATEGORIES = void 0;
exports.classify = classify;
exports.resolveCategory = resolveCategory;
/** The 8 categories in declaration order (= breakdown render order). */
exports.TELEMETRY_WORKLOAD_CATEGORIES = [
    "file-read",
    "artifact-summary",
    "repo-analysis",
    "test-output",
    "debug-output",
    "mcp-result",
    "rehydration",
    "compaction",
];
const CATEGORY_SET = new Set(exports.TELEMETRY_WORKLOAD_CATEGORIES);
const FILE_READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const TEST_CMD = /\b(vitest|jest|pytest|go\s+test|cargo\s+test|npm\s+t(est)?\b)/i;
const REPO_CMD = /\b(git|rg|grep|find|ls|tree)\b/i;
/**
 * Classify a workload into one of the 8 savings categories. Top-down,
 * first-match-wins. Pure and deterministic.
 */
function classify(input) {
    // 1. rehydration
    if (input.op === "rehydrate" || input.full_rehydration === true) {
        return "rehydration";
    }
    // 2. compaction
    if (input.compaction === true) {
        return "compaction";
    }
    // 3. mcp-result
    if (typeof input.tool_type === "string" && input.tool_type.startsWith("mcp__")) {
        return "mcp-result";
    }
    // 4. file-read — Read/Grep/Glob tool, or a file/range source.
    if ((input.tool_type !== undefined && FILE_READ_TOOLS.has(input.tool_type)) ||
        input.source_kind === "file" ||
        input.source_kind === "range" ||
        input.source_kind === "symbol") {
        return "file-read";
    }
    // 5. test-output — Bash command running a test runner.
    if (input.command !== undefined && TEST_CMD.test(input.command)) {
        return "test-output";
    }
    // 6. repo-analysis — Bash/search command, or a search source.
    if ((input.command !== undefined && REPO_CMD.test(input.command)) ||
        input.source_kind === "search") {
        return "repo-analysis";
    }
    // 7. artifact-summary — agent/explore summary or disclosed lossy reduction.
    if (input.is_summary === true || input.reduction_kind === "lossy") {
        return "artifact-summary";
    }
    // 8. debug-output — everything else (other Bash, stderr/error traces).
    return "debug-output";
}
const LEGACY_TOOL_DERIVED = new Set(["suppress", "observe"]);
/**
 * Read-time category resolution for a persisted record.
 *
 *  - Already an 8-value category  → returned as-is.
 *  - "planning"                   → debug-output.
 *  - "suppress" / "observe"       → re-derived from persisted fields (these are
 *                                   real savings events, NOT debug-output).
 *  - anything else / absent       → re-derived from persisted fields; if still
 *                                   undeterminable, returns `undefined` so the
 *                                   caller can render `[incomplete]`.
 *
 * The raw Bash command is unavailable at read time, so command-only rules (5,
 * 6-bash) cannot fire here; records relying on them fall through to the
 * persisted-field signals or `undefined`.
 */
function resolveCategory(rec) {
    const wc = rec.workload_category;
    if (typeof wc === "string" && CATEGORY_SET.has(wc)) {
        return wc;
    }
    if (wc === "planning") {
        return "debug-output";
    }
    // Derive from persisted fields (no command available at read time).
    const derived = classify({
        full_rehydration: (rec.full_rehydrations ?? 0) > 0 ? undefined : undefined, // never infer rehydration from a counter
        tool_type: rec.tool_type,
        source_kind: rec.source_kind,
        reduction_kind: rec.reduction_kind,
    });
    // `classify` always returns a value (defaulting to debug-output). For legacy
    // suppress/observe we trust that derivation. For an unknown/absent label with
    // no usable signal, prefer `[incomplete]` over a misleading debug-output.
    if (typeof wc === "string" && LEGACY_TOOL_DERIVED.has(wc)) {
        return derived;
    }
    const hasSignal = rec.tool_type !== undefined ||
        rec.source_kind !== undefined ||
        rec.reduction_kind === "lossy";
    return hasSignal ? derived : undefined;
}
