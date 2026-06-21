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
exports.INSPECTOR_ANALYSIS_FILE = void 0;
exports.runInspectorWrite = runInspectorWrite;
const path = __importStar(require("node:path"));
const atomic_io_1 = require("../core/atomic-io");
const hash_1 = require("../core/hash");
const output_1 = require("../core/output");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
const state_store_1 = require("../core/state-store");
const artifact_1 = require("./artifact");
/**
 * `th inspector write` — the Codebase-Inspector agent's single governed write path
 * (SG3 P3-A, D2). The inspector is a READ-ONLY agent (`disallowedTools: Write`); it
 * cannot use the `Write` tool, so it emits its source-anchored brownfield analysis
 * through this verb instead. The verb is a NARROW, fixed-target writer: it produces
 * EXACTLY `docs/00-existing-codebase-analysis.md` (the artifact the agent prompt
 * names) and nothing else — the general `th doc write` consolidation is deferred to
 * SG4.
 *
 * Mechanical only (plan §3 boundary rule): the CLI records the content the caller
 * supplies and content-hashes it. It never decides what the analysis SAYS.
 */
/**
 * The ONE file `th inspector write` is permitted to produce. Hard-pinned in the
 * handler (mirrors `th research write`→`docs/00-research/<topic>.md`): a write aimed
 * at any other path is refused HERE, before the path ever reaches
 * `assertGovernedWriteSurface` — the governed-write chokepoint (`paths.ts`) stays
 * UNMODIFIED (its first-segment `docs` allowance already admits this file). Pinning
 * the producer→file binding in the handler pre-installs the seam SG4 generalizes.
 */
exports.INSPECTOR_ANALYSIS_FILE = "docs/00-existing-codebase-analysis.md";
/**
 * `th inspector write --content <md> [--file docs/00-existing-codebase-analysis.md] [--version <n>]`
 *
 * 1. HARD-PIN the target to {@link INSPECTOR_ANALYSIS_FILE}; refuse any other `--file`
 *    BEFORE the governed-write chokepoint (handler pin — chokepoint untouched).
 * 2. Write the content atomically through the UNMODIFIED `assertGovernedWriteSurface`
 *    chokepoint (threaded via `atomicWriteFile`'s `root` option).
 * 3. Auto-register the artifact by calling the in-process register CORE handler
 *    (`runArtifactRegister`) — never shelling out to another verb.
 * 4. Return a `receipts: [{file, hash}]` payload in `data`.
 */
function runInspectorWrite(paths, opts) {
    const content = opts.content;
    if (content === undefined) {
        return (0, output_1.failure)({
            human: `usage: th inspector write --content <markdown> [--version <n>]\n\nWrites the source-anchored brownfield analysis to ${exports.INSPECTOR_ANALYSIS_FILE} and registers it.`,
            data: { error: "missing_content" },
        });
    }
    // Handler pin (D3): refuse ANY target other than the one fixed analysis file BEFORE
    // touching the governed-write chokepoint. A caller may omit `--file` (the pin is the
    // default) or pass it EXACTLY; anything else is rejected with a stable token.
    if (opts.file !== undefined && normalizeRel(opts.file) !== exports.INSPECTOR_ANALYSIS_FILE) {
        return (0, output_1.failure)({
            human: `th inspector write only writes ${exports.INSPECTOR_ANALYSIS_FILE} — refusing ${opts.file}.`,
            data: { error: "inspector_path_pinned", requested: opts.file, pinned: exports.INSPECTOR_ANALYSIS_FILE },
        });
    }
    // Validate an EXPLICIT version up front (an absent version is resolved by the guard
    // below — first write ⇒ v1, re-author ⇒ caller must bump). A present-but-invalid
    // value is rejected before any state read or write.
    if (opts.version !== undefined && (!Number.isInteger(opts.version) || opts.version < 1)) {
        return (0, output_1.failure)({
            human: "usage: th inspector write --content <markdown> [--version <n>] (version must be a positive integer)",
            data: { error: "invalid_version" },
        });
    }
    // Require an initialized project so the auto-register step has a state.json to upsert
    // into (matches `th artifact register`'s precondition; fail fast before writing).
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `Existing state.json is invalid; fix it before writing the analysis:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    // Audit P1: this governed writer writes directly and THEN auto-registers, bypassing the
    // PreToolUse R-14 approved-artifact clobber guard. Consult the shared guard BEFORE
    // writing — refuse to silently overwrite (or downgrade the registered version of) an
    // already-approved analysis. A deliberate re-author passes an explicit higher --version.
    const guard = (0, artifact_1.guardApprovedArtifactReauthor)(r.state.approved_artifacts, exports.INSPECTOR_ANALYSIS_FILE, opts.version, `inspector write ${exports.INSPECTOR_ANALYSIS_FILE}`);
    if (!guard.ok)
        return guard.result;
    const version = guard.version;
    // Write the pinned file through the UNMODIFIED governed-write chokepoint: threading
    // `root` makes `atomicWriteFile` assert the write-surface allowlist (first segment
    // `docs` is already admitted). `INSPECTOR_ANALYSIS_FILE` is a fixed root-relative
    // literal, so the absolute target is deterministic.
    const abs = path.resolve(paths.root, exports.INSPECTOR_ANALYSIS_FILE);
    (0, atomic_io_1.atomicWriteFile)(abs, content, { root: paths.root });
    // Auto-register the artifact via the in-process register CORE handler (never shells
    // out to another verb — Principle 1). It re-hashes the file from disk and upserts
    // `approved_artifacts` under its own state lock.
    const reg = (0, artifact_1.runArtifactRegister)(paths, exports.INSPECTOR_ANALYSIS_FILE, version);
    if (!reg.ok) {
        // The bytes are on disk but registration failed (e.g. a contended state lock):
        // surface the register failure verbatim so the caller can retry register without
        // re-writing.
        return reg;
    }
    // The receipt hash is the content hash of exactly what we wrote (CRLF-normalized,
    // matching the artifact registry's text-hash convention via `hashContent`/`shortHash`).
    const hash = (0, hash_1.shortHash)(content);
    const receipts = [{ file: exports.INSPECTOR_ANALYSIS_FILE, hash }];
    (0, log_1.structuredLog)({ cmd: "inspector write", file: exports.INSPECTOR_ANALYSIS_FILE, version, hash });
    return (0, output_1.success)({
        data: { file: exports.INSPECTOR_ANALYSIS_FILE, version, hash, receipts },
        human: `wrote ${exports.INSPECTOR_ANALYSIS_FILE} and registered it v${version} (${hash})`,
    });
}
/** Normalize a caller-supplied path to a forward-slash root-relative key for the pin compare. */
function normalizeRel(p) {
    return p.split(path.sep).join("/").replace(/^\.\//, "");
}
