/**
 * Task brief model — the input to the Tier-0 classifier (spec §5).
 *
 * A brief captures the five Tier-0 conditions plus any detected blast-radius
 * flags. Validation is hand-rolled (zero runtime dependencies — plan Principle
 * 3) and mirrors `validateState`'s style: a precise issue list so the `th tier`
 * commands can explain *what* is wrong with a brief.json.
 *
 * The CLI only *records and computes* against a brief; it never decides the
 * tier number (plan §3 boundary rule). The one mechanical truth it enforces is
 * the blast-radius veto floor (`th tier veto-check`).
 */

import * as fs from "node:fs";
import {
  BLAST_RADIUS_FLAGS,
  type BlastRadiusFlag,
  type ValidationIssue,
} from "./state-schema";

export interface TaskBrief {
  description?: string;
  /** Touches a single file / tightly local area. */
  single_file_or_local: boolean;
  /** Changes a public interface / schema / contract. */
  changes_public_interface: boolean;
  /** Adds a new dependency. */
  adds_dependency: boolean;
  /** Has an obvious, testable correct answer. */
  obvious_testable_answer: boolean;
  /** Detected blast-radius flags (subset of the 5; reuses the state-schema set). */
  blast_radius_flags: BlastRadiusFlag[];
}

export interface BriefResult {
  ok: boolean;
  issues: ValidationIssue[];
  brief?: TaskBrief;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate an arbitrary parsed value against the brief schema. */
export function validateBrief(value: unknown): BriefResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ path: "$", message: "brief must be a JSON object" }] };
  }
  const v = value;

  if (!(v.description === undefined || typeof v.description === "string")) {
    issues.push({ path: "description", message: "must be a string if present" });
  }

  for (const key of [
    "single_file_or_local",
    "changes_public_interface",
    "adds_dependency",
    "obvious_testable_answer",
  ] as const) {
    if (typeof v[key] !== "boolean") {
      issues.push({ path: key, message: "must be a boolean" });
    }
  }

  if (!Array.isArray(v.blast_radius_flags)) {
    issues.push({ path: "blast_radius_flags", message: "must be an array" });
  } else {
    v.blast_radius_flags.forEach((f: unknown, i: number) => {
      if (typeof f !== "string" || !(BLAST_RADIUS_FLAGS as readonly string[]).includes(f)) {
        issues.push({ path: `blast_radius_flags[${i}]`, message: `invalid flag "${String(f)}"` });
      }
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], brief: value as unknown as TaskBrief };
}

/** Read + JSON.parse a brief.json file, then validate it. */
export function loadBriefFromFile(filePath: string): BriefResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, issues: [{ path: "$", message: `brief file not found: ${filePath}` }] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, issues: [{ path: "$", message: `could not read brief: ${(e as Error).message}` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, issues: [{ path: "$", message: `invalid JSON: ${(e as Error).message}` }] };
  }
  return validateBrief(parsed);
}
