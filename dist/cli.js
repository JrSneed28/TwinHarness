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
function parseArgs(argv) {
    const positionals = [];
    let json = false;
    let force = false;
    let cwd = process.cwd();
    let cap;
    let version;
    let reqs;
    let plan;
    let tests;
    let scope;
    let code;
    let slice;
    let includeDone = false;
    let scanReqs = false;
    let scanTests = false;
    let scanCode = false;
    let strict = false;
    let since;
    let artifact;
    let layer;
    let ref;
    let discovery;
    let action;
    let escalation;
    let source;
    let dryRun = false;
    let removeMissing = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--json")
            json = true;
        else if (a === "--force")
            force = true;
        else if (a === "--cwd")
            cwd = argv[++i] ?? process.cwd();
        else if (a.startsWith("--cwd="))
            cwd = a.slice("--cwd=".length);
        else if (a === "--cap")
            cap = Number(argv[++i]);
        else if (a.startsWith("--cap="))
            cap = Number(a.slice("--cap=".length));
        else if (a === "--version")
            version = Number(argv[++i]);
        else if (a.startsWith("--version="))
            version = Number(a.slice("--version=".length));
        else if (a === "--reqs")
            reqs = argv[++i];
        else if (a.startsWith("--reqs="))
            reqs = a.slice("--reqs=".length);
        else if (a === "--plan")
            plan = argv[++i];
        else if (a.startsWith("--plan="))
            plan = a.slice("--plan=".length);
        else if (a === "--tests")
            tests = argv[++i];
        else if (a.startsWith("--tests="))
            tests = a.slice("--tests=".length);
        else if (a === "--scope")
            scope = argv[++i];
        else if (a.startsWith("--scope="))
            scope = a.slice("--scope=".length);
        else if (a === "--code")
            code = argv[++i];
        else if (a.startsWith("--code="))
            code = a.slice("--code=".length);
        else if (a === "--slice")
            slice = argv[++i];
        else if (a.startsWith("--slice="))
            slice = a.slice("--slice=".length);
        else if (a === "--include-done")
            includeDone = true;
        else if (a === "--scan-reqs")
            scanReqs = true;
        else if (a === "--scan-tests")
            scanTests = true;
        else if (a === "--scan-code")
            scanCode = true;
        else if (a === "--strict")
            strict = true;
        else if (a === "--since")
            since = argv[++i];
        else if (a.startsWith("--since="))
            since = a.slice("--since=".length);
        else if (a === "--artifact")
            artifact = argv[++i];
        else if (a.startsWith("--artifact="))
            artifact = a.slice("--artifact=".length);
        else if (a === "--layer")
            layer = argv[++i];
        else if (a.startsWith("--layer="))
            layer = a.slice("--layer=".length);
        else if (a === "--ref")
            ref = argv[++i];
        else if (a.startsWith("--ref="))
            ref = a.slice("--ref=".length);
        else if (a === "--discovery")
            discovery = argv[++i];
        else if (a.startsWith("--discovery="))
            discovery = a.slice("--discovery=".length);
        else if (a === "--action")
            action = argv[++i];
        else if (a.startsWith("--action="))
            action = a.slice("--action=".length);
        else if (a === "--escalation")
            escalation = argv[++i];
        else if (a.startsWith("--escalation="))
            escalation = a.slice("--escalation=".length);
        else if (a === "--source")
            source = argv[++i];
        else if (a.startsWith("--source="))
            source = a.slice("--source=".length);
        else if (a === "--dry-run")
            dryRun = true;
        else if (a === "--remove-missing")
            removeMissing = true;
        else
            positionals.push(a);
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
            return (0, init_1.runInit)(paths, { force: parsed.flags.force });
        case "migrate":
            return (0, migrate_1.runMigrate)(paths);
        case "doctor":
            return (0, doctor_1.runDoctor)(paths);
        case "next":
            return (0, next_1.runNext)(paths);
        case "context":
            switch (sub) {
                case "estimate":
                    return (0, context_1.runContextEstimate)();
                case "pack":
                    return (0, context_1.runContextPack)(paths, { slice: parsed.flags.slice });
                default:
                    return (0, output_1.failure)({ human: `unknown 'context' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
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
                default:
                    return (0, output_1.failure)({ human: `unknown 'build' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
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
    }
    const result = dispatch(parsed);
    process.stdout.write((0, output_1.renderResult)(result, parsed.flags.json) + "\n");
    process.exit(result.exitCode);
}
main();
