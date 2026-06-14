"use strict";
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
exports.runContextEstimate = runContextEstimate;
exports.runContextPack = runContextPack;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const summary_1 = require("../core/summary");
const log_1 = require("../core/log");
const repo_1 = require("./repo");
// Anchor: REQ-RU-061
// Anchor: REQ-RU-095
// Anchor: REQ-RU-063
/**
 * `th context estimate` — approximate the context/token cost of the plugin's
 * prompt surface (Phase 3; the Goose/Windsurf "no token visibility" gap, and
 * the lever for audit F7). Heuristic only: ~4 chars per token. Flags prompt
 * files that exceed Claude Code's guidance (SKILL/agent bodies < ~500 lines;
 * invoked skills are re-attached keeping only the first ~5,000 tokens after
 * compaction, so a body past that can lose its tail on long runs).
 *
 * Read-only; resolves files relative to the plugin root, not the user's project.
 */
const TOKENS_PER_CHAR = 1 / 4;
const LINE_WARN = 500;
const TOKEN_WARN = 5000;
/** Plugin root from the compiled location (dist/commands → root). */
function pluginRoot() {
    return path.resolve(__dirname, "..", "..");
}
function listMd(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return [];
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory())
                walk(p);
            else if (e.isFile() && e.name.endsWith(".md"))
                out.push(p);
        }
    };
    walk(dir);
    return out;
}
function estimate(root, abs) {
    const content = fs.readFileSync(abs, "utf8");
    const lines = content.split(/\r?\n/).length;
    const tokens = Math.round(content.length * TOKENS_PER_CHAR);
    return {
        file: path.relative(root, abs).split(path.sep).join("/"),
        lines,
        tokens,
        flag: lines > LINE_WARN || tokens > TOKEN_WARN,
    };
}
/**
 * `th context estimate` — report per-file and total approximate token cost of
 * the orchestration prompt surface (skill + reference files + agents + commands).
 */
function runContextEstimate() {
    const root = pluginRoot();
    const files = [
        ...listMd(path.join(root, "skills")),
        ...listMd(path.join(root, "agents")),
        ...listMd(path.join(root, "commands")),
    ]
        .map((abs) => estimate(root, abs))
        .sort((a, b) => b.tokens - a.tokens);
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    const flagged = files.filter((f) => f.flag);
    const rows = files.map((f) => `${f.flag ? "!" : " "} ${String(f.tokens).padStart(6)} tok  ${String(f.lines).padStart(4)} ln  ${f.file}`);
    const human = [
        "Approximate prompt-surface context cost (~4 chars/token):",
        ...rows,
        "",
        `Total: ~${totalTokens} tokens across ${files.length} prompt files.`,
        flagged.length
            ? `${flagged.length} file(s) exceed the guidance (>${LINE_WARN} lines or >${TOKEN_WARN} tokens): ${flagged.map((f) => f.file).join(", ")}`
            : `All prompt files are within the ${LINE_WARN}-line / ${TOKEN_WARN}-token guidance.`,
    ].join("\n");
    return (0, output_1.success)({
        data: { files, totalTokens, flagged: flagged.map((f) => f.file), lineWarn: LINE_WARN, tokenWarn: TOKEN_WARN },
        human,
    });
}
/**
 * `th context pack [--slice <SLICE-ID>]` — mechanically assemble the §9 handoff
 * bundle: the Summary block of every approved artifact (the handoff currency),
 * plus, when `--slice` is given, that slice's record, its components, and the
 * other slices that share those components (conflict awareness for §16).
 *
 * It COMPUTES a candidate bundle from durable state + artifact summaries; it does
 * NOT decide what to route — the Orchestrator still owns that call. Read-only.
 */
