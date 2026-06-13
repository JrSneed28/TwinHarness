import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import {
  type SliceState,
  type ValidationIssue,
  SLICE_STATUSES,
  validateState,
} from "../core/state-schema";
import { structuredLog } from "../core/log";

/**
 * `th slices sync` — populate `state.slices` from the implementation plan
 * (spec §16; build plan §4 Slice 7 (b)).
 *
 * Parses docs/09-implementation-plan.md (or `--plan <file>`) for headings
 * containing `SLICE-<n>` tokens and the per-slice "components touched" line.
 * Upserts into state.slices: existing slice ids KEEP their current status;
 * new ids get status "pending". Slices in state but absent from the plan are
 * reported but NOT removed unless `--remove-missing` is passed.
 */

export interface SlicesSyncOptions {
  /** Path to the implementation-plan file (default docs/09-implementation-plan.md). */
  planFile?: string;
  /** Compute and report without writing state. */
  dryRun?: boolean;
  /** Remove state slices that are no longer in the plan. */
  removeMissing?: boolean;
}

/** Parsed slice record from the implementation plan. */
interface PlanSlice {
  id: string;
  components: string[];
  /** Slice IDs from an optional "Depends on: SLICE-x, SLICE-y" line (§16 ordering). */
  dependsOn: string[];
}

