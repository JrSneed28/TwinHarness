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
exports.MIN_NODE_MAJOR = void 0;
exports.parseArgs = parseArgs;
exports.checkNodeVersion = checkNodeVersion;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./core/paths");
const output_1 = require("./core/output");
const init_1 = require("./commands/init");
const state_1 = require("./commands/state");
const revise_1 = require("./commands/revise");
const tier_1 = require("./commands/tier");
const artifact_1 = require("./commands/artifact");
const artifact_lease_1 = require("./commands/artifact-lease");
const research_1 = require("./commands/research");
const collab_1 = require("./commands/collab");
const debate_1 = require("./commands/debate");
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
const budget_1 = require("./commands/budget");
const handoff_1 = require("./commands/handoff");
const inspector_1 = require("./commands/inspector");
const tester_1 = require("./commands/tester");
const manifest_1 = require("./commands/manifest");
const preview_1 = require("./commands/preview");
const scorecard_1 = require("./commands/scorecard");
const telemetry_1 = require("./commands/telemetry");
const route_1 = require("./commands/route");
const delegate_1 = require("./commands/delegate");
const delegation_scope_1 = require("./core/delegation-scope");
const repo_1 = require("./commands/repo");
const decision_1 = require("./commands/decision");
const template_1 = require("./commands/template");
const sim_1 = require("./commands/sim");
const gate_1 = require("./commands/gate");
const HELP = `th — TwinHarness mechanical CLI (records and computes; never decides)

Usage:
  th init [--force] [--brownfield] [--delivery-mode <m>] [--no-ui] [--interview-required|--no-interview-required] [--interview-cutoff <0..1>]
                                    Scaffold docs/, .twinharness/state.json, drift-log.md (the gate-defining flags set delivery_mode/has_ui/interview_required/interview_cutoff once at creation)
  th state get [dotted.path]        Print state.json (or one value)
  th state set <dotted.key> <value> Patch state.json (refuses invalid results; rejects unknown keys; gate-owned fields require --emergency — prefer the typed gate commands below)
  th state status                   Human-readable tier/stage/gate snapshot
  th state verify                   Validate state.json (exit 0 = valid)
  th state unlock [--force]         Reclaim a stale .state.lock left by a crashed process (refuses a live lock unless --force; R-21 recovery)
  th revise bump <mode> [--cap N]   Increment revise-loop count (computes escalate = count >= cap)
  th revise status <mode> [--cap N] Report revise-loop count + cap (no mutation)
  th revise reset <mode>            Zero revise-loop count (stage passed / zero issues)
  th tier classify <brief.json>     Advisory Tier-0 eligibility + detected blast-radius flags
  th tier veto-check <brief.json>   Mechanical veto gate (exit 3 when a blast-radius flag forbids T0)
  th tier record <T0-T3>            Typed gate command: validate + record the run's tier (gate-checked; upgrades backfill skipped stages)
  th tier features                  Show which advanced-coordination features (collab/debate/section-lease/sub-lease) are active for the current tier (+ "use when")
  th stage advance                  Typed gate command: advance to the next engaged stage when the full gate ladder clears
  th implementation unlock [--lock] Typed gate command: unlock implementation when the gate ladder clears (--lock re-locks)
  th artifact register <file> --version <n>  Content-hash a file and record it in approved_artifacts
  th artifact list                  List recorded approved artifacts (file, version, hash)
  th research write --topic <t> --markdown <md> [--version <n>]  Persist + register research at docs/00-research/<topic>.md (governed; --version bumps a re-author of an already-registered topic)
  th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]
                                    Verify every (MVP) REQ-ID maps to ≥1 slice and ≥1 test (hard gate)
  th coverage report [--reqs F] [--plan F] [--tests D] [--scope F] [--code D]
                                    Planned/implemented/tested/passing breakdown per REQ-ID (status view)
  th verify add "<command>" [--as <actor>]  Add a project test/check command (records actor+time provenance; the new set is UNAPPROVED until \`th verify approve\`)
  th verify list                    Show configured verify commands (with provenance + approval status)
  th verify approve [--as <actor>]  Human-confirm the current command SET for execution — requires an interactive TTY (an agent/non-interactive caller cannot self-approve); sealed in a tamper-evident ledger; re-required after any add/change
  th verify clear                   Remove all configured verify commands
  th verify run [--no-obvious-writes]  Run every configured verify command; refuses an UNAPPROVED set; --no-obvious-writes blocks commands that look like obvious repo-writes (best-effort heuristic, NOT a security boundary or real containment — unrecognized write shapes still execute); writes a report; exit 1 on failure
                                       Deprecated alias: --read-only (still accepted; emits a deprecation warning to stderr)
  th build plan [--include-done] [--advise]  Schedule slices into dependency-aware, conflict-free build waves (§16; a slice's wave is strictly after its hard depends_on); --advise emits the parallelism-optimizer advisory (max wave width + serializing conflict pairs); exit 7 when the depends_on graph is unsatisfiable (cycle/dangling)
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
  th artifact section --file <path> --section <heading> [--max-tokens <N>]
                                    Extract a named heading's body under a token budget, with a content-hash read receipt (C-12)
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
  th scorecard [--hotspots]         Post-run one-screen summary (tier/coverage/slices/suite/drift/revise); --hotspots emits a per-stage token (estimate/proxy) + wall-clock table from the local telemetry log (empty/exit-0 when no telemetry)
  th route [--agent A] [--mode M] [--tier T] [--component-blast] [--summarization]
                                    Advisory model+effort for an agent spawn (computes; the Orchestrator applies)
  th telemetry on|off|status        Toggle/report opt-in, LOCAL-ONLY run telemetry (never sent off-machine)
  th context estimate               Approximate the prompt-surface token cost (flags oversized files)
  th context pack [--slice <ID>|--req <REQ-ID>|--file <path>] [--max-tokens <N>]
                                    Assemble the §9 handoff bundle (artifact Summary blocks + slice/REQ/file framing; --max-tokens bounds the pack)
  th context read --files-list <a,b,c> [--max-tokens <N>]
                                    Batch-read files under ONE token budget with deterministic truncation + per-file read receipts (C-11)
  th budget check [--max <k>] [--files-read N] [--slices-built N] [--tool-calls N] [--artifacts N]
                                    Deterministic context-budget estimate from agent-supplied proxy counts → { estTokens, pct, verdict } (--max in thousands; tier-aware default when omitted)
  th handoff write                  Assemble .twinharness/HANDOFF.md (run state + next action + artifact Summary blocks + open questions + "don't re-read docs/" directive)
  th handoff verify                 Confirm a resumed run matches HANDOFF (current_stage/slice + approved-artifact hashes still valid); pass/fail
  th resume                         Detect .twinharness/HANDOFF.md and print the next mechanical action (from th next)
  th inspector write --content <md> [--version <n>]
                                    Codebase-Inspector governed write: emit + auto-register the source-anchored brownfield analysis at docs/00-existing-codebase-analysis.md (path is fixed; refuses any other target)
  th tester record --driver <d> [--provider real|sandbox] [--evidence-ref <p>]
                                    Attach the live-QA Tester record (.twinharness/tester-record.json) that satisfies the production-reality gate's Tester condition
  th delegate plan [--intent I] [--files N] [--writes] [--noisy] [--task T] [--slice ID]
                                    Recommend delegate vs keep-main for a task (context-preservation oracle)
  th delegate pack [--agent A] [--slice ID] [--task T] [--intent I] [--allowed-files <a,b,c>]
                                    Assemble a bounded child-agent handoff (reuses context pack for a slice; --allowed-files emits the write-gate-enforced scope, C-11)
  th delegate capsule               Print the blank Delegation Capsule skeleton (the strict return format)
  th delegate check --capsule <path>  Validate a returned capsule has every required section (presence only)
  th repo map [--write|--no-write] [--force] [--format <summary|json|md>] [--max-files <N>] [--max-bytes <N>]
                                    Scan the repo; write .twinharness/repo-map.json + docs/00-repo-map.md (writes by default; --no-write = dry/preview; --force overwrites a target registered as an approved artifact; --max-files/--max-bytes raise the scan caps for large repos)
  th repo check [--max-files <N>] [--max-bytes <N>]
                                    Report whether .twinharness/repo-map.json is fresh vs the working tree (exit 0 fresh / 4 stale / 5 no-map / 1 parse-fail; pass the same caps used to build the map)
  th repo relevant (--slice <ID> | --req <REQ-ID> | --file <path> | --query <kw>)
                   [--maxResults <n>] [--format <slice|req|file|json>]
                                    Precision context: read-first/related/tests/risks for a selector (reads persisted map)
  th repo impact (--file <path> | --component <name|path>) [--format <file|json>]
                                    Pre-edit blast-radius: impacted components, tests, features, risk flags (reads persisted map; no state read)
  th repo search --pattern <p> --kind <literal|regex|symbol|req|artifact|template> [--maxResults <N>]
                                    Governed repo search over the map's scope: path:line citations under a cap, each with a SHA-256 read receipt (C-11)
  th decision detect                Surface advisory decision candidates from ADRs/drift-log/scope/blast-radius flags (read-only; exit 0)
  th decision add --title <t> --rationale <r> [--links a,b] [--proposer <n>]
                                    Record a proposed decision (mints DECISION-NNN; never auto-approves)
  th decision approve <DECISION-ID> [--reject | --supersede <id>] [--as <actor>]
                                    HUMAN-ONLY: interactive-TTY-gated transition (proposed→approved/rejected; approved→superseded). Never an MCP tool.
  th decision check                 Fail (exit 6) when an unapproved decision gates the current stage; else exit 0
  th decision list                  List the decision set (ids/titles/statuses/links/audit), sorted (exit 0; non-zero if the hash chain is broken)
  th sim add --classification <Real|Sandbox|Emulated|Mocked|Stubbed|Hardcoded> [--replaces ...] [--intro-slice ...] [--retire-slice ...] [--owner ...] [--user-visible]
                                    Append a simulation-ledger entry (.twinharness/simulation-ledger.json); a user-visible simulated entry BLOCKS the production-reality gate until retired
  th sim list                       List simulation-ledger entries + the ids that block production-reality
  th sim retire <SIM-NNN> [--retire-slice ...]  Mark a simulation entry retired (status transition; entries are never deleted)
  th sim scan                       Grep dist/+tests for unledgered simulation patterns (mock|fake|stub|fixture|placeholder|demo|TODO|canned|hardcoded); advisory (exit 0)
  th gate production-reality        Reader: report the production-reality gate (no unretired user-visible simulation, verify green, Tester record, no unledgered dist/ patterns)
  th stage current|describe <s>|list  Per-stage contract (produces/critic/gate) from the pipeline
  th manifest export                Deterministic run snapshot (state + drift + ledger); --json for full
  th manifest tools                 List the advertised MCP tool set (name + summary); CLI mirror of ListTools; --json for full
  th template get <name>            Resolve a template by bare name (e.g. task-file or task-file.md): project override (.twinharness/templates/) → plugin-bundled (templates/) → structured template_not_found; --json returns path+content+source
  th template list                  List resolvable templates across both layers (deduped; marks project overrides that shadow a bundled template)
  th version                        Print the CLI version
  th help                           Show this help

Global flags:
  --json            Emit machine-readable JSON on stdout
  --cwd <dir>       Operate against <dir> instead of the current directory
  --cap <n>         (revise) Override the revise-loop cap (default 3)
  --version <n>     (artifact register) Artifact version (positive integer)
  --topic <t>       (research write, debate add) Research topic slug (file stem under docs/00-research/) / debate topic
  --markdown <md>   (research write) Markdown body to persist under docs/00-research/<topic>.md
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
  --hotspots        (scorecard) Emit the per-stage token + wall-clock table from local telemetry
  --intent <i>      (delegate) read|write|debug|review|artifact|repo-analysis
  --files <n>       (delegate plan) Expected file reads (delegate when > 3)
  --writes          (delegate plan) The task modifies source code
  --noisy           (delegate plan) The task runs noisy commands / logs / tests / repo scans
  --task <s>        (delegate) Free-text task label (echoed; not parsed)
  --agent <a>       (route, delegate pack) The agent being spawned / delegated to
  --capsule <path>  (delegate check) Capsule file to validate
  --force           (init) Reset existing state.json; (collab fragment) overwrite an existing fragment; (repo map) overwrite a target registered as an approved artifact (R-14); (state unlock) remove a lock that still looks live (R-21)
  --brownfield      (init) Scaffold a brownfield run (project_mode=brownfield; adopting an existing codebase)
  --max-tokens <k>  (init) Per-session context budget in THOUSANDS; persisted as max_tokens (×1000, e.g. 150 → 150000)
  --max <k>         (budget check) Budget override in THOUSANDS; default is state.max_tokens, else the tier-aware default
  --files-read <n>  (budget check) Proxy count: files read so far
  --slices-built <n> (budget check) Proxy count: slices built so far
  --tool-calls <n>  (budget check) Proxy count: tool calls so far
  --artifacts <n>   (budget check) Proxy count: approved artifacts carried
  --write           (repo map) Write the artifacts (default; bare \`th repo map\` writes)
  --no-write        (repo map) Dry/preview: build in memory, write nothing (alias of --dry-run)
  --format <f>      (repo map) Text rendering: summary (default) | json | md
                    (repo relevant) Text rendering: slice | req | file | json
  --query <kw>      (repo relevant) Keyword/phrase selector (exact one of --slice/--req/--file/--query required)
  --maxResults <n>  (repo relevant) Cap on combined emitted items (default 20; ≤0 = default)
  --component <n>   (repo impact) Component name or path selector (exact one of --file/--component required)
  --pattern <p>     (repo search) The pattern to search for (required)
  --kind <k>        (repo search) literal (default) | regex | symbol | req | artifact | template
  --section <h>     (artifact section) The heading name whose body to extract (also: artifact claim/release section id)
  --files-list <l>  (context read) Comma-separated file list to batch-read under one budget
  --allowed-files <l>  (delegate pack) Comma-separated write scope emitted as allowedFiles[] and enforced by the write-gate (C-11)
  --title <t>       (decision add) Decision title (required)
  --rationale <r>   (decision add) Decision rationale (required)
  --links <a,b>     (decision add) Comma-separated REQ-IDs / ADR-ids / stage ids the decision concerns
  --proposer <n>    (decision add) Proposer attribution (default: orchestrator)
  --reject          (decision approve) Append a rejected event instead of approved (mutually exclusive with --supersede)
  --supersede <id>  (decision approve) Mark this (approved) decision superseded by <id> (mutually exclusive with --reject)
  --as <actor>      (decision approve) Approver attribution (attribution only — NOT a barrier; default TH_APPROVAL_ACTOR or "human")
  --lock            (implementation unlock) Re-lock implementation (set implementation_allowed=false) instead of unlocking
  --emergency       (state set) Force a raw write to a gate-owned field, bypassing the typed gate ladder (loud + audit-ledgered)
  --delivery-mode <m>  (init) Set delivery_mode once at creation: code (default) | no-code | documentation-only
  --has-ui / --no-ui   (init) Set has_ui at creation (default absent ⇒ true; --no-ui drops the UX/UI stages)
  --interview-required / --no-interview-required  (init) Force the clarity-interview gate on/off (default absent ⇒ computed from tier)
  --interview-cutoff <0..1>  (init) Set the interview-readiness confidence cutoff at creation
  --classification <C>  (sim add) Real | Sandbox | Emulated | Mocked | Stubbed | Hardcoded (required)
  --replaces <s>    (sim add) What real dependency this simulation stands in for
  --intro-slice <s> (sim add) Slice/task that introduced the simulation
  --retire-slice <s> (sim add / sim retire) Slice/owner that will (or did) replace it with reality
  --owner <s>       (sim add) Who owns retiring the simulation
  --user-visible    (sim add) A user-visible production path depends on this (BLOCKS production-reality until retired)
  --driver <d>      (tester record) Driver/runner the live QA used (playwright | curl | cli-e2e | …) (required)
  --provider <p>    (tester record) Provider tier the live run exercised (real | sandbox)
  --evidence-ref <p>  (tester record) Path/URL to the raw live-run output or screenshots`;
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
    // R-04 typed capture path (init-only): the boolean gate-defining config fields.
    "--has-ui": "hasUi",
    "--no-ui": "noUi",
    "--interview-required": "interviewRequired",
    "--no-interview-required": "noInterviewRequired",
    "--component-blast": "componentBlast",
    "--summarization": "summarization",
    "--explain": "explain",
    "--hotspots": "hotspots",
    "--writes": "writes",
    "--noisy": "noisy",
    "--write": "write",
    "--no-write": "noWrite",
    "--reject": "reject",
    "--advise": "advise",
    "--self-test": "selfTest",
    "--lock": "lock",
    "--emergency": "emergency",
    "--no-obvious-writes": "readOnly",
    // Deprecated alias for --no-obvious-writes; kept for back-compat (emits a deprecation warning at parse time).
    "--read-only": "readOnly",
    // SG3 P2-C — a user-visible simulation entry is what the production-reality gate blocks on.
    "--user-visible": "userVisible",
};
/** Flags that consume a string value (`--flag v` or `--flag=v`). */
const STRING_FLAGS = {
    "--cwd": "cwd",
    // R-04 typed capture path (init-only): delivery_mode enum.
    "--delivery-mode": "deliveryMode",
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
    "--content": "content",
    "--section": "section",
    "--holder": "holder",
    "--topic": "topic",
    "--markdown": "markdown",
    "--positions": "positions",
    "--id": "id",
    "--resolution": "resolution",
    "--corpus-root": "corpusRoot",
    "--output-root": "outputRoot",
    "--scenario-root": "scenarioRoot",
    // SG3 P1-B (C-11/C-12) — governed search + bounded reads + delegate scope.
    "--pattern": "pattern",
    "--kind": "kind",
    "--files-list": "filesList",
    "--allowed-files": "allowedFiles",
    // SG3 P2-C — simulation-ledger entry fields.
    "--classification": "classification",
    "--replaces": "replaces",
    "--intro-slice": "introSlice",
    "--retire-slice": "retireSlice",
    "--owner": "owner",
    // SG3 P2-C — live-QA Tester record fields (`th tester record`).
    "--driver": "driver",
    "--provider": "provider",
    "--evidence-ref": "evidenceRef",
};
/** Flags that consume a numeric value. */
const NUMBER_FLAGS = {
    "--cap": "cap",
    "--version": "version",
    "--files": "files",
    "--maxResults": "maxResults",
    // Track A-2 — context budget. `--max-tokens` / `--max` are RAW numbers here (in
    // thousands "k"); the ×1000 conversion happens at the write/compute site
    // (budget.ts / init), NOT in this parser.
    "--max-tokens": "maxTokens",
    // R-04 typed capture path (init-only): interview_cutoff in [0,1] (validated at the
    // init write site, like every gate-defining field — the parser only coerces).
    "--interview-cutoff": "interviewCutoff",
    "--max": "max",
    "--files-read": "filesRead",
    "--slices-built": "slicesBuilt",
    "--tool-calls": "toolCalls",
    "--artifacts": "artifacts",
    // P4-8 — configurable scan caps for large repos. RAW numbers; the scanner clamps
    // ≤0 to its default. `--max-files` = file-count cap; `--max-bytes` = total-bytes cap.
    "--max-files": "maxFiles",
    "--max-bytes": "maxBytes",
};
/**
 * P4-8 — build the scanner `ScanOptions` cap overrides from the parsed `--max-files`
 * / `--max-bytes` flags. Returns `{}` when neither is set (the scanner then uses its
 * default envelope). Shared by `th repo map` and `th repo check` so both scan the
 * SAME scope. Values ≤0 are clamped to the default by the scanner, so no validation
 * is needed here.
 */
