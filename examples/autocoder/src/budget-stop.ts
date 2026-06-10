/**
 * IF-011 BudgetController (`budget-stop`) — accrual + pre-turn guard + terminal
 * classification (REQ-014, REQ-015, REQ-NFR-003; enforces RULE-006 + RULE-007 +
 * RULE-011).
 *
 * Three responsibilities, all in one in-process controller consumed by
 * `agent-run`:
 *
 *  1. accrue(usage) — after each completed turn, add the turn's input+output
 *     tokens to `tokensUsed` and increment `iterationsUsed`. Accrual is strictly
 *     MONOTONIC (never decreases). When the SDK omits usage, the caller may pass a
 *     character-based ESTIMATE flagged `estimated:true` (DQ-001 / ODQ-005) — the
 *     controller accrues it exactly the same, and remembers that an estimate was
 *     used for the run summary.
 *
 *  2. checkGuard() — the PRE-TURN guard (RULE-006, INV-004). It runs BEFORE the
 *     model call so a near-budget turn is PREVENTED, not aborted mid-flight: once
 *     `iterationsUsed >= maxIterations` (→ `max-iterations-reached`) or
 *     `tokensUsed >= tokenBudget` (→ `budget-exhausted`), the guard returns
 *     `{ proceed:false, stopCondition }` and `agent-run` must NOT start the turn
 *     (no half-iteration). Iteration ceiling is checked first so a run that has hit
 *     BOTH ceilings reports `max-iterations-reached` (a single StopCondition fires —
 *     INV-005). When a ceiling is first crossed the controller signals its
 *     `budget-exceeded` event metadata for the transcript.
 *
 *  3. classify(signal) — the TERMINAL classifier (RULE-007, RULE-011). It maps the
 *     terminating signal (a ceiling hit, or the loop's task-success / model-give-up
 *     / unrecoverable-error / user-abort) to exactly one StopCondition + the derived
 *     RunOutcome status + exitCode, with `exitCode == 0` IFF `status == "succeeded"`
 *     (INV-006).
 *
 * Ceilings are resolved from Config (`maxIterations`, `tokenBudget`); absent
 * config the conservative IF-011 defaults apply (25 iterations, ~1,000,000 tokens).
 */
import type { Usage } from "./contracts.js";

/** Conservative IF-011 defaults applied when Config omits a ceiling. */
export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_TOKEN_BUDGET = 1_000_000;

/**
 * Rough chars-per-token ratio for the character-based fallback estimate used when
 * the SDK omits usage (DQ-001 / ODQ-005). ~4 chars/token is the conventional
 * English-text approximation; the exact value is not load-bearing — the point is a
 * bounded, monotonic accrual that still trips the ceiling, never an unbounded run.
 */
export const CHARS_PER_TOKEN = 4;

/** The two ceilings the pre-turn guard can trip (RULE-006). */
export type CeilingStopCondition = "max-iterations-reached" | "budget-exhausted";

/** The full StopCondition union — the five conditions a run terminates on (INV-005). */
export type StopCondition =
  | "task-success"
  | "max-iterations-reached"
  | "budget-exhausted"
  | "model-give-up"
  | "unrecoverable-error"
  | "user-abort";

/** The pre-turn budget verdict (IF-011 checkGuard output). */
export interface GuardVerdict {
  proceed: boolean;
  /** Set IFF `proceed === false` (a ceiling was hit). */
  stopCondition?: CeilingStopCondition;
}

/** The metadata for a `budget-exceeded` transcript entry, emitted when a ceiling is hit. */
export interface BudgetExceeded {
  kind: CeilingStopCondition;
  iterationsUsed: number;
  tokensUsed: number;
}

/** The terminating signal handed to `classify` (IF-011). */
export interface TerminalSignal {
  kind: "task-success" | "model-give-up" | "unrecoverable-error" | "user-abort";
  testsPassed?: boolean;
}

/** The classified RunOutcome shape (status + the single StopCondition + exit code). */
export interface ClassifiedOutcome {
  status: "succeeded" | "stopped" | "failed";
  stopCondition: StopCondition;
  exitCode: number;
}

export interface BudgetControllerOptions {
  /** Iteration ceiling resolved from Config; defaults to 25 when absent/invalid. */
  maxIterations?: number;
  /** Token ceiling resolved from Config; defaults to ~1,000,000 when absent/invalid. */
  tokenBudget?: number;
}

/**
 * Estimate a turn's token usage from the raw character length of the model's
 * round-trip text when the SDK omits usage (DQ-001 / ODQ-005). Returns a `Usage`
 * with `estimated:true` so callers and the run summary can flag it. The split
 * between input/output is approximate; only the TOTAL feeds the ceiling.
 */
export function estimateUsage(inputChars: number, outputChars: number): Usage {
  const inTokens = Math.ceil(Math.max(0, inputChars) / CHARS_PER_TOKEN);
  const outTokens = Math.ceil(Math.max(0, outputChars) / CHARS_PER_TOKEN);
  return { inputTokens: inTokens, outputTokens: outTokens, estimated: true };
}

