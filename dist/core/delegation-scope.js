"use strict";
/**
 * SG3 P1-B (C-11) + R-36 (finding F7) — the DURABLE per-delegation allowed-files scope.
 *
 * `th delegate pack --allowed-files <list>` computes the explicit write scope a
 * delegated agent may touch, but the PreToolUse write-gate runs in a SEPARATE process
 * (the installed hook `node dist/cli.js hook pretool-gate`) and Claude Code's PreToolUse
 * stdin payload carries NO `allowed_files`. So a scope returned only in the pack's
 * result can never reach the gate — enforcement stays inactive (audit P1). This module
 * is the missing seam: the CLI ARMS the scope here on `th delegate pack`, the gate READS
 * it from here on every write, and it is CLEARED when the delegated subagent stops.
 *
 * R-36 / F7 — PER-DELEGATION-ID scopes with TTL recovery (was: a SINGLETON file).
 * The singleton was fail-broken under overlap: two concurrent delegations clobbered
 * each other's scope (last pack won), and ANY SubagentStop lifted the one shared file —
 * dropping a still-running peer's scope (fail-OPEN). The fix gives each delegation its
 * OWN scope file keyed by a minted `delegationId`:
 *
 *   - `th delegate pack --allowed-files a,b` → mints an id, writes `<id>.json` with a TTL.
 *   - The gate enforces the UNION of all ACTIVE (non-expired) scopes. With a per-payload
 *     `delegation_id` it can enforce that delegation's OWN scope precisely; without one it
 *     fails TIGHTER to the union of all active scopes (see runHookPretoolGate's XOR).
 *   - SubagentStop clears ONLY the stopping delegation's id (a peer's scope survives).
 *   - TTL + lazy GC: a CRASHED delegate's scope self-expires, so a crash can't wedge the
 *     gate forever; the next read garbage-collects expired files.
 *
 * Lifecycle:
 *   - `th delegate pack --allowed-files a,b`  → arms `<id>.json` (TTL-stamped).
 *   - `th delegate pack` (no scope)           → no scope file written.
 *   - SubagentStop (with that id)             → removes `<id>.json` (the delegate finished).
 *   - TTL expiry                              → lazily GC'd on the next read.
 *
 * KNOWN LIMITATION (Tier 1, documented not hidden): a session-level id alone cannot tell
 * the orchestrator's OWN non-delegated write apart from a sibling delegation's write in
 * the SAME session. So with >=1 active sibling delegation and no per-delegation id on the
 * payload, a legitimate non-delegated orchestrator write is constrained to the union — a
 * LOUD, recoverable false-block, bounded by the delegation's TTL, escapable via the
 * existing `TH_DISABLE_WRITE_GATE` hatch. Read-path TTL GC does NOT fix it (the sibling
 * scope is ACTIVE, not expired). Only Tier 2 (a host-supplied stable per-subagent id on
 * the hook payload) eliminates it.
 *
 * The scopes live under the state dir (`.twinharness/delegation-scopes/<id>.json`),
 * written through the governed-write chokepoint. Reads are tolerant: an absent/empty/
 * corrupt file yields an empty scope (a no-op for the gate), never throws.
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
exports.DEFAULT_DELEGATION_TTL_MS = void 0;
exports.delegationScopesDir = delegationScopesDir;
exports.legacyDelegationScopePath = legacyDelegationScopePath;
exports.delegationTtlMs = delegationTtlMs;
exports.sanitizeDelegationId = sanitizeDelegationId;
exports.mintDelegationId = mintDelegationId;
exports.delegationScopeFile = delegationScopeFile;
exports.readActiveDelegationScopes = readActiveDelegationScopes;
exports.writeDelegationScope = writeDelegationScope;
exports.clearDelegationScope = clearDelegationScope;
exports.clearAllDelegationScopes = clearAllDelegationScopes;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomic_io_1 = require("./atomic-io");
/** `<stateDir>/delegation-scopes` — the directory of per-delegation-id scope files. */
function delegationScopesDir(paths) {
    return path.join(paths.stateDir, "delegation-scopes");
}
/**
 * Legacy SINGLETON scope path (pre-R-36): `<stateDir>/delegation-scope.json`. Still READ
 * (folded into the active union as one un-expiring scope) so an in-flight upgrade never
 * silently drops an armed scope; never WRITTEN by the new code. Cleared by a global clear.
 */