function buildScanOptions(flags) {
    const out = {};
    if (typeof flags.maxFiles === "number")
        out.fileCountCap = flags.maxFiles;
    if (typeof flags.maxBytes === "number")
        out.totalBytesCap = flags.maxBytes;
    return out;
}
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
        hasUi: false,
        noUi: false,
        interviewRequired: false,
        noInterviewRequired: false,
        componentBlast: false,
        summarization: false,
        explain: false,
        hotspots: false,
        writes: false,
        noisy: false,
        write: false,
        noWrite: false,
        reject: false,
        advise: false,
        selfTest: false,
        lock: false,
        emergency: false,
        readOnly: false,
        userVisible: false,
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
            // R-32: --read-only is a deprecated alias for --no-obvious-writes; warn once.
            if (name === "--read-only") {
                process.stderr.write("warning: --read-only is deprecated; use --no-obvious-writes\n");
            }
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
/** The minimum Node major version TwinHarness supports (mirrors `th doctor`). */
exports.MIN_NODE_MAJOR = 20;
/**
 * P0-4 (#20) — pure Node-version guard. Parses a `process.version`-shaped string
 * (`"v20.11.0"`, also tolerates a bare `"18.0.0"`) and reports whether it meets
 * the supported floor, plus a friendly, actionable message reusing the `th doctor`
 * wording. Pure + exported so it is unit-testable without spawning a process;
 * `main()` calls it with `process.version` and exits early when unsupported.
 */
