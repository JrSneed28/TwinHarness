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
import { runArtifactClaim, runArtifactRelease, runArtifactLeases } from "./commands/artifact-lease";
import { runCollabInit, runCollabFragment, runCollabList, runCollabMerge } from "./commands/collab";
import { runDebateAdd, runDebateList, runDebateResolve } from "./commands/debate";
import { runCoverageCheck, runCoverageReport } from "./commands/coverage";
import { runVerifyRun, runVerifyAdd, runVerifyList, runVerifyClear } from "./commands/verify";
import { runNext } from "./commands/next";
import {
  runBuildPlan,
  runBuildNextWave,
  runBuildDispatch,
  runBuildClaim,
  runBuildRelease,
  runBuildLeases,
  runBuildSubClaim,
  runBuildSubRelease,
} from "./commands/build";
import { runDebugPack, runDebugLogAdd, runDebugLogList } from "./commands/debug";
import { runAnchorsScan } from "./commands/anchors";
import { runDriftAdd, runDriftList, runDriftResolve } from "./commands/drift";
import { runTraceRender } from "./commands/trace";
import { runStale } from "./commands/stale";
import {
  runHookStopGate,
  runHookPretoolGate,
  runHookSubagentStop,
  type StopHookInput,
  type PreToolHookInput,
  type SubagentStopHookInput,
} from "./commands/hook";
import { runSlicesSync, runSliceSetStatus } from "./commands/slices";
import { runMigrate } from "./commands/migrate";
import { runDoctor } from "./commands/doctor";
import { runContextEstimate, runContextPack } from "./commands/context";
import { runStageCurrent, runStageDescribe, runStageList } from "./commands/stage";
import { runManifestExport } from "./commands/manifest";
import { runPreview } from "./commands/preview";
import { runScorecard } from "./commands/scorecard";
import { runTelemetrySet, runTelemetryStatus } from "./commands/telemetry";
import { runRoute } from "./commands/route";
import {
  runDelegatePlan,
  runDelegatePack,
  runDelegateCapsule,
  runDelegateCheck,
} from "./commands/delegate";
import { runRepoMap, runRepoRelevant, runRepoImpact, runRepoCheck } from "./commands/repo";
import {
  runDecisionAdd,
  runDecisionDetect,
  runDecisionList,
  runDecisionApprove,
  runDecisionCheck,
} from "./commands/decision";

