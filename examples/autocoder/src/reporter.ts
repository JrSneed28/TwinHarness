/**
 * Reporter (`reporter`) — IF-016 RunSummary / `--json` + the human progress stream
 * (REQ-017, REQ-019, REQ-024; secret redaction for REQ-018).
 *
 * Two surfaces, ONE source of truth:
 *
 *  1. The HUMAN STREAM (REQ-017): during the run the CLI streams ordered, human-
 *     readable progress — the plan/step, each tool call + its outcome, diffs, and
 *     test results — to stdout (in that order). The reporter exposes a small set of
 *     `stream*` methods the loop/composition root calls as events occur; the ORDER of
 *     emission is the contract (not colors/width).
 *
 *  2. The FINAL SUMMARY (REQ-019, REQ-024): on completion the reporter renders the
 *     SAME `RunSummary` (IF-016) two ways from a SINGLE computed object — human-
 *     readably always, and as a schema-stable parseable JSON object when `--json` is
 *     set. The `status`/`exitCode`/`stopCondition` come from the SLICE-7
 *     classification (the caller passes the already-classified RunSummary) — the
 *     reporter NEVER recomputes them (exitCode == 0 IFF succeeded — INV-006, reused).
 *
 * SECRET REDACTION (REQ-018): the `apiKey` must appear in NEITHER stdout (human or
 * `--json`) NOR the transcript. The transcript side is enforced by emitters never
 * placing the key in a payload (TASK-016); here the reporter additionally REDACTS any
 * occurrence of a configured secret from every byte it writes to stdout, as a
 * defense-in-depth guarantee that a stray diff/output line carrying the key can never
 * leak through the human stream or `--json`.
 */
import type { RunOutcome, RunSummary } from "./contracts.js";

/** The injectable stdout sink (tests capture it instead of touching process.stdout). */
export interface ReporterWriter {
  write(text: string): void;
}

/** The default sink writes to the real process stdout. */
const processStdout: ReporterWriter = {
  write: (t) => process.stdout.write(t),
};

export interface ReporterOptions {
  /** stdout sink; defaults to process.stdout. Injected in tests for capture. */
  out?: ReporterWriter;
  /** `--json` mode: also emit the RunSummary as a JSON object on stdout (REQ-024). */
  json?: boolean;
  /**
   * [SENSITIVE] the secret(s) to REDACT from every byte written to stdout (REQ-018).
   * Any occurrence of one of these strings is replaced with `[REDACTED]` before it
   * reaches stdout, so the API key can never leak through a diff/output/summary line.
   * Empty/short entries are ignored (a 0-length secret would match everywhere).
   */
  secrets?: string[];
}

export interface ReporterStopSignal {
  runId: string;
  /** Slice 0 only ever produces task-success → succeeded. */
  kind: "task-success";
}

/** The placeholder a redacted secret is replaced with in any stdout byte. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Build the reporter. The streaming methods and the final-summary renderer all write
 * through the SAME redacting sink, so no secret can leak via any channel.
 */