function legacyDelegationScopePath(paths) {
    return path.join(paths.stateDir, "delegation-scope.json");
}
/**
 * Default delegation scope TTL (ms): how long an armed per-delegation scope stays ACTIVE
 * before it self-expires and is GC'd. Bounded so a CRASHED delegate (whose SubagentStop
 * never fires) cannot wedge the gate forever, yet long enough for a real delegate turn.
 * `TH_DELEGATION_TTL_MS` overrides it (mirrors `TH_LOCK_TIMEOUT_MS`); a non-numeric /
 * non-positive value falls back to the default.
 */
exports.DEFAULT_DELEGATION_TTL_MS = 60 * 60 * 1000; // 60 min
function delegationTtlMs() {
    const raw = process.env.TH_DELEGATION_TTL_MS;
    if (raw === undefined)
        return exports.DEFAULT_DELEGATION_TTL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : exports.DEFAULT_DELEGATION_TTL_MS;
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
 * Sanitize a delegation id into a safe single filesystem component. Keeps the id readable
 * (alnum / `-` / `_` survive) while neutralizing any path-traversal or separator so a scope
 * file can never escape `delegationScopesDir`. An id that sanitizes to empty is rejected by
 * the caller (returns "" here so callers can guard).
 */
function sanitizeDelegationId(id) {
    return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
}
/** Mint a fresh, collision-resistant delegation id (timestamp + random suffix). */
function mintDelegationId() {
    return `DEL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** `<delegationScopesDir>/<sanitized-id>.json` for a delegation id (null if id is unusable). */
function delegationScopeFile(paths, id) {
    const safe = sanitizeDelegationId(id);
    if (safe.length === 0)
        return null;
    return path.join(delegationScopesDir(paths), `${safe}.json`);
}
/** Parse one scope file's bytes into a DelegationScope, or null if absent/empty/corrupt. */
function parseScopeFile(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        return null;
    }
    if (raw.trim() === "")
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const p = parsed;
    const allowedFiles = Array.isArray(p.allowedFiles)
        ? dedupeTrim(p.allowedFiles.filter((x) => typeof x === "string"))
        : [];
    return {
        allowedFiles,
        delegationId: typeof p.delegationId === "string" ? p.delegationId : undefined,
        packedAt: typeof p.packedAt === "string" ? p.packedAt : undefined,
        expiresAt: typeof p.expiresAt === "string" ? p.expiresAt : undefined,
        agent: typeof p.agent === "string" ? p.agent : undefined,
        slice: typeof p.slice === "string" ? p.slice : undefined,
    };
}
/** True iff `scope.expiresAt` is set AND already in the past (relative to `now`). */
function isExpired(scope, now) {
    if (!scope.expiresAt)
        return false; // no TTL (legacy singleton) → never expires by time.
    const t = Date.parse(scope.expiresAt);
    return Number.isFinite(t) && t <= now;
}
/**
 * Read all ACTIVE per-delegation scopes, lazily GARBAGE-COLLECTING expired ones (TTL
 * recovery: a crashed delegate's scope self-expires and is removed here). Folds in the
 * legacy singleton scope (if present) as one un-expiring active scope so an in-flight
 * upgrade never drops an armed scope. Tolerant: a missing dir / unreadable / corrupt file
 * is skipped, never throws. Returns the active records (for per-id enforcement) plus the
 * convenience UNION of their allowed-files (for no-id union enforcement).
 */
function readActiveDelegationScopes(paths, now = Date.now()) {
    const active = [];
    const unionSeen = new Set();
    const union = [];
    const addUnion = (files) => {
        for (const f of files) {
            if (!unionSeen.has(f)) {
                unionSeen.add(f);
                union.push(f);
            }
        }
    };
    const dir = delegationScopesDir(paths);
    let entries = [];
    try {
        entries = fs.readdirSync(dir).filter((e) => e.endsWith(".json"));
    }
    catch {
        entries = []; // dir absent → no per-id scopes (the legacy fold below may still add one).
    }
    for (const entry of entries) {
        const file = path.join(dir, entry);
        const scope = parseScopeFile(file);
        if (scope === null) {
            // Unreadable/corrupt scope file → GC it (it can never enforce anything) and move on.
            try {
                fs.rmSync(file, { force: true });
            }
            catch {
                /* best-effort */
            }
            continue;
        }
        if (isExpired(scope, now)) {
            // TTL recovery: a crashed/abandoned delegation's scope self-expires → remove it so a
            // crash cannot wedge the gate forever.
            try {
                fs.rmSync(file, { force: true });
            }
            catch {
                /* best-effort */
            }
            continue;
        }
        const id = scope.delegationId ?? entry.replace(/\.json$/, "");
        if (scope.allowedFiles.length === 0)
            continue; // empty scope is a no-op for the gate.
        active.push({ delegationId: id, allowedFiles: scope.allowedFiles, file });
        addUnion(scope.allowedFiles);
    }
    // Legacy singleton fold (pre-R-36): treat a present `delegation-scope.json` as one
    // active scope with no TTL, so an upgrade mid-delegation never drops its scope.
    const legacy = parseScopeFile(legacyDelegationScopePath(paths));
    if (legacy && legacy.allowedFiles.length > 0 && !isExpired(legacy, now)) {
        active.push({
            delegationId: legacy.delegationId ?? "legacy-singleton",
            allowedFiles: legacy.allowedFiles,
            file: legacyDelegationScopePath(paths),
        });
        addUnion(legacy.allowedFiles);
    }
    return { active, union };
}
/**
 * Arm a per-delegation scope for `delegationId` when `allowedFiles` is non-empty (write
 * `<id>.json` through the governed chokepoint, TTL-stamped). An EMPTY list clears that id's
 * scope (so a re-pack with no scope lifts a prior one). Returns the normalized list
 * persisted (empty ⇒ cleared). A blank/unusable id is a no-op (returns []).
 */
function writeDelegationScope(paths, delegationId, allowedFiles, meta = {}) {
    const file = delegationScopeFile(paths, delegationId);
    if (file === null)
        return []; // unusable id → cannot arm.
    const list = dedupeTrim(allowedFiles);
    if (list.length === 0) {
        clearDelegationScope(paths, delegationId);
        return [];
    }
    const now = Date.now();
    const ttl = meta.ttlMs && meta.ttlMs > 0 ? meta.ttlMs : delegationTtlMs();
    const scope = {
        delegationId: sanitizeDelegationId(delegationId),
        allowedFiles: list,
        packedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttl).toISOString(),
        ...(meta.agent ? { agent: meta.agent } : {}),
        ...(meta.slice ? { slice: meta.slice } : {}),
    };
    (0, atomic_io_1.atomicWriteFile)(file, JSON.stringify(scope, null, 2) + "\n", { root: paths.root });
    return list;
}
/**
 * Best-effort disarm of ONE delegation's scope (the delegation ended). Removes only
 * `<id>.json` so an unrelated SubagentStop never clears a peer's scope (R-36). Never throws.
 */
function clearDelegationScope(paths, delegationId) {
    const file = delegationScopeFile(paths, delegationId);
    if (file === null)
        return;
    try {
        fs.rmSync(file, { force: true });
    }
    catch {
        /* best-effort — a missing/locked scope file must never break the hook. */
    }
}
/**
 * Best-effort disarm of ALL delegation scopes (and the legacy singleton). Used by recovery
 * / test teardown — NOT by the per-delegation SubagentStop path (which clears one id). Never
 * throws.
 */
function clearAllDelegationScopes(paths) {
    try {
        fs.rmSync(delegationScopesDir(paths), { recursive: true, force: true });
    }
    catch {
        /* best-effort */
    }
    try {
        fs.rmSync(legacyDelegationScopePath(paths), { force: true });
    }
    catch {
        /* best-effort */
    }
}
