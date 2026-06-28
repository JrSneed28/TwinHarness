/**
 * context-manifest.ts — Stage dependency manifests (S4; D-03).
 *
 * A StageManifest at `.twinharness/context-manifests/<tier>/<stage>.json`
 * declares which context pages are pinned, upstream, optional, excluded,
 * which sections an artifact provides, and which critic evidence is required.
 *
 * ADVISORY only: when a manifest is absent or malformed, all callers MUST
 * treat it as a passthrough — behavior unchanged, never throws, never blocks.
 * A later promotion (N=10 clean equivalence runs) may make manifests
 * authoritative; that is explicitly out of scope for this run.
 *
 * Key dependencies (reused, not reinvented):
 *   ProjectPaths  ← src/core/paths.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";

// ---------------------------------------------------------------------------
// Schema (D-03)
// ---------------------------------------------------------------------------

/**
 * D-03: Stage dependency manifest.
 * Stored at `<stateDir>/context-manifests/<tier>/<stage>.json`.
 */
export interface StageManifest {
  /** Logical keys that must be resident before this stage's context is assembled. */
  pinned: string[];
  /** Logical keys from the immediately upstream stage (advisory precedence). */
  upstream: string[];
  /** Logical keys to include if the token budget allows. */
  optional: string[];
  /** Logical keys that must never be included (noise / stale / sensitive). */
  excluded: string[];
  /** Which sections each artifact provides for downstream stages. */
  sections: { artifact: string[] };
  /** Selector expressions for content narrowing (reserved for future expansion). */
  selectors: string[];
  /** Critic-mode evidence signals required at this stage. */
  critic_evidence: string[];
  /**
   * Maximum token budget for context assembly at this stage.
   * 0 means unconstrained (no cap applied).
   */
  max_budget: number;
}

// ---------------------------------------------------------------------------
// Advisory default
// ---------------------------------------------------------------------------

/**
 * Advisory default: returned by {@link loadManifest} when the manifest file
 * is absent or malformed. All fields are empty / zero — callers that receive
 * this default produce behaviour identical to having no manifest at all.
 *
 * Not exported because the advisory contract is surfaced through the
 * {@link ManifestLoadResult} fields (`found`, `valid`); callers never branch
 * on the default's content, they branch on `valid`.
 */
const ADVISORY_DEFAULT: StageManifest = {
  pinned: [],
  upstream: [],
  optional: [],
  excluded: [],
  sections: { artifact: [] },
  selectors: [],
  critic_evidence: [],
  max_budget: 0,
};

// ---------------------------------------------------------------------------
// Well-known agent packs (preset manifests)
// ---------------------------------------------------------------------------

/**
 * Critic pack — pinned context the Critic requires for a coherence review.
 * Covers the mandatory upstream artifacts and the evidence signals each
 * grounded defect must supply.
 */
export const CRITIC_MANIFEST_PACK: Readonly<StageManifest> = {
  pinned: ["requirements", "scope", "domain-model"],
  upstream: ["architecture", "contracts", "test-strategy"],
  optional: ["adr", "technical-design", "security", "failure-modes"],
  excluded: [],
  sections: { artifact: ["Summary", "Findings", "Risks", "Open questions"] },
  selectors: [],
  critic_evidence: ["grounded-defect", "upstream-summary"],
  max_budget: 4000,
};

/**
 * Builder pack — context the Builder needs to implement a slice task.
 * Intentionally lean; full artifacts fetched on demand only (§9).
 */
export const BUILDER_MANIFEST_PACK: Readonly<StageManifest> = {
  pinned: ["slice-plan", "contracts"],
  upstream: ["architecture", "domain-model", "test-strategy"],
  optional: ["adr", "technical-design"],
  excluded: [],
  sections: { artifact: ["Summary", "Tasks", "Acceptance criteria"] },
  selectors: [],
  critic_evidence: [],
  max_budget: 3000,
};

/**
 * Debugger pack — context the Debugger needs for an evidence-first defect trace.
 * Emphasises contract anchors and reproduction evidence over narrative artifacts.
 */
export const DEBUGGER_MANIFEST_PACK: Readonly<StageManifest> = {
  pinned: ["requirements", "contracts"],
  upstream: ["slice-plan", "test-strategy"],
  optional: ["domain-model", "architecture"],
  excluded: [],
  sections: { artifact: ["Summary", "Root cause", "Reproduction", "Minimal fix"] },
  selectors: [],
  critic_evidence: ["file-line-anchor", "captured-output"],
  max_budget: 2500,
};

/**
 * Codebase-Inspector pack — context needed for a brownfield ground-truth scan.
 * Requires no pinned upstream artifacts (the Inspector IS the first fact-gather).
 */
