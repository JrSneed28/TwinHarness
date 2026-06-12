import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { parseDriftEntries } from "../core/drift-log";
import { readLedger } from "../core/ledger";

/**
 * `th manifest export` — a deterministic, inspectable snapshot of a TwinHarness
 * run (Phase 4 — "deterministic run manifest"). It aggregates the otherwise
 * scattered run record (state.json, drift-log.md, the gate ledger) into one
 * stable JSON so a run can be reviewed, diffed, archived, or asserted against a
 * golden fixture in CI.
 *
 * Deterministic: volatile fields (ledger timestamps) are dropped so the same run
 * state always produces byte-identical output. It records and computes — it
 * never re-runs anything (plan §3 boundary rule).
 */

export interface RunManifest {
  schema_version: number | null;
  tier: string | null;
  current_stage: string;
  implementation_allowed: boolean;
  write_gate: string;
  blast_radius_flags: string[];
  approved_artifacts: Array<{ file: string; version: number; hash: string }>;
  slices: Array<{ id: string; status: string; components: string[] }>;
  drift_open_blocking: number;
  drift_entries: Array<{ id: string; ref: string; layer: string }>;
  revise_loop_counts: Record<string, number>;
  open_questions: string[];
  gate_ledger: { count: number; events: Array<Record<string, unknown>> };
}

/** Sort an object's keys for deterministic serialization. */
function sortedRecord(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]!;
  return out;
}

export function buildManifest(paths: ProjectPaths): RunManifest | null {
  const r = readState(paths);
  if (!r.exists || !r.state) return null;
  const s = r.state;

  const driftText = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
  const driftEntries = parseDriftEntries(driftText).map((e) => ({ id: e.id, ref: e.ref, layer: e.layer }));

  const ledger = readLedger(paths).map((e) => {
    // Drop the volatile timestamp so the manifest is deterministic.
    const { ts: _ts, ...rest } = e;
    void _ts;
    return rest;
  });

  return {
    schema_version: s.schema_version ?? null,
    tier: s.tier,
    current_stage: s.current_stage,
    implementation_allowed: s.implementation_allowed,
    write_gate: s.write_gate ?? "ask",
    blast_radius_flags: [...s.blast_radius_flags].sort(),
    approved_artifacts: s.approved_artifacts.map((a) => ({ file: a.file, version: a.version, hash: a.hash })),
    slices: s.slices.map((sl) => ({ id: sl.id, status: sl.status, components: sl.components })),
    drift_open_blocking: s.drift_open_blocking,
    drift_entries: driftEntries,
    revise_loop_counts: sortedRecord(s.revise_loop_counts),
    open_questions: s.open_questions,
    gate_ledger: { count: ledger.length, events: ledger },
  };
}

/** `th manifest export` — emit the deterministic run snapshot. */
export function runManifestExport(paths: ProjectPaths): CommandResult {
  const manifest = buildManifest(paths);
  if (manifest === null) {
    const r = readState(paths);
    if (!r.exists) return failure({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
    return failure({ human: "state.json is invalid; cannot export a manifest.", data: { error: "invalid_state", issues: r.issues } });
  }

  const human = [
    `Run manifest (schema v${manifest.schema_version ?? "legacy"})`,
    `  Tier:            ${manifest.tier ?? "(unclassified)"}`,
    `  Stage:           ${manifest.current_stage}`,
    `  Implementation:  ${manifest.implementation_allowed ? "allowed" : "not allowed"}`,
    `  Blast-radius:    ${manifest.blast_radius_flags.length ? manifest.blast_radius_flags.join(", ") : "(none)"}`,
    `  Artifacts:       ${manifest.approved_artifacts.length}`,
    `  Slices:          ${manifest.slices.length} (${manifest.slices.filter((s) => s.status === "done").length} done)`,
    `  Open drift:      ${manifest.drift_open_blocking} blocking, ${manifest.drift_entries.length} total`,
    `  Gate ledger:     ${manifest.gate_ledger.count} entries`,
    "",
    "Pass --json for the full deterministic manifest.",
  ].join("\n");

  return success({ data: { manifest }, human });
}
