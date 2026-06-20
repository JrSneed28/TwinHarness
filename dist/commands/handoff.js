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
exports.handoffPath = handoffPath;
exports.runHandoffWrite = runHandoffWrite;
exports.runHandoffVerify = runHandoffVerify;
exports.runResume = runResume;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const atomic_io_1 = require("../core/atomic-io");
const log_1 = require("../core/log");
const hash_1 = require("../core/hash");
const next_1 = require("./next");
const context_1 = require("./context");
/**
 * `th handoff write` / `th handoff verify` / `th resume` (Track A-2).
 *
 * When a session approaches its context budget (`th budget check` → verdict
 * "over"), the Orchestrator can pause, write a HANDOFF.md, and STOP. A fresh
 * session then re-enters via `th resume`, which detects the handoff and prints the
 * next mechanical action — trusting the artifact Summary blocks captured here
 * rather than re-reading `docs/`.
 *
 * The handoff currency is the §9 Summary blocks (assembled by reusing
 * `th context pack`), the `th next` recommended action, and a machine-readable
 * state snapshot used by `th handoff verify` to confirm a clean resume.
 */
/** The handoff file lives in the state dir alongside state.json. */
function handoffPath(paths) {
    return path.join(paths.stateDir, "HANDOFF.md");
}
/** Sentinels bracketing the machine-readable state snapshot in HANDOFF.md. */
const HANDOFF_STATE_OPEN = "<!-- TH-HANDOFF-STATE";
const HANDOFF_STATE_CLOSE = "TH-HANDOFF-STATE -->";
const DO_NOT_REREAD_DIRECTIVE = "**Directive: do NOT re-read `docs/`. Trust the artifact Summary blocks below.** " +
    "They are the §9 handoff currency; re-reading the full corpus is exactly the context " +
    "bloat this handoff exists to avoid. Read a full doc only if a Summary is insufficient for the next action.";
/**
 * `th handoff write` — assemble `.twinharness/HANDOFF.md` from durable state, the
 * recommended next action, the approved-artifact Summary blocks, the open
 * questions, and an explicit "don't re-read docs/" directive. Returns the path and
 * the sections produced.
 */
