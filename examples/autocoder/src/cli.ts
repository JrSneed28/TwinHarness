/**
 * IF-014 CLI argument surface + composition root (`cli`).
 *
 * The CLI is the composition root (ADR-004): it parses argv, resolves + validates
 * Config (fail-fast on misconfiguration — BEFORE any AgentRun is constructed),
 * injects the DI seams (the LlmClient and CommandRunner), drives the run, and
 * translates `RunOutcome.exitCode` into the process exit code (0 iff succeeded —
 * INV-006 / REQ-020). It is THIN: it contains no agent logic.
 *
 * SLICE-1 realizes: REQ-001 (task ingestion: positional > --task/-t > --task-file
 * > stdin), REQ-002 (root resolution + validation), REQ-018 (config precedence
 * flags > env > file > defaults), REQ-020 (exit code from outcome), REQ-NFR-006
 * (--help lists every flag; misconfiguration fails fast with an actionable stderr
 * message + non-zero exit). The allowlist subcommand is only ROUTED here (body is
 * SLICE-9); the real production LlmClient/CommandRunner seams land in later slices.
 *
 * REQ-NFR-002 (partial): determinism is established by injecting the LlmClient +
 * CommandRunner seams here rather than constructing real ones internally.
 */
import { createAgentRun } from "./agent-run.js";
import { createApprovalGate } from "./approval-gate.js";
import type { ConfirmFn, ConfirmCommandFn } from "./approval-gate.js";
import {
  AllowlistPersistError,
  ConfigError,
  inspectAllowlist,
  mutateAllowlist,
  newRunId,
  resolveConfig,
} from "./config.js";
import type { ConfigEnv, ConfigFsSeam } from "./config.js";
import { parseArgs, USAGE_TEXT } from "./args.js";
import type { ParsedAllowlistArgs } from "./args.js";
import { createPathSandbox } from "./path-sandbox.js";
import { createReadTool } from "./tool-read.js";
import { createSearchTool } from "./tool-search.js";
import { createWriteEditTool } from "./tool-writeedit.js";
import { createRunCommandTool } from "./tool-runcommand.js";
import { createApplyPatchTool } from "./tool-applypatch.js";
import { createAllowlist } from "./allowlist.js";
import { createBudgetController } from "./budget-stop.js";
import { createToolRegistry } from "./tool-registry.js";
import { createReporter } from "./reporter.js";
import { buildRepoContext } from "./repo-context.js";
import { createTranscriptWriter } from "./transcript.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CommandRunner,
  Config,
  EditApprovalPolicy,
  CommandApprovalPolicy,
  LlmClient,
  RunOutcome,
} from "./contracts.js";

export interface RunAutocoderOptions {
  task: string;
  root: string;
  transcriptDir: string;
  /** DI seam — stubbed in tests, real SDK-backed in production. */
  llm: LlmClient;
  /** DI seam — stubbed in tests, real shell-backed in production. */
  commandRunner: CommandRunner;
  apiKey?: string;
  modelId?: string;
  runId?: string;
  /**
   * Optional override of the resolved approval modes (default: the IF-017
   * confirm-each / allowlist-confirm). The e2e harness sets these explicitly so a
   * closed-loop run drives edits/commands deterministically (e.g. "auto" both).
   */
  editMode?: Config["editMode"];
  commandMode?: Config["commandMode"];
  /**
   * Optional injected approval-confirm seams (REQ-NFR-002). When supplied, the
   * composition root uses them instead of the default stdin readers, so a test
   * drives approve / deny / abort with NO real stdin. Production omits them (the
   * real stdin prompt is used in confirm-each / allowlist-confirm).
   */
  confirm?: ConfirmFn;
  confirmCommand?: ConfirmCommandFn;
}

/** Default knobs used when a caller hands an explicit task/root (e.g. the e2e harness). */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Compose and run one Autocoder invocation from an already-validated task + root.
 * Used by the slice e2e harness, which supplies explicit values (so it bypasses
 * the env/root fail-fast that `resolveConfig` enforces for the real entry path).
 * Returns the RunOutcome (the caller maps `outcome.exitCode` to the process code).
 */
export async function runAutocoder(opts: RunAutocoderOptions): Promise<RunOutcome> {
  const config: Config = {
    apiKey: opts.apiKey ?? "stub-key",
    modelId: opts.modelId ?? DEFAULT_MODEL,
    root: opts.root,
    editMode: opts.editMode ?? "confirm-each",
    commandMode: opts.commandMode ?? "allowlist-confirm",
    maxIterations: 25,
    tokenBudget: 1_000_000,
    allowlist: [],
    task: opts.task,
  };
  const runId = opts.runId ?? newRunId();
  return composeAndRun({
    config,
    runId,
    transcriptDir: opts.transcriptDir,
    llm: opts.llm,
    commandRunner: opts.commandRunner,
    confirm: opts.confirm,
    confirmCommand: opts.confirmCommand,
  });
}

