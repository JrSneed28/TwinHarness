"use strict";
/**
 * SG3 P1-B (C-11) — the DURABLE delegate allowed-files scope.
 *
 * `th delegate pack --allowed-files <list>` computes the explicit write scope a
 * delegated agent may touch, but the PreToolUse write-gate runs in a SEPARATE process
 * (the installed hook `node dist/cli.js hook pretool-gate`) and Claude Code's PreToolUse
 * stdin payload carries NO `allowed_files`. So a scope returned only in the pack's
 * result can never reach the gate — enforcement stays inactive (audit P1). This module
 * is the missing seam: the CLI ARMS the scope here on `th delegate pack`, the gate READS
 * it from here on every write, and it is CLEARED when the delegated subagent stops.
 *
 * Lifecycle (single active delegation at a time):
 *   - `th delegate pack --allowed-files a,b`  → arms the scope (writes the file).
 *   - `th delegate pack` (no scope)           → disarms (removes the file).
 *   - SubagentStop hook                       → disarms (the delegate finished).
 * The latest pack defines the active scope. KNOWN LIMITATION: parallel delegations share
 * one scope file, so the last pack wins and the first subagent-stop lifts it — fail-OPEN
 * for the still-running peers (never a false block), and the orchestrator should arm the
 * scope immediately before spawning the delegate to keep the window tight.
 *
 * The file lives under the state dir (`.twinharness/delegation-scope.json`), written
 * through the governed-write chokepoint. Reads are tolerant: an absent/empty/corrupt
 * file yields an empty scope (a no-op for the gate), never throws.
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
exports.delegationScopePath = delegationScopePath;
exports.readDelegationScope = readDelegationScope;
exports.writeDelegationScope = writeDelegationScope;
exports.clearDelegationScope = clearDelegationScope;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomic_io_1 = require("./atomic-io");
/** `<stateDir>/delegation-scope.json` — the persisted delegate allowed-files scope. */
function delegationScopePath(paths) {
    return path.join(paths.stateDir, "delegation-scope.json");
}
/** Trim, drop empties, dedupe, preserve insertion order. */
function dedupeTrim(list) {
    const seen = new Set();
    const out = [];
    for (const f of list) {
        const t = f.trim();
        if (t.length > 0 && !seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out;
}
/**
 * Read the persisted scope. Absent / empty / unreadable / malformed ⇒
 * `{ allowedFiles: [] }` — a NO-OP for the gate (the gate only enforces a non-empty
 * set), so a damaged scope file never wedges every write. Never throws.
 */
function readDelegationScope(paths) {
    const file = delegationScopePath(paths);
    if (!fs.existsSync(file))
        return { allowedFiles: [] };
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        return { allowedFiles: [] };
    }
    if (raw.trim() === "")
        return { allowedFiles: [] };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { allowedFiles: [] };
    }
    if (typeof parsed !== "object" || parsed === null)
        return { allowedFiles: [] };
    const p = parsed;
    const allowedFiles = Array.isArray(p.allowedFiles)
        ? dedupeTrim(p.allowedFiles.filter((x) => typeof x === "string"))
        : [];
    return {
        allowedFiles,
        packedAt: typeof p.packedAt === "string" ? p.packedAt : undefined,
        agent: typeof p.agent === "string" ? p.agent : undefined,
        slice: typeof p.slice === "string" ? p.slice : undefined,
    };
}
/**
 * Arm the delegate scope when `allowedFiles` is non-empty (write the file through the
 * governed chokepoint); DISARM (remove the file) when it is empty — so a plain
 * `th delegate pack` with no scope lifts a previously-armed one. Returns the normalized
 * list that was persisted (empty ⇒ cleared).
 */
function writeDelegationScope(paths, allowedFiles, meta = {}) {
    const list = dedupeTrim(allowedFiles);
    if (list.length === 0) {
        clearDelegationScope(paths);
        return [];
    }
    const scope = {
        allowedFiles: list,
        packedAt: new Date().toISOString(),
        ...(meta.agent ? { agent: meta.agent } : {}),
        ...(meta.slice ? { slice: meta.slice } : {}),
    };
    (0, atomic_io_1.atomicWriteFile)(delegationScopePath(paths), JSON.stringify(scope, null, 2) + "\n", { root: paths.root });
    return list;
}
/** Best-effort disarm (the delegation ended). Never throws. */
function clearDelegationScope(paths) {
    try {
        fs.rmSync(delegationScopePath(paths), { force: true });
    }
    catch {
        /* best-effort — a missing/locked scope file must never break the hook. */
    }
}