function runContextPack(paths, opts = {}) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return (0, output_1.failure)({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
    if (!r.state)
        return (0, output_1.failure)({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });
    const s = r.state;
    const packed = s.approved_artifacts.map((a) => {
        const abs = path.resolve(paths.root, a.file);
        let exists = false;
        let isDir = false;
        let content = "";
        if (fs.existsSync(abs)) {
            const stat = fs.statSync(abs);
            if (stat.isFile()) {
                exists = true;
                content = fs.readFileSync(abs, "utf8");
            }
            else if (stat.isDirectory()) {
                // Directory artifacts (e.g. docs/05-adrs/) have no single Summary block.
                exists = true;
                isDir = true;
            }
        }
        const { summary, head } = (0, summary_1.extractSummary)(content);
        const text = isDir ? `(directory artifact — read ${a.file}/ on demand)` : summary ?? head;
        return { file: a.file, version: a.version, summary, text, tokens: Math.round(text.length / 4), exists, isDir };
    });
    // Slice-specific framing.
    let sliceBlock;
    if (opts.slice) {
        const target = s.slices.find((sl) => sl.id === opts.slice);
        if (!target) {
            return (0, output_1.failure)({
                human: `Unknown slice: ${opts.slice}. Known: ${s.slices.map((sl) => sl.id).join(", ") || "(none)"}`,
                data: { error: "unknown_slice", slice: opts.slice },
            });
        }
        const components = new Set(target.components);
        const sharesWith = s.slices
            .filter((sl) => sl.id !== target.id)
            .map((sl) => ({ id: sl.id, shared: sl.components.filter((c) => components.has(c)) }))
            .filter((x) => x.shared.length > 0);
        sliceBlock = { id: target.id, status: target.status, components: target.components, sharesWith };
    }
    // REQ-RU-061 / REQ-RU-095: when --slice is given, augment the bundle with
    // repo-relevant files/tests sourced from the persisted repo-map (READ-ONLY —
    // no re-scan; uses runRepoRelevant which reads .twinharness/repo-map.json).
    // If the map is missing or malformed, we include an informational note but do
    // NOT fail the overall pack (the §9 bundle is still usable).
    let repoRelevantFiles = [];
    let repoRelevantNote = null;
    if (opts.slice && sliceBlock) {
        const relResult = (0, repo_1.runRepoRelevant)(paths, { slice: opts.slice });
        if (relResult.ok && relResult.data) {
            const d = relResult.data;
            for (const item of d.readFirst ?? [])
                repoRelevantFiles.push({ ...item, kind: "readFirst" });
            for (const item of d.related ?? [])
                repoRelevantFiles.push({ ...item, kind: "related" });
            for (const item of d.tests ?? [])
                repoRelevantFiles.push({ ...item, kind: "tests" });
        }
        else if (!relResult.ok) {
            // Map missing / not initialized: surface as a note, do NOT fail the pack.
            repoRelevantNote = `(repo-relevant layer unavailable: ${relResult.data?.error ?? "unknown error"} — run \`th repo map\` first)`;
        }
    }
    const totalTokens = packed.reduce((sum, p) => sum + p.tokens, 0);
    (0, log_1.structuredLog)({ cmd: "context pack", slice: opts.slice ?? null, artifacts: packed.length, tokens: totalTokens, repoRelevantFiles: repoRelevantFiles.length });
    const header = opts.slice
        ? `Context pack for ${opts.slice} — ${packed.length} artifact summary block(s), ~${totalTokens} tokens`
        : `Context pack — ${packed.length} artifact summary block(s), ~${totalTokens} tokens`;
    const sliceLines = sliceBlock
        ? [
            "",
            `Slice ${sliceBlock.id} [${sliceBlock.status}] — components: ${sliceBlock.components.join(", ") || "(none)"}`,
            sliceBlock.sharesWith.length
                ? `  Shares components with (serialize per §16): ${sliceBlock.sharesWith.map((x) => `${x.id} (${x.shared.join(", ")})`).join("; ")}`
                : "  No component overlap with other slices (safe to parallelize).",
        ]
        : [];
    // REQ-RU-061: repo-relevant section in human text.
    const repoRelevantLines = [];
    if (opts.slice) {
        repoRelevantLines.push("");
        if (repoRelevantNote) {
            repoRelevantLines.push(`Repo-relevant files: ${repoRelevantNote}`);
        }
        else if (repoRelevantFiles.length === 0) {
            repoRelevantLines.push("Repo-relevant files: (none matched — repo-map may be empty for this slice)");
        }
        else {
            repoRelevantLines.push(`Repo-relevant files (${repoRelevantFiles.length} from repo-understanding layer):`);
            for (const f of repoRelevantFiles) {
                repoRelevantLines.push(`  [${f.kind}] ${f.path}  — ${f.why}`);
            }
        }
    }
    const artifactLines = packed.length === 0
        ? ["", "(no approved artifacts yet — nothing to pack)"]
        : packed.flatMap((p) => [
            "",
            `### ${p.file} (v${p.version})${p.exists ? "" : " — MISSING ON DISK"}${p.summary === null && p.exists && !p.isDir ? " — no Summary block (head shown)" : ""}`,
            p.text || "(empty)",
        ]);
    const human = [header, ...sliceLines, ...repoRelevantLines, ...artifactLines].join("\n");
    return (0, output_1.success)({
        data: {
            slice: sliceBlock ?? null,
            artifacts: packed,
            totalTokens,
            // REQ-RU-061: repo-relevant data included in structured response.
            repoRelevantFiles,
            repoRelevantNote: repoRelevantNote ?? null,
        },
        human,
    });
}
