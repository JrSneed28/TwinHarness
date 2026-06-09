#!/usr/bin/env node
import * as fs from "node:fs";
import { resolveProjectPaths } from "./core/paths";
import { type CommandResult, renderResult, failure } from "./core/output";
import { runInit } from "./commands/init";
import { runStateGet, runStateSet, runStateStatus, runStateVerify } from "./commands/state";
import { runReviseBump, runReviseStatus, runReviseReset } from "./commands/revise";
import { runTierClassify, runTierVetoCheck } from "./commands/tier";
import { runArtifactRegister, runArtifactList } from "./commands/artifact";
import { runCoverageCheck } from "./commands/coverage";
import { runBuildPlan } from "./commands/build";
import { runAnchorsScan } from "./commands/anchors";
import { runDriftAdd, runDriftList, runDriftResolve } from "./commands/drift";
import { runTraceRender } from "./commands/trace";
import { runStale } from "./commands/stale";
import { runHookStopGate, type StopHookInput } from "./commands/hook";

const HELP = `th — TwinHarness mechanical CLI (records and computes; never decides)

Usage:
  th init [--force]                 Scaffold docs/, .agentic-sdlc/state.json, drift-log.md
  th state get [dotted.path]        Print state.json (or one value)
  th state set <dotted.key> <value> Patch state.json (refuses invalid results)
  th state status                   Human-readable tier/stage/gate snapshot
  th state verify                   Validate state.json (exit 0 = valid)
  th revise bump <mode> [--cap N]   Increment revise-loop count (computes escalate = count >= cap)
  th revise status <mode> [--cap N] Report revise-loop count + cap (no mutation)
  th revise reset <mode>            Zero revise-loop count (stage passed / zero issues)
  th tier classify <brief.json>     Advisory Tier-0 eligibility + detected blast-radius flags
  th tier veto-check <brief.json>   Mechanical veto gate (exit 3 when a blast-radius flag forbids T0)
  th artifact register <file> --version <n>  Content-hash a file and record it in approved_artifacts
  th artifact list                  List recorded approved artifacts (file, version, hash)
  th coverage check [--reqs F] [--plan F] [--tests D]  Verify every REQ-ID maps to ≥1 slice and ≥1 test
  th build plan [--include-done]    Schedule slices into conflict-free build waves (§16: disjoint parallelize, shared serialize)
  th anchors scan [--scan-reqs] [--scan-tests] [--scan-code] [--strict]  Map REQ-anchors across docs/tests/src; report orphans
  th trace render                   Render the §17 traceability view from anchors (on demand; never stored)
  th stale --since <hash>           Compute the diff-scoped downstream artifacts made stale by an upstream change (§18)
  th drift add --layer <derived|requirement> [--ref ...] [--discovery ...] [--action ...] [--escalation ...]  Append a §10 drift entry
  th drift list                     List drift entries + open blocking count
  th drift resolve <DRIFT-NNN>      Append a resolution note and clear one blocking drift
  th hook stop-gate                 Emit a Claude Code Stop-hook decision
  th help                           Show this help

Global flags:
  --json            Emit machine-readable JSON on stdout
  --cwd <dir>       Operate against <dir> instead of the current directory
  --cap <n>         (revise) Override the revise-loop cap (default 3)
  --version <n>     (artifact register) Artifact version (positive integer)
  --reqs <file>     (coverage) Requirements file (default docs/01-requirements.md)
  --plan <file>     (coverage) Implementation-plan file (default docs/09-implementation-plan.md)
  --tests <dir>     (coverage) Tests directory (default tests)
  --include-done    (build plan) Include slices with status done (default: only unfinished)
  --scan-reqs       (anchors) Scan docs/ for REQ-anchors
  --scan-tests      (anchors) Scan tests/ for REQ-anchors
  --scan-code       (anchors) Scan src/ for REQ-anchors
  --strict          (anchors) Exit 1 when orphan anchors are found
  --since <hash>    (stale) Recorded hash of the upstream artifact to check (required)
  --layer <l>       (drift add) derived | requirement (required)
  --ref <s>         (drift add) SLICE-x / TASK-y reference
  --discovery <s>   (drift add) What was discovered
  --action <s>      (drift add) Action taken
  --escalation <s>  (drift add) Escalation status
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
    includeDone: boolean;
    scanReqs: boolean;
    scanTests: boolean;
    scanCode: boolean;
    strict: boolean;
    since?: string;
    layer?: string;
    ref?: string;
    discovery?: string;
    action?: string;
    escalation?: string;
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
  let includeDone = false;
  let scanReqs = false;
  let scanTests = false;
  let scanCode = false;
  let strict = false;
  let since: string | undefined;
  let layer: string | undefined;
  let ref: string | undefined;
  let discovery: string | undefined;
  let action: string | undefined;
  let escalation: string | undefined;
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
    else if (a === "--include-done") includeDone = true;
    else if (a === "--scan-reqs") scanReqs = true;
    else if (a === "--scan-tests") scanTests = true;
    else if (a === "--scan-code") scanCode = true;
    else if (a === "--strict") strict = true;
    else if (a === "--since") since = argv[++i];
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
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
      includeDone,
      scanReqs,
      scanTests,
      scanCode,
      strict,
      since,
      layer,
      ref,
      discovery,
      action,
      escalation,
    },
  };
}

function dispatch(parsed: ParsedArgs): CommandResult {
  const paths = resolveProjectPaths(parsed.flags.cwd);
  const [group, sub, ...rest] = parsed.positionals;
  switch (group) {
    case undefined:
      return failure({ human: HELP });
    case "help":
      return { ok: true, exitCode: 0, human: HELP };
    case "init":
      return runInit(paths, { force: parsed.flags.force });
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
          });
        default:
          return failure({ human: `unknown 'coverage' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
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
      return runStale(paths, parsed.flags.since);
    case "drift":
      switch (sub) {
        case "add":
          return runDriftAdd(paths, {
            layer: parsed.flags.layer,
            ref: parsed.flags.ref,
            discovery: parsed.flags.discovery,
            action: parsed.flags.action,
            escalation: parsed.flags.escalation,
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
 */
function readHookStdin(): StopHookInput | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as StopHookInput;
  } catch {
    return undefined;
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));

  // Hook commands speak the Claude Code hook protocol on stdout (not --json).
  if (parsed.positionals[0] === "hook" && parsed.positionals[1] === "stop-gate") {
    const paths = resolveProjectPaths(parsed.flags.cwd);
    const out = runHookStopGate(paths, readHookStdin());
    process.stdout.write(out.stdout + "\n");
    process.exit(out.exitCode);
  }

  const result = dispatch(parsed);
  process.stdout.write(renderResult(result, parsed.flags.json) + "\n");
  process.exit(result.exitCode);
}

main();
