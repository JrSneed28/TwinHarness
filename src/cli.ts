#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectPaths } from "./core/paths";
import { type CommandResult, renderResult, failure, success } from "./core/output";
import { runInit } from "./commands/init";
import { runStateGet, runStateSet, runStateStatus, runStateVerify } from "./commands/state";
import { runReviseBump, runReviseStatus, runReviseReset } from "./commands/revise";
import { runTierClassify, runTierVetoCheck } from "./commands/tier";
import { runArtifactRegister, runArtifactList } from "./commands/artifact";
import { runCoverageCheck, runCoverageReport } from "./commands/coverage";
import { runVerifyRun, runVerifyAdd, runVerifyList, runVerifyClear } from "./commands/verify";
import { runNext } from "./commands/next";
import { runBuildPlan } from "./commands/build";
import { runAnchorsScan } from "./commands/anchors";
import { runDriftAdd, runDriftList, runDriftResolve } from "./commands/drift";
import { runTraceRender } from "./commands/trace";
import { runStale } from "./commands/stale";
import { runHookStopGate, runHookPretoolGate, type StopHookInput, type PreToolHookInput } from "./commands/hook";
import { runSlicesSync, runSliceSetStatus } from "./commands/slices";
import { runMigrate } from "./commands/migrate";
import { runDoctor } from "./commands/doctor";
import { runContextEstimate, runContextPack } from "./commands/context";
import { runStageCurrent, runStageDescribe, runStageList } from "./commands/stage";
import { runManifestExport } from "./commands/manifest";

const HELP = `th — TwinHarness mechanical CLI (records and computes; never decides)

Usage:
  th init [--force]                 Scaffold docs/, .twinharness/state.json, drift-log.md
  th state get [dotted.path]        Print state.json (or one value)
  th state set <dotted.key> <value> Patch state.json (refuses invalid results; rejects unknown keys)
  th state status                   Human-readable tier/stage/gate snapshot
  th state verify                   Validate state.json (exit 0 = valid)
  th revise bump <mode> [--cap N]   Increment revise-loop count (computes escalate = count >= cap)
  th revise status <mode> [--cap N] Report revise-loop count + cap (no mutation)
  th revise reset <mode>            Zero revise-loop count (stage passed / zero issues)
  th tier classify <brief.json>     Advisory Tier-0 eligibility + detected blast-radius flags
  th tier veto-check <brief.json>   Mechanical veto gate (exit 3 when a blast-radius flag forbids T0)
  th artifact register <file> --version <n>  Content-hash a file and record it in approved_artifacts
  th artifact list                  List recorded approved artifacts (file, version, hash)
  th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]
                                    Verify every (MVP) REQ-ID maps to ≥1 slice and ≥1 test (hard gate)
  th coverage report [--reqs F] [--plan F] [--tests D] [--scope F] [--code D]
                                    Planned/implemented/tested/passing breakdown per REQ-ID (status view)
  th verify add "<command>"         Add a project test/check command to the verify list
  th verify list                    Show configured verify commands
  th verify clear                   Remove all configured verify commands
  th verify run                     Run every configured verify command; writes a report; exit 1 on failure
  th build plan [--include-done]    Schedule slices into conflict-free build waves (§16: disjoint parallelize, shared serialize)
  th anchors scan [--scan-reqs] [--scan-tests] [--scan-code] [--strict]  Map REQ-anchors across docs/tests/src; report orphans
  th trace render                   Render the §17 traceability view from anchors (on demand; never stored)
  th stale --since <hash>           Compute the diff-scoped downstream artifacts made stale by an upstream change (§18)
  th stale --artifact <file>        Same as --since but look up the artifact by file key (safe after re-register)
  th slices sync [--plan F] [--dry-run] [--remove-missing]
                                    Upsert state.slices from the implementation plan
  th slice set-status <SLICE-ID> <status>  Set a single slice's status (pending|in-progress|done|blocked)
  th drift add --layer <derived|requirement> [--ref ...] [--discovery ...] [--action ...] [--escalation ...] [--source ...]
                                    Append a §10 drift entry
  th drift list                     List drift entries + open blocking count
  th drift resolve <DRIFT-NNN>      Append a resolution note; decrement blocking counter only for requirement-layer entries
  th hook stop-gate                 Emit a Claude Code Stop-hook decision
  th hook pretool-gate              Emit a Claude Code PreToolUse write-gate decision
  th migrate                        Upgrade state.json to the current schema version
  th doctor                         Self-diagnostic + run-health audit (env, state, artifacts, coverage, slices, revise loops)
  th next                           The next mechanical obligation the run owes (next-action oracle)
  th context estimate               Approximate the prompt-surface token cost (flags oversized files)
  th context pack [--slice <ID>]    Assemble the §9 handoff bundle (artifact Summary blocks + slice framing)
  th stage current|describe <s>|list  Per-stage contract (produces/critic/gate) from the pipeline
  th manifest export                Deterministic run snapshot (state + drift + ledger); --json for full
  th version                        Print the CLI version
  th help                           Show this help

Global flags:
  --json            Emit machine-readable JSON on stdout
  --cwd <dir>       Operate against <dir> instead of the current directory
  --cap <n>         (revise) Override the revise-loop cap (default 3)
  --version <n>     (artifact register) Artifact version (positive integer)
  --reqs <file>     (coverage) Requirements file (default docs/01-requirements.md)
  --plan <file>     (coverage, slices sync) Implementation-plan file (default docs/09-implementation-plan.md)
  --tests <dir>     (coverage) Tests directory (default tests)
  --scope <file>    (coverage) Scope file for MVP filtering (default docs/02-scope.md)
  --code <dir>      (coverage report) Code directory scanned for implemented (default src)
  --slice <id>      (context pack) Frame the pack for a specific slice (SLICE-ID)
  --include-done    (build plan) Include slices with status done (default: only unfinished)
  --scan-reqs       (anchors) Scan docs/ for REQ-anchors
  --scan-tests      (anchors) Scan tests/ for REQ-anchors
  --scan-code       (anchors) Scan src/ for REQ-anchors
  --strict          (anchors) Exit 1 when orphan anchors are found
  --since <hash>    (stale) Recorded hash of the upstream artifact to check
  --artifact <file> (stale) Root-relative file key of the artifact to check
  --layer <l>       (drift add) derived | requirement (required)
  --ref <s>         (drift add) SLICE-x / TASK-y reference
  --discovery <s>   (drift add) What was discovered
  --action <s>      (drift add) Action taken
  --escalation <s>  (drift add) Escalation status
  --source <s>      (drift add) Who logged the entry (default: Builder)
  --dry-run         (slices sync) Compute without writing state
  --remove-missing  (slices sync) Remove slices absent from the plan
  --force           (init) Reset existing state.json`;