interface ComposeAndRunInput {
  config: Config;
  runId: string;
  transcriptDir: string;
  llm: LlmClient;
  commandRunner: CommandRunner;
  /** Injected approval-confirm seams (tests); omitted in production (stdin). */
  confirm?: ConfirmFn;
  confirmCommand?: ConfirmCommandFn;
}

/**
 * The shared wiring core (SLICE-10 — the composition root pays down the deferred
 * tool-wiring debt from DRIFT-005/008/011/013): build the safety gates + ALL FIVE
 * real in-process tool executors from a resolved Config and the injected
 * LlmClient/CommandRunner, wire the real budget guard, then drive AgentRun to a
 * RunOutcome. Assumes the Config is already validated (fail-fast happened upstream).
 *
 * Wiring order (each tool's seam dependencies are constructed once and shared):
 *  - PathSandbox over Config.root (the confinement primitive for write/exec/search),
 *  - ApprovalGate with the injected confirm seams + the run transcript (so edit/
 *    command approval rows land in the audit log),
 *  - the bounded RepoContext (its detected testCommand feeds the tests-as-signal),
 *  - read_file / list_search / write_edit / run_command / apply_patch — REAL bodies,
 *  - a BudgetController resolved from Config.maxIterations / Config.tokenBudget so
 *    PRODUCTION runs are bounded by the real ceilings (not just the IF-011 default).
 */
async function composeAndRun(input: ComposeAndRunInput): Promise<RunOutcome> {
  const { config, runId } = input;

  const sandbox = createPathSandbox(config.root);
  const transcript = createTranscriptWriter({ dir: input.transcriptDir });
  const reporter = createReporter({ secrets: [config.apiKey] });
  const context = buildRepoContext(config.root);

  // The ApprovalGate is the model-intent → real-world trust boundary (RULE-004/005).
  // Its confirm seams default to the real stdin readers; the e2e harness injects
  // deterministic answers (REQ-NFR-002). Approval transcript rows are stamped with
  // the runId so the audit log records every gating decision.
  const approval = createApprovalGate({
    confirm: input.confirm,
    confirmCommand: input.confirmCommand,
    transcript,
    runId,
  });

  // The resolved approval policies (IF-017): from Config (confirm-each / allowlist-
  // confirm by default; "auto" when --yes was passed).
  const editPolicy: EditApprovalPolicy = { editMode: config.editMode };
  const commandPolicy: CommandApprovalPolicy = { commandMode: config.commandMode };

  // The auto-run allowlist matcher (ADR-006) over the resolved Config allowlist.
  const allowlist = createAllowlist(config.allowlist);

  // ALL FIVE real tool executors (DRIFT-005/008/011/013 closure). read_file may read
  // anywhere (INV-002); the four mutating/exec/search tools confine to root via the
  // sandbox; the two mutating tools + run_command gate via the ApprovalGate.
  const readTool = createReadTool(sandbox);
  const searchTool = createSearchTool(sandbox);
  const writeEditTool = createWriteEditTool({
    sandbox,
    approval,
    policy: editPolicy,
    transcript,
    runId,
  });
  const runCommandTool = createRunCommandTool({
    sandbox,
    approval,
    runner: input.commandRunner,
    allowlist,
    policy: commandPolicy,
    workingRoot: config.root,
    testCommand: context.testCommand,
    transcript,
    runId,
  });
  const applyPatchTool = createApplyPatchTool({
    sandbox,
    approval,
    policy: editPolicy,
    transcript,
    runId,
  });

  const registry = createToolRegistry(
    readTool,
    searchTool,
    writeEditTool,
    runCommandTool,
    applyPatchTool,
  );

  // The real pre-turn budget guard (RULE-006): bound PRODUCTION runs by the resolved
  // Config ceilings so a runaway loop is prevented, never just the IF-011 default.
  const budget = createBudgetController({
    maxIterations: config.maxIterations,
    tokenBudget: config.tokenBudget,
  });

  const agentRun = createAgentRun({
    runId,
    task: config.task,
    root: config.root,
    modelId: config.modelId,
    context,
    llm: input.llm,
    registry,
    transcript,
    reporter,
    budget,
  });

  return agentRun.run();
}

/** Resolve the per-run transcript file path for a given run id + dir. */
export function transcriptPathFor(dir: string, runId: string): string {
  return `${dir}/${runId}.jsonl`;
}

