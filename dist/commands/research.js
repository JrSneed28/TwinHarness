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
exports.sanitizeTopic = sanitizeTopic;
exports.runResearchWrite = runResearchWrite;
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const atomic_io_1 = require("../core/atomic-io");
const hash_1 = require("../core/hash");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
const artifact_1 = require("./artifact");
/**
 * `th research write` (SG3 P2-A, resolves C-01) — the governed output path for the
 * Researcher agent, which is read/web-only (`Write`/`Edit`/`Bash` disallowed) and so
 * cannot author its own `docs/00-research/<topic>.md` artifact.
 *
 * Boundary rule (plan §3): the write target is HARD-PINNED in this handler to
 * `docs/00-research/<topic>.md`. `<topic>` is sanitized to a single flat slug, and any
 * path that does not match the pinned shape is refused HERE — BEFORE the governed-write
 * chokepoint (`assertGovernedWriteSurface`, reached via `atomicWriteFile`). The
 * chokepoint stays UNMODIFIED (its first-segment allow-set already admits `docs`); this
 * handler pins the exact sub-path so the producer→file binding is explicit and SG4 can
 * generalize it rather than retrofit it.
 *
 * After the write succeeds the artifact is auto-registered by calling the existing
 * `runArtifactRegister` CORE function in-process (NOT by shelling out to another verb —
 * the parity rule forbids verb-calls-verb). A read/write receipt `{file, hash}` is
 * returned so a downstream gate can verify what was actually persisted.
 */
/** Reserved Windows device names that can never be a topic slug (defense-in-depth). */
const WINDOWS_RESERVED = new Set([
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
/**
 * Validate `<topic>` and reduce it to a single flat slug. The slug becomes the file
 * STEM under `docs/00-research/`, so it must contain NO path syntax at all: no slashes
 * (`/` or `\`), no `..`, no absolute/drive/UNC prefix, no leading dot. We accept only
 * `[A-Za-z0-9._-]` and forbid a leading `.` (so `.`/`..`/dotfiles can't slip through),
 * a trailing `.md` is tolerated and stripped (callers may pass `auth-options` OR
 * `auth-options.md`). Returns the bare stem (no extension) or an error reason.
 */
function sanitizeTopic(topic) {
    const raw = topic.trim();
    if (raw === "")
        return { error: "empty topic" };
    // Reject any path syntax outright — a topic is a flat name, never a path.
    if (raw.includes("/") || raw.includes("\\"))
        return { error: "topic must not contain a path separator" };
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw))
        return { error: "topic must not be an absolute or drive path" };
    if (raw.includes(".."))
        return { error: "topic must not contain `..`" };
    // Strip a redundant trailing extension so `auth-options.md` and `auth-options` agree.
    const stem = raw.replace(/\.(md|markdown)$/i, "");
    if (stem === "")
        return { error: "empty topic" };
    if (stem.startsWith("."))
        return { error: "topic must not start with `.`" };
    if (!/^[A-Za-z0-9._-]+$/.test(stem)) {
        return { error: "topic may contain only letters, digits, `.`, `_`, `-`" };
    }
    if (WINDOWS_RESERVED.has(stem.toLowerCase()))
        return { error: "topic is a reserved name" };
    return { stem };
}
/** The pinned sub-directory every research artifact lives under (root-relative). */
const RESEARCH_DIR = "docs/00-research";
function runResearchWrite(paths, opts) {
    const topic = opts.topic;
    const markdown = opts.markdown;
    if (topic === undefined || topic === "") {
        return (0, output_1.failure)({ human: "usage: th research write --topic <t> --markdown <content>", data: { error: "missing_topic" } });
    }
    if (markdown === undefined) {
        return (0, output_1.failure)({ human: "usage: th research write --topic <t> --markdown <content>", data: { error: "missing_markdown" } });
    }
    // Sanitize + pin BEFORE touching the governed-write chokepoint. A bad topic is
    // refused here, never reaching `assertGovernedWriteSurface`.
    const sanitized = sanitizeTopic(topic);
    if ("error" in sanitized) {
        return (0, output_1.failure)({ human: `Refusing research write: ${sanitized.error}: ${topic}`, data: { error: "invalid_topic", reason: sanitized.error, topic } });
    }
    // The ONLY shape this handler will ever write: docs/00-research/<stem>.md.
    const relTarget = `${RESEARCH_DIR}/${sanitized.stem}.md`;
    const absTarget = path.resolve(paths.root, relTarget);
    // Belt-and-braces: re-derive the relative target from the resolved absolute path and
    // assert it is EXACTLY the pin. This catches any platform-specific normalization that
    // could let a crafted stem escape `docs/00-research/` even after the slug checks.
    const reRel = path.relative(paths.root, absTarget).split(path.sep).join("/");
    if (reRel !== relTarget) {
        return (0, output_1.failure)({ human: `Refusing research write outside ${RESEARCH_DIR}/: ${reRel}`, data: { error: "path_not_pinned", expected: relTarget, got: reRel } });
    }
    // Require an initialized run (matches the artifact-register guard) so the auto-register
    // step below has a valid state.json; gives a clean NOT_INIT instead of a write+fail.
    const st = (0, guards_1.requireState)(paths);
    if (st.result)
        return st.result;
    // Audit P1: this governed writer writes the file directly and THEN auto-registers, so
    // it bypasses the PreToolUse R-14 approved-artifact clobber guard. Consult the shared
    // guard BEFORE writing — refuse to silently overwrite (or downgrade the registered
    // version of) an already-approved research doc. A deliberate re-author passes an
    // explicit `--version` greater than the registered one.
    const guard = (0, artifact_1.guardApprovedArtifactReauthor)(st.state.approved_artifacts, relTarget, opts.version, `research write ${relTarget}`);
    if (!guard.ok)
        return guard.result;
    const version = guard.version;
    // Write through the UNMODIFIED governed-write chokepoint. `atomicWriteFile` calls
    // `assertGovernedWriteSurface(root, absTarget)` when a root is threaded; `docs` is an
    // admitted first segment, so the pinned target passes.
    (0, atomic_io_1.atomicWriteFile)(absTarget, markdown, { root: paths.root });
    // Provenance receipt: content hash of what we just persisted (same short-hash form
    // `th artifact register` records, so the receipt and the registered hash agree).
    const hash = (0, hash_1.shortHashPath)(absTarget);
    // Auto-register the artifact IN-PROCESS via the core function (no verb-calls-verb) at
    // the guard-approved version (first write ⇒ v1, or an explicit higher re-author bump).
    const reg = (0, artifact_1.runArtifactRegister)(paths, relTarget, version);
    if (!reg.ok) {
        // The file is written but registration failed — surface it rather than reporting
        // success. Carry the register failure payload so the caller sees the real cause.
        return (0, output_1.failure)({
            human: `Wrote ${relTarget} but failed to register it: ${reg.human ?? "register failed"}`,
            data: { error: "register_failed", file: relTarget, hash, register: reg.data },
        });
    }
    (0, log_1.structuredLog)({ cmd: "research write", file: relTarget, hash, version });
    return (0, output_1.success)({
        data: { file: relTarget, hash, registered: true, version },
        human: `wrote ${relTarget} (${hash}) and registered it v${version}`,
        receipts: [{ file: relTarget, hash }],
    });
}