export const INSPECTOR_MANIFEST_PACK: Readonly<StageManifest> = {
  pinned: [],
  upstream: [],
  optional: ["requirements"],
  excluded: [],
  sections: { artifact: ["Summary", "Module map", "Blast-radius inventory", "Adoption seams"] },
  selectors: [],
  critic_evidence: [],
  max_budget: 3000,
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path of a manifest file:
 * `<stateDir>/context-manifests/<tier>/<stage>.json`.
 */
export function manifestFilePath(paths: ProjectPaths, tier: string, stage: string): string {
  return path.join(paths.stateDir, "context-manifests", tier, `${stage}.json`);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface ManifestLoadResult {
  /**
   * The loaded manifest, or the advisory default when absent / malformed.
   * Callers should check `valid` before acting on this value.
   */
  manifest: StageManifest;
  /** True when the manifest file was found on disk. */
  found: boolean;
  /**
   * True when the file was found, is valid JSON, and conforms to the schema.
   * False means the advisory default is in use — callers MUST treat as passthrough.
   */
  valid: boolean;
  /** Human-readable explanation when `found && !valid`. */
  reason?: string;
}

/**
 * Load the stage manifest for `<tier>/<stage>` from disk.
 *
 * ADVISORY contract (D-03):
 *   - File absent        → `{found:false, valid:false}` + advisory default.
 *   - Invalid JSON       → `{found:true,  valid:false, reason}` + advisory default.
 *   - Schema violation   → `{found:true,  valid:false, reason}` + advisory default.
 *   - Well-formed        → `{found:true,  valid:true,  manifest}`.
 *
 * Never throws. Callers must treat any non-valid result as passthrough — the
 * default is all-empty / zero, ensuring no behaviour change on the absent path.
 */
export function loadManifest(paths: ProjectPaths, tier: string, stage: string): ManifestLoadResult {
  const filePath = manifestFilePath(paths, tier, stage);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    // Absent or unreadable — advisory default, passthrough.
    return { manifest: { ...ADVISORY_DEFAULT, sections: { artifact: [] } }, found: false, valid: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      manifest: { ...ADVISORY_DEFAULT, sections: { artifact: [] } },
      found: true,
      valid: false,
      reason: "manifest is not valid JSON",
    };
  }

  const result = validateManifest(parsed);
  if (!result.ok) {
    return {
      manifest: { ...ADVISORY_DEFAULT, sections: { artifact: [] } },
      found: true,
      valid: false,
      reason: result.reason,
    };
  }

  return { manifest: result.manifest, found: true, valid: true };
}

// ---------------------------------------------------------------------------
// Validator (exported for tests and direct use)
// ---------------------------------------------------------------------------

/** Successful validation. */
export interface ManifestValidOk {
  ok: true;
  manifest: StageManifest;
}

/** Failed validation with a human-readable reason. */
export interface ManifestValidFail {
  ok: false;
  reason: string;
}

/**
 * Validate that `raw` conforms to the {@link StageManifest} schema.
 *
 * Permissive on extra fields; strict on required shapes. Each field that is
 * absent defaults to the empty / zero value rather than being an error — the
 * only failures are wrong TYPES (non-array, non-string element, non-number
 * budget). Does not access the filesystem.
 */
export function validateManifest(raw: unknown): ManifestValidOk | ManifestValidFail {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "manifest must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  const pinned = coerceStringArray(obj["pinned"]);
  if (pinned === null) return { ok: false, reason: '"pinned" must be an array of strings' };

  const upstream = coerceStringArray(obj["upstream"]);
  if (upstream === null) return { ok: false, reason: '"upstream" must be an array of strings' };

  const optional = coerceStringArray(obj["optional"]);
  if (optional === null) return { ok: false, reason: '"optional" must be an array of strings' };

  const excluded = coerceStringArray(obj["excluded"]);
  if (excluded === null) return { ok: false, reason: '"excluded" must be an array of strings' };

  const selectors = coerceStringArray(obj["selectors"]);
  if (selectors === null) return { ok: false, reason: '"selectors" must be an array of strings' };

  const critic_evidence = coerceStringArray(obj["critic_evidence"]);
  if (critic_evidence === null)
    return { ok: false, reason: '"critic_evidence" must be an array of strings' };

  // sections: optional object; sections.artifact defaults to []
  const sectionsRaw = obj["sections"];
  let sections: { artifact: string[] };
  if (sectionsRaw === undefined || sectionsRaw === null) {
    sections = { artifact: [] };
  } else if (typeof sectionsRaw !== "object" || Array.isArray(sectionsRaw)) {
    return { ok: false, reason: '"sections" must be an object' };
  } else {
    const artifact = coerceStringArray(
      (sectionsRaw as Record<string, unknown>)["artifact"],
    );
    if (artifact === null)
      return { ok: false, reason: '"sections.artifact" must be an array of strings' };
    sections = { artifact };
  }

  // max_budget: non-negative finite number; defaults to 0 when absent
  const budgetRaw = obj["max_budget"];
  let max_budget: number;
  if (budgetRaw === undefined || budgetRaw === null) {
    max_budget = 0;
  } else if (
    typeof budgetRaw !== "number" ||
    !Number.isFinite(budgetRaw) ||
    budgetRaw < 0
  ) {
    return { ok: false, reason: '"max_budget" must be a non-negative finite number' };
  } else {
    max_budget = budgetRaw;
  }

  return {
    ok: true,
    manifest: { pinned, upstream, optional, excluded, sections, selectors, critic_evidence, max_budget },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce `val` to `string[]`.
 *   - `undefined` → `[]`   (field absent, use the empty default).
 *   - non-array or array-with-non-string-element → `null` (type mismatch).
 */
function coerceStringArray(val: unknown): string[] | null {
  if (val === undefined) return [];
  if (!Array.isArray(val)) return null;
  for (const item of val) {
    if (typeof item !== "string") return null;
  }
  return val as string[];
}