const HELP = `th — TwinHarness mechanical CLI (records and computes; never decides)

Usage:
  th init [--force] [--brownfield]  Scaffold docs/, .twinharness/state.json, drift-log.md
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
  th build plan [--include-done] [--advise]  Schedule slices into conflict-free build waves (§16); --advise emits the parallelism-optimizer advisory (max wave width + serializing conflict pairs)
  th build next-wave                Live oracle: slices dispatchable in parallel now (deps done, components free)
  th build dispatch                 Live oracle: full parallel wave + per-slice spawn descriptors in one payload (for single-message batch spawn)
  th build claim|release <SLICE-ID> Take/release a live component lease (collision guard for parallel Builders)
  th build sub-claim <PARENT-SLICE> --components <c1,c2,...>
                                    Open a SUB-lease for a scoped sub-Builder (subset of an in-progress parent's components)
  th build sub-release <SUB-ID>     Release a sub-lease (parent settling already makes it stale)
  th build leases                   List the live component leases (and sub-leases)
  th debug pack [--slice ID|--req REQ]  Assemble a read-only evidence bundle for a failure (Debugger agent)
  th debug log add --ref … --symptom … [--evidence …] [--root-cause …] [--status open|resolved]
  th debug log list                 List debug-log evidence entries + open count
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
  th artifact claim <file#section> --holder <id>  Take a section-level artifact lease (REQ-PCO-041; collision guard for intra-artifact fan-out)
  th artifact release <file#section> --holder <id>  Release a section-level artifact lease
  th artifact leases                List active section-level artifact leases
  th collab init --stage <s>        Initialize a blackboard stage dir (REQ-PCO-040)
  th collab fragment --stage <s> --round <r> --name <n> --text <t> [--force]  Drop a fragment file on the blackboard (refuses to overwrite without --force)
  th collab list --stage <s> [--round <r>]  List blackboard fragments
  th collab merge --stage <s> --round <r>   Concatenate fragments (REQ-anchor-validated) for the Reconciler
  th debate add --topic <t> [--positions ...] [--links a,b] [--source ...]  Open a BLOCKING debate (REQ-PCO-042)
  th debate list                    List debate-ledger entries + open blocking count
  th debate resolve --id <DEBATE-ID> --resolution <r>  Resolve a debate (clears the blocking obligation)
  th drift resolve <DRIFT-NNN>      Append a resolution note; decrement blocking counter only for requirement-layer entries
  th hook stop-gate                 Emit a Claude Code Stop-hook decision
  th hook pretool-gate              Emit a Claude Code PreToolUse write-gate decision
  th hook subagent-stop             Emit a Claude Code SubagentStop-hook decision (state-validity guard)
  th migrate                        Upgrade state.json to the current schema version
  th doctor                         Self-diagnostic + run-health audit (env, state, artifacts, coverage, slices, revise loops)
  th next [--explain]               The next mechanical obligation the run owes (next-action oracle); --explain adds a WHY
  th preview [--tier T<n>]          Pre-run view: engaged stages, human gates, and Critic modes for a tier
  th scorecard                      Post-run one-screen summary (tier/coverage/slices/suite/drift/revise)
  th route [--agent A] [--mode M] [--tier T] [--component-blast] [--summarization]
                                    Advisory model+effort for an agent spawn (computes; the Orchestrator applies)
  th telemetry on|off|status        Toggle/report opt-in, LOCAL-ONLY run telemetry (never sent off-machine)
  th context estimate               Approximate the prompt-surface token cost (flags oversized files)
  th context pack [--slice <ID>]    Assemble the §9 handoff bundle (artifact Summary blocks + slice framing)
  th delegate plan [--intent I] [--files N] [--writes] [--noisy] [--task T] [--slice ID]
                                    Recommend delegate vs keep-main for a task (context-preservation oracle)
  th delegate pack [--agent A] [--slice ID] [--task T] [--intent I]
                                    Assemble a bounded child-agent handoff (reuses context pack for a slice)
  th delegate capsule               Print the blank Delegation Capsule skeleton (the strict return format)
  th delegate check --capsule <path>  Validate a returned capsule has every required section (presence only)
  th repo map [--write|--no-write] [--format <summary|json|md>]
                                    Scan the repo; write .twinharness/repo-map.json + docs/00-repo-map.md (writes by default; --no-write = dry/preview)
  th repo check                     Report whether .twinharness/repo-map.json is fresh vs the working tree (exit 0 fresh / 4 stale / 5 no-map / 1 parse-fail)
  th repo relevant (--slice <ID> | --req <REQ-ID> | --file <path> | --query <kw>)
                   [--maxResults <n>] [--format <slice|req|file|json>]
                                    Precision context: read-first/related/tests/risks for a selector (reads persisted map)
  th repo impact (--file <path> | --component <name|path>) [--format <file|json>]
                                    Pre-edit blast-radius: impacted components, tests, features, risk flags (reads persisted map; no state read)
  th decision detect                Surface advisory decision candidates from ADRs/drift-log/scope/blast-radius flags (read-only; exit 0)
  th decision add --title <t> --rationale <r> [--links a,b] [--proposer <n>]
                                    Record a proposed decision (mints DECISION-NNN; never auto-approves)
  th decision approve <DECISION-ID> [--reject | --supersede <id>] [--as <actor>]
                                    HUMAN-ONLY: interactive-TTY-gated transition (proposed→approved/rejected; approved→superseded). Never an MCP tool.
  th decision check                 Fail (exit 6) when an unapproved decision gates the current stage; else exit 0
  th decision list                  List the decision set (ids/titles/statuses/links/audit), sorted (exit 0; non-zero if the hash chain is broken)
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
  --tier <T0-T3>    (preview) Tier whose engaged pipeline to preview (default: state.tier, else T2)
  --slice <id>      (context/debug pack, delegate) Frame the pack/handoff for a specific slice (SLICE-ID)
  --components <l>  (build sub-claim) Comma-separated component subset for the sub-lease
  --req <REQ-ID>    (debug pack) Frame the pack for a specific REQ-ID
  --symptom <s>     (debug log add) The observed failure
  --evidence <s>    (debug log add) Anchored evidence (file:line / captured output)
  --root-cause <s>  (debug log add) The identified root cause
  --status <s>      (debug log add) open | resolved (default open)
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
  --explain         (next) Include a WHY string: why this obligation is the highest-priority one
  --intent <i>      (delegate) read|write|debug|review|artifact|repo-analysis
  --files <n>       (delegate plan) Expected file reads (delegate when > 3)
  --writes          (delegate plan) The task modifies source code
  --noisy           (delegate plan) The task runs noisy commands / logs / tests / repo scans
  --task <s>        (delegate) Free-text task label (echoed; not parsed)
  --agent <a>       (route, delegate pack) The agent being spawned / delegated to
  --capsule <path>  (delegate check) Capsule file to validate
  --force           (init) Reset existing state.json; (collab fragment) overwrite an existing fragment
  --brownfield      (init) Scaffold a brownfield run (project_mode=brownfield; adopting an existing codebase)
  --write           (repo map) Write the artifacts (default; bare \`th repo map\` writes)
  --no-write        (repo map) Dry/preview: build in memory, write nothing (alias of --dry-run)
  --format <f>      (repo map) Text rendering: summary (default) | json | md
                    (repo relevant) Text rendering: slice | req | file | json
  --query <kw>      (repo relevant) Keyword/phrase selector (exact one of --slice/--req/--file/--query required)
  --maxResults <n>  (repo relevant) Cap on combined emitted items (default 20; ≤0 = default)
  --component <n>   (repo impact) Component name or path selector (exact one of --file/--component required)
  --title <t>       (decision add) Decision title (required)
  --rationale <r>   (decision add) Decision rationale (required)
  --links <a,b>     (decision add) Comma-separated REQ-IDs / ADR-ids / stage ids the decision concerns
  --proposer <n>    (decision add) Proposer attribution (default: orchestrator)
  --reject          (decision approve) Append a rejected event instead of approved (mutually exclusive with --supersede)
  --supersede <id>  (decision approve) Mark this (approved) decision superseded by <id> (mutually exclusive with --reject)
  --as <actor>      (decision approve) Approver attribution (attribution only — NOT a barrier; default TH_APPROVAL_ACTOR or "human")`;

