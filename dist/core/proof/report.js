"use strict";
/**
 * Component 9 (dual-format report) — plan Step 9 / AC #4 / AC #8.
 *
 * {@link emitReport} consolidates a {@link ProofReport} into THREE artifacts under
 * `<outputRoot>/<ISO-ts>/` AND copies them to `<outputRoot>/latest/`:
 *   - `report.json`  — the whole report, machine-readable.
 *   - `report.jsonl` — one object per line (summary, each card, the matrix, each
 *                      regression delta, each diagnostic) for streaming consumers.
 *   - `report.md`    — the human report: run summary + a section per component card
 *                      + the coverage-matrix table + regression deltas + diagnostics.
 *
 * {@link renderMarkdown} and {@link toJsonl} are exported pure renderers so the dual
 * format is unit-testable without touching disk. Report artifacts live in the REPO
 * (`<repoRoot>/.twinharness/proof/`, via {@link defaultOutputRoot}) — NOT in a
 * scenario sandbox. This module performs file IO only inside `outputRoot`.
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
exports.defaultOutputRoot = defaultOutputRoot;
exports.toJsonl = toJsonl;
exports.renderMarkdown = renderMarkdown;
exports.emitReport = emitReport;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
const types_1 = require("./types");
/**
 * The default report output root: `<repoRoot>/.twinharness/proof` (root-contained
 * via {@link resolveWithinRoot}). The report lives in the repo, never in a scenario
 * sandbox (which is a disposable OS temp root).
 */
function defaultOutputRoot(repoRoot) {
    const dir = (0, paths_1.resolveWithinRoot)(repoRoot, path.join(".twinharness", "proof"));
    if (dir === null) {
        // A constant in-root relative path cannot escape; this guards a hostile repoRoot.
        throw new Error(`proof output root escapes repo root: ${repoRoot}`);
    }
    return dir;
}
/** A filesystem-safe timestamp directory name (Windows forbids `:` in paths). */
function timestampDir(iso) {
    const stamp = (iso && iso.length > 0 ? iso : new Date().toISOString()).replace(/:/g, "-");
    return stamp;
}
/**
 * Render the report as JSONL — one self-describing object per line, in the order
 * summary → cards → matrix → regressions → diagnostics. Each line carries a `kind`
 * discriminator and is independently `JSON.parse`-able (AC #4).
 */
function toJsonl(report) {
    const lines = [];
    lines.push(JSON.stringify({ kind: "summary", ...report.summary }));
    for (const card of report.cards)
        lines.push(JSON.stringify({ kind: "card", ...card }));
    lines.push(JSON.stringify({ kind: "matrix", ...report.matrix }));
    for (const r of report.regressions)
        lines.push(JSON.stringify({ kind: "regression", ...r }));
    for (const d of report.diagnostics)
        lines.push(JSON.stringify({ kind: "diagnostic", ...d }));
    return lines.join("\n") + "\n";
}
/** One coverage-matrix table row. */
function dimensionRow(label, dim) {
    const status = dim.untouched.length === 0 ? "✓ complete" : `✗ ${dim.untouched.length} untouched`;
    const untouched = dim.untouched.length ? dim.untouched.join(", ") : "—";
    return `| ${label} | ${dim.count} | ${dim.touched.length} | ${untouched} | ${status} |`;
}
/**
 * Render the human markdown report: run summary, a `##` section PER component card
 * (verdict + assertion tally + per-card diagnostics), the coverage-matrix table,
 * regression deltas, and the consolidated diagnostics list (AC #4 / AC #8).
 */