interface ParsedArgs {
  positionals: string[];
  flags: {
    json: boolean;
    force: boolean;
    cwd: string;
    cap?: number;
    version?: number;
    reqs?: string;
    plan?: string;
    tests?: string;
    scope?: string;
    code?: string;
    slice?: string;
    includeDone: boolean;
    scanReqs: boolean;
    scanTests: boolean;
    scanCode: boolean;
    strict: boolean;
    since?: string;
    artifact?: string;
    layer?: string;
    ref?: string;
    discovery?: string;
    action?: string;
    escalation?: string;
    source?: string;
    dryRun: boolean;
    removeMissing: boolean;
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let json = false;
  let force = false;
  let cwd = process.cwd();
  let cap: number | undefined;
  let version: number | undefined;
  let reqs: string | undefined;
  let plan: string | undefined;
  let tests: string | undefined;
  let scope: string | undefined;
  let code: string | undefined;
  let slice: string | undefined;
  let includeDone = false;
  let scanReqs = false;
  let scanTests = false;
  let scanCode = false;
  let strict = false;
  let since: string | undefined;
  let artifact: string | undefined;
  let layer: string | undefined;
  let ref: string | undefined;
  let discovery: string | undefined;
  let action: string | undefined;
  let escalation: string | undefined;
  let source: string | undefined;
  let dryRun = false;
  let removeMissing = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--force") force = true;
    else if (a === "--cwd") cwd = argv[++i] ?? process.cwd();
    else if (a.startsWith("--cwd=")) cwd = a.slice("--cwd=".length);
    else if (a === "--cap") cap = Number(argv[++i]);
    else if (a.startsWith("--cap=")) cap = Number(a.slice("--cap=".length));
    else if (a === "--version") version = Number(argv[++i]);
    else if (a.startsWith("--version=")) version = Number(a.slice("--version=".length));
    else if (a === "--reqs") reqs = argv[++i];
    else if (a.startsWith("--reqs=")) reqs = a.slice("--reqs=".length);
    else if (a === "--plan") plan = argv[++i];
    else if (a.startsWith("--plan=")) plan = a.slice("--plan=".length);
    else if (a === "--tests") tests = argv[++i];
    else if (a.startsWith("--tests=")) tests = a.slice("--tests=".length);
    else if (a === "--scope") scope = argv[++i];
    else if (a.startsWith("--scope=")) scope = a.slice("--scope=".length);
    else if (a === "--code") code = argv[++i];
    else if (a.startsWith("--code=")) code = a.slice("--code=".length);
    else if (a === "--slice") slice = argv[++i];
    else if (a.startsWith("--slice=")) slice = a.slice("--slice=".length);
    else if (a === "--include-done") includeDone = true;
    else if (a === "--scan-reqs") scanReqs = true;
    else if (a === "--scan-tests") scanTests = true;
    else if (a === "--scan-code") scanCode = true;
    else if (a === "--strict") strict = true;
    else if (a === "--since") since = argv[++i];
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a === "--artifact") artifact = argv[++i];
    else if (a.startsWith("--artifact=")) artifact = a.slice("--artifact=".length);
    else if (a === "--layer") layer = argv[++i];
    else if (a.startsWith("--layer=")) layer = a.slice("--layer=".length);
    else if (a === "--ref") ref = argv[++i];
    else if (a.startsWith("--ref=")) ref = a.slice("--ref=".length);
    else if (a === "--discovery") discovery = argv[++i];
    else if (a.startsWith("--discovery=")) discovery = a.slice("--discovery=".length);
    else if (a === "--action") action = argv[++i];
    else if (a.startsWith("--action=")) action = a.slice("--action=".length);
    else if (a === "--escalation") escalation = argv[++i];
    else if (a.startsWith("--escalation=")) escalation = a.slice("--escalation=".length);
    else if (a === "--source") source = argv[++i];
    else if (a.startsWith("--source=")) source = a.slice("--source=".length);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--remove-missing") removeMissing = true;
    else positionals.push(a);
  }
  return {
    positionals,
    flags: {
      json,
      force,
      cwd,
      cap,
      version,
      reqs,
      plan,
      tests,
      scope,
      code,
      slice,
      includeDone,
      scanReqs,
      scanTests,
      scanCode,
      strict,
      since,
      artifact,
      layer,
      ref,
      discovery,
      action,
      escalation,
      source,
      dryRun,
      removeMissing,
    },
  };
}

