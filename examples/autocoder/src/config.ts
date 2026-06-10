/**
 * Config resolution (IF-017) — full schema, SLICE-1 / TASK-003.
 *
 * Merge configuration from flags > environment > config file > built-in defaults
 * into one resolved `Config` (RULE-016 precedence), resolve and validate the
 * WorkingRoot (default cwd, or `--cwd`/`--root`; must be an existing directory),
 * and FAIL FAST with an actionable message + non-zero exit (CONFIG_INVALID /
 * ERR-015) when `ANTHROPIC_API_KEY` is missing or the root is invalid — BEFORE any
 * AgentRun is constructed (REQ-NFR-006).
 *
 * Realizes: REQ-018 (precedence + sources), REQ-002 (working-root resolution +
 * validation). This completes the DRIFT-001 deferral: the Config is now the full
 * IF-017 shape (editMode/commandMode/maxIterations/tokenBudget/allowlist).
 *
 * SENSITIVE: `apiKey` is read from env and is never serialized — there is no
 * code path here that logs or stringifies it (the redaction assertion is SLICE-8).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AllowlistEntry,
  CommandMode,
  Config,
  EditMode,
} from "./contracts.js";

/** Built-in defaults (IF-017). */
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_EDIT_MODE: EditMode = "confirm-each";
const DEFAULT_COMMAND_MODE: CommandMode = "allowlist-confirm";
const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_TOKEN_BUDGET = 1_000_000;
/** Default allowlist = safe read-only commands (detected test/build cmd is SLICE-9). */
const DEFAULT_ALLOWLIST: AllowlistEntry[] = [
  { pattern: "git status" },
  { pattern: "git diff" },
  { pattern: "ls" },
  { pattern: "cat" },
];

/** The CONFIG_INVALID error code (ERR-015, Channel B fail-fast). */
export const CONFIG_INVALID = "CONFIG_INVALID";

/**
 * Raised when resolution fails the RULE-016 preconditions (missing apiKey or
 * invalid root). The composition root catches this, writes `message` to stderr,
 * and exits non-zero — before any AgentRun is constructed.
 */
export class ConfigError extends Error {
  readonly code = CONFIG_INVALID;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Flag-layer inputs (highest precedence). These come from the parsed argv
 * (`src/args.ts`); only fields the user supplied are set.
 */
export interface ConfigFlags {
  task: string;
  root?: string;
  modelId?: string;
  /** --yes/--auto: sets BOTH editMode and commandMode to "auto". */
  auto?: boolean;
  maxIterations?: number;
  tokenBudget?: number;
  configFile?: string;
}

/** Environment layer (second precedence). Injectable for deterministic tests. */
export interface ConfigEnv {
  ANTHROPIC_API_KEY?: string;
  AUTOCODER_MODEL?: string;
  AUTOCODER_ROOT?: string;
  AUTOCODER_MAX_ITERATIONS?: string;
  AUTOCODER_TOKEN_BUDGET?: string;
}

/** Shape read from an optional config file (third precedence). */
interface ConfigFile {
  modelId?: string;
  root?: string;
  editMode?: EditMode;
  commandMode?: CommandMode;
  maxIterations?: number;
  tokenBudget?: number;
  allowlist?: AllowlistEntry[];
}

/**
 * The minimal filesystem seam the allowlist-management write-back needs (SLICE-9 /
 * TASK-018, RULE-014). It is injectable so a test can simulate a PERSISTENCE FAILURE
 * (disk full / permission) deterministically — without touching the real disk — and
 * assert the non-zero exit / "no silent saved" behavior (FAIL-004). The default
 * binds to `node:fs` synchronous calls.
 *
 * `readFileSync` MAY throw `ENOENT` for a not-yet-existing config file (the manager
 * treats that as "start from the resolved/default allowlist"). `writeFileSync` is the
 * persistence step whose failure must surface (never be swallowed).
 */
export interface ConfigFsSeam {
  readFileSync(filePath: string): string;
  writeFileSync(filePath: string, data: string): void;
}

/** Default FS seam — real `node:fs`, used in production. */
const defaultConfigFs: ConfigFsSeam = {
  readFileSync: (filePath) => fs.readFileSync(filePath, "utf8"),
  writeFileSync: (filePath, data) => fs.writeFileSync(filePath, data, "utf8"),
};

export interface ResolveConfigInput {
  flags: ConfigFlags;
  /** Injected for tests; defaults to `process.env`. */
  env?: ConfigEnv;
  /** Injected for tests; defaults to `process.cwd()`. */
  cwd?: string;
}

/** Read + parse an optional JSON config file; throws ConfigError on malformed JSON. */
function readConfigFile(filePath: string): ConfigFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new ConfigError(
      `config file not found: ${filePath}\n` +
        `  → check the --config path, or omit it to use flags/env/defaults.`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as ConfigFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new ConfigError(
      `config file is not valid JSON: ${filePath}\n` +
        `  → fix the JSON syntax or remove --config.`,
    );
  }
}