function renderMarkdown(report) {
    const { summary, cards, matrix, regressions, diagnostics } = report;
    const out = [];
    out.push("# TwinHarness Operational Proof Report");
    out.push("");
    out.push(`- **Run:** ${summary.id}`);
    out.push(`- **Verdict:** ${summary.verdict.toUpperCase()}`);
    out.push(`- **Started:** ${summary.startedAt}`);
    out.push(`- **Finished:** ${summary.finishedAt}`);
    out.push(`- **Briefs:** ${summary.briefIds.length ? summary.briefIds.join(", ") : "—"}`);
    out.push(`- **Components run:** ${summary.componentsRun.join(", ")}`);
    if (summary.tokenCost !== undefined && summary.tokenCost !== null) {
        out.push(`- **Token cost:** ${summary.tokenCost}`);
    }
    out.push("");
    // Per-component cards — one section each (AC #3 / AC #4).
    out.push("## Component cards");
    out.push("");
    for (const card of cards) {
        const n = types_1.PROOF_COMPONENT_NUMBERS[card.component];
        const passed = card.assertions.filter((a) => a.pass).length;
        out.push(`### ${n}. ${card.component} — ${card.verdict.toUpperCase()}`);
        out.push("");
        out.push(`- assertions: ${passed}/${card.assertions.length} passed`);
        for (const a of card.assertions) {
            out.push(`  - ${a.pass ? "✓" : "✗"} ${a.name}`);
        }
        if (card.diagnostics.length) {
            out.push(`- diagnostics:`);
            for (const d of card.diagnostics)
                out.push(`  - [${d.severity}] ${d.location} — ${d.hint}`);
        }
        out.push("");
    }
    // Coverage matrix table (AC #5).
    out.push("## Coverage matrix");
    out.push("");
    out.push(`Overall: ${matrix.complete ? "✓ COMPLETE" : "✗ INCOMPLETE — a feature went unexercised"}`);
    out.push("");
    out.push("| dimension | count | touched | untouched | status |");
    out.push("| --- | --- | --- | --- | --- |");
    out.push(dimensionRow("subsystems", matrix.subsystems));
    out.push(dimensionRow("mcpTools", matrix.mcpTools));
    out.push(dimensionRow("gates", matrix.gates));
    out.push("");
    // Regression deltas (AC #7).
    out.push("## Regression deltas");
    out.push("");
    if (regressions.length === 0) {
        out.push("_No baseline deltas computed._");
    }
    else {
        out.push("| metric | baseline | current | deltaPct | gating | regressed |");
        out.push("| --- | --- | --- | --- | --- | --- |");
        for (const r of regressions) {
            out.push(`| ${r.metric} | ${r.baseline.toFixed(3)} | ${r.current.toFixed(3)} | ${r.deltaPct.toFixed(1)}% | ${r.gating} | ${r.regressed ? "✗ YES" : "no"} |`);
        }
    }
    out.push("");
    // Consolidated diagnostics (AC #8) — a line per finding.
    out.push("## Diagnostics");
    out.push("");
    if (diagnostics.length === 0) {
        out.push("_No diagnostics — clean run._");
    }
    else {
        for (const d of diagnostics) {
            out.push(`- [${d.severity}] (${d.component}) ${d.location} — ${d.hint}`);
        }
    }
    out.push("");
    return out.join("\n");
}
/**
 * Write the dual-format report under `<outputRoot>/<ISO-ts>/` and copy it to
 * `<outputRoot>/latest/`. Returns the timestamped artifact paths (AC #4).
 */
function emitReport(report, opts) {
    const dir = path.join(opts.outputRoot, timestampDir(report.summary.finishedAt));
    const latest = path.join(opts.outputRoot, "latest");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(latest, { recursive: true });
    const artifacts = [
        { file: "report.json", content: JSON.stringify(report, null, 2) + "\n" },
        { file: "report.jsonl", content: toJsonl(report) },
        { file: "report.md", content: renderMarkdown(report) },
    ];
    for (const { file, content } of artifacts) {
        fs.writeFileSync(path.join(dir, file), content, "utf8");
        fs.writeFileSync(path.join(latest, file), content, "utf8");
    }
    return {
        dir,
        jsonPath: path.join(dir, "report.json"),
        jsonlPath: path.join(dir, "report.jsonl"),
        mdPath: path.join(dir, "report.md"),
    };
}