/**
 * IO surface the composition root writes to. Injectable so tests capture stdout/
 * stderr instead of touching the real process streams.
 */
export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/** Full inputs for the testable composition root (`runCli`). */
export interface RunCliInput {
  /** argv AFTER node + script (i.e. process.argv.slice(2)). */
  argv: string[];
  /** Injected for tests; defaults to process.env. */
  env?: ConfigEnv;
  /** Injected for tests; defaults to process.cwd(). */
  cwd?: string;
  /** stdin fallback for the Task; returns the piped task or "" when none. */
  readStdin?: () => Promise<string>;
  /** Where per-run transcripts are written. */
  transcriptDir: string;
  /** DI seams — stubbed in tests, real (SDK/shell) in production (later slice). */
  llm: LlmClient;
  commandRunner: CommandRunner;
  /**
   * Optional injected approval-confirm seams (REQ-NFR-002). Defaults to the real
   * stdin readers in production; a test injects deterministic answers so edits/
   * commands resolve with no real stdin. Threaded into the composition root.
   */
  confirm?: ConfirmFn;
  confirmCommand?: ConfirmCommandFn;
  /** Output sink (defaults to process stdout/stderr). */
  io?: CliIo;
  /** Deterministic run id for tests. */
  runId?: string;
  /**
   * Injectable FS seam for the allowlist-management config write-back (SLICE-9 /
   * REQ-025). Defaults to real `node:fs` in production; a test injects a failing
   * `writeFileSync` to exercise the persistence-failure → non-zero exit path
   * (FAIL-004) deterministically, with no real disk write.
   */
  configFs?: ConfigFsSeam;
}

/** Default config-file name used by the allowlist subcommand when `--config` is omitted. */
const DEFAULT_CONFIG_FILE = ".autocoder.json";

const processIo: CliIo = {
  writeOut: (t) => process.stdout.write(t),
  writeErr: (t) => process.stderr.write(t),
};

/**
 * The testable composition root. Parses argv, handles --help (exit 0), usage
 * errors (stderr + non-zero), routes the allowlist subcommand, resolves the Task
 * (positional > --task/-t > --task-file > stdin), resolves + validates Config
 * (fail-fast on missing key / invalid root BEFORE any run), drives the run, and
 * returns the process exit code (0 iff the RunOutcome succeeded — REQ-020/INV-006).
 */