export interface BudgetController {
  /** Accrue one completed turn's usage; monotonic. Increments iterationsUsed. */
  accrue(usage: Usage): void;
  /** The pre-turn guard (RULE-006, INV-004). Runs BEFORE the model call. */
  checkGuard(): GuardVerdict;
  /** Terminal classification → RunOutcome status + StopCondition + exitCode (RULE-007/011). */
  classify(signal: TerminalSignal): ClassifiedOutcome;
  /**
   * The `budget-exceeded` event metadata for the ceiling that was hit, or null if
   * no ceiling has been hit. Computed off the current accrued state so `agent-run`
   * can emit the transcript entry exactly once when the guard first forbids a turn.
   */
  exceededEvent(): BudgetExceeded | null;
  /** Current accrued iteration count (turns completed). */
  iterationsUsed(): number;
  /** Current accrued token total (input+output across turns). */
  tokensUsed(): number;
  /** True iff any accrued usage was a character-based estimate (ODQ-005 flag). */
  usedEstimate(): boolean;
}

/** A positive integer ceiling, or the supplied default when absent/non-positive. */
function ceilingOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/**
 * Construct a BudgetController bound to the resolved (or default) ceilings. State
 * is per-run and private; the controller is the single owner of `iterationsUsed`
 * and `tokensUsed`, so accrual stays monotonic and the guard is authoritative.
 */
export function createBudgetController(
  opts: BudgetControllerOptions = {},
): BudgetController {
  const maxIterations = ceilingOrDefault(opts.maxIterations, DEFAULT_MAX_ITERATIONS);
  const tokenBudget = ceilingOrDefault(opts.tokenBudget, DEFAULT_TOKEN_BUDGET);

  let iterations = 0;
  let tokens = 0;
  let sawEstimate = false;

  /** The ceiling currently hit, if any. Iteration checked first (single fire — INV-005). */
  function hitCeiling(): CeilingStopCondition | null {
    if (iterations >= maxIterations) return "max-iterations-reached";
    if (tokens >= tokenBudget) return "budget-exhausted";
    return null;
  }

  return {
    accrue(usage: Usage): void {
      // Defensive clamp: tokens are non-negative; accrual is strictly monotonic so
      // a malformed (negative) usage can never decrease the accrued totals.
      const inTok = Math.max(0, usage.inputTokens ?? 0);
      const outTok = Math.max(0, usage.outputTokens ?? 0);
      tokens += inTok + outTok;
      iterations += 1;
      if (usage.estimated === true) sawEstimate = true;
    },

    checkGuard(): GuardVerdict {
      const ceiling = hitCeiling();
      if (ceiling !== null) {
        return { proceed: false, stopCondition: ceiling };
      }
      return { proceed: true };
    },

    classify(signal: TerminalSignal): ClassifiedOutcome {
      // A ceiling hit takes precedence: if the guard forbade the turn, the terminal
      // condition IS the ceiling regardless of the loop's own signal. This keeps the
      // single-StopCondition invariant (INV-005) when a run both runs out of budget
      // AND the model never finalized.
      const ceiling = hitCeiling();
      if (ceiling !== null) {
        // A ceiling stop is always Stopped (clean) with a non-zero exit (RULE-011).
        return { status: "stopped", stopCondition: ceiling, exitCode: 1 };
      }

      switch (signal.kind) {
        case "task-success":
          // The only Succeeded path → exit 0 (INV-006).
          return { status: "succeeded", stopCondition: "task-success", exitCode: 0 };
        case "model-give-up":
          return { status: "stopped", stopCondition: "model-give-up", exitCode: 1 };
        case "user-abort":
          // user-abort is a CLEAN stop (Stopped, NOT Failed).
          return { status: "stopped", stopCondition: "user-abort", exitCode: 1 };
        case "unrecoverable-error":
          // The only Failed path.
          return { status: "failed", stopCondition: "unrecoverable-error", exitCode: 1 };
        default: {
          // Exhaustiveness guard: an unknown signal is treated as unrecoverable so
          // the run STILL terminates on exactly one condition (RULE-007) rather than
          // hanging — never an undefined/throwing terminal.
          const _exhaustive: never = signal.kind;
          void _exhaustive;
          return {
            status: "failed",
            stopCondition: "unrecoverable-error",
            exitCode: 1,
          };
        }
      }
    },

    exceededEvent(): BudgetExceeded | null {
      const ceiling = hitCeiling();
      if (ceiling === null) return null;
      return { kind: ceiling, iterationsUsed: iterations, tokensUsed: tokens };
    },

    iterationsUsed(): number {
      return iterations;
    },

    tokensUsed(): number {
      return tokens;
    },

    usedEstimate(): boolean {
      return sawEstimate;
    },
  };
}