/** Parse a positive-integer env value; ignored (undefined) when not > 0. */
function envPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : undefined;
}

/**
 * Resolve the full IF-017 Config with precedence flags > env > file > defaults,
 * validate the WorkingRoot, and fail fast (ConfigError → CONFIG_INVALID) on a
 * missing API key or an invalid root. The resolved Config is complete and
 * validated before it is returned — misconfiguration never reaches the loop.
 */
export function resolveConfig(input: ResolveConfigInput): Config {
  const env = input.env ?? (process.env as ConfigEnv);
  const cwd = input.cwd ?? process.cwd();
  const flags = input.flags;

  const file: ConfigFile = flags.configFile ? readConfigFile(flags.configFile) : {};

  // --- apiKey: env-primary (SENSITIVE). Required (RULE-016). ---
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new ConfigError(
      `${CONFIG_INVALID}: ANTHROPIC_API_KEY is not set.\n` +
        `  → Set it in your environment, e.g.:\n` +
        `      export ANTHROPIC_API_KEY=sk-ant-...\n` +
        `  Autocoder needs an Anthropic API key to run the agent loop.`,
    );
  }

  // --- root: flags > env > file > default(cwd). Must be an existing directory. ---
  const rootInput =
    flags.root ?? env.AUTOCODER_ROOT ?? file.root ?? cwd;
  const resolvedRoot = path.resolve(rootInput);
  let rootStat: fs.Stats | undefined;
  try {
    rootStat = fs.statSync(resolvedRoot);
  } catch {
    rootStat = undefined;
  }
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new ConfigError(
      `${CONFIG_INVALID}: working root is not an existing directory: ${resolvedRoot}\n` +
        `  → Pass --cwd/--root pointing at the target repository, or run from inside it.`,
    );
  }

  // --- modelId: flags > env > file > default. ---
  const modelId =
    flags.modelId ?? env.AUTOCODER_MODEL ?? file.modelId ?? DEFAULT_MODEL;

  // --- approval modes: --yes/--auto forces both to "auto"; else file > default. ---
  const editMode: EditMode = flags.auto
    ? "auto"
    : file.editMode ?? DEFAULT_EDIT_MODE;
  const commandMode: CommandMode = flags.auto
    ? "auto"
    : file.commandMode ?? DEFAULT_COMMAND_MODE;

  // --- ceilings: flags > env > file > default (always > 0). ---
  const maxIterations =
    flags.maxIterations ??
    envPositiveInt(env.AUTOCODER_MAX_ITERATIONS) ??
    file.maxIterations ??
    DEFAULT_MAX_ITERATIONS;
  const tokenBudget =
    flags.tokenBudget ??
    envPositiveInt(env.AUTOCODER_TOKEN_BUDGET) ??
    file.tokenBudget ??
    DEFAULT_TOKEN_BUDGET;

  // --- allowlist: file > default (add/remove persistence is SLICE-9). ---
  const allowlist =
    Array.isArray(file.allowlist) && file.allowlist.length > 0
      ? file.allowlist
      : DEFAULT_ALLOWLIST;

  return {
    apiKey,
    modelId,
    root: resolvedRoot,
    editMode,
    commandMode,
    maxIterations,
    tokenBudget,
    allowlist,
    task: flags.task,
  };
}

/** Generate a fresh run id (correlates Config → AgentRun → Transcript). */
export function newRunId(): string {
  return `run-${randomUUID()}`;
}

// ===========================================================================
// Allowlist management + persistence (SLICE-9 / TASK-018 — REQ-025, RULE-014)
// ---------------------------------------------------------------------------
// The `autocoder allowlist <list|add|remove>` subcommand inspects/mutates the
// auto-run allowlist and PERSISTS the change to the config file (RULE-014) — no
// agent loop is started (Architecture §Secondary flow). The set operations are
// idempotent on membership (add-existing / remove-absent are no-ops) and a
// persistence-write failure surfaces as a fatal error (FAIL-004) — never a silent
// "saved". This is the SET-MANAGEMENT + write-back half; the MATCHING half lives
// in `allowlist.ts` (SLICE-5, frozen) and is untouched here.
// ===========================================================================

/** The error code surfaced when the allowlist config write-back fails (FAIL-004). */
export const ALLOWLIST_PERSIST_FAILED = "ALLOWLIST_PERSIST_FAILED";

/**
 * Raised when persisting an allowlist mutation to the config file FAILS (disk full /
 * permission — FAIL-004). The CLI catches it, reports the failure to stderr, and exits
 * non-zero; the in-memory mutation is NOT treated as saved (RULE-014). It is distinct
 * from `ConfigError` (resolution-time fail-fast) so the caller can message it precisely.
 */
