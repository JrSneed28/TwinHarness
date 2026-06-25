"use strict";
/**
 * `toToolResult` projection oracle (Axis-B slice-7 / BSC-9).
 *
 * The MCP server is a THIN adapter: every tool closure delegates to the SAME `run*`
 * handler the CLI dispatches to (guarded by `tests/mcp-cli-parity.test.ts`'s REQ-PCO-070
 * thinness check), so there is NO divergent execution path. The ONE authentic CLI↔MCP
 * divergence surface is the PROJECTION — `toToolResult` (`mcp-server.ts`) maps a
 * `CommandResult` onto the MCP `CallToolResult`. A projection that drops/alters `ok`,
 * the numeric `exitCode`, or the `data` payload is a real (and otherwise silent)
 * divergence between what the CLI returns and what an MCP caller observes.
 *
 * This module is the SENSOR for that surface, expressed PURELY in core terms so it can
 * run at gate time WITHOUT importing `mcp-server.ts` (which would invert the core→adapter
 * layering and pull the MCP SDK into core). It pins the projection CONTRACT as a pure
 * reference projector ({@link referenceProjection}) and a fidelity predicate
 * ({@link projectionFidelity}); `mcp-server.ts`'s real `toToolResult` is held to this
 * SAME contract by `tests/mcp-cli-parity.test.ts`, so the two can never drift:
 *   - the parity test asserts `toToolResult(r)` ≡ `referenceProjection(r)` over the
 *     committed twin-call fixture set, so a regression in the real projector is caught;
 *   - the gate rung re-runs the fixtures through `referenceProjection` + the fidelity
 *     predicate, so a fixture whose projection drops/alters ok/exitCode/data BLOCKS.
 *
 * The fidelity contract (mirrors `toToolResult`'s documented mapping, ARCH-005):
 *   - `isError === !result.ok`               (a failing command surfaces as a tool error)
 *   - `structuredContent.exitCode === result.exitCode`  (the FULL CLI exit-code taxonomy,
 *     not just the coarse ok/not-ok boolean — and the envelope's exitCode WINS over any
 *     `data.exitCode`, the reserved-key precedence guard)
 *   - every `result.data` field is present in `structuredContent` (the machine payload is
 *     preserved, never dropped)
 *   - the human text is the `human` rendering, else JSON(data), else OK/FAILED.
 *
 * The fixture set is a FIXED, committed twin-call set (named tools + concrete handler
 * outputs) stored under `.omc/audit/probes/bsc9/`; the gate loads it via
 * {@link loadProjectionFixtures}. A seeded infidelity in a fixture's `projected` is the
 * negative-control the oracle BLOCKS on.
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
exports.referenceProjection = referenceProjection;
exports.projectionFidelity = projectionFidelity;
exports.isValidFixtureSet = isValidFixtureSet;
exports.loadProjectionFixtures = loadProjectionFixtures;
exports.runProjectionOracle = runProjectionOracle;
const fs = __importStar(require("node:fs"));
/**
 * The PURE reference projector — the single source of the projection CONTRACT, in core.
 * Mirrors `mcp-server.toToolResult` EXACTLY (the parity test pins the real projector to
 * this), but returns the SDK-free {@link ProjectedResult} subset. The `text` precedence,
 * the `isError = !ok`, and the `exitCode`-spread-last reserved-key precedence are all
 * reproduced here so the gate-time check is byte-faithful to the runtime projection.
 */
function referenceProjection(result) {
    const text = result.human !== undefined
        ? result.human
        : result.data !== undefined
            ? JSON.stringify(result.data, null, 2)
            : result.ok
                ? "OK"
                : "FAILED";
    return {
        isError: !result.ok,
        text,
        // `exitCode` is spread LAST so the envelope's exitCode deterministically WINS over any
        // `exitCode` nested inside `result.data` (the reserved-key precedence invariant).
        structuredContent: { ...(result.data ?? {}), exitCode: result.exitCode },
    };
}
/**
 * The fidelity predicate: does `projected` faithfully preserve `result`'s `ok` / `exitCode`
 * / `data` / text rendering? Returns the list of infidelities (empty = faithful). The
 * reference is {@link referenceProjection}; `projected` is the value under test (a fixture's
 * recorded projection, or — in the parity test — the real `toToolResult` output).
 */
function projectionFidelity(tool, result, projected) {
    const ref = referenceProjection(result);
    const out = [];
    if (projected.isError !== ref.isError) {
        out.push({ tool, axis: "isError", detail: `expected isError=${ref.isError}, got ${projected.isError}` });
    }
    if (projected.structuredContent?.exitCode !== ref.structuredContent.exitCode) {
        out.push({
            tool,
            axis: "exitCode",
            detail: `expected exitCode=${String(ref.structuredContent.exitCode)}, got ${String(projected.structuredContent?.exitCode)}`,
        });
    }
    // Every reference structuredContent field (the data payload + exitCode) must be present
    // and deep-equal in the projected result — a dropped/altered data field is an infidelity.
    for (const [k, v] of Object.entries(ref.structuredContent)) {
        if (k === "exitCode")
            continue; // checked above
        if (JSON.stringify(projected.structuredContent?.[k]) !== JSON.stringify(v)) {
            out.push({ tool, axis: "data", detail: `data.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(projected.structuredContent?.[k])}` });
        }
    }
    if (projected.text !== ref.text) {
        out.push({ tool, axis: "text", detail: `text rendering diverged` });
    }
    return out;
}
/** Validate a parsed fixture-set; a malformed file yields `null` (the gate treats it fail-closed). */
function isValidFixtureSet(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const fx = parsed.fixtures;
    if (!Array.isArray(fx))
        return false;
    return fx.every((f) => {
        if (typeof f !== "object" || f === null)
            return false;
        const r = f;
        if (typeof r.tool !== "string" || r.tool === "")
            return false;
        if (typeof r.result !== "object" || r.result === null)
            return false;
        if (typeof r.projected !== "object" || r.projected === null)
            return false;
        const proj = r.projected;
        if (typeof proj.isError !== "boolean")
            return false;
        if (typeof proj.text !== "string")
            return false;
        if (typeof proj.structuredContent !== "object" || proj.structuredContent === null)
            return false;
        return true;
    });
}
/**
 * Load + parse the committed twin-call fixture set from `absPath`. Missing/malformed →
 * `null` (the gate rung treats a null fixture set as a fail-closed oracle-unavailable
 * signal under enforce). Never throws.
 */
function loadProjectionFixtures(absPath) {
    try {
        if (!fs.existsSync(absPath))
            return null;
        const parsed = JSON.parse(fs.readFileSync(absPath, "utf8"));
        return isValidFixtureSet(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
/**
 * Run the oracle over a fixture set: for each fixture, re-derive the reference projection of
 * `result` and assert the recorded `projected` is faithful. Returns ALL infidelities found
 * (empty = the projection is faithful across the whole fixture set). This is the SINGLE
 * predicate consumed by BOTH the gate rung (over the committed fixtures) and the parity
 * test (over the real `toToolResult`).
 */
function runProjectionOracle(set) {
    const out = [];
    for (const f of set.fixtures) {
        out.push(...projectionFidelity(f.tool, f.result, f.projected));
    }
    return out;
}