export interface ParsedArgs {
  positionals: string[];
  /** `--flags` the parser does not recognize (typos); `main()` rejects them. */
  unknownFlags: string[];
  /** Flags supplied without a required (or non-numeric) value; `main()` rejects them. */
  errors: string[];
  flags: {
    json: boolean;
    force: boolean;
    cwd: string;
    agent?: string;
    mode?: string;
    brief?: string;
    componentBlast: boolean;
    summarization: boolean;
    cap?: number;
    version?: number;
    reqs?: string;
    plan?: string;
    tests?: string;
    scope?: string;
    code?: string;
    tier?: string;
    slice?: string;
    components?: string;
    req?: string;
    symptom?: string;
    evidence?: string;
    rootCause?: string;
    status?: string;
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
    brownfield: boolean;
    explain: boolean;
    intent?: string;
    task?: string;
    capsule?: string;
    files?: number;
    writes: boolean;
    noisy: boolean;
    write: boolean;
    noWrite: boolean;
    format?: string;
    query?: string;
    maxResults?: number;
    file?: string;
    component?: string;
    title?: string;
    rationale?: string;
    links?: string;
    proposer?: string;
    reject: boolean;
    supersede?: string;
    as?: string;
    advise: boolean;
    stage?: string;
    round?: string;
    name?: string;
    text?: string;
    section?: string;
    holder?: string;
    topic?: string;
    positions?: string;
    id?: string;
    resolution?: string;
  };
}

type FlagField = keyof ParsedArgs["flags"];

/** Boolean flags (presence = true). */
const BOOLEAN_FLAGS: Record<string, FlagField> = {
  "--json": "json",
  "--force": "force",
  "--include-done": "includeDone",
  "--scan-reqs": "scanReqs",
  "--scan-tests": "scanTests",
  "--scan-code": "scanCode",
  "--strict": "strict",
  "--dry-run": "dryRun",
  "--remove-missing": "removeMissing",
  "--brownfield": "brownfield",
  "--component-blast": "componentBlast",
  "--summarization": "summarization",
  "--explain": "explain",
  "--writes": "writes",
  "--noisy": "noisy",
  "--write": "write",
  "--no-write": "noWrite",
  "--reject": "reject",
  "--advise": "advise",
};