function checkNodeVersion(version) {
    const m = /^v?(\d+)\./.exec(version);
    const major = m ? Number(m[1]) : 0;
    const ok = major >= exports.MIN_NODE_MAJOR;
    const message = ok
        ? `${version} (>= ${exports.MIN_NODE_MAJOR})`
        : `Unsupported Node ${version} — TwinHarness requires Node >= ${exports.MIN_NODE_MAJOR}. ` +
            `Upgrade via nvm (\`nvm install ${exports.MIN_NODE_MAJOR}\`) or https://nodejs.org/, then re-run \`th\`.`;
    return { ok, major, message };
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
        case "init": {
            // R-04 typed capture path: fold the boolean flag PAIRS into tri-state
            // optionals (undefined = "leave at the safe default / omit from state"), so
            // an operator sets a gate-defining field once cleanly at creation without
            // `--emergency`. Passing BOTH halves of a pair is contradictory → refused.
            if (parsed.flags.hasUi && parsed.flags.noUi) {
                return (0, output_1.failure)({ human: "Pass only one of --has-ui / --no-ui." });
            }
            if (parsed.flags.interviewRequired && parsed.flags.noInterviewRequired) {
                return (0, output_1.failure)({ human: "Pass only one of --interview-required / --no-interview-required." });
            }
            const hasUi = parsed.flags.hasUi ? true : parsed.flags.noUi ? false : undefined;
            const interviewRequired = parsed.flags.interviewRequired
                ? true
                : parsed.flags.noInterviewRequired
                    ? false
                    : undefined;
            return (0, init_1.runInit)(paths, {
                force: parsed.flags.force,
                brownfield: parsed.flags.brownfield,
                maxTokens: parsed.flags.maxTokens,
                deliveryMode: parsed.flags.deliveryMode,
                hasUi,
                interviewRequired,
                interviewCutoff: parsed.flags.interviewCutoff,
            });
        }
        case "budget":
            switch (sub) {
                case "check":
                    return (0, budget_1.runBudgetCheck)(paths, {
                        max: parsed.flags.max,
                        filesRead: parsed.flags.filesRead,
                        slicesBuilt: parsed.flags.slicesBuilt,
                        toolCalls: parsed.flags.toolCalls,
                        artifacts: parsed.flags.artifacts,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'budget' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "handoff":
            switch (sub) {
                case "write":
                    return (0, handoff_1.runHandoffWrite)(paths);
                case "verify":
                    return (0, handoff_1.runHandoffVerify)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'handoff' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "inspector":
            switch (sub) {
                case "write":
                    return (0, inspector_1.runInspectorWrite)(paths, {
                        content: parsed.flags.content,
                        file: parsed.flags.file,
                        version: parsed.flags.version,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'inspector' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        // SG3 P2-C — attach the live-QA Tester record the production-reality gate requires.
        case "tester":
            switch (sub) {
                case "record":
                    return (0, tester_1.runTesterRecord)(paths, {
                        driver: parsed.flags.driver,
                        provider: parsed.flags.provider,
                        evidenceRef: parsed.flags.evidenceRef,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'tester' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "resume":
            return (0, handoff_1.runResume)(paths);
        case "migrate":
            return (0, migrate_1.runMigrate)(paths);
        case "doctor":
            return (0, doctor_1.runDoctor)(paths, { strict: parsed.flags.strict });
        case "next":
            return (0, next_1.runNext)(paths, { explain: parsed.flags.explain });
        case "preview":
            return (0, preview_1.runPreview)(paths, { tier: parsed.flags.tier });
        case "scorecard":
            return (0, scorecard_1.runScorecard)(paths, { json: parsed.flags.json, hotspots: parsed.flags.hotspots });
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
                    // P4-6/P4-7 — optional REQ/file selectors for the repo-relevant layer and a
                    // --max-tokens budget (raw tokens here; the budget compares directly).
                    return (0, context_1.runContextPack)(paths, {
                        slice: parsed.flags.slice,
                        req: parsed.flags.req,
                        file: parsed.flags.file,
                        maxTokens: parsed.flags.maxTokens,
                    });
                case "read":
                    // SG3 P1-B (C-11) — batch read a comma-separated file list under one budget.
                    return (0, context_1.runContextRead)(paths, {
                        files: (parsed.flags.filesList ?? "").split(",").map((s) => s.trim()).filter(Boolean),
                        maxTokens: parsed.flags.maxTokens,
                    });
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
                case "pack": {
                    const packRes = (0, delegate_1.runDelegatePack)(paths, {
                        agent: parsed.flags.agent,
                        task: parsed.flags.task,
                        intent: parsed.flags.intent,
                        slice: parsed.flags.slice,
                        req: parsed.flags.req,
                        file: parsed.flags.file,
                        // SG3 P1-B (C-11) — explicit allowed-files write scope (comma-separated).
                        allowedFiles: (parsed.flags.allowedFiles ?? "").split(",").map((s) => s.trim()).filter(Boolean),
                    });
                    // SG3 P1-B (C-11) — ARM the DURABLE delegate scope so the out-of-process
                    // PreToolUse write-gate can enforce it (the installed hook receives no
                    // allowed_files on stdin — without this the scope never reached the gate and
                    // enforcement was inactive). The pack's normalized `data.allowedFiles` IS the
                    // scope; persist it (a non-empty set arms; an empty set disarms a prior scope).
                    // CLI-only: the MCP `th_delegate_pack` exposes no --allowed-files, so it never
                    // arms a scope and stays genuinely read-only.
                    if (packRes.ok) {
                        (0, delegation_scope_1.writeDelegationScope)(paths, packRes.data?.allowedFiles ?? [], {
                            agent: parsed.flags.agent,
                            slice: parsed.flags.slice,
                        });
                    }
                    return packRes;
                }
                case "capsule":
                    return (0, delegate_1.runDelegateCapsule)();
                case "check":
                    return (0, delegate_1.runDelegateCheck)(paths, { file: parsed.flags.capsule });
                default:
                    return (0, output_1.failure)({ human: `unknown 'delegate' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "repo":
            switch (sub) {
                case "map": {
                    // D-CONTRACTS-001: bare `th repo map` WRITES; --no-write (alias
                    // --dry-run) builds in memory only. --write is accepted (it is the
                    // default). --no-write/--dry-run wins when both are given.
                    const noWrite = parsed.flags.noWrite || parsed.flags.dryRun;
                    // P4-8 — configurable scan caps for large repos.
                    // R-14 / DR-04a — --force overrides the approved-artifact clobber guard so a
                    // deliberately-registered repo-map artifact can still be re-authored.
                    return (0, repo_1.runRepoMap)(paths, {
                        write: !noWrite,
                        format: parsed.flags.format,
                        scanOptions: buildScanOptions(parsed.flags),
                        force: parsed.flags.force,
                    });
                }
                case "relevant":
                    // Anchor: REQ-RU-020 — four selectors (--slice/--req/--file/--query)
                    // Anchor: REQ-RU-024 — path guard first (inside runRepoRelevant)
                    // Anchor: REQ-RU-025 — map-load failure
                    // Anchor: REQ-RU-026 — read-only
                    return (0, repo_1.runRepoRelevant)(paths, {
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
                    return (0, repo_1.runRepoImpact)(paths, {
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
                    // P4-8 — `th repo check` accepts the SAME --max-files/--max-bytes overrides
                    // as `th repo map`, so a large-repo map built with raised caps is re-checked
                    // against the matching scan scope (mismatched caps would phantom-flag files
                    // outside the build's scope as added/removed).
                    return (0, repo_1.runRepoCheck)(paths, { scanOptions: buildScanOptions(parsed.flags) });
                case "search":
                    // SG3 P1-B (C-11) — governed, receipt-bearing repo search over the map's scope.
                    return (0, repo_1.runRepoSearch)(paths, {
                        pattern: parsed.flags.pattern,
                        kind: parsed.flags.kind,
                        maxResults: parsed.flags.maxResults,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'repo' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "decision":
            switch (sub) {
                case "detect":
                    // Anchor: REQ-405 — read-only candidate surfacing; exit 0 always.
                    return (0, decision_1.runDecisionDetect)(paths, {});
                case "add":
                    // Anchor: REQ-402 — record a proposed decision; mint id; never auto-approve.
                    return (0, decision_1.runDecisionAdd)(paths, {
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
                    return (0, decision_1.runDecisionApprove)(paths, rest[0], {
                        reject: parsed.flags.reject,
                        supersede: parsed.flags.supersede,
                        as: parsed.flags.as,
                    });
                case "check":
                    // Anchor: REQ-404 — exit 6 when an unapproved decision gates the stage.
                    return (0, decision_1.runDecisionCheck)(paths, {});
                case "list":
                    // Anchor: REQ-406 — sorted decision read model; exit 0 always.
                    return (0, decision_1.runDecisionList)(paths, {});
                default:
                    return (0, output_1.failure)({ human: `unknown 'decision' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "stage":
            switch (sub) {
                case "current":
                    return (0, stage_1.runStageCurrent)(paths);
                case "describe":
                    return (0, stage_1.runStageDescribe)(rest[0]);
                case "list":
                    return (0, stage_1.runStageList)();
                case "advance":
                    return (0, stage_1.runStageAdvance)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'stage' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "sim":
            switch (sub) {
                case "add":
                    // SG3 P2-C — append an active simulation-ledger entry (classification required).
                    return (0, sim_1.runSimAdd)(paths, {
                        classification: parsed.flags.classification,
                        replaces: parsed.flags.replaces,
                        introSlice: parsed.flags.introSlice,
                        retireSlice: parsed.flags.retireSlice,
                        owner: parsed.flags.owner,
                        userVisible: parsed.flags.userVisible,
                    });
                case "list":
                    return (0, sim_1.runSimList)(paths, {});
                case "retire":
                    return (0, sim_1.runSimRetire)(paths, rest[0], { retireSlice: parsed.flags.retireSlice });
                case "scan":
                    // Advisory: grep dist/+tests for unledgered simulation patterns (exit 0).
                    return (0, sim_1.runSimScan)(paths, {});
                default:
                    return (0, output_1.failure)({ human: `unknown 'sim' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "gate":
            switch (sub) {
                case "production-reality":
                    // SG3 P2-C — PURE READER of checkProductionReality (no verb-calls-verb).
                    return (0, gate_1.runGateProductionReality)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'gate' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "manifest":
            switch (sub) {
                case "export":
                    return (0, manifest_1.runManifestExport)(paths);
                case "tools":
                    // C-09/C-16: runtime tool discovery — the CLI mirror of MCP ListTools.
                    return (0, manifest_1.runManifestTools)();
                default:
                    return (0, output_1.failure)({ human: `unknown 'manifest' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "template":
            switch (sub) {
                case "get":
                    // C-10 — deterministic template resolver (project-override → plugin-bundled → structured miss).
                    return (0, template_1.runTemplateGet)(paths, rest[0]);
                case "list":
                    return (0, template_1.runTemplateList)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'template' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "state":
            switch (sub) {
                case "get":
                    return (0, state_1.runStateGet)(paths, rest[0]);
                case "set":
                    if (rest.length < 2)
                        return (0, output_1.failure)({ human: "usage: th state set <dotted.key> <value>" });
                    return (0, state_1.runStateSet)(paths, rest[0], rest.slice(1).join(" "), { emergency: parsed.flags.emergency });
                case "status":
                    return (0, state_1.runStateStatus)(paths);
                case "verify":
                    return (0, state_1.runStateVerify)(paths);
                case "unlock":
                    return (0, state_1.runStateUnlock)(paths, { force: parsed.flags.force });
                default:
                    return (0, output_1.failure)({ human: `unknown 'state' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "tier":
            switch (sub) {
                case "classify":
                    return (0, tier_1.runTierClassify)(paths, rest[0]);
                case "veto-check":
                    return (0, tier_1.runTierVetoCheck)(paths, rest[0]);
                case "record":
                    return (0, tier_1.runTierRecord)(paths, rest[0]);
                case "features":
                    return (0, tier_1.runTierFeatures)(paths);
                default:
                    return (0, output_1.failure)({ human: `unknown 'tier' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "implementation":
            switch (sub) {
                case "unlock":
                    return (0, stage_1.runImplementationUnlock)(paths, { lock: parsed.flags.lock });
                default:
                    return (0, output_1.failure)({ human: `unknown 'implementation' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        case "artifact":
            switch (sub) {
                case "register":
                    return (0, artifact_1.runArtifactRegister)(paths, rest[0], parsed.flags.version);
                case "list":
                    return (0, artifact_1.runArtifactList)(paths);
                // Anchor: REQ-PCO-041 — section-level artifact leases (file#section).
                case "claim":
                    return (0, artifact_lease_1.runArtifactClaim)(paths, { section: rest[0] ?? parsed.flags.section, holder: parsed.flags.holder });
                case "release":
                    return (0, artifact_lease_1.runArtifactRelease)(paths, { section: rest[0] ?? parsed.flags.section, holder: parsed.flags.holder });
                case "leases":
                    return (0, artifact_lease_1.runArtifactLeases)(paths);
                case "section":
                    // SG3 P1-B (C-12) — bounded named-heading extraction with a content-hash receipt.
                    return (0, artifact_1.runArtifactSection)(paths, {
                        file: parsed.flags.file,
                        section: parsed.flags.section,
                        maxTokens: parsed.flags.maxTokens,
                    });
                default:
                    return (0, output_1.failure)({ human: `unknown 'artifact' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        // SG3 P2-A — governed research-output path (resolves C-01). The write target is
        // hard-pinned to docs/00-research/<topic>.md inside runResearchWrite.
        case "research":
            switch (sub) {
                case "write":
                    return (0, research_1.runResearchWrite)(paths, { topic: parsed.flags.topic, markdown: parsed.flags.markdown, version: parsed.flags.version });
                default:
                    return (0, output_1.failure)({ human: `unknown 'research' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
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
                    // P6-5 (#19): --no-obvious-writes (alias --read-only) blocks obvious repo-mutating verify commands (heuristic, not a security boundary).
                    return (0, verify_1.runVerifyRun)(paths, { readOnly: parsed.flags.readOnly });
                case "add":
                    // P6-2 (#19): --as records the actor in per-command provenance.
                    return (0, verify_1.runVerifyAdd)(paths, rest.join(" "), { as: parsed.flags.as });
                case "approve":
                    // P6-2 (#19): human-confirm the current command set for execution.
                    return (0, verify_1.runVerifyApprove)(paths, { as: parsed.flags.as });
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
                    return (0, build_1.runBuildPlan)(paths, { includeDone: parsed.flags.includeDone, advise: parsed.flags.advise });
                case "next-wave":
                    return (0, build_1.runBuildNextWave)(paths);
                case "dispatch":
                    // Anchor: REQ-PCO-001 — full parallel wave + per-slice spawn descriptors in one payload.
                    return (0, build_1.runBuildDispatch)(paths);
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
        // Anchor: REQ-PCO-040 — blackboard collab substrate (fragments + reconcile-merge).
        case "collab":
            switch (sub) {
                case "init":
                    return (0, collab_1.runCollabInit)(paths, { stage: parsed.flags.stage });
                case "fragment":
                    return (0, collab_1.runCollabFragment)(paths, {
                        stage: parsed.flags.stage,
                        round: parsed.flags.round,
                        name: parsed.flags.name,
                        text: parsed.flags.text,
                        force: parsed.flags.force,
                    });
                case "list":
                    return (0, collab_1.runCollabList)(paths, { stage: parsed.flags.stage, round: parsed.flags.round });
                case "merge":
                    return (0, collab_1.runCollabMerge)(paths, { stage: parsed.flags.stage, round: parsed.flags.round });
                default:
                    return (0, output_1.failure)({ human: `unknown 'collab' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
            }
        // Anchor: REQ-PCO-042 — append-only debate ledger (mirrors the drift ledger).
        case "debate":
            switch (sub) {
                case "add":
                    return (0, debate_1.runDebateAdd)(paths, {
                        topic: parsed.flags.topic ?? rest[0],
                        positions: parsed.flags.positions,
                        links: parsed.flags.links,
                        source: parsed.flags.source,
                    });
                case "list":
                    return (0, debate_1.runDebateList)(paths);
                case "resolve":
                    return (0, debate_1.runDebateResolve)(paths, { id: parsed.flags.id ?? rest[0], resolution: parsed.flags.resolution });
                default:
                    return (0, output_1.failure)({ human: `unknown 'debate' subcommand: ${sub ?? "(none)"}\n\n${HELP}` });
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
 * Write `text` to stdout, then exit with `code` ONLY after the bytes have drained.
 * stdout to a pipe is ASYNCHRONOUS on POSIX (macOS/Linux), so a bare `process.exit()`
 * right after a large `write` truncates it mid-flush — the proven failure was
 * `th help` losing its tail on macOS CI while passing on
 * Linux/Windows. Exiting from the write callback guarantees the OS accepted the data
 * first; `process.exitCode` is mirrored so a natural drain still carries the code.
 */
function writeAndExit(text, code) {
    process.exitCode = code;
    process.stdout.write(text, () => process.exit(code));
    return undefined;
}
/** Render a {@link CommandResult} to stdout (honoring `--json`) and exit with its code. */
function emitAndExit(result, json) {
    return writeAndExit((0, output_1.renderResult)(result, json) + "\n", result.exitCode);
}
/**
 * Map a KNOWN typed core error to a clean structured failure — the single CLI
 * error boundary — so every command returns a non-zero exit + a valid `--json`
 * envelope instead of a raw Node stack crash. Two families flow here:
 *   • State-store contention (lock timeout, or a write that lost the rename race
 *     past its retry budget) — exit 1, "retry the command".
 *   • Path-containment violations (an absolute / ".." / separator-bearing segment
 *     that escapes the project root) — a client/security reject, exit 2.
 * Any OTHER error is a real bug and is rethrown.
 */
function mapDispatchError(e) {
    const code = e.code;
    if (e instanceof paths_1.PathContainmentError) {
        return (0, output_1.failure)({ human: e.message, data: { error: e.code, segment: e.segment }, exitCode: 2 });
    }
    if (code === "state_lock_timeout" || code === "state_write_contended") {
        return (0, output_1.failure)({ human: e.message, data: { error: code } });
    }
    // R-33 / F4 — the mutation-boundary refused a too-new / corrupt on-disk state
    // (writeState's assertWriteAllowed seam). A client-correctable refusal, not a
    // bug: surface the stable `schema_too_new` token + the on-disk/current versions
    // so a `--json` caller can react (upgrade th, or repair the file).
    if (code === "schema_too_new") {
        const err = e;
        return (0, output_1.failure)({
            human: err.message,
            data: { error: code, onDisk: err.onDisk, current: err.current },
        });
    }
    throw e;
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
/**
 * Resolve the project paths for a hook dispatch, reading the hook's stdin payload
 * once and applying the SAME stdin-`cwd` precedence to every hook (PreToolUse /
 * Stop / SubagentStop). Claude Code does NOT pass `--cwd` to the shipped hooks
 * (`hooks/hooks.json`), so the session's project dir arrives ONLY on the stdin
 * payload's `cwd`. If all three hooks resolved from process cwd while one read
 * stdin, they could govern different roots for one session — the write-gate and
 * the completion-gate must agree.
 *
 * Precedence (identical for all hooks): prefer the payload's `cwd` UNLESS the
 * caller explicitly passed `--cwd` (then the explicit flag wins). Returns the
 * resolved paths alongside the parsed payload so callers don't re-read stdin.
 */
function resolveHookPaths(flagCwd) {
    const payload = readHookStdin();
    const cwdFromStdin = payload?.cwd;
    const effectiveCwd = cwdFromStdin && !process.argv.includes("--cwd") ? cwdFromStdin : flagCwd;
    return { paths: (0, paths_1.resolveProjectPaths)(effectiveCwd), payload };
}
function main() {
    // P0-4 (#20) — fail fast with a friendly, actionable message on an unsupported
    // Node, BEFORE any command runs. A too-old runtime can otherwise surface as an
    // opaque syntax/API error deep inside a command.
    const node = checkNodeVersion(process.version);
    if (!node.ok) {
        process.stderr.write(node.message + "\n");
        process.exit(1);
    }
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
        writeAndExit((0, output_1.renderResult)(result, parsed.flags.json) + "\n", result.exitCode);
    }
    // Hook commands speak the Claude Code hook protocol on stdout (not --json).
    // A matched hook command is TERMINAL: it must be the SOLE thing on stdout so a
    // strict JSON consumer (Claude Code) parses the decision. `writeAndExit` defers
    // its `process.exit` to the stdout-flush callback, so a bare fall-through would
    // synchronously reach `dispatch` below and append "unknown command: hook" + the
    // full help to the hook's stdout — corrupting the decision into unparseable JSON
    // (a fail-open). Compute the decision, then exit; never fall through.
    if (parsed.positionals[0] === "hook") {
        let hookOut;
        if (parsed.positionals[1] === "stop-gate") {
            const { paths, payload } = resolveHookPaths(parsed.flags.cwd);
            hookOut = (0, hook_1.runHookStopGate)(paths, payload);
        }
        else if (parsed.positionals[1] === "pretool-gate") {
            const { paths, payload } = resolveHookPaths(parsed.flags.cwd);
            hookOut = (0, hook_1.runHookPretoolGate)(paths, payload);
        }
        else if (parsed.positionals[1] === "subagent-stop") {
            const { paths, payload } = resolveHookPaths(parsed.flags.cwd);
            hookOut = (0, hook_1.runHookSubagentStop)(paths, payload);
        }
        if (hookOut) {
            writeAndExit(hookOut.stdout + "\n", hookOut.exitCode);
            // `writeAndExit` defers `process.exit` to the stdout-drain callback (an
            // intentional POSIX large-output correctness measure — see its doc), so it
            // returns synchronously. Without this `return`, control would fall through
            // to `dispatch` below and append help text to the hook's stdout BEFORE the
            // drain callback exits. Stop the synchronous continuation here.
            return;
        }
        // An unknown `hook <x>` subcommand falls through to the normal help/error path.
    }
    let result;
    try {
        result = dispatch(parsed);
    }
    catch (e) {
        result = mapDispatchError(e);
    }
    emitAndExit(result, parsed.flags.json);
}
if (require.main === module)
    main();
