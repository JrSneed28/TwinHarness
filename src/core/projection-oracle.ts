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

import * as fs from "node:fs";
import type { CommandResult } from "./output";

/**
 * The MINIMAL structural subset of an MCP `CallToolResult` the oracle reasons over — the
 * fields that carry the CLI↔MCP correspondence. Kept SDK-free (a plain object) so this
 * module stays in core: the real `CallToolResult` (mcp-server / MCP SDK) is a SUPERSET of
 * this shape, so `toToolResult(r)` structurally satisfies it.
 */
export interface ProjectedResult {
  /** The inverse of `CommandResult.ok` — a failing command surfaces as a tool error. */
  isError: boolean;
  /** The human-readable text content (the first text content block). */
  text: string;
  /** The machine payload + the numeric `exitCode` (reserved key, envelope wins). */
  structuredContent: Record<string, unknown>;
}

/**
 * The PURE reference projector — the single source of the projection CONTRACT, in core.
 * Mirrors `mcp-server.toToolResult` EXACTLY (the parity test pins the real projector to
 * this), but returns the SDK-free {@link ProjectedResult} subset. The `text` precedence,
 * the `isError = !ok`, and the `exitCode`-spread-last reserved-key precedence are all
 * reproduced here so the gate-time check is byte-faithful to the runtime projection.
 */
export function referenceProjection(result: CommandResult): ProjectedResult {
  const text =
    result.human !== undefined
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

/** One infidelity the oracle found on a fixture — the axis that diverged + the values. */
export interface ProjectionInfidelity {
  /** The fixture's tool name (e.g. `th_state_get`). */
  tool: string;
  /** Which fidelity axis diverged. */
  axis: "isError" | "exitCode" | "data" | "text";
  /** Human-readable detail (expected vs observed). */
  detail: string;
}

/**
 * The fidelity predicate: does `projected` faithfully preserve `result`'s `ok` / `exitCode`
 * / `data` / text rendering? Returns the list of infidelities (empty = faithful). The
 * reference is {@link referenceProjection}; `projected` is the value under test (a fixture's
 * recorded projection, or — in the parity test — the real `toToolResult` output).
 */
export function projectionFidelity(
  tool: string,
  result: CommandResult,
  projected: ProjectedResult,
): ProjectionInfidelity[] {
  const ref = referenceProjection(result);
  const out: ProjectionInfidelity[] = [];
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
    if (k === "exitCode") continue; // checked above
    if (JSON.stringify(projected.structuredContent?.[k]) !== JSON.stringify(v)) {
      out.push({ tool, axis: "data", detail: `data.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(projected.structuredContent?.[k])}` });
    }
  }
  if (projected.text !== ref.text) {
    out.push({ tool, axis: "text", detail: `text rendering diverged` });
  }
  return out;
}

/**
 * One twin-call fixture: a named tool, the concrete `CommandResult` its `run*` handler
 * returns for a fixed input, and the MCP projection that should result. The gate re-projects
 * `result` via {@link referenceProjection} and asserts {@link projectionFidelity} against the
 * recorded `projected`. A SEEDED infidelity (a `projected` that drops/alters ok/exitCode/data)
 * is the negative-control the oracle blocks on.
 */
export interface ProjectionFixture {
  tool: string;
  result: CommandResult;
  projected: ProjectedResult;
}

/** The committed fixture-set file shape (a JSON array of {@link ProjectionFixture}). */
export interface ProjectionFixtureSet {
  fixtures: ProjectionFixture[];
}

/** Validate a parsed fixture-set; a malformed file yields `null` (the gate treats it fail-closed). */
export function isValidFixtureSet(parsed: unknown): parsed is ProjectionFixtureSet {
  if (typeof parsed !== "object" || parsed === null) return false;
  const fx = (parsed as Record<string, unknown>).fixtures;
  if (!Array.isArray(fx)) return false;
  return fx.every((f) => {
    if (typeof f !== "object" || f === null) return false;
    const r = f as Record<string, unknown>;
    if (typeof r.tool !== "string" || r.tool === "") return false;
    if (typeof r.result !== "object" || r.result === null) return false;
    if (typeof r.projected !== "object" || r.projected === null) return false;
    const proj = r.projected as Record<string, unknown>;
    if (typeof proj.isError !== "boolean") return false;
    if (typeof proj.text !== "string") return false;
    if (typeof proj.structuredContent !== "object" || proj.structuredContent === null) return false;
    return true;
  });
}

/**
 * Load + parse the committed twin-call fixture set from `absPath`. Missing/malformed →
 * `null` (the gate rung treats a null fixture set as a fail-closed oracle-unavailable
 * signal under enforce). Never throws.
 */
export function loadProjectionFixtures(absPath: string): ProjectionFixtureSet | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(absPath, "utf8"));
    return isValidFixtureSet(parsed) ? parsed : null;
  } catch {
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
export function runProjectionOracle(set: ProjectionFixtureSet): ProjectionInfidelity[] {
  const out: ProjectionInfidelity[] = [];
  for (const f of set.fixtures) {
    out.push(...projectionFidelity(f.tool, f.result, f.projected));
  }
  return out;
}