/** Flags that consume a string value (`--flag v` or `--flag=v`). */
const STRING_FLAGS: Record<string, FlagField> = {
  "--cwd": "cwd",
  "--reqs": "reqs",
  "--plan": "plan",
  "--tests": "tests",
  "--scope": "scope",
  "--code": "code",
  "--tier": "tier",
  "--slice": "slice",
  "--components": "components",
  "--req": "req",
  "--symptom": "symptom",
  "--evidence": "evidence",
  "--root-cause": "rootCause",
  "--status": "status",
  "--since": "since",
  "--artifact": "artifact",
  "--layer": "layer",
  "--ref": "ref",
  "--discovery": "discovery",
  "--action": "action",
  "--escalation": "escalation",
  "--source": "source",
  "--agent": "agent",
  "--mode": "mode",
  "--brief": "brief",
  "--intent": "intent",
  "--task": "task",
  "--capsule": "capsule",
  "--format": "format",
  "--query": "query",
  "--file": "file",
  "--component": "component",
  "--title": "title",
  "--rationale": "rationale",
  "--links": "links",
  "--proposer": "proposer",
  "--supersede": "supersede",
  "--as": "as",
  "--stage": "stage",
  "--round": "round",
  "--name": "name",
  "--text": "text",
  "--section": "section",
  "--holder": "holder",
  "--topic": "topic",
  "--positions": "positions",
  "--id": "id",
  "--resolution": "resolution",
};

/** Flags that consume a numeric value. */
const NUMBER_FLAGS: Record<string, FlagField> = {
  "--cap": "cap",
  "--version": "version",
  "--files": "files",
  "--maxResults": "maxResults",
};

