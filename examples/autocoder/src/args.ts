/**
 * IF-014 CLI argument surface — argv parsing (SLICE-1 / TASK-002).
 *
 * Pure, deterministic parsing of the `autocoder` argument vector into a typed
 * `ParsedArgs`. The composition root (`cli.ts`) consumes this; keeping the parse
 * here keeps the CLI entry thin (a composition root only — design note §6.4).
 *
 * Realizes: REQ-001 (task ingestion), REQ-NFR-006 (--help lists all flags; unknown
 * flag / missing required arg → usage hint to stderr + non-zero exit). REQ-020
 * (exit code from RunOutcome) is enforced by the caller, not here.
 *
 * Task ingestion precedence (documented order): positional > --task/-t >
 * --task-file > stdin. This module resolves the first three (synchronous);
 * stdin is the caller's fallback when none of these is present in run mode.
 */

/** The two CLI modes (IF-014): the agent run, or the allowlist subcommand. */
export type CliMode = "run" | "allowlist";

/** Parsed allowlist subcommand (body lands in SLICE-9; here we only route it). */
export interface AllowlistInvocation {
  action: "list" | "add" | "remove";
  pattern?: string;
}

/** A successful parse of the argument vector (run mode). */
export interface ParsedRunArgs {
  kind: "run";
  /**
   * The Task resolved from positional / --task / --task-file (precedence in that
   * order). `undefined` here means "no task on the argv" — the caller falls back
   * to stdin, and if stdin is also empty that is a usage error.
   */
  task?: string;
  /** Source of `task` when present (for transcript/debug; not behaviorally load-bearing). */
  taskSource?: "positional" | "flag" | "file";
  /** Raw --task-file path when supplied (the caller reads it). */
  taskFile?: string;
  root?: string;
  modelId?: string;
  /** --yes/--auto: sets BOTH editMode and commandMode to "auto" (resolved in config). */
  auto: boolean;
  maxIterations?: number;
  tokenBudget?: number;
  json: boolean;
  configFile?: string;
}

/** A successful parse of the allowlist subcommand. */
export interface ParsedAllowlistArgs {
  kind: "allowlist";
  invocation: AllowlistInvocation;
  configFile?: string;
}

/** Caller asked for --help: print usage and exit 0 (REQ-NFR-006). */
export interface ParsedHelp {
  kind: "help";
}

/** A usage error: emit `message` to stderr, exit non-zero (REQ-NFR-006). */
export interface ParsedError {
  kind: "error";
  message: string;
}

export type ParsedArgs =
  | ParsedRunArgs
  | ParsedAllowlistArgs
  | ParsedHelp
  | ParsedError;

/**
 * The canonical IF-014 usage text. `--help` prints this (exit 0) and it is the
 * hint appended to usage errors. Every flag in IF-014 is enumerated here — the
 * REQ-NFR-006 acceptance test asserts each one is present.
 */
export const USAGE_TEXT = `Usage:
  autocoder [task] [flags]                          run an agent task against a repo
  autocoder allowlist <list|add|remove> [pattern]   manage the command auto-run allowlist

Positional:
  task                 the natural-language Task; if omitted, read from --task / stdin / --task-file

Flags:
  --task, -t <str>     the Task as a flag (alternative to the positional)
  --task-file <path>   read the Task from a file
  --cwd, --root <p>    the WorkingRoot (default: current directory)
  --model <id>         the model id (default: current Claude model)
  --yes, --auto        auto-approve edits AND auto-run all commands (default: off)
  --max-iterations <n> iteration ceiling (default: 25; must be > 0)
  --token-budget <n>   token ceiling (default: ~1000000; must be > 0)
  --json               emit the final RunSummary as machine-readable JSON (default: off)
  --config <path>      config file path
  --help               show this usage text and exit 0
`;

/** Flags that take a value (consume the next argv token). */
const VALUE_FLAGS = new Set([
  "--task",
  "-t",
  "--task-file",
  "--cwd",
  "--root",
  "--model",
  "--max-iterations",
  "--token-budget",
  "--config",
]);

/** Boolean flags (no value). */
const BOOLEAN_FLAGS = new Set(["--yes", "--auto", "--json", "--help"]);