function runHandoffWrite(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists) {
        return (0, output_1.failure)({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
    }
    if (!r.state) {
        return (0, output_1.failure)({ human: "state.json is invalid; fix it before writing a handoff.", data: { error: "invalid_state", issues: r.issues } });
    }
    const s = r.state;
    // The recommended next action (reuse the next-action oracle).
    const next = (0, next_1.runNext)(paths);
    const nextAction = next.data?.action ?? "(no mechanical obligation outstanding)";
    const nextKind = next.data?.kind ?? "unknown";
    // Artifact Summary blocks (reuse `th context pack`; never duplicate the assembly).
    const pack = (0, context_1.runContextPack)(paths);
    const packHuman = pack.ok && pack.human ? pack.human : "(context pack unavailable)";
    const slices = s.slices.map((sl) => ({ id: sl.id, status: sl.status }));
    const openQuestions = s.open_questions;
    const snapshot = {
        current_stage: s.current_stage,
        slices,
        approved_artifacts: s.approved_artifacts.map((a) => ({ file: a.file, version: a.version, hash: a.hash })),
    };
    const sliceLines = slices.length
        ? slices.map((sl) => `- ${sl.id} — ${sl.status}`)
        : ["- (no slices yet)"];
    const oqLines = openQuestions.length
        ? openQuestions.map((q) => `- ${q}`)
        : ["- (none)"];
    const md = [
        "# TwinHarness HANDOFF",
        "",
        "A fresh session is resuming this run. Re-enter with `th resume`.",
        "",
        DO_NOT_REREAD_DIRECTIVE,
        "",
        "## Run state",
        "",
        `- current_stage: **${s.current_stage}**`,
        `- tier: ${s.tier ?? "(unclassified)"}`,
        `- implementation_allowed: ${s.implementation_allowed}`,
        `- approved artifacts: ${s.approved_artifacts.length}`,
        "",
        "## Slices",
        "",
        ...sliceLines,
        "",
        "## Next action (`th next`)",
        "",
        `- kind: \`${nextKind}\``,
        `- ${nextAction}`,
        "",
        "## Open questions",
        "",
        ...oqLines,
        "",
        "## Artifact Summary blocks (handoff currency — §9)",
        "",
        packHuman,
        "",
        "<!-- Machine-readable resume snapshot; consumed by `th handoff verify`. Do not edit by hand. -->",
        HANDOFF_STATE_OPEN,
        JSON.stringify(snapshot),
        HANDOFF_STATE_CLOSE,
        "",
    ].join("\n");
    fs.mkdirSync(paths.stateDir, { recursive: true });
    // Atomic write (temp + rename) — same durability guarantee as state.json /
    // interview.json, so a crash mid-write never leaves a corrupt HANDOFF.md.
    (0, atomic_io_1.atomicWriteFile)(handoffPath(paths), md, { root: paths.root });
    const relPath = path.relative(paths.root, handoffPath(paths)).split(path.sep).join("/");
    (0, log_1.structuredLog)({ cmd: "handoff write", path: relPath, slices: slices.length, artifacts: s.approved_artifacts.length });
    return (0, output_1.success)({
        data: {
            path: relPath,
            current_stage: s.current_stage,
            slices,
            nextAction,
            nextKind,
            openQuestions,
            artifacts: snapshot.approved_artifacts,
            sections: ["Run state", "Slices", "Next action", "Open questions", "Artifact Summary blocks"],
        },
        human: [
            `Wrote ${relPath} (${slices.length} slice(s), ${s.approved_artifacts.length} artifact summary block(s)).`,
            `Next action: ${nextAction}`,
            "Resume a fresh session with `th resume`.",
        ].join("\n"),
    });
}
/** Extract the machine-readable snapshot embedded in HANDOFF.md, or null. */
function parseSnapshot(md) {
    const start = md.indexOf(HANDOFF_STATE_OPEN);
    const end = md.indexOf(HANDOFF_STATE_CLOSE);
    if (start < 0 || end < 0 || end <= start)
        return null;
    const json = md.slice(start + HANDOFF_STATE_OPEN.length, end).trim();
    try {
        const parsed = JSON.parse(json);
        if (typeof parsed !== "object" || parsed === null)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * `th handoff verify` — confirm a resumed run matches its HANDOFF: the
 * current_stage is unchanged, the recorded slices still carry the recorded
 * statuses, and every approved artifact's on-disk content still hashes to the
 * recorded value (reuse `hashPathContent`). Returns pass/fail with the specific
 * mismatches.
 */
function runHandoffVerify(paths) {
    const file = handoffPath(paths);
    if (!fs.existsSync(file)) {
        return (0, output_1.failure)({ human: "No HANDOFF.md found — nothing to verify.", data: { error: "no_handoff", pass: false } });
    }
    const md = fs.readFileSync(file, "utf8");
    const snapshot = parseSnapshot(md);
    if (!snapshot) {
        return (0, output_1.failure)({ human: "HANDOFF.md has no readable machine snapshot — cannot verify.", data: { error: "unparseable_handoff", pass: false } });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return (0, output_1.failure)({ human: "No state.json found.", data: { error: "not_initialized", pass: false } });
    if (!r.state)
        return (0, output_1.failure)({ human: "state.json is invalid.", data: { error: "invalid_state", pass: false, issues: r.issues } });
    const s = r.state;
    const mismatches = [];
    if (s.current_stage !== snapshot.current_stage) {
        mismatches.push(`current_stage: HANDOFF "${snapshot.current_stage}" ≠ state "${s.current_stage}"`);
    }
    // Each recorded slice must still exist with the recorded status.
    for (const recorded of snapshot.slices) {
        const live = s.slices.find((sl) => sl.id === recorded.id);
        if (!live) {
            mismatches.push(`slice ${recorded.id}: in HANDOFF but missing from state`);
        }
        else if (live.status !== recorded.status) {
            mismatches.push(`slice ${recorded.id}: HANDOFF "${recorded.status}" ≠ state "${live.status}"`);
        }
    }
    // Each recorded approved-artifact hash must still match the file on disk.
    for (const recorded of snapshot.approved_artifacts) {
        const abs = path.resolve(paths.root, recorded.file);
        if (!fs.existsSync(abs)) {
            mismatches.push(`artifact ${recorded.file}: recorded but missing on disk`);
            continue;
        }
        let live;
        try {
            // approved_artifacts stores the SHORT (12-char) hash (see artifact register
            // → shortHashPath); compare in the same form.
            live = (0, hash_1.shortHashPath)(abs);
        }
        catch (e) {
            mismatches.push(`artifact ${recorded.file}: could not hash (${e.message})`);
            continue;
        }
        if (live !== recorded.hash) {
            mismatches.push(`artifact ${recorded.file}: content changed since handoff (hash mismatch)`);
        }
    }
    const pass = mismatches.length === 0;
    (0, log_1.structuredLog)({ cmd: "handoff verify", pass, mismatches: mismatches.length });
    if (!pass) {
        return (0, output_1.failure)({
            data: { pass: false, mismatches },
            human: ["Handoff verify FAILED — resume does not match HANDOFF:", ...mismatches.map((m) => `  - ${m}`)].join("\n"),
        });
    }
    return (0, output_1.success)({
        data: { pass: true, current_stage: s.current_stage, slices: snapshot.slices.length, artifacts: snapshot.approved_artifacts.length },
        human: `Handoff verify PASSED — current_stage, slices, and approved-artifact hashes all match HANDOFF.`,
    });
}
/**
 * `th resume` — detect `.twinharness/HANDOFF.md` and print the next mechanical
 * action (reusing `th next`). When a handoff is present the output notes it (and
 * suggests `th handoff verify`); when absent, resume still works — it just reports
 * the next action from durable state.
 */
function runResume(paths) {
    const file = handoffPath(paths);
    const hasHandoff = fs.existsSync(file);
    const relPath = path.relative(paths.root, file).split(path.sep).join("/");
    const next = (0, next_1.runNext)(paths);
    const nextAction = next.data?.action ?? "(no mechanical obligation outstanding)";
    (0, log_1.structuredLog)({ cmd: "resume", hasHandoff });
    const human = [
        hasHandoff
            ? `Resuming from ${relPath}. Run \`th handoff verify\` to confirm the snapshot, then proceed.`
            : "No HANDOFF.md found — resuming from durable state.",
        `next: ${nextAction}`,
    ].join("\n");
    return (0, output_1.success)({
        data: {
            hasHandoff,
            handoffPath: hasHandoff ? relPath : null,
            nextAction,
            nextKind: next.data?.kind ?? null,
        },
        human,
    });
}