/**
 * Read the CLI version from package.json. Tries `__dirname/../package.json`
 * (dist/cli.js → ../package.json) then `__dirname/../../package.json`
 * (src/cli.ts in ts-node/test context). Returns "unknown" if neither is found
 * or parsing fails.
 */
function readCliVersion(): string {
  const candidates = [
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const json = JSON.parse(fs.readFileSync(candidate, "utf8")) as unknown;
        if (typeof json === "object" && json !== null && "version" in json) {
          const v = (json as Record<string, unknown>).version;
          if (typeof v === "string") return v;
        }
      }
    } catch {
      // Try next candidate.
    }
  }
  return "unknown";
}

function dispatch(parsed: ParsedArgs): CommandResult {
  const paths = resolveProjectPaths(parsed.flags.cwd);
  const [group, sub, ...rest] = parsed.positionals;
  switch (group) {
    case undefined:
      return failure({ human: HELP });
    case "help":
      return { ok: true, exitCode: 0, human: HELP };
    case "version": {
      const ver = readCliVersion();
      return success({ data: { version: ver }, human: ver });
    }
    case "init":
      return runInit(paths, { force: parsed.flags.force });
    case "migrate":
      return runMigrate(paths);
    case "doctor":
      return runDoctor(paths);
    case "next":
      return runNext(paths);
    case "context":
      switch (sub) {
        case "estimate":
          return runContextEstimate();
        case "pack":
          return runContextPack(paths, { slice: parsed.flags.slice });
        default:
          return failure({ human: `unknown 'context' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "stage":
      switch (sub) {
        case "current":
          return runStageCurrent(paths);
        case "describe":
          return runStageDescribe(rest[0]);
        case "list":
          return runStageList();
        default:
          return failure({ human: `unknown 'stage' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "manifest":
      switch (sub) {
        case "export":
          return runManifestExport(paths);
        default:
          return failure({ human: `unknown 'manifest' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "state":
      switch (sub) {
        case "get":
          return runStateGet(paths, rest[0]);
        case "set":
          if (rest.length < 2) return failure({ human: "usage: th state set <dotted.key> <value>" });
          return runStateSet(paths, rest[0]!, rest.slice(1).join(" "));
        case "status":
          return runStateStatus(paths);
        case "verify":
          return runStateVerify(paths);
        default:
          return failure({ human: `unknown 'state' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "tier":
      switch (sub) {
        case "classify":
          return runTierClassify(paths, rest[0]);
        case "veto-check":
          return runTierVetoCheck(paths, rest[0]);
        default:
          return failure({ human: `unknown 'tier' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "artifact":
      switch (sub) {
        case "register":
          return runArtifactRegister(paths, rest[0], parsed.flags.version);
        case "list":
          return runArtifactList(paths);
        default:
          return failure({ human: `unknown 'artifact' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "coverage":
      switch (sub) {
        case "check":
          return runCoverageCheck(paths, {
            reqsFile: parsed.flags.reqs,
            planFile: parsed.flags.plan,
            testsDir: parsed.flags.tests,
            scopeFile: parsed.flags.scope,
          });
        case "report":
          return runCoverageReport(paths, {
            reqsFile: parsed.flags.reqs,
            planFile: parsed.flags.plan,
            testsDir: parsed.flags.tests,
            scopeFile: parsed.flags.scope,
            codeDir: parsed.flags.code,
          });
        default:
          return failure({ human: `unknown 'coverage' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "verify":
      switch (sub) {
        case "run":
          return runVerifyRun(paths);
        case "add":
          return runVerifyAdd(paths, rest.join(" "));
        case "list":
          return runVerifyList(paths);
        case "clear":
          return runVerifyClear(paths);
        default:
          return failure({ human: `unknown 'verify' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "build":
      switch (sub) {
        case "plan":
          return runBuildPlan(paths, { includeDone: parsed.flags.includeDone });
        default:
          return failure({ human: `unknown 'build' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "anchors":
      switch (sub) {
        case "scan":
          return runAnchorsScan(paths, {
            reqs: parsed.flags.scanReqs,
            tests: parsed.flags.scanTests,
            code: parsed.flags.scanCode,
            strict: parsed.flags.strict,
          });
        default:
          return failure({ human: `unknown 'anchors' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "trace":
      switch (sub) {
        case "render":
          return runTraceRender(paths);
        default:
          return failure({ human: `unknown 'trace' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "stale":
      return runStale(paths, parsed.flags.since, parsed.flags.artifact);
    case "slices":
      switch (sub) {
        case "sync":
          return runSlicesSync(paths, {
            planFile: parsed.flags.plan,
            dryRun: parsed.flags.dryRun,
            removeMissing: parsed.flags.removeMissing,
          });
        default:
          return failure({ human: `unknown 'slices' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "slice":
      switch (sub) {
        case "set-status":
          return runSliceSetStatus(paths, rest[0], rest[1]);
        default:
          return failure({ human: `unknown 'slice' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "drift":
      switch (sub) {
        case "add":
          return runDriftAdd(paths, {
            layer: parsed.flags.layer,
            ref: parsed.flags.ref,
            discovery: parsed.flags.discovery,
            action: parsed.flags.action,
            escalation: parsed.flags.escalation,
            source: parsed.flags.source,
          });
        case "list":
          return runDriftList(paths);
        case "resolve":
          return runDriftResolve(paths, rest[0]);
        default:
          return failure({ human: `unknown 'drift' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "revise": {
      const mode = rest[0];
      if (!mode) return failure({ human: `usage: th revise ${sub ?? "<bump|status|reset>"} <mode> [--cap N]` });
      const cap = parsed.flags.cap;
      if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
        return failure({ human: "--cap must be a positive integer" });
      }
      switch (sub) {
        case "bump":
          return runReviseBump(paths, mode, cap);
        case "status":
          return runReviseStatus(paths, mode, cap);
        case "reset":
          return runReviseReset(paths, mode);
        default:
          return failure({ human: `unknown 'revise' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    }
    default:
      return failure({ human: `unknown command: ${group}\n\n${HELP}` });
  }
}

/**
 * Best-effort read of the Claude Code hook payload from stdin. Hooks always
 * receive piped JSON; a TTY means a human ran the command by hand, so skip
 * reading rather than hang waiting for EOF. Malformed/absent input → undefined.
 * The type parameter lets callers narrow the returned object for their hook.
 */
function readHookStdin<T extends object>(): T | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));

  // Hook commands speak the Claude Code hook protocol on stdout (not --json).
  if (parsed.positionals[0] === "hook") {
    if (parsed.positionals[1] === "stop-gate") {
      const paths = resolveProjectPaths(parsed.flags.cwd);
      const out = runHookStopGate(paths, readHookStdin<StopHookInput>());
      process.stdout.write(out.stdout + "\n");
      process.exit(out.exitCode);
    }
    if (parsed.positionals[1] === "pretool-gate") {
      // Prefer the payload's cwd for path resolution when --cwd was not explicitly passed.
      const stdinPayload = readHookStdin<PreToolHookInput>();
      const cwdFromStdin = stdinPayload?.cwd;
      const effectiveCwd =
        cwdFromStdin && !process.argv.includes("--cwd") ? cwdFromStdin : parsed.flags.cwd;
      const paths = resolveProjectPaths(effectiveCwd);
      const out = runHookPretoolGate(paths, stdinPayload);
      process.stdout.write(out.stdout + "\n");
      process.exit(out.exitCode);
    }
  }

  const result = dispatch(parsed);
  process.stdout.write(renderResult(result, parsed.flags.json) + "\n");
  process.exit(result.exitCode);
}

main();
