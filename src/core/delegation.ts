/**
 * Context Preservation / Delegation Layer — the pure, deterministic core.
 *
 * The main Claude Code context window is a scarce CONTROL-PLANE resource: the
 * Orchestrator coordinates, while high-context work (broad reads, code edits,
 * debugging, reviews, artifact drafting, repo inspection) is DELEGATED to a child
 * agent that consumes detail in its own context and returns a compact capsule.
 *
 * This module is the mechanical spine behind `th delegate`:
 *  - `computeDelegation` recommends delegate / keep-main from mechanical signals,
 *    exactly as `core/routing.ts` recommends a model/effort. It COMPUTES; the
 *    Orchestrator still decides (the §3 boundary: records and computes, never decides).
 *  - `capsuleTemplate` / `validateCapsule` define and presence-check the strict
 *    return format a delegate owes back to the main context.
 *
 * Pure and total: same inputs → same decision, no IO, no clock — mirrors `routing.ts`.
 */

/** The kind of work a task is — the primary delegation signal. */
export type DelegationIntent =
  | "read"
  | "write"
  | "debug"
  | "review"
  | "artifact"
  | "repo-analysis";

export const DELEGATION_INTENTS: readonly DelegationIntent[] = [
  "read",
  "write",
  "debug",
  "review",
  "artifact",
  "repo-analysis",
];

/** Expected file reads strictly above this belong in a child context (delegate). */
export const FILE_THRESHOLD = 3;

/** Intents that are inherently high-context and always recommend delegation. */
const DELEGATE_INTENTS: ReadonlySet<DelegationIntent> = new Set<DelegationIntent>([
  "write",
  "debug",
  "review",
  "artifact",
  "repo-analysis",
]);

/** Mechanical signals describing the task the Orchestrator is about to perform. */
export interface DelegationSignals {
  /** The kind of work (read|write|debug|review|artifact|repo-analysis). */
  intent?: DelegationIntent;
  /** Expected number of file reads. */
  files?: number;
  /** The task modifies source code. */
  writes?: boolean;
  /** The task runs noisy commands / inspects logs / runs tests / scans the repo. */
  noisy?: boolean;
}

export interface DelegationRecommendation {
  recommendation: "delegate" | "keep-main";
  /** Why this recommendation — one deterministic string per fired trigger. */
  reasons: string[];
  /** The agent type best suited to the work, or null when keep-main. */
  suggestedAgent: string | null;
  /** Whether assembling a `th delegate pack` handoff is worthwhile. */
  packRecommended: boolean;
  /** Whether the delegate must return a Delegation Capsule. */
  capsuleRequired: boolean;
}

/**
 * Map an intent to the existing agent (under `agents/`) best suited to consume
 * that work. Annotation only — the Orchestrator still chooses the agent at spawn.
 */
function agentForIntent(intent: DelegationIntent | undefined): string {
  switch (intent) {
    case "debug":
      return "debugger";
    case "review":
      return "critic";
    case "artifact":
      return "spec";
    case "repo-analysis":
      return "codebase-inspector";
    case "write":
      return "builder";
    default:
      // A read broad/large enough to delegate is a codebase-inspection job.
      return "codebase-inspector";
  }
}

/**
 * Recommend whether a task should be DELEGATED to a child agent or KEPT in the
 * main context, from mechanical signals. Deterministic and side-effect-free.
 *
 * Delegate when ANY trigger fires: a high-context intent, expected file reads
 * over {@link FILE_THRESHOLD}, a source-modifying task, or noisy output.
 * Otherwise the task is small/read-scoped enough to keep in the control plane.
 *
 * Advisory: the recommendation annotates; the Orchestrator may still keep a
 * truly trivial one-liner in main even when a trigger nominally fires.
 */
export function computeDelegation(signals: DelegationSignals): DelegationRecommendation {
  const reasons: string[] = [];
  const intent = signals.intent;
  const files = signals.files;

  if (intent && DELEGATE_INTENTS.has(intent)) {
    reasons.push(`intent "${intent}" is high-context work that belongs in a child agent`);
  }
  if (typeof files === "number" && files > FILE_THRESHOLD) {
    reasons.push(`expected file reads (${files}) exceed the main-context threshold (${FILE_THRESHOLD})`);
  }
  if (signals.writes === true) {
    reasons.push("task modifies source code");
  }
  if (signals.noisy === true) {
    reasons.push("task runs noisy commands / inspects logs / runs tests / scans the repo");
  }

  if (reasons.length > 0) {
    return {
      recommendation: "delegate",
      reasons,
      suggestedAgent: agentForIntent(intent),
      packRecommended: true,
      capsuleRequired: true,
    };
  }

  return {
    recommendation: "keep-main",
    reasons: ["small, read-scoped task below the delegation thresholds — keep it in the main context"],
    suggestedAgent: null,
    packRecommended: false,
    capsuleRequired: false,
  };
}

/* ------------------------------------------------------------------ *
 * Delegation Capsule — the strict, compact return format.            *
 * ------------------------------------------------------------------ */

/**
 * The required sections of a Delegation Capsule (the compact conclusion a
 * delegate returns to the main context). Long-form detail lives in durable
 * files under `.twinharness/delegations/DEL-###/`, never in the capsule itself.
 */
export const CAPSULE_SECTIONS = [
  "Agent",
  "Task",
  "Intent",
  "Inputs used",
  "Files read",
  "Files changed",
  "Commands run",
  "Findings",
  "Risks",
  "Tests/checks",
  "Result",
  "Open questions",
  "Recommended next action",
  "Artifacts produced",
] as const;

/** The title line every capsule opens with. */
export const CAPSULE_TITLE = "DELEGATION CAPSULE";

export interface CapsuleValidation {
  ok: boolean;
  present: string[];
  missing: string[];
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Validate that a capsule contains every required section HEADING. Presence
 * only — content is not judged (a section may legitimately read "none"). A
 * section counts as present when a line is exactly its label (case-insensitive),
 * optionally prefixed with markdown heading (`#`) / bullet (`-`/`*`) markers and
 * followed by a colon or end-of-line: e.g. `Files read:`, `## Files read`,
 * `- Tests/checks: none`. The trailing lookahead rejects partial matches
 * (`Taskmaster:` does not satisfy `Task`).
 */
export function validateCapsule(text: string): CapsuleValidation {
  const lines = text.split(/\r?\n/);
  const present: string[] = [];
  const missing: string[] = [];
  for (const section of CAPSULE_SECTIONS) {
    const re = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:[-*]\\s*)?${escapeRegExp(section)}(?=:|\\s|$)`, "i");
    if (lines.some((ln) => re.test(ln))) present.push(section);
    else missing.push(section);
  }
  return { ok: missing.length === 0, present, missing };
}

/** Emit a blank Delegation Capsule skeleton (one `Label:` line per section). */
export function capsuleTemplate(): string {
  return [CAPSULE_TITLE, ...CAPSULE_SECTIONS.map((s) => `${s}:`)].join("\n");
}