/** Extract backtick-quoted tokens or comma-separated bare words from a component line/cell. */
function parseComponentTokens(raw: string): string[] {
  // First try backtick-quoted tokens: `foo`, `bar`.
  const quoted: string[] = [];
  for (const m of raw.matchAll(/`([^`]+)`/g)) {
    const tok = m[1]!.trim();
    if (tok) quoted.push(tok);
  }
  if (quoted.length > 0) return quoted;

  // Fall back to comma-separated plain tokens (strip any leading dash/bullet).
  const stripped = raw.replace(/^[\s\-*]+/, "");
  return stripped
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Parse the implementation plan markdown for SLICE-N headings and their
 * "components touched" lines. Tolerant: accepts `## Slice 0 — ...`,
 * `### SLICE-2 — ...`, mixed case in the heading word.
 *
 * For each slice heading found, scans forward until the next slice heading for
 * a line matching /components?\s+touched/i. The component names are extracted
 * from that line or the immediately following list/table line.
 */
export function parsePlanSlices(planContent: string): PlanSlice[] {
  // Match headings: `## Slice 0`, `## SLICE-1 — name`, `### SLICE-2 — name`
  // Normalize "Slice N" → "SLICE-N" so the id is canonical.
  const SLICE_HEADING_RE = /^#{1,6}\s+(?:SLICE-(\d+)|Slice\s+(\d+))(?:\s|—|$)/i;
  const COMPONENTS_RE = /components?\s+touched/i;
  const DEPENDS_RE = /depends?\s+on/i;

  const lines = planContent.split(/\r?\n/);
  const slices: PlanSlice[] = [];

  // First pass: collect the line index of each slice heading + its id.
  const headings: Array<{ lineIdx: number; id: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SLICE_HEADING_RE.exec(lines[i]!);
    if (m) {
      const n = m[1] ?? m[2]!;
      headings.push({ lineIdx: i, id: `SLICE-${n}` });
    }
  }

  // Second pass: for each slice heading, scan its section for "components touched".
  for (let hi = 0; hi < headings.length; hi++) {
    const { lineIdx, id } = headings[hi]!;
    const sectionEnd = headings[hi + 1]?.lineIdx ?? lines.length;
    let components: string[] = [];
    let dependsOn: string[] = [];

    for (let li = lineIdx + 1; li < sectionEnd; li++) {
      const line = lines[li]!;
      if (components.length === 0 && COMPONENTS_RE.test(line)) {
        // The line itself may contain the component names after a colon.
        const afterColon = line.replace(COMPONENTS_RE, "").replace(/^[^:]*:\s*/, "").trim();
        if (afterColon) {
          components = parseComponentTokens(afterColon);
        } else if (li + 1 < sectionEnd) {
          // Try the immediately following line (list item or table cell).
          components = parseComponentTokens(lines[li + 1]!);
        }
      } else if (dependsOn.length === 0 && DEPENDS_RE.test(line)) {
        // Capture canonical SLICE-N tokens from a "Depends on: SLICE-1, SLICE-2" line.
        for (const m of line.matchAll(/SLICE-\d+/gi)) dependsOn.push(m[0]!.toUpperCase());
      }
    }

    slices.push({ id, components, dependsOn });
  }

  return slices;
}

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

/**
 * `th slices sync [--plan <file>] [--dry-run] [--remove-missing]`
 *
 * Upsert plan slices into state.slices. Existing slice ids keep their status;
 * new ids get "pending"; obsolete ids are reported (and removed only with
 * `--remove-missing`). `--dry-run` computes but does not write.
 */
export function runSlicesSync(paths: ProjectPaths, opts: SlicesSyncOptions = {}): CommandResult {
  return withStateLock(paths, () => runSlicesSyncLocked(paths, opts));
}

function runSlicesSyncLocked(paths: ProjectPaths, opts: SlicesSyncOptions = {}): CommandResult {
  const planAbs = path.resolve(paths.root, opts.planFile ?? "docs/09-implementation-plan.md");

  if (!fs.existsSync(planAbs) || !fs.statSync(planAbs).isFile()) {
    const rel = path.relative(paths.root, planAbs).split(path.sep).join("/");
    return failure({
      human: `Plan file not found: ${rel}. Provide the path with --plan or author the implementation plan first.`,
      data: { error: "plan_file_not_found", planFile: rel },
    });
  }

  const planContent = fs.readFileSync(planAbs, "utf8");
  const planSlices = parsePlanSlices(planContent);

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  // Build a lookup of existing state slices by id.
  const stateById = new Map<string, SliceState>();
  for (const s of r.state.slices) stateById.set(s.id, s);

  const planIds = new Set(planSlices.map((s) => s.id));

  // Slices in state but no longer in the plan.
  const missing = r.state.slices.filter((s) => !planIds.has(s.id)).map((s) => s.id);

  // Build the upserted slice list.
  const upserted: SliceState[] = planSlices.map((ps) => {
    const existing = stateById.get(ps.id);
    const slice: SliceState = {
      id: ps.id,
      status: existing?.status ?? "pending",
      components: ps.components,
    };
    // Only attach depends_on when the plan declares one, so slices without
    // dependencies serialize byte-identically to pre-feature state (§18).
    if (ps.dependsOn.length > 0) slice.depends_on = ps.dependsOn;
    return slice;
  });

  // If not removing missing, append them unchanged.
  let finalSlices: SliceState[];
  if (opts.removeMissing) {
    finalSlices = upserted;
  } else {
    const missingEntries = r.state.slices.filter((s) => !planIds.has(s.id));
    finalSlices = [...upserted, ...missingEntries];
  }

  const nextState = { ...r.state, slices: finalSlices };
  const validation = validateState(nextState);
  if (!validation.ok) {
    return failure({
      human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
      data: { error: "would_be_invalid", issues: validation.issues },
    });
  }

  const added = planSlices.filter((ps) => !stateById.has(ps.id)).map((ps) => ps.id);
  const updated = planSlices.filter((ps) => stateById.has(ps.id)).map((ps) => ps.id);

  const data = {
    added,
    updated,
    missing,
    removed: opts.removeMissing ? missing : [],
    total: finalSlices.length,
    dryRun: opts.dryRun ?? false,
  };

  if (!opts.dryRun) {
    writeState(paths, validation.state!);
  }

  structuredLog({ cmd: "slices sync", ...data });

  const missingNote =
    missing.length
      ? `\n  ${missing.length} slice(s) in state but absent from plan (${missing.join(", ")})` +
        (opts.removeMissing ? " — removed." : " — kept (pass --remove-missing to delete).")
      : "";
  const dryNote = opts.dryRun ? " (dry run — no write)" : "";
  const human =
    `slices sync: ${added.length} added, ${updated.length} kept, total ${finalSlices.length}${dryNote}.${missingNote}`;

  return success({ data, human });
}

/**
 * `th slice set-status <SLICE-ID> <status>` — convenience command to update a
 * single slice's status without editing the whole slices array by hand.
 * Validates the slice exists and status is one of pending|in-progress|done|blocked.
 */
export function runSliceSetStatus(
  paths: ProjectPaths,
  sliceId?: string,
  status?: string,
): CommandResult {
  return withStateLock(paths, () => runSliceSetStatusLocked(paths, sliceId, status));
}

function runSliceSetStatusLocked(
  paths: ProjectPaths,
  sliceId?: string,
  status?: string,
): CommandResult {
  if (!sliceId) {
    return failure({ human: "usage: th slice set-status <SLICE-ID> <status>" });
  }
  if (!status || !(SLICE_STATUSES as readonly string[]).includes(status)) {
    return failure({
      human: `Invalid status "${status ?? ""}". Must be one of: ${SLICE_STATUSES.join(", ")}`,
      data: { error: "invalid_status", validStatuses: [...SLICE_STATUSES] },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid; fix it before updating slice status:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const idx = r.state.slices.findIndex((s) => s.id === sliceId);
  if (idx < 0) {
    return failure({
      human: `Slice not found: ${sliceId}. Known slices: ${r.state.slices.map((s) => s.id).join(", ") || "(none)"}`,
      data: { error: "slice_not_found", sliceId },
    });
  }

  const slices = r.state.slices.map((s, i) =>
    i === idx ? { ...s, status: status as SliceState["status"] } : s,
  );
  const nextState = { ...r.state, slices };
  const validation = validateState(nextState);
  if (!validation.ok) {
    return failure({
      human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
      data: { error: "would_be_invalid", issues: validation.issues },
    });
  }

  writeState(paths, validation.state!);
  structuredLog({ cmd: "slice set-status", sliceId, status });
  return success({
    data: { sliceId, status },
    human: `${sliceId} status set to "${status}".`,
  });
}