export function createReporter(opts: ReporterOptions = {}) {
  const out = opts.out ?? processStdout;
  const json = opts.json ?? false;
  // Only redact non-trivial secrets (a too-short string would over-match).
  const secrets = (opts.secrets ?? []).filter((s) => typeof s === "string" && s.length >= 4);

  /** Replace every occurrence of every configured secret with the placeholder. */
  function redact(text: string): string {
    let redacted = text;
    for (const secret of secrets) {
      // Global, literal replace (no regex-special interpretation of the key).
      redacted = redacted.split(secret).join(REDACTION_PLACEHOLDER);
    }
    return redacted;
  }

  /** The single write seam — EVERY stdout byte passes through redaction (REQ-018). */
  function emit(text: string): void {
    out.write(redact(text));
  }

  return {
    /**
     * Map a terminal signal to a RunOutcome (exitCode 0 iff succeeded — INV-006).
     * Retained for back-compatibility with the SLICE-0 callers; the real terminal
     * classification now lives in `budget-stop` (SLICE-7) and is REUSED, not redone.
     */
    renderOutcome(signal: ReporterStopSignal): RunOutcome {
      return { status: "succeeded", exitCode: 0, runId: signal.runId };
    },

    // ---- Human progress stream (REQ-017), emitted IN ORDER as events occur. ----

    /** The current plan/step the agent is about to take. */
    streamPlan(step: string): void {
      emit(`▸ plan: ${step}\n`);
    },

    /** A tool call about to be dispatched (name + a compact arg preview). */
    streamToolCall(toolName: string, args: Record<string, unknown>): void {
      emit(`  → tool ${toolName} ${compactArgs(args)}\n`);
    },

    /** The outcome of the tool call just dispatched (ok/error + a short note). */
    streamToolResult(status: "ok" | "error", note?: string): void {
      const tail = note ? ` ${note}` : "";
      emit(`  ← ${status}${tail}\n`);
    },

    /** A unified diff produced by an edit/patch (shown verbatim, redacted). */
    streamDiff(diff: string): void {
      emit(`${diff.endsWith("\n") ? diff : diff + "\n"}`);
    },

    /** A test run's result (command + pass/fail counts). */
    streamTestResult(command: string, passed: number, failed: number): void {
      emit(`  ✓ tests: ${command} — ${passed} passed, ${failed} failed\n`);
    },

    // ---- Allowlist-management confirmation (REQ-025, SLICE-9). No agent loop. ----
    // Reuses the SAME redacting `emit` seam as the run stream (the design note's "one
    // output path") so allowlist UX can never leak a secret either.

    /** Print the current allowlist for `allowlist list` (inspect). */
    streamAllowlist(patterns: readonly string[]): void {
      if (patterns.length === 0) {
        emit(`allowlist: (empty)\n`);
        return;
      }
      emit(`allowlist (${patterns.length}):\n`);
      for (const p of patterns) {
        emit(`  • ${p}\n`);
      }
    },

    /**
     * Confirm a mutating allowlist op (add | remove). `changed=false` is the idempotent
     * no-op case (add-existing / remove-absent): still a SUCCESS, but reported as
     * "no change" so the user is never falsely told a duplicate was added. This is the
     * ONLY success line a mutating op prints — it is emitted AFTER persistence succeeds,
     * so a persistence failure (which throws upstream) can never reach this "saved" line.
     */
    streamAllowlistChanged(op: "add" | "remove", pattern: string, changed: boolean): void {
      if (!changed) {
        const why = op === "add" ? "already present" : "not present";
        emit(`allowlist ${op}: "${pattern}" ${why} — no change (saved)\n`);
        return;
      }
      emit(`allowlist ${op}: "${pattern}" — saved\n`);
    },

    // ---- Final summary (REQ-019 human + REQ-024 --json), ONE object two ways. ----

    /**
     * Render the final `RunSummary` (IF-016). ALWAYS emits the human form; ALSO emits
     * the schema-stable JSON object when `--json` is set. The summary is passed in
     * fully classified (status/exitCode/stopCondition from SLICE-7) — this method
     * NEVER recomputes the outcome. Returns the summary object (handy for the caller).
     */
    renderSummary(summary: RunSummary): RunSummary {
      // Human form (REQ-019): outcome, files changed (+ diffs), tests, iterations,
      // tokens, runId. Ordered, redacted through `emit`.
      emit(humanSummary(summary));
      // Machine form (REQ-024): a single parseable JSON object on its own line. It is
      // the SAME object — fields per IF-016, schemaVersion stable. Redacted too, so a
      // secret can never appear even if some field carried it.
      if (json) {
        emit(JSON.stringify(summary) + "\n");
      }
      return summary;
    },
  };
}

/** A compact one-line preview of tool arguments for the human stream. */
function compactArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return "{}";
  }
}

/**
 * The human-readable rendering of the RunSummary (REQ-019). Ordered: outcome →
 * stop condition → files changed (+ diffs) → tests → iterations → tokens → runId.
 * Built as one string so the whole block passes through the redaction seam at once.
 */
function humanSummary(s: RunSummary): string {
  const lines: string[] = [];
  lines.push(`── run summary ──`);
  lines.push(`status:        ${s.status} (exit ${s.exitCode})`);
  lines.push(`stopCondition: ${s.stopCondition}`);
  if (s.filesChanged.length === 0) {
    lines.push(`filesChanged:  (none)`);
  } else {
    lines.push(`filesChanged:  ${s.filesChanged.length}`);
    for (const f of s.filesChanged) {
      lines.push(`  • ${f.targetPath}`);
      // Indent the diff body so it reads as part of the file entry.
      for (const dl of f.diff.split("\n")) {
        lines.push(`    ${dl}`);
      }
    }
  }
  if (s.testsResult.ran) {
    lines.push(
      `tests:         ${s.testsResult.passed} passed, ${s.testsResult.failed} failed`,
    );
  } else {
    lines.push(`tests:         (not run)`);
  }
  lines.push(`iterations:    ${s.iterationsUsed}`);
  const est = s.estimated ? " (estimated)" : "";
  lines.push(`tokens:        ${s.tokensUsed}${est}`);
  lines.push(`runId:         ${s.runId}`);
  return lines.join("\n") + "\n";
}

export type Reporter = ReturnType<typeof createReporter>;
