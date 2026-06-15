#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./core/paths");
const output_1 = require("./core/output");
const init_1 = require("./commands/init");
const state_1 = require("./commands/state");
const revise_1 = require("./commands/revise");
const tier_1 = require("./commands/tier");
const artifact_1 = require("./commands/artifact");
const coverage_1 = require("./commands/coverage");
const verify_1 = require("./commands/verify");
const next_1 = require("./commands/next");
const build_1 = require("./commands/build");
const debug_1 = require("./commands/debug");
const anchors_1 = require("./commands/anchors");
const drift_1 = require("./commands/drift");
const trace_1 = require("./commands/trace");
const stale_1 = require("./commands/stale");
const hook_1 = require("./commands/hook");
const slices_1 = require("./commands/slices");
const migrate_1 = require("./commands/migrate");
const doctor_1 = require("./commands/doctor");
const context_1 = require("./commands/context");
const stage_1 = require("./commands/stage");
const manifest_1 = require("./commands/manifest");
const preview_1 = require("./commands/preview");
const scorecard_1 = require("./commands/scorecard");
const telemetry_1 = require("./commands/telemetry");
const route_1 = require("./commands/route");
const delegate_1 = require("./commands/delegate");
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
  th build plan [--include-done]    Schedule slices into conflict-free build waves (§16: disjoint parallelize, shared serialize)
  th build next-wave                Live oracle: slices dispatchable in parallel now (deps done, components free)
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
  --force           (init) Reset existing state.json
  --brownfield      (init) Scaffold a brownfield run (project_mode=brownfield; adopting an existing codebase)`;
/** Boolean flags (presence = true). */
const BOOLEAN_FLAGS = {
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
};
/** Flags that consume a string value (`--flag v` or `--flag=v`). */
const STRING_FLAGS = {
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
};
/** Flags that consume a numeric value. */
const NUMBER_FLAGS = {
    "--cap": "cap",
    "--version": "version",
    "--files": "files",
};
/**
 * Table-driven flag parser. Unknown `--flags` and value-less flags are recorded
 * (rather than silently swallowed as positionals / coerced to NaN — the old
 * behavior); `main()` rejects them with a clear error. A bare `--` ends flag
 * parsing so a positional value may legitimately begin with `--`.
 */
function parseArgs(argv) {
    const flags = {
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
    };
    const positionals = [];
    const unknownFlags = [];
    const errors = [];
    const assign = (field, value) => {
        flags[field] = value;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") {
            for (let j = i + 1; j < argv.length; j++)
                positionals.push(argv[j]);
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
            assign(BOOLEAN_FLAGS[name], true);
        }
        else if (name in STRING_FLAGS) {
            const val = inlineVal ?? argv[++i];
            if (val === undefined)
                errors.push(`flag ${name} requires a value`);
            else
                assign(STRING_FLAGS[name], val);
        }
        else if (name in NUMBER_FLAGS) {
            const val = inlineVal ?? argv[++i];
            if (val === undefined) {
                errors.push(`flag ${name} requires a value`);
            }
            else {
                const n = Number(val);
                if (!Number.isFinite(n))
                    errors.push(`flag ${name} requires a number (got "${val}")`);
                else
                    assign(NUMBER_FLAGS[name], n);
            }
        }
        else {
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
function readCliVersion() {
    const candidates = [
        path.join(__dirname, "..", "package.json"),
        path.join(__dirname, "..", "..", "package.json"),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                const json = JSON.parse(fs.readFileSync(candidate, "utf8"));
                if (typeof json === "object" && json !== null && "version" in json) {
                    const v = json.version;
                    if (typeof v === "string")
                        return v;
                }
            }
        }
        catch {
            // Try next candidate.
        }
    }
    return "unknown";
}
function dispatch(parsed) {
    const paths = (0, paths_1.resolveProjectPaths)(parsed.flags.cwd);
    const [group, sub, ...rest] = parsed.positionals;
    switch (group) {
        case undefined:
            return (0, output_1.failure)({ human: HELP });
        case "help":
            return { ok: true, exitCode: 0, human: HELP };
        case "version": {
            const ver = readCliVersion();
            return (0, output_1.success)({ data: { version: ver }, human: ver });
        }
        case "init":
            return (0, init_1.runInit)(paths, { force: parsed.flags.force, brownfield: parsed.flags.brownfield });
        case "migrate":
            return (0, migrate_1.runMigrate)(paths);
        case "doctor":
            return (0, doctor_1.runDoctor)(paths);
        case "next":
            return (0, next_1.runNext)(paths, { explain: parsed.flags.explain });
        case "preview":
            return (0, preview_1.runPreview)(paths, { tier: parsed.flags.tier });
        case "scorecard":
            return (0, scorecard_1.runScorecard)(paths, { json: parsed.flags.json });
        case "route":
            return (0, route_1.runRoute)(paths, {
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
                    return (0, telemetry_1.runTelemetrySet)(paths, "on");
                case "off":
                    return (0, telemetry_1.runTelemetrySet)(paths, "off");
                case "status":
                    return (0, telemetry_1.runTelemetryStatus)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'telemetry' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "context":
            switch (sub) {
                case "estimate":
                    return (0, context_1.runContextEstimate)();
                case "pack":
                    return (0, context_1.runContextPack)(paths, { slice: parsed.flags.slice });
                default:
                    return (0, output_1.failure)({ human: `unknown 'context' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "delegate":
            switch (sub) {
                case "plan":
                    return (0, delegate_1.runDelegatePlan)({
                        intent: parsed.flags.intent,
                        files: parsed.flags.files,
                        writes: parsed.flags.writes,
                        noisy: parsed.flags.noisy,
                        task: parsed.flags.task,
                        slice: parsed.flags.slice,
                    });
                case "pack":
                    return (0, delegate_1.runDelegatePack)(paths, {
                        agent: parsed.flags.agent,
                        task: parsed.flags.task,
                        intent: parsed.flags.intent,
                        slice: parsed.flags.slice,
                    });
                case "capsule":
                    return (0, delegate_1.runDelegateCapsule)();
                case "check":
                    return (0, delegate_1.runDelegateCheck)(paths, { file: parsed.flags.capsule });
                default:
                    return (0, output_1.failure)({ human: `unknown 'delegate' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "stage":
            switch (sub) {
                case "current":
                    return (0, stage_1.runStageCurrent)(paths);
                case "describe":
                    return (0, stage_1.runStageDescribe)(rest[0]);
                case "list":
                    return (0, stage_1.runStageList)();
                default:
                    return (0, output_1.failure)({ human: `unknown 'stage' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "manifest":
            switch (sub) {
                case "export":
                    return (0, manifest_1.runManifestExport)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'manifest' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "state":
            switch (sub) {
                case "get":
                    return (0, state_1.runStateGet)(paths, rest[0]);
                case "set":
                    if (rest.length < 2)
                        return (0, output_1.failure)({ human: "usage: th state set <dotted.key> <value>" });
                    return (0, state_1.runStateSet)(paths, rest[0], rest.slice(1).join(" "));
                case "status":
                    return (0, state_1.runStateStatus)(paths);
                case "verify":
                    return (0, state_1.runStateVerify)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'state' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "tier":
            switch (sub) {
                case "classify":
                    return (0, tier_1.runTierClassify)(paths, rest[0]);
                case "veto-check":
                    return (0, tier_1.runTierVetoCheck)(paths, rest[0]);
                default:
                    return (0, output_1.failure)({ human: `unknown 'tier' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "artifact":
            switch (sub) {
                case "register":
                    return (0, artifact_1.runArtifactRegister)(paths, rest[0], parsed.flags.version);
                case "list":
                    return (0, artifact_1.runArtifactList)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'artifact' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "coverage":
            switch (sub) {
                case "check":
                    return (0, coverage_1.runCoverageCheck)(paths, {
                        reqsFile: parsed.flags.reqs,
                        planFile: parsed.flags.plan,
                        testsDir: parsed.flags.tests,
                        scopeFile: parsed.flags.scope,
                    });
                case "report":
                    return (0, coverage_1.runCoverageReport)(paths, {
                        reqsFile: parsed.flags.reqs,
                        planFile: parsed.flags.plan,
                        testsDir: parsed.flags.tests,
                        scopeFile: parsed.flags.scope,
                        codeDir: parsed.flags.code,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'coverage' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "verify":
            switch (sub) {
                case "run":
                    return (0, verify_1.runVerifyRun)(paths);
                case "add":
                    return (0, verify_1.runVerifyAdd)(paths, rest.join(" "));
                case "list":
                    return (0, verify_1.runVerifyList)(paths);
                case "clear":
                    return (0, verify_1.runVerifyClear)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'verify' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "build":
            switch (sub) {
                case "plan":
                    return (0, build_1.runBuildPlan)(paths, { includeDone: parsed.flags.includeDone });
                case "next-wave":
                    return (0, build_1.runBuildNextWave)(paths);
                case "claim":
                    return (0, build_1.runBuildClaim)(paths, rest[0]);
                case "release":
                    return (0, build_1.runBuildRelease)(paths, rest[0]);
                case "sub-claim": {
                    const components = (parsed.flags.components ?? "")
                        .split(",")
                        .map((c) => c.trim())
                        .filter(Boolean);
                    return (0, build_1.runBuildSubClaim)(paths, rest[0], components);
                }
                case "sub-release":
                    return (0, build_1.runBuildSubRelease)(paths, rest[0]);
                case "leases":
                    return (0, build_1.runBuildLeases)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'build' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "debug":
            switch (sub) {
                case "pack":
                    return (0, debug_1.runDebugPack)(paths, { slice: parsed.flags.slice, req: parsed.flags.req });
                case "log":
                    switch (rest[0]) {
                        case "add":
                            return (0, debug_1.runDebugLogAdd)(paths, {
                                ref: parsed.flags.ref,
                                symptom: parsed.flags.symptom,
                                evidence: parsed.flags.evidence,
                                rootCause: parsed.flags.rootCause,
                                status: parsed.flags.status,
                            });
                        case "list":
                            return (0, debug_1.runDebugLogList)(paths);
                        default:
                            return (0, output_1.failure)({ human: `unknown 'debug log' subcommand: ${rest[0] ?? "(none)"}\n\n${HELP}` });
                    }
                default:
                    return (0, output_1.failure)({ human: `unknown 'debug' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "anchors":
            switch (sub) {
                case "scan":
                    return (0, anchors_1.runAnchorsScan)(paths, {
                        reqs: parsed.flags.scanReqs,
                        tests: parsed.flags.scanTests,
                        code: parsed.flags.scanCode,
                        strict: parsed.flags.strict,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'anchors' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "trace":
            switch (sub) {
                case "render":
                    return (0, trace_1.runTraceRender)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'trace' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "stale":
            return (0, stale_1.runStale)(paths, parsed.flags.since, parsed.flags.artifact);
        case "slices":
            switch (sub) {
                case "sync":
                    return (0, slices_1.runSlicesSync)(paths, {
                        planFile: parsed.flags.plan,
                        dryRun: parsed.flags.dryRun,
                        removeMissing: parsed.flags.removeMissing,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'slices' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "slice":
            switch (sub) {
                case "set-status":
                    return (0, slices_1.runSliceSetStatus)(paths, rest[0], rest[1]);
                default:
                    return (0, output_1.failure)({ human: `unknown 'slice' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "drift":
            switch (sub) {
                case "add":
                    return (0, drift_1.runDriftAdd)(paths, {
                        layer: parsed.flags.layer,
                        ref: parsed.flags.ref,
                        discovery: parsed.flags.discovery,
                        action: parsed.flags.action,
                        escalation: parsed.flags.escalation,
                        source: parsed.flags.source,
                    });
                case "list":
                    return (0, drift_1.runDriftList)(paths);
                case "resolve":
                    return (0, drift_1.runDriftResolve)(paths, rest[0]);
                default:
                    return (0, output_1.failure)({ human: `unknown 'drift' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "revise": {
            const mode = rest[0];
            if (!mode)
                return (0, output_1.failure)({ human: `usage: th revise ${sub ?? "<bump|status|reset>"} <mode> [--cap N]` });
            const cap = parsed.flags.cap;
            if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
                return (0, output_1.failure)({ human: "--cap must be a positive integer" });
            }
            switch (sub) {
                case "bump":
                    return (0, revise_1.runReviseBump)(paths, mode, cap);
                case "status":
                    return (0, revise_1.runReviseStatus)(paths, mode, cap);
                case "reset":
                    return (0, revise_1.runReviseReset)(paths, mode);
                default:
                    return (0, output_1.failure)({ human: `unknown 'revise' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        }
        default:
            return (0, output_1.failure)({ human: `unknown command: ${group}\n\n${HELP}` });
    }
}
/**
 * Best-effort read of the Claude Code hook payload from stdin. Hooks always
 * receive piped JSON; a TTY means a human ran the command by hand, so skip
 * reading rather than hang waiting for EOF. Malformed/absent input → undefined.
 * The type parameter lets callers narrow the returned object for their hook.
 */
function readHookStdin() {
    if (process.stdin.isTTY)
        return undefined;
    try {
        const raw = fs.readFileSync(0, "utf8");
        if (!raw.trim())
            return undefined;
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null)
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
function main() {
    const parsed = parseArgs(process.argv.slice(2));
    // Reject unknown flags / value-less flags up front (a typo'd flag must not be
    // silently swallowed as a positional, the old behavior).
    if (parsed.unknownFlags.length > 0 || parsed.errors.length > 0) {
        const human = [...parsed.unknownFlags.map((f) => `unknown flag: ${f}`), ...parsed.errors].join("\n") +
            "\n\nRun `th help` for usage.";
        const result = (0, output_1.failure)({
            human,
            data: { error: "bad_args", unknownFlags: parsed.unknownFlags, errors: parsed.errors },
        });
        process.stdout.write((0, output_1.renderResult)(result, parsed.flags.json) + "\n");
        process.exit(result.exitCode);
    }
    // Hook commands speak the Claude Code hook protocol on stdout (not --json).
    if (parsed.positionals[0] === "hook") {
        if (parsed.positionals[1] === "stop-gate") {
            const paths = (0, paths_1.resolveProjectPaths)(parsed.flags.cwd);
            const out = (0, hook_1.runHookStopGate)(paths, readHookStdin());
            process.stdout.write(out.stdout + "\n");
            process.exit(out.exitCode);
        }
        if (parsed.positionals[1] === "pretool-gate") {
            // Prefer the payload's cwd for path resolution when --cwd was not explicitly passed.
            const stdinPayload = readHookStdin();
            const cwdFromStdin = stdinPayload?.cwd;
            const effectiveCwd = cwdFromStdin && !process.argv.includes("--cwd") ? cwdFromStdin : parsed.flags.cwd;
            const paths = (0, paths_1.resolveProjectPaths)(effectiveCwd);
            const out = (0, hook_1.runHookPretoolGate)(paths, stdinPayload);
            process.stdout.write(out.stdout + "\n");
            process.exit(out.exitCode);
        }
        if (parsed.positionals[1] === "subagent-stop") {
            const paths = (0, paths_1.resolveProjectPaths)(parsed.flags.cwd);
            const out = (0, hook_1.runHookSubagentStop)(paths, readHookStdin());
            process.stdout.write(out.stdout + "\n");
            process.exit(out.exitCode);
        }
    }
    const result = dispatch(parsed);
    process.stdout.write((0, output_1.renderResult)(result, parsed.flags.json) + "\n");
    process.exit(result.exitCode);
}
if (require.main === module)
    main();