/** Allowlist actions that route in run-free mode (body is SLICE-9). */
const ALLOWLIST_ACTIONS = new Set(["list", "add", "remove"]);

function usageError(detail: string): ParsedError {
  return { kind: "error", message: `${detail}\n\n${USAGE_TEXT}` };
}

/** Parse a positive integer flag value; returns null when not a valid integer > 0. */
function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : null;
}

/**
 * Parse `argv` (the args AFTER the node binary + script — i.e. `process.argv.slice(2)`).
 * Pure and synchronous: it never reads stdin or a file; the caller does that using
 * the returned `taskFile` / the absence of `task`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // --help anywhere wins (exit 0, REQ-NFR-006).
  if (argv.includes("--help")) {
    return { kind: "help" };
  }

  // Subcommand routing: `autocoder allowlist ...` (no agent loop — SLICE-9).
  if (argv[0] === "allowlist") {
    return parseAllowlist(argv.slice(1));
  }

  return parseRun(argv);
}

function parseAllowlist(rest: string[]): ParsedArgs {
  const action = rest[0];
  if (action === undefined) {
    return usageError("allowlist: missing action (expected: list | add | remove)");
  }
  if (!ALLOWLIST_ACTIONS.has(action)) {
    return usageError(`allowlist: unknown action "${action}" (expected: list | add | remove)`);
  }
  const positionals: string[] = [];
  let configFile: string | undefined;
  for (let i = 1; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok === "--config") {
      const val = rest[++i];
      if (val === undefined) return usageError("--config requires a path");
      configFile = val;
    } else if (tok.startsWith("-")) {
      return usageError(`unknown flag: ${tok}`);
    } else {
      positionals.push(tok);
    }
  }
  const pattern = positionals[0];
  if ((action === "add" || action === "remove") && pattern === undefined) {
    return usageError(`allowlist ${action}: missing <pattern>`);
  }
  return {
    kind: "allowlist",
    invocation: { action: action as AllowlistInvocation["action"], pattern },
    configFile,
  };
}

function parseRun(argv: string[]): ParsedArgs {
  const out: ParsedRunArgs = { kind: "run", auto: false, json: false };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;

    if (!tok.startsWith("-")) {
      positionals.push(tok);
      continue;
    }

    // Reject any flag we do not recognize (REQ-NFR-006 usage error).
    if (!VALUE_FLAGS.has(tok) && !BOOLEAN_FLAGS.has(tok)) {
      return usageError(`unknown flag: ${tok}`);
    }

    if (VALUE_FLAGS.has(tok)) {
      const val = argv[++i];
      if (val === undefined) {
        return usageError(`${tok} requires a value`);
      }
      switch (tok) {
        case "--task":
        case "-t":
          out.task = val;
          out.taskSource = "flag";
          break;
        case "--task-file":
          out.taskFile = val;
          break;
        case "--cwd":
        case "--root":
          out.root = val;
          break;
        case "--model":
          out.modelId = val;
          break;
        case "--max-iterations": {
          const n = parsePositiveInt(val);
          if (n === null) return usageError(`--max-iterations must be an integer > 0 (got "${val}")`);
          out.maxIterations = n;
          break;
        }
        case "--token-budget": {
          const n = parsePositiveInt(val);
          if (n === null) return usageError(`--token-budget must be an integer > 0 (got "${val}")`);
          out.tokenBudget = n;
          break;
        }
        case "--config":
          out.configFile = val;
          break;
      }
      continue;
    }

    // Boolean flags.
    switch (tok) {
      case "--yes":
      case "--auto":
        out.auto = true;
        break;
      case "--json":
        out.json = true;
        break;
    }
  }

  // Task ingestion precedence: positional > --task/-t > --task-file > stdin.
  // A positional task wins over the --task flag; the --task flag wins over a file;
  // an explicit task-file wins over stdin (resolved by the caller). When none of
  // these is present, `task` stays undefined and the caller falls back to stdin.
  if (positionals.length > 0) {
    out.task = positionals[0];
    out.taskSource = "positional";
  } else if (out.task !== undefined) {
    // already set from --task/-t with taskSource "flag"
  } else if (out.taskFile !== undefined) {
    out.taskSource = "file";
  }

  return out;
}
