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
exports.runArtifactRegister = runArtifactRegister;
exports.runArtifactList = runArtifactList;
exports.runArtifactSection = runArtifactSection;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const hash_1 = require("../core/hash");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
const summary_1 = require("../core/summary");
/**
 * `th artifact` — content-hash and record an approved, versioned artifact
 * (spec §12: "each artifact is versioned with a content hash referenced by
 * state.json"; §18 `approved_artifacts`).
 *
 * Mechanical only (plan §3 boundary rule): the CLI computes a deterministic
 * content hash and records the version it is told. It never decides *whether* an
 * artifact is approved — the caller supplies the version when it approves.
 */
/** Normalize a root-relative path to forward slashes for cross-platform stable storage. */
function toRelKey(root, file) {
    const abs = path.resolve(root, file);
    return path.relative(root, abs).split(path.sep).join("/");
}
/**
 * `th artifact register <path> --version <n>` — compute the content hash of a
 * file OR directory (relative to the project root) and upsert it into
 * `approved_artifacts`. Directories (e.g. the T3 ADR set `docs/05-adrs/`) are
 * hashed deterministically over their contents (§15.S; stage contract
 * `produces: docs/05-adrs/`). Re-registering the same path REPLACES its entry
 * (version bump, no duplicate).
 */
function runArtifactRegister(paths, file, version) {
    return (0, state_store_1.withStateLock)(paths, () => runArtifactRegisterLocked(paths, file, version));
}
function runArtifactRegisterLocked(paths, file, version) {
    if (!file)
        return (0, output_1.failure)({ human: "usage: th artifact register <file> --version <n>" });
    if (version === undefined || !Number.isInteger(version) || version < 1) {
        return (0, output_1.failure)({ human: "usage: th artifact register <file> --version <n>" });
    }
    const abs = (0, paths_1.resolveWithinRoot)(paths.root, file);
    if (abs === null) {
        return (0, output_1.failure)({ human: `Path outside project root: ${file}`, data: { error: "path_outside_root", file } });
    }
    if (!fs.existsSync(abs)) {
        return (0, output_1.failure)({ human: `File not found: ${file}`, data: { error: "file_not_found", file } });
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile() && !stat.isDirectory()) {
        return (0, output_1.failure)({ human: `Not a file or directory: ${file}`, data: { error: "not_a_file_or_dir", file } });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `Existing state.json is invalid; fix it before registering:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    let hash;
    try {
        hash = (0, hash_1.shortHashPath)(abs);
    }
    catch (e) {
        if (e instanceof hash_1.HashLimitError) {
            return (0, output_1.failure)({
                human: `Cannot register ${file}: ${e.message}`,
                data: { error: "artifact_too_large", file },
            });
        }
        throw e;
    }
    const relKey = toRelKey(paths.root, file);
    // P4-7 — validate the Summary block at register time to bound head-fallback bloat.
    // `th context pack` routes the artifact's `## Summary` block as the handoff currency;
    // when it is ABSENT the pack falls back to the file HEAD. For a markdown artifact
    // missing a Summary block we surface a non-blocking warning so the author adds a tight
    // Summary rather than letting the pack inject the document head. Never blocks
    // registration (registration is a mechanical hash record); directories have no single
    // Summary block and are exempt.
    let summaryWarning = null;
    if (stat.isFile() && /\.(md|markdown)$/i.test(relKey)) {
        try {
            const { summary } = (0, summary_1.extractSummary)(fs.readFileSync(abs, "utf8"));
            if (summary === null) {
                summaryWarning = `no \`## Summary\` block — \`th context pack\` will fall back to the file head; add a Summary block to keep the handoff tight.`;
            }
        }
        catch {
            /* unreadable as text — leave unvalidated (best-effort). */
        }
    }
    const entry = { file: relKey, version, hash };
    const next = { ...r.state, approved_artifacts: [...r.state.approved_artifacts] };
    const idx = next.approved_artifacts.findIndex((a) => a.file === relKey);
    if (idx >= 0)
        next.approved_artifacts[idx] = entry;
    else
        next.approved_artifacts.push(entry);
    (0, state_store_1.writeState)(paths, next);
    (0, log_1.structuredLog)({ cmd: "artifact register", file: relKey, version, hash, summaryWarning: summaryWarning !== null });
    return (0, output_1.success)({
        data: { file: relKey, version, hash, summaryWarning },
        human: summaryWarning
            ? `registered ${relKey} v${version} (${hash})\n  ⚠ ${summaryWarning}`
            : `registered ${relKey} v${version} (${hash})`,
    });
}
/** `th artifact list` — list every recorded approved artifact. */
function runArtifactList(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const artifacts = r.state.approved_artifacts;
    const human = artifacts.length
        ? artifacts.map((a) => `${a.file}  v${a.version}  ${a.hash}`).join("\n")
        : "(none)";
    return (0, output_1.success)({ data: { artifacts }, human });
}
// ---------------------------------------------------------------------------
// `th artifact section` (SG3 P1-B / C-12) — bounded named-heading extraction
// ---------------------------------------------------------------------------
/**
 * Token estimator: ~4 chars per token (mirrors `context.ts` TOKENS_PER_CHAR and the
 * §9 pack budget heuristic). The single estimation point so the budget math here and
 * in `th context pack` / `th context read` agree.
 */
function estimateTokens(text) {
    return Math.round(text.length / 4);
}
/**
 * `th artifact section --file <p> --section <h> [--max-tokens N]` (C-12) — extract the
 * BODY of a named heading from a markdown artifact under an optional token budget, with
 * a content-hash RECEIPT of the FULL extracted section. This closes the "no bounded
 * section read" gap: an agent can pull JUST `## External Dependencies` (or any heading)
 * without reading — or paying the token cost of — the whole document.
 *
 * Determinism: the section is the first heading whose text equals `--section`
 * (case-insensitive); its body runs to the next same-or-higher-level heading
 * (`extractSection`). When `--max-tokens` is set and the body exceeds it, the body is
 * truncated to the budget by KEEPING A LINE PREFIX (deterministic — never a random
 * slice), and `truncated:true` is reported. The receipt always hashes the FULL section
 * body (the evidence of what was extracted), regardless of truncation. Read-only.
 *
 * Follows Critical Pattern 1: named `runArtifactSection`, `paths` first, typed opts
 * second; returns `success()`/`failure()` (never throws / exits); one structuredLog.
 */
function runArtifactSection(paths, opts = {}) {
    if (!opts.file) {
        (0, log_1.structuredLog)({ cmd: "artifact section", error: "no_file" });
        return (0, output_1.failure)({ human: "usage: th artifact section --file <path> --section <heading> [--max-tokens N]", data: { error: "no_file" } });
    }
    if (!opts.section) {
        (0, log_1.structuredLog)({ cmd: "artifact section", error: "no_section" });
        return (0, output_1.failure)({ human: "usage: th artifact section --file <path> --section <heading> [--max-tokens N]", data: { error: "no_section" } });
    }
    const abs = (0, paths_1.resolveWithinRoot)(paths.root, opts.file);
    if (abs === null) {
        (0, log_1.structuredLog)({ cmd: "artifact section", error: "path_outside_root", file: opts.file });
        return (0, output_1.failure)({ human: `Path outside project root: ${opts.file}`, data: { error: "path_outside_root", file: opts.file } });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        (0, log_1.structuredLog)({ cmd: "artifact section", error: "file_not_found", file: opts.file });
        return (0, output_1.failure)({ human: `File not found: ${opts.file}`, data: { error: "file_not_found", file: opts.file } });
    }
    const relKey = toRelKey(paths.root, opts.file);
    let content;
    try {
        content = fs.readFileSync(abs, "utf8");
    }
    catch {
        (0, log_1.structuredLog)({ cmd: "artifact section", error: "read_failed", file: relKey });
        return (0, output_1.failure)({ human: `Could not read ${relKey}`, data: { error: "read_failed", file: relKey } });
    }
    const extracted = (0, summary_1.extractSection)(content, opts.section);
    if (!extracted.found) {
        (0, log_1.structuredLog)({ cmd: "artifact section", error: "section_not_found", file: relKey, section: opts.section });
        return (0, output_1.failure)({
            human: `No \`${opts.section}\` heading in ${relKey}.`,
            data: { error: "section_not_found", file: relKey, section: opts.section },
        });
    }
    const fullBody = extracted.body;
    const fullTokens = estimateTokens(fullBody);
    // Token budget: when set (>0), truncate the body to fit by keeping a deterministic
    // LINE PREFIX. The receipt always hashes the FULL body (the evidence of what the
    // section is), so a downstream consumer can detect a later edit even if it only saw
    // the truncated head.
    const budget = typeof opts.maxTokens === "number" && opts.maxTokens > 0 ? opts.maxTokens : null;
    let bodyOut = fullBody;
    let truncated = false;
    if (budget !== null && fullTokens > budget) {
        const lines = fullBody.split("\n");
        const kept = [];
        let running = 0;
        for (const line of lines) {
            const cost = estimateTokens(line + "\n");
            if (running + cost > budget)
                break;
            kept.push(line);
            running += cost;
        }
        bodyOut = kept.join("\n");
        truncated = true;
    }
    const receipt = { file: relKey, hash: (0, hash_1.hashContent)(fullBody), tokensConsumed: estimateTokens(bodyOut) };
    (0, log_1.structuredLog)({
        cmd: "artifact section",
        file: relKey,
        section: opts.section,
        fullTokens,
        returnedTokens: receipt.tokensConsumed,
        truncated,
    });
    const human = [
        extracted.heading ?? `## ${opts.section}`,
        "",
        bodyOut || "(empty section)",
        "",
        truncated
            ? `(truncated to --max-tokens=${budget}; full section ~${fullTokens} tokens, hash ${receipt.hash.slice(0, 12)})`
            : `(~${fullTokens} tokens, hash ${receipt.hash.slice(0, 12)})`,
    ].join("\n");
    return (0, output_1.success)({
        receipts: [receipt],
        data: {
            file: relKey,
            section: opts.section,
            heading: extracted.heading,
            body: bodyOut,
            fullTokens,
            returnedTokens: receipt.tokensConsumed,
            truncated,
            maxTokens: budget,
            receipts: [receipt],
        },
        human,
    });
}