export class AllowlistPersistError extends Error {
  readonly code = ALLOWLIST_PERSIST_FAILED;
  constructor(message: string, cause?: unknown) {
    super(`${ALLOWLIST_PERSIST_FAILED}: ${message}`, { cause });
    this.name = "AllowlistPersistError";
  }
}

/** A mutating allowlist op (the transcript/reporter `op` discriminant, IF-015). */
export type AllowlistOp = "add" | "remove";

/** The outcome of an allowlist-management operation (REQ-025). */
export interface AllowlistOpResult {
  /** The op performed. */
  op: AllowlistOp;
  /** The pattern operated on. */
  pattern: string;
  /** True iff the set actually changed (false ⇒ idempotent no-op: add-existing / remove-absent). */
  changed: boolean;
  /** The full allowlist AFTER the op (the persisted set). */
  entries: AllowlistEntry[];
}

/**
 * Read the config file's current object (preserving all unrelated fields), or `{}`
 * when the file does not yet exist. A malformed-JSON file is a hard error (we must not
 * clobber a file we cannot parse). Uses the injected FS seam so failure is testable.
 */
function readConfigObject(filePath: string, io: ConfigFsSeam): Record<string, unknown> {
  let raw: string;
  try {
    raw = io.readFileSync(filePath);
  } catch (err) {
    // Not-yet-existing config file → start from an empty object (we will create it).
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return {};
    throw new AllowlistPersistError(`failed to read config file ${filePath}`, err);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    throw new AllowlistPersistError(
      `config file is not valid JSON (refusing to overwrite): ${filePath}`,
      err,
    );
  }
}

/** Read the persisted allowlist from a config file, falling back to `fallback`. */
function currentAllowlist(
  obj: Record<string, unknown>,
  fallback: AllowlistEntry[],
): AllowlistEntry[] {
  const al = obj.allowlist;
  if (Array.isArray(al)) {
    // Keep only well-formed entries (defensive — a hand-edited file may carry junk).
    return al.filter(
      (e): e is AllowlistEntry =>
        !!e && typeof e === "object" && typeof (e as AllowlistEntry).pattern === "string",
    );
  }
  return fallback;
}

/** Inputs shared by the allowlist-management operations. */
export interface AllowlistManagerInput {
  /** The config file to read the current set from and persist the change back to. */
  configFile: string;
  /** The resolved/default allowlist to fall back to when the file has none yet. */
  fallback?: AllowlistEntry[];
  /** Injectable FS seam (default real `node:fs`); a test injects a failing write. */
  io?: ConfigFsSeam;
}

/** Read the current allowlist for inspection (`list`) — no mutation, no persistence. */
export function inspectAllowlist(input: AllowlistManagerInput): AllowlistEntry[] {
  const io = input.io ?? defaultConfigFs;
  const obj = readConfigObject(input.configFile, io);
  return currentAllowlist(obj, input.fallback ?? DEFAULT_ALLOWLIST);
}

/**
 * Apply a mutating allowlist op (add | remove) on SET MEMBERSHIP, then PERSIST the
 * whole config object back to the file (RULE-014). Idempotent: adding an existing
 * pattern or removing an absent one changes nothing (`changed:false`) but is still a
 * success that re-persists the unchanged set (so the file is normalized). A write
 * failure throws `AllowlistPersistError` — the mutation is NOT reported as saved.
 *
 * `pattern` must have length ≥ 1 (AllowlistEntry min len 1, IF-017); an empty pattern
 * is rejected by the caller (`args.ts` requires a positional), but we guard here too.
 */
export function mutateAllowlist(
  op: AllowlistOp,
  pattern: string,
  input: AllowlistManagerInput,
): AllowlistOpResult {
  const io = input.io ?? defaultConfigFs;
  if (pattern.length < 1) {
    throw new AllowlistPersistError("allowlist pattern must be non-empty (min len 1)");
  }
  const obj = readConfigObject(input.configFile, io);
  const current = currentAllowlist(obj, input.fallback ?? DEFAULT_ALLOWLIST);
  const has = current.some((e) => e.pattern === pattern);

  let next: AllowlistEntry[];
  let changed: boolean;
  if (op === "add") {
    changed = !has; // add-existing is a no-op (idempotent on membership).
    next = has ? current : [...current, { pattern }];
  } else {
    changed = has; // remove-absent is a no-op (idempotent on membership).
    next = has ? current.filter((e) => e.pattern !== pattern) : current;
  }

  // Persist the full object with the (possibly unchanged) allowlist — preserving every
  // unrelated config field. A write failure is fatal (FAIL-004): surface, never swallow.
  const merged = { ...obj, allowlist: next };
  try {
    io.writeFileSync(input.configFile, JSON.stringify(merged, null, 2) + "\n");
  } catch (err) {
    throw new AllowlistPersistError(
      `failed to persist allowlist change to ${input.configFile}`,
      err,
    );
  }

  return { op, pattern, changed, entries: next };
}