/**
 * Table-driven flag parser. Unknown `--flags` and value-less flags are recorded
 * (rather than silently swallowed as positionals / coerced to NaN — the old
 * behavior); `main()` rejects them with a clear error. A bare `--` ends flag
 * parsing so a positional value may legitimately begin with `--`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs["flags"] = {
    json: false,
    force: false,
    cwd: process.cwd(),
    includeDone: false,
    scanReqs: false,
    scanTests: false,
    scanCode: false,
    strict: false,
    dryRun: false,
    removeMissing: false,
    brownfield: false,
    componentBlast: false,
    summarization: false,
    explain: false,
    writes: false,
    noisy: false,
    write: false,
    noWrite: false,
    reject: false,
    advise: false,
  };
  const positionals: string[] = [];
  const unknownFlags: string[] = [];
  const errors: string[] = [];
  const assign = (field: FlagField, value: string | number | boolean): void => {
    (flags as Record<string, unknown>)[field] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]!);
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inlineVal = eq >= 0 ? a.slice(eq + 1) : undefined;

    if (name in BOOLEAN_FLAGS) {
      assign(BOOLEAN_FLAGS[name]!, true);
    } else if (name in STRING_FLAGS) {
      const val = inlineVal ?? argv[++i];
      if (val === undefined) errors.push(`flag ${name} requires a value`);
      else assign(STRING_FLAGS[name]!, val);
    } else if (name in NUMBER_FLAGS) {
      const val = inlineVal ?? argv[++i];
      if (val === undefined) {
        errors.push(`flag ${name} requires a value`);
      } else {
        const n = Number(val);
        if (!Number.isFinite(n)) errors.push(`flag ${name} requires a number (got "${val}")`);
        else assign(NUMBER_FLAGS[name]!, n);
      }
    } else {
      unknownFlags.push(name);
    }
  }

  return { positionals, unknownFlags, errors, flags };
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
      return runInit(paths, { force: parsed.flags.force, brownfield: parsed.flags.brownfield });
    case "migrate":
      return runMigrate(paths);
    case "doctor":
      return runDoctor(paths);
    case "next":
      return runNext(paths, { explain: parsed.flags.explain });
    case "preview":
      return runPreview(paths, { tier: parsed.flags.tier });
    case "scorecard":
      return runScorecard(paths, { json: parsed.flags.json });
    case "route":
      return runRoute(paths, {
        agent: parsed.flags.agent,
        mode: parsed.flags.mode,
        tier: parsed.flags.tier,
        brief: parsed.flags.brief,
        componentBlast: parsed.flags.componentBlast,
        summarization: parsed.flags.summarization,
      });
    case "telemetry":
      switch (sub) {
        case "on":
          return runTelemetrySet(paths, "on");
        case "off":
          return runTelemetrySet(paths, "off");
        case "status":
          return runTelemetryStatus(paths);
        default:
          return failure({ human: `unknown 'telemetry' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "context":
      switch (sub) {
        case "estimate":
          return runContextEstimate();
        case "pack":
          return runContextPack(paths, { slice: parsed.flags.slice });
        default:
          return failure({ human: `unknown 'context' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "delegate":
      switch (sub) {
        case "plan":
          return runDelegatePlan({
            intent: parsed.flags.intent,
            files: parsed.flags.files,
            writes: parsed.flags.writes,
            noisy: parsed.flags.noisy,
            task: parsed.flags.task,
            slice: parsed.flags.slice,
          });
        case "pack":
          return runDelegatePack(paths, {
            agent: parsed.flags.agent,
            task: parsed.flags.task,
            intent: parsed.flags.intent,
            slice: parsed.flags.slice,
          });
        case "capsule":
          return runDelegateCapsule();
        case "check":
          return runDelegateCheck(paths, { file: parsed.flags.capsule });
        default:
          return failure({ human: `unknown 'delegate' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "repo":
      switch (sub) {
        case "map": {
          // D-CONTRACTS-001: bare `th repo map` WRITES; --no-write (alias
          // --dry-run) builds in memory only. --write is accepted (it is the
          // default). --no-write/--dry-run wins when both are given.
          const noWrite = parsed.flags.noWrite || parsed.flags.dryRun;
          return runRepoMap(paths, { write: !noWrite, format: parsed.flags.format });
        }
        case "relevant":
          // Anchor: REQ-RU-020 — four selectors (--slice/--req/--file/--query)
          // Anchor: REQ-RU-024 — path guard first (inside runRepoRelevant)
          // Anchor: REQ-RU-025 — map-load failure
          // Anchor: REQ-RU-026 — read-only
          return runRepoRelevant(paths, {
            slice: parsed.flags.slice,
            req: parsed.flags.req,
            file: parsed.flags.file,
            query: parsed.flags.query,
            maxResults: parsed.flags.maxResults,
            format: parsed.flags.format,
          });
        case "impact":
          // Anchor: REQ-RU-030 — two selectors (--file/--component)
          // Anchor: REQ-RU-032 — path guard first (inside runRepoImpact)
          // Anchor: REQ-RU-033 — no state read
          // Anchor: REQ-RU-034 — map-load failure
          return runRepoImpact(paths, {
            file: parsed.flags.file,
            component: parsed.flags.component,
            format: parsed.flags.format,
          });
        case "check":
          // Anchor: REQ-201 — th repo check subcommand dispatch.
          // Anchor: REQ-202 — stale detection (added/removed/modified).
          // Anchor: REQ-203 — exit 0 fresh / 4 stale / 5 no-map / 1 parse-fail.
          // Anchor: REQ-204 — { fresh, added[], removed[], modified[] } report.
          // Anchor: REQ-205 — deterministic strategy; never executes content.
          return runRepoCheck(paths, {});
        default:
          return failure({ human: `unknown 'repo' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "decision":
      switch (sub) {
        case "detect":
          // Anchor: REQ-405 — read-only candidate surfacing; exit 0 always.
          return runDecisionDetect(paths, {});
        case "add":
          // Anchor: REQ-402 — record a proposed decision; mint id; never auto-approve.
          return runDecisionAdd(paths, {
            title: parsed.flags.title,
            rationale: parsed.flags.rationale,
            links: (parsed.flags.links ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            proposer: parsed.flags.proposer,
          });
        case "approve":
          // Anchor: REQ-403 — HUMAN-ONLY TTY-gated transition (never an MCP tool).
          // Anchor: REQ-407 — state-machine graph enforced.
          // Anchor: REQ-412 — non-self-approval barrier is mechanical (TTY).
          return runDecisionApprove(paths, rest[0], {
            reject: parsed.flags.reject,
            supersede: parsed.flags.supersede,
            as: parsed.flags.as,
          });
        case "check":
          // Anchor: REQ-404 — exit 6 when an unapproved decision gates the stage.
          return runDecisionCheck(paths, {});
        case "list":
          // Anchor: REQ-406 — sorted decision read model; exit 0 always.
          return runDecisionList(paths, {});
        default:
          return failure({ human: `unknown 'decision' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
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
        // Anchor: REQ-PCO-041 — section-level artifact leases (file#section).
        case "claim":
          return runArtifactClaim(paths, { section: rest[0] ?? parsed.flags.section, holder: parsed.flags.holder });
        case "release":
          return runArtifactRelease(paths, { section: rest[0] ?? parsed.flags.section, holder: parsed.flags.holder });
        case "leases":
          return runArtifactLeases(paths);
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
          return runBuildPlan(paths, { includeDone: parsed.flags.includeDone, advise: parsed.flags.advise });
        case "next-wave":
          return runBuildNextWave(paths);
        case "dispatch":
          // Anchor: REQ-PCO-001 — full parallel wave + per-slice spawn descriptors in one payload.
          return runBuildDispatch(paths);
        case "claim":
          return runBuildClaim(paths, rest[0]);
        case "release":
          return runBuildRelease(paths, rest[0]);
        case "sub-claim": {
          const components = (parsed.flags.components ?? "")
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
          return runBuildSubClaim(paths, rest[0], components);
        }
        case "sub-release":
          return runBuildSubRelease(paths, rest[0]);
        case "leases":
          return runBuildLeases(paths);
        default:
          return failure({ human: `unknown 'build' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    // Anchor: REQ-PCO-040 — blackboard collab substrate (fragments + reconcile-merge).
    case "collab":
      switch (sub) {
        case "init":
          return runCollabInit(paths, { stage: parsed.flags.stage });
        case "fragment":
          return runCollabFragment(paths, {
            stage: parsed.flags.stage,
            round: parsed.flags.round,
            name: parsed.flags.name,
            text: parsed.flags.text,
            force: parsed.flags.force,
          });
        case "list":
          return runCollabList(paths, { stage: parsed.flags.stage, round: parsed.flags.round });
        case "merge":
          return runCollabMerge(paths, { stage: parsed.flags.stage, round: parsed.flags.round });
        default:
          return failure({ human: `unknown 'collab' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    // Anchor: REQ-PCO-042 — append-only debate ledger (mirrors the drift ledger).
    case "debate":
      switch (sub) {
        case "add":
          return runDebateAdd(paths, {
            topic: parsed.flags.topic ?? rest[0],
            positions: parsed.flags.positions,
            links: parsed.flags.links,
            source: parsed.flags.source,
          });
        case "list":
          return runDebateList(paths);
        case "resolve":
          return runDebateResolve(paths, { id: parsed.flags.id ?? rest[0], resolution: parsed.flags.resolution });
        default:
          return failure({ human: `unknown 'debate' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
      }
    case "debug":
      switch (sub) {
        case "pack":
          return runDebugPack(paths, { slice: parsed.flags.slice, req: parsed.flags.req });
        case "log":
          switch (rest[0]) {
            case "add":
              return runDebugLogAdd(paths, {
                ref: parsed.flags.ref,
                symptom: parsed.flags.symptom,
                evidence: parsed.flags.evidence,
                rootCause: parsed.flags.rootCause,
                status: parsed.flags.status,
              });
            case "list":
              return runDebugLogList(paths);
            default:
              return failure({ human: `unknown 'debug log' subcommand: ${rest[0] ?? "(none)"}\n\n${HELP}` });
          }
        default:
          return failure({ human: `unknown 'debug' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
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

  // Reject unknown flags / value-less flags up front (a typo'd flag must not be
  // silently swallowed as a positional, the old behavior).
  if (parsed.unknownFlags.length > 0 || parsed.errors.length > 0) {
    const human =
      [...parsed.unknownFlags.map((f) => `unknown flag: ${f}`), ...parsed.errors].join("\n") +
      "\n\nRun `th help` for usage.";
    const result = failure({
      human,
      data: { error: "bad_args", unknownFlags: parsed.unknownFlags, errors: parsed.errors },
    });
    process.stdout.write(renderResult(result, parsed.flags.json) + "\n");
    process.exit(result.exitCode);
  }

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
    if (parsed.positionals[1] === "subagent-stop") {
      const paths = resolveProjectPaths(parsed.flags.cwd);
      const out = runHookSubagentStop(paths, readHookStdin<SubagentStopHookInput>());
      process.stdout.write(out.stdout + "\n");
      process.exit(out.exitCode);
    }
  }

  let result: CommandResult;
  try {
    result = dispatch(parsed);
  } catch (e) {
    // Contention on the state store (lock timeout, or a write that lost the
    // rename race past its retry budget) surfaces as a typed error. Convert it
    // to a clean structured failure here — at the single CLI boundary — so every
    // mutating command gets non-zero exit + valid --json instead of a raw stack
    // crash (C-2 / M-3). Any other error is a real bug and must propagate.
    const code = (e as { code?: string }).code;
    if (code === "state_lock_timeout" || code === "state_write_contended") {
      result = failure({ human: (e as Error).message, data: { error: code } });
    } else {
      throw e;
    }
  }
  process.stdout.write(renderResult(result, parsed.flags.json) + "\n");
  process.exit(result.exitCode);
}

if (require.main === module) main();