export async function runCli(input: RunCliInput): Promise<number> {
  const io = input.io ?? processIo;
  const parsed = parseArgs(input.argv);

  // --help → usage text on stdout, exit 0 (REQ-NFR-006).
  if (parsed.kind === "help") {
    io.writeOut(USAGE_TEXT);
    return 0;
  }

  // Unknown flag / missing required arg → usage hint on stderr, non-zero exit.
  if (parsed.kind === "error") {
    io.writeErr(parsed.message.endsWith("\n") ? parsed.message : parsed.message + "\n");
    return 2;
  }

  // allowlist subcommand (SLICE-9 / REQ-025): inspect/add/remove the auto-run set and
  // PERSIST to the config file (RULE-014). NO agent loop is started (Architecture
  // §Secondary flow): CLI → Allowlist Manager → Config persists → Reporter confirms.
  if (parsed.kind === "allowlist") {
    return runAllowlist(parsed, input, io);
  }

  // --- run mode: resolve the Task (precedence ends at stdin). ---
  let task = parsed.task;
  let taskSource: "positional" | "flag" | "file" | "stdin" | undefined =
    parsed.taskSource;
  if (task === undefined && parsed.taskFile !== undefined) {
    try {
      task = fs.readFileSync(parsed.taskFile, "utf8").trim();
      taskSource = "file";
    } catch {
      io.writeErr(`task-file not readable: ${parsed.taskFile}\n`);
      return 2;
    }
  }
  if ((task === undefined || task === "") && input.readStdin) {
    const piped = (await input.readStdin()).trim();
    if (piped.length > 0) {
      task = piped;
      taskSource = "stdin";
    }
  }
  if (task === undefined || task === "") {
    io.writeErr(`no task provided.\n\n${USAGE_TEXT}`);
    return 2;
  }
  void taskSource;

  // --- resolve + validate Config; fail fast on misconfiguration (ERR-015). ---
  let config: Config;
  try {
    config = resolveConfig({
      flags: {
        task,
        root: parsed.root,
        modelId: parsed.modelId,
        auto: parsed.auto,
        maxIterations: parsed.maxIterations,
        tokenBudget: parsed.tokenBudget,
        configFile: parsed.configFile,
      },
      env: input.env,
      cwd: input.cwd,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      io.writeErr(err.message.endsWith("\n") ? err.message : err.message + "\n");
      return 2;
    }
    throw err;
  }

  // --- drive the run; exit code is the outcome's (0 iff succeeded — INV-006). ---
  const runId = input.runId ?? newRunId();
  const outcome = await composeAndRun({
    config,
    runId,
    transcriptDir: input.transcriptDir,
    llm: input.llm,
    commandRunner: input.commandRunner,
    confirm: input.confirm,
    confirmCommand: input.confirmCommand,
  });
  return outcome.exitCode;
}

/**
 * Resolve the config-file path the allowlist subcommand reads from and persists to.
 * Uses `--config` when supplied (highest precedence); otherwise a default file
 * (`.autocoder.json`) in the working directory (`input.cwd` / process cwd). The path
 * is resolved absolutely so the write target is unambiguous.
 */
function resolveAllowlistConfigFile(parsed: ParsedAllowlistArgs, cwd: string): string {
  const target = parsed.configFile ?? path.join(cwd, DEFAULT_CONFIG_FILE);
  return path.resolve(target);
}

/**
 * The allowlist-management subcommand body (SLICE-9 / REQ-025, RULE-014). NO agent loop
 * is started: CLI → Allowlist Manager (set ops, idempotent on membership) → Config
 * persists the change to the config file → Reporter confirms (Architecture §Secondary
 * flow). A persistence failure (FAIL-004) is reported to stderr with a NON-ZERO exit —
 * the in-memory mutation is never silently treated as "saved".
 *
 * Transcript note (no-loop mode): an `allowlist-changed` TranscriptEntry (IF-015) is a
 * per-RUN audit row keyed to a runId; the allowlist subcommand starts no run and opens
 * no transcript, so there is no run context to append it to. Per the architecture
 * secondary flow ("Reporter confirms"), the mutating op surfaces the change via the
 * Reporter's `streamAllowlistChanged` instead — carrying the SAME `{op, pattern}` data
 * the transcript payload would (documented choice; see DRIFT entry / 07-contracts.md).
 */
async function runAllowlist(
  parsed: ParsedAllowlistArgs,
  input: RunCliInput,
  io: CliIo,
): Promise<number> {
  const cwd = input.cwd ?? process.cwd();
  const configFile = resolveAllowlistConfigFile(parsed, cwd);
  const fsSeam = input.configFs;
  // Reuse the reporter for confirmation output (one output path — design note). The
  // reporter writes to stdout; bridge it to the injected CliIo so tests capture it.
  const reporter = createReporter({ out: { write: (t) => io.writeOut(t) } });
  const { action, pattern } = parsed.invocation;

  try {
    if (action === "list") {
      const entries = inspectAllowlist({ configFile, io: fsSeam });
      reporter.streamAllowlist(entries.map((e) => e.pattern));
      return 0;
    }

    // add | remove: the parser guarantees a pattern is present for these actions.
    const op = action; // "add" | "remove"
    const result = mutateAllowlist(op, pattern as string, { configFile, io: fsSeam });
    reporter.streamAllowlistChanged(op, result.pattern, result.changed);
    return 0;
  } catch (err) {
    if (err instanceof AllowlistPersistError) {
      // FAIL-004: surface the persistence failure on stderr; non-zero exit. No "saved"
      // line was printed (the confirmation is emitted only AFTER a successful persist).
      io.writeErr(err.message.endsWith("\n") ? err.message : err.message + "\n");
      return 1;
    }
    throw err;
  }
}

/**
 * Direct-invocation entry (the `autocoder` bin). The real LlmClient + CommandRunner
 * seams (SDK-backed / shell-backed) are not built in this slice, so a direct `run`
 * from the terminal cannot execute the loop yet — but argv parsing, --help, usage
 * errors, and config fail-fast ARE wired through `runCli` and exercised by tests.
 * This guard keeps the bin entry present (IF-014) without inventing the production
 * seams, which land in a later slice.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  // --help and usage errors are fully serviceable without the production seams.
  if (parsed.kind === "help") {
    process.stdout.write(USAGE_TEXT);
    process.exitCode = 0;
    return;
  }
  process.stderr.write(
    "autocoder: the production LlmClient/CommandRunner seams are not wired yet " +
      "(slice build in progress). Run via the test harness with injected seams.\n",
  );
  process.exitCode = 2;
}

// Run main only when executed directly (not when imported by tests). Compare the
// resolved invoked script path to this module's path, normalized via pathToFileURL.
const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedHref) {
  void main();
}
