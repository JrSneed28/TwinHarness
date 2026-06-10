# System Architecture — Autocoder

> **Stage 4 — System Architecture** (spec §14.4). Mostly streams; human gate on the **one or two
> genuinely irreversible style decisions** surfaced as explicit choices (§8) — everything else
> proceeds without blocking approval. Reads Summaries from `01-requirements.md`, `02-scope.md`,
> and `03-domain-model.md` by default; fetches full artifacts only when a detail cannot be
> resolved from the Summary (§9). Recommends sane defaults where the user has no preference.
> Security and Failure Modes are **folded sections** here by default; for this **Tier-3,
> data-integrity** project they **graduate** to their own stages
> (`08a-security-threat-model.md` and `08b-failure-edge-cases.md`) — the sections below are
> forward-pointers, not the full treatments (§13, spec §15.S, §15.F).

## Summary

Autocoder is a **layered, single-process CLI pipeline** built around one central orchestrator —
the **AgentRun loop controller** — that drives a single sequential agent loop (no parallel tools,
locked per REQ-NFR-002 / Assumptions). The harness is deterministic and offline-testable because
the two non-deterministic dependencies are isolated behind injected interfaces: the **LlmClient**
(wrapping the Anthropic TS SDK) and the **CommandRunner** (wrapping shell/process execution). The
loop reads from the model, dispatches the model's tool calls through a **ToolRegistry** to the
five tool implementations, mediates every mutation/exec through the **PathSandbox** and the
**ApprovalGate**, renders **Diffs**, runs the project's tests as the completion signal, accrues
the **Budget**, and always terminates on one **StopCondition** into a **RunOutcome** rendered by
the **Reporter** (human stream + `--json`). A durable **Transcript** records every event for
audit. Two trust boundaries dominate the design — the **LLM/network boundary** (untrusted model
output crossing into the harness) and the **filesystem/shell boundary** (untrusted
write/exec intent crossing into the developer's machine).

- **Architectural style:** layered single-process CLI pipeline with a central agent-loop
  controller and dependency-injected LLM + shell seams (deterministic harness, REQ-NFR-002).
- **Key components:** **AgentRun** (loop controller / orchestrator), **ToolRegistry + 5 Tools**
  (the model's mediated effector surface), **PathSandbox + ApprovalGate** (the two safety gates
  that make every mutation/exec confined and approved).
- **Irreversible decision(s) — CONFIRMED (2026-06-09):** (1) **Tool-use protocol = Anthropic
  native structured tool-use** (Messages API `tool_use`/`tool_result` blocks) over a custom
  text-parsed protocol; (2) **Transcript persistence = append-only JSONL event log** over a single
  structured JSON document. The human deferred the explicit gate and adopted the architect's
  recommended options; both remain reversible behind their named seams (`LlmClient` for the
  protocol; the typed/versioned `TranscriptEntry` schema for the format). See **Architecture Risks**
  and **Verification Notes** for the decision briefs.

---

## Inputs Used

| Artifact | Version | Sections consumed |
|---|---|---|
| `01-requirements.md` | signed-off 2026-06-09 | Summary, Functional Requirements (REQ-001…025), Non-Functional Requirements (REQ-NFR-001…008), Constraints, Non-Negotiables |
| `02-scope.md` | signed-off 2026-06-09 | Summary, MVP Scope, Scope Risks, User-Confirmed Decisions |
| `03-domain-model.md` | streamed 2026-06-09 | Summary, Core Entities, State Models, Domain Rules (RULE-001…016), Domain Events |

---

## Architecture Summary

Autocoder is a **layered single-process CLI pipeline**. There is no service mesh, no message
broker, no database — it is a program that runs once, end-to-end, on the developer's machine
against one repository and exits with a code. The shape is dictated by the requirements and
scope: one task per invocation (REQ-001, Assumptions), a **single sequential agent loop** with no
parallel tool execution (locked, Assumptions / scope), local CLI form factor (Constraints), and a
**deterministic, offline-testable harness** in which the Anthropic SDK and the shell are injected
behind interfaces (REQ-NFR-002 — a hard non-negotiable). That last constraint is the strongest
force on the design: every non-deterministic edge of the system is pushed behind exactly one
interface (`LlmClient`, `CommandRunner`) so that all loop control, tool dispatch, path
sandboxing, diff generation, approval gating, budget enforcement, and stop-condition logic — the
entire harness — is plain deterministic code unit-testable with stubs (RULE-015).

The system is organized as a thin **CLI/config layer** on top of a central **AgentRun**
orchestrator (the domain aggregate root). AgentRun owns the loop: it builds `RepoContext`, then
repeatedly asks the `LlmClient` for the next action, routes returned tool calls through the
`ToolRegistry` to one of five `Tool` implementations, and feeds each `ToolResult` back. Two safety
components sit *between the model's intent and the real world* and enforce the domain's blast-radius
rules: the **PathSandbox** (RULE-001 / REQ-021 — no write or exec escapes the root) and the
**ApprovalGate** (RULE-004/005 / REQ-012/016 — confirm-each edits, allowlist-or-confirm commands).
A **Diff/Patch engine** guarantees no silent writes (RULE-002 / REQ-010). A **Budget controller**
enforces the hard iteration/token ceilings before each turn (RULE-006 / REQ-015), and a
**StopCondition classifier** guarantees bounded termination into a `RunOutcome` (RULE-007 /
REQ-014). A durable **Transcript writer** records every domain event for reconstructable audit
(RULE-010 / REQ-022 / REQ-NFR-008), and a **Reporter** renders the human stream and the `--json`
summary (REQ-017/019/024). The two irreversible decisions that went to the human gate are the
**tool-use protocol** (native structured tool-use vs. custom text parsing) and the **transcript
persistence format** (append-only JSONL vs. single JSON document) — both detailed below.

---

## Major Components

> "Components-touched label" is the stable token Stage 9 slice planning uses to detect overlap.
> Components are load-bearing only; trivial wrappers are folded into their owner.

### CLI / Entry Layer

- **Responsibility:** parse argv and subcommands, read the task (positional / `--task` / stdin /
  file), select the run mode (`run` vs. allowlist-management subcommands), wire dependencies, and
  set the process exit code from the final `RunOutcome`.
- **Realizes:** REQ-001, REQ-002 (flag surface), REQ-020 (exit code), REQ-025 (allowlist
  subcommands), REQ-NFR-006 (`--help`, fail-fast messaging).
- **Components-touched label:** `cli`
- **Notes:** thin; contains no agent logic. The composition root that injects `LlmClient` and
  `CommandRunner` real implementations in production and stubs in tests (REQ-NFR-002).

### Config Resolver

- **Responsibility:** merge configuration from flags, environment, and an optional config file
  into one resolved `Config`; fail fast on missing required values (API key, invalid root); persist
  allowlist mutations back to the config file.
- **Realizes:** REQ-018, REQ-002 (root resolution input), REQ-015 (ceiling values), REQ-016
  (allowlist source), REQ-025 (persistence), REQ-NFR-006 (fail-fast).
- **Components-touched label:** `config`
- **Notes:** precedence flags > env > file. Enforces RULE-016 (fail-fast misconfiguration).

### RepoContext Builder

- **Responsibility:** build the initial understanding of the target repo — directory listing,
  detected project type, **detected test command**, key files — without loading the whole repo
  into the prompt.
- **Realizes:** REQ-003, REQ-013 (provides the test command used as the completion signal).
- **Components-touched label:** `repo-context`
- **Notes:** test-command detection (e.g. from `package.json` scripts) is overridable via config
  (Assumptions). Reads only — uses the read path, never mutates.

### AgentRun Orchestrator (Loop Controller)

- **Responsibility:** own the run lifecycle and the single sequential agent loop —
  Initializing → GatheringContext → Iterating → AwaitingApproval → Terminating — sending
  task+context+results to the `LlmClient`, dispatching returned tool calls, accumulating the
  conversation, checking the Budget guard before each turn, and resolving the StopCondition.
- **Realizes:** REQ-004, REQ-005 (loop + tool execution), REQ-014 (termination), REQ-013 (uses
  test result as completion signal), drives REQ-015 budget checks.
- **Components-touched label:** `agent-run`
- **Notes:** the domain aggregate root. Strictly sequential — one tool call resolved fully before
  the next (locked: no parallel tools). Enforces RULE-007 (bounded termination), coordinates
  RULE-006 (budget guard) and RULE-008 (errors-as-results).

### LlmClient Adapter *(DI seam — LOCKED)*

- **Responsibility:** the **single interface** wrapping the Anthropic TS SDK — send a conversation
  + tool schemas, receive the model's response (tool_use blocks or final answer) and token usage;
  apply bounded-backoff retry on transient API failures.
- **Realizes:** REQ-004, REQ-005 (tool-use transport), REQ-NFR-002 (injected for determinism),
  REQ-NFR-004 (retry with backoff), feeds REQ-015 (token accounting).
- **Components-touched label:** `llm-client`
- **Notes:** **isolates the SDK behind one seam (REQ-NFR-002, LOCKED).** Production impl calls
  `@anthropic-ai/sdk`; tests inject a deterministic stub. The **tool-use protocol** lives here and
  is the irreversible decision #1 (see Risks). Emits `LLMRetry` events.

### ToolRegistry + Dispatcher

- **Responsibility:** declare the **exactly five** tool schemas exposed to the model and dispatch
  each model `ToolCall` to its executor; reject any tool name outside the fixed set; normalize
  every executor outcome (success or error) into a `ToolResult`.
- **Realizes:** REQ-005, REQ-006…REQ-009, REQ-023 (the five-tool surface), REQ-NFR-004
  (errors-as-results).
- **Components-touched label:** `tool-registry`
- **Notes:** enforces RULE-012 (fixed five-tool surface, SCOPE-RISK-001 guardrail) and RULE-008
  (tool errors become results, never crashes).

### Tool: ReadFile

- **Responsibility:** return full or bounded-range file contents; **read-anywhere** (may read
  paths outside the root).
- **Realizes:** REQ-006, REQ-021 (read-anywhere half of the policy / RULE-003).
- **Components-touched label:** `tool-read`
- **Notes:** the only effector permitted outside the root; content read from outside can never be
  written back outside (RULE-003 enforced by PathSandbox on the write side).

### Tool: ListSearch

- **Responsibility:** list directory entries and search file contents (glob and/or text/regex)
  within the working root.
- **Realizes:** REQ-007.
- **Components-touched label:** `tool-search`
- **Notes:** read-only; scoped to the root for listing/search.

### Tool: WriteEdit

- **Responsibility:** create or modify a file via whole-file write **or** targeted string-replace;
  produce an `Edit` (path, before, after) for the Diff/Patch engine; never write directly.
- **Realizes:** REQ-008, REQ-010 (produces a Diff), REQ-011 (persist on approval), REQ-021 (via
  PathSandbox).
- **Components-touched label:** `tool-writeedit`
- **Notes:** mutating — every Edit flows through PathSandbox (RULE-001) + Diff (RULE-002) +
  ApprovalGate (RULE-004) before persistence.

### Tool: ApplyPatch

- **Responsibility:** apply a unified-diff `Patch` (one+ hunks across one+ files) to the working
  tree as a set of `Edit`s; reject malformed/non-applying patches atomically with an actionable
  error fed back as a `ToolResult` (no partial application).
- **Realizes:** REQ-023, REQ-010, REQ-011, REQ-021, REQ-012 (edit-approval gated).
- **Components-touched label:** `tool-applypatch`
- **Notes:** enforces RULE-013 (atomic rejection). Shares the Diff/Patch engine, PathSandbox, and
  ApprovalGate with WriteEdit.

### Tool: RunCommand

- **Responsibility:** execute a shell command in the working root via the `CommandRunner`,
  capturing exit code, stdout, stderr; surface test runs as the completion signal.
- **Realizes:** REQ-009, REQ-013 (test runs), REQ-016 (command-approval gated), REQ-021 (root
  confinement).
- **Components-touched label:** `tool-runcommand`
- **Notes:** executing — every command flows through PathSandbox (cwd confinement, RULE-001) +
  ApprovalGate command policy (RULE-005) before the `CommandRunner` runs it.

### CommandRunner *(DI seam — LOCKED)*

- **Responsibility:** the **single interface** wrapping OS process/shell execution — run a command
  in a given cwd, capture exit/stdout/stderr; the only place real shell execution happens.
- **Realizes:** REQ-009, REQ-NFR-002 (injected for determinism), REQ-NFR-007 (cross-platform
  shell handling).
- **Components-touched label:** `command-runner`
- **Notes:** **isolates the shell behind one seam (REQ-NFR-002, LOCKED).** Production impl uses
  Node `child_process`; tests inject a deterministic stub. Cross-platform path/shell differences
  (REQ-NFR-007, SCOPE-RISK-005) are contained here.

### PathSandbox (Root-Confinement Guard)

- **Responsibility:** validate that every **write and exec** target resolves inside the working
  root, rejecting traversal / absolute / symlink escapes **before** the operation; permit reads
  outside the root.
- **Realizes:** REQ-021, REQ-NFR-005 (least authority).
- **Components-touched label:** `path-sandbox`
- **Notes:** the data-integrity safety boundary. Enforces RULE-001 and the write-isolation half of
  RULE-003. Pure deterministic function — heavily negative-tested (Success Criteria: path-escape
  rejection). ⚠ blast-radius: data integrity.

### ApprovalGate (Edit + Command)

- **Responsibility:** resolve each mutating/executing `ToolCall` against the configured
  `ApprovalPolicy` into an `ApprovalDecision` (auto-approved / approved-by-user / denied); a
  denial yields an error `ToolResult` rather than executing.
- **Realizes:** REQ-012 (edit policy, confirm-each default), REQ-016 (command policy, allowlist
  auto-run / non-allowlisted confirm), REQ-NFR-005.
- **Components-touched label:** `approval-gate`
- **Notes:** the trust boundary between model intent and the real world. Enforces RULE-004 (edit
  gating) and RULE-005 (command gating). Consults the `Allowlist` for command decisions; honors
  `--yes`/`--auto`. ⚠ blast-radius: safety.

### Allowlist Manager

- **Responsibility:** hold the configurable command allowlist; match commands for the
  ApprovalGate; provide inspect/add/remove operations that persist to config.
- **Realizes:** REQ-016 (matching), REQ-025 (inspect/add/remove UX), REQ-018 (persistence).
- **Components-touched label:** `allowlist`
- **Notes:** default entries = detected test/build command + safe read-only commands. Enforces
  RULE-014 (allowlist changes persist).

### Diff/Patch Engine

- **Responsibility:** generate the unified `Diff` (before → after) for every `Edit`; parse and
  apply input `Patch` documents for ApplyPatch; reject non-applying patches.
- **Realizes:** REQ-010 (no silent writes), REQ-008, REQ-023.
- **Components-touched label:** `diff-engine`
- **Notes:** enforces RULE-002 (no Edit reaches Applied without a Diff) and supports RULE-013.
  Pure deterministic.

### Budget / StopCondition Controller

- **Responsibility:** accrue iterations and token usage; enforce the hard ceilings **before each
  turn**; classify the terminating reason into one `StopCondition` and derive the `RunOutcome`
  status.
- **Realizes:** REQ-014 (stop conditions), REQ-015 (ceilings), REQ-NFR-003 (runaway protection),
  REQ-020 (outcome → exit code).
- **Components-touched label:** `budget-stop`
- **Notes:** enforces RULE-006 (budget is a hard ceiling) and RULE-007 (bounded termination). The
  budget guard runs on every Iterating → Iterating step. ⚠ blast-radius: cost.

### Transcript Writer

- **Responsibility:** durably record every domain event (iteration, tool call, tool result,
  approval decision, diff, stop condition) as ordered entries sufficient to reconstruct the run.
- **Realizes:** REQ-022, REQ-NFR-008 (observability).
- **Components-touched label:** `transcript`
- **Notes:** enforces RULE-010 (durable reconstructable audit). Persistence **format** is the
  irreversible decision #2 (append-only JSONL vs. single JSON doc — see Risks). ⚠ blast-radius:
  data integrity / audit.

### Reporter (Human Stream + `--json`)

- **Responsibility:** stream human-readable progress during the run (plan/step, each tool call +
  outcome, diffs, test results) and emit the final `RunSummary` both human-readably and as
  schema-stable `--json`.
- **Realizes:** REQ-017 (human stream), REQ-019 (final summary), REQ-024 (`--json`), REQ-NFR-006
  (readable output).
- **Components-touched label:** `reporter`
- **Notes:** the `--json` schema is stable and parseable by CI (the secondary user). Renders the
  same `RunOutcome` two ways.

---

## Responsibilities

| Component | Owns | Does NOT own |
|---|---|---|
| AgentRun Orchestrator | loop control, conversation accumulation, turn sequencing, stop resolution | SDK calls, shell exec, path validation, diff generation, approval prompting |
| LlmClient | SDK transport, retry/backoff, token-usage extraction, tool-use protocol | loop control, budget decisions, approval |
| CommandRunner | raw process execution, cross-platform shell, output capture | command-approval, cwd confinement decision (delegates to PathSandbox/ApprovalGate before being called) |
| PathSandbox | write/exec confinement validation | approval decisions, the actual write/exec |
| ApprovalGate | edit/command policy resolution, user prompting, allowlist consultation | path confinement, executing the action itself |
| Diff/Patch Engine | diff generation, patch parse/apply/reject | persistence to disk, approval |
| Budget/StopCondition Controller | ceiling enforcement, stop classification, outcome status | rendering, transcript writing |
| Transcript Writer | durable event log | live human streaming (Reporter does that) |
| Reporter | human stream + `--json` summary | durable on-disk audit (Transcript does that) |

---

## System Boundaries

The system has **two trust boundaries that dominate every safety rule**, plus the human principal
and the config sources.

- **LLM / network boundary (untrusted output)** — interaction: AgentRun ⇄ `LlmClient` ⇄ Anthropic
  Messages API over HTTPS. The model's responses (tool calls + arguments) are **untrusted input**:
  the model can request any path, any command, any patch. — trust: **untrusted** (model output is
  treated as adversarial intent and must pass PathSandbox + ApprovalGate before any effect).
- **Filesystem / shell boundary (untrusted intent → real machine)** — interaction:
  WriteEdit/ApplyPatch/RunCommand ⇄ PathSandbox/ApprovalGate ⇄ disk + `CommandRunner`. This is
  where model intent becomes real mutation/execution on the developer's machine. — trust:
  **untrusted until gated** (every write/exec is confined to the root and approved per policy;
  reads may range outside the root by the read-anywhere decision, with residual read-exposure
  risk accepted upstream).
- **Human principal (developer)** — interaction: terminal stdin (approvals, abort) + stdout
  (stream, summary) + exit code. — trust: **trusted authority** (owns the task, approves
  edits/commands, can abort).
- **Config sources (flags / env / file)** — interaction: read at startup by Config Resolver;
  `ANTHROPIC_API_KEY` via env. — trust: **trusted** (developer-controlled), but validated
  fail-fast.

> The Anthropic API key crosses the LLM/network boundary; auth to that boundary is a single
> bearer credential the developer supplies. The full trust-boundary analysis is in
> `08a-security-threat-model.md` (graduated — see Security below).

---

## Data Flow

### Primary flow: one autonomous coding run

1. **Developer** invokes `autocoder "<task>"` → **CLI / Entry Layer** captures the task and flags.
2. **CLI** → **Config Resolver** merges flags + env + file into a resolved `Config`; fail-fast if
   API key missing or root invalid (REQ-018, REQ-NFR-006).
3. **CLI** resolves & validates the **WorkingRoot** and injects the real `LlmClient` +
   `CommandRunner` (or stubs, in tests) → constructs **AgentRun** (REQ-002, REQ-NFR-002).
4. **AgentRun** → **RepoContext Builder** assembles listing + project type + **detected test
   command** + key files (REQ-003, REQ-013).
5. **AgentRun** sends task + context + accumulated `ConversationMessage`s + tool schemas to the
   **LlmClient**, which returns `tool_use` blocks **or** a final answer + token usage
   (REQ-004, REQ-005).
6. For each returned **ToolCall**, **AgentRun** → **ToolRegistry** dispatches to the matching
   **Tool**:
   - **read / list-search** → execute directly (read-anywhere for read), return `ToolResult`.
   - **write/edit / apply-patch** → **Diff/Patch Engine** produces `Edit` + `Diff` →
     **PathSandbox** validates target in root (reject on escape) → **ApprovalGate** resolves edit
     policy → on approval, persist to disk → `ToolResult` (REQ-008/010/011/021/023).
   - **run-command** → **PathSandbox** confines cwd → **ApprovalGate** resolves command policy
     against the **Allowlist** → on approval, **CommandRunner** executes → capture
     exit/stdout/stderr → `ToolResult` (REQ-009/013/016/021).
7. Every `ToolResult` (ok or error) is appended to the conversation and fed back; every event is
   written to the **Transcript** and streamed by the **Reporter** (REQ-NFR-004, REQ-022, REQ-017).
8. Before the next turn, **Budget/StopCondition Controller** checks
   `iterationsUsed`/`tokensUsed` against ceilings; if exceeded, transition to Terminating
   (REQ-015, RULE-006).
9. The loop repeats (step 5) until a **StopCondition** fires (task-success / max-iterations /
   budget-exhausted / model-give-up / unrecoverable-error) (REQ-014).
10. **AgentRun** classifies the StopCondition → **RunOutcome** → **Reporter** emits the final
    summary human-readably + as `--json`; **CLI** sets the exit code (0 succeeded / non-zero
    stopped|failed) (REQ-019, REQ-024, REQ-020).

### Secondary flow: allowlist management

1. **Developer** runs an allowlist subcommand (inspect / add / remove) → **CLI**.
2. **CLI** → **Allowlist Manager** performs the operation → **Config Resolver** persists to the
   config file → **Reporter** confirms (REQ-025, REQ-018, RULE-014). No agent loop is started.

---

## Runtime Flow

- **Startup:** parse argv → resolve `Config` (flags > env > file) → fail-fast on missing API
  key / invalid root (RULE-016) → resolve & validate WorkingRoot → wire dependencies
  (inject real or stub `LlmClient` + `CommandRunner`) → construct AgentRun. *(Maps to domain
  state **Initializing**.)*
- **Context phase:** AgentRun builds RepoContext (listing, project type, test command).
  *(Domain state **GatheringContext**.)*
- **Loop lifecycle (single, sequential):** for each turn — **budget guard check** → send to
  `LlmClient` (with bounded-backoff retry on transient failure, RULE-008) → receive tool_use /
  final → if tool calls: dispatch **one at a time**, each through PathSandbox + ApprovalGate as
  applicable → capture `ToolResult` → append to conversation + Transcript → repeat. A mutating
  edit or non-allowlisted command suspends the loop at **AwaitingApproval** for terminal stdin
  before proceeding. *(Domain states **Iterating** ⇄ **AwaitingApproval**; per-turn sub-lifecycle
  Requested → Planned → Gated → Executing → Recorded.)*
- **No background / async work:** the MVP is strictly synchronous and sequential — **no parallel
  tool execution, no queues, no schedulers** (locked, Assumptions). The only concurrency concern
  is bounded-backoff retry inside `LlmClient`, which is sequential from the loop's view.
- **Termination & shutdown:** on the first StopCondition, transition to **Terminating** →
  classify into Succeeded / Stopped / Failed → flush the Transcript to disk → emit RunSummary
  (human + `--json`) → set exit code → exit. The Transcript flush and outcome emission are the
  shutdown's durability guarantee (RULE-010). *(Domain terminal states **Succeeded / Stopped /
  Failed**.)*

---

## External Dependencies

| Dependency | Purpose | Critical path? | Constraints |
|---|---|---|---|
| Anthropic Messages API (`@anthropic-ai/sdk`) | the LLM driving reasoning + tool calls | yes | requires `ANTHROPIC_API_KEY` + network at runtime (live runs not offline); rate limits / transient errors handled by bounded-backoff retry (REQ-NFR-004); accessed only via the `LlmClient` seam (REQ-NFR-002) |
| User's shell / OS process (`child_process`) | execute repo commands incl. the test command | yes | cross-platform path/shell differences (REQ-NFR-007); confined to root + approval-gated; accessed only via the `CommandRunner` seam (REQ-NFR-002) |
| User's filesystem (Node `fs`) | read context, read/write files, persist transcript + config | yes | write/exec confined to root (REQ-021); reads may range outside (read-anywhere); symlink/traversal escapes rejected by PathSandbox |
| Node.js runtime ≥ 18 | execution platform | yes | hard constraint (locked); cross-platform (macOS/Linux/Windows, REQ-NFR-007) |
| Vitest | test framework for the harness | no (build-time) | hard constraint (locked); exercises the deterministic harness with SDK + shell stubbed (REQ-NFR-001/002) |

---

## Deployment Shape

- **Target:** a published **npm CLI package** installed and run **locally** on the developer's
  machine against a local repository. Not a service, not hosted, not multi-tenant (Constraints,
  Out of Scope).
- **Runtime:** Node.js ≥ 18, TypeScript compiled to JS; single process, one invocation per run.
- **Infrastructure:** none beyond the local filesystem — no database, no message bus, no object
  store. The Transcript and config are local files; the only network call is to the Anthropic API.
- **Scaling model:** **single instance, single sequential run per invocation.** No horizontal
  scaling, no concurrency (parallel tools are explicitly Future scope). Bounded by Budget
  (iterations + tokens) per run.

---

## Security

> **Graduated → `08a-security-threat-model.md`.** This is a **Tier-3, data-integrity blast-radius**
> project, so the full threat model (assets, trust boundaries, STRIDE-per-boundary threats,
> authn/authz model, abuse cases, mitigations → components/REQs, residual risks) lives in its own
> stage and is **not** reproduced here. This section is the forward-pointer plus the inline
> boundary list the Critic's "sections present" check requires.

- **Trust boundaries to be modeled in 08a (inline list):**
  1. **LLM/network boundary** — untrusted model output (tool calls/args) crossing into the
     harness via `LlmClient`; defended by treating model intent as adversarial and forcing every
     mutating/executing call through **PathSandbox** + **ApprovalGate**.
  2. **Filesystem/shell boundary** — untrusted write/exec intent reaching the real machine via
     WriteEdit/ApplyPatch/RunCommand; defended by **root confinement** (REQ-021/RULE-001) and the
     **approval policies** (REQ-012/016/RULE-004/005).
- **Blast-radius flags:** auth = no (single local API key, no multi-user authz) · money = no
  (only indirect API cost, bounded by Budget) · **data-integrity = YES** (file mutation + shell
  execution on the developer's tree — the reason this project is Tier-3) · migrations = no.
- **Key credential:** `ANTHROPIC_API_KEY` (env), supplied by the developer; never written outside
  the root; the read-anywhere residual exposure (reading secrets in sibling dirs) is an accepted,
  recorded upstream risk to be carried into 08a.

*Full threat model: `08a-security-threat-model.md` (security stage).*

---

## Failure Modes

> **Graduated → `08b-failure-edge-cases.md`.** As a **reliability-critical, data-integrity**
> project, the full failure catalog (per-component invalid-input, duplicates/idempotency, partial
> failure, dependency outage, crash/restart recovery, race conditions, unexpected states,
> negative-tests map) lives in its own stage and is **not** reproduced here. This section is the
> forward-pointer plus the inline list of failure-prone seams.

- **Failure-prone seams to be cataloged in 08b (inline list):**
  - **LlmClient ↔ Anthropic API** — transient errors / timeouts / rate limits → bounded-backoff
    retry, then a clean `unrecoverable-error` stop if exhausted (REQ-NFR-004, RULE-008).
  - **CommandRunner ↔ shell** — command non-zero exit / timeout / spawn failure → returned as an
    **error ToolResult**, never a process crash (REQ-NFR-004, RULE-008); cross-platform shell
    quirks (REQ-NFR-007, SCOPE-RISK-005).
  - **PathSandbox** — traversal / absolute / symlink escape attempts on write/exec → **rejected
    before the op** (REQ-021, RULE-001); the project's most safety-critical negative tests.
  - **Diff/Patch Engine** — malformed / non-applying patch → **atomic rejection**, actionable
    error fed back (REQ-023, RULE-013); no partial Edits.
  - **Budget/StopCondition Controller** — ceiling reached mid-run → clean termination with reason,
    never unbounded (REQ-015, RULE-006/007).
  - **Transcript Writer** — write/flush failure on the durable audit log → must not silently lose
    the audit trail (RULE-010); recovery/handling is a key 08b entry (data-integrity).
  - **ApprovalGate** — user denial / abort → denial becomes an error ToolResult or a clean run
    abort (REQ-012/016).

*Full failure catalog + negative-tests map: `08b-failure-edge-cases.md` (failure-modes stage).*

---

## Architecture Risks

- **ARCH-RISK-001 — Tool-use protocol choice (IRREVERSIBLE, CONFIRMED 2026-06-09).** The harness
  binds to **Anthropic native structured tool-use** (`tool_use` blocks via the Messages API). This
  is recommended over a custom text-parsed protocol because the SDK + model are first-class for it
  (cleaner, validated tool args; less brittle than regex-parsing free text) and the requirements
  already mandate the Anthropic SDK + function-calling (REQ-004/005). It is **costly to reverse**:
  the conversation shape, the `LlmClient` interface contract, the ToolRegistry schema format, and
  every ToolResult round-trip are built around the structured protocol; swapping to a text-parsed
  protocol later means rewriting the loop's core message handling. — affects: `llm-client`,
  `agent-run`, `tool-registry` — mitigation: the protocol is confined behind the `LlmClient` seam
  (REQ-NFR-002), which bounds the blast radius of a future change to that interface. **CONFIRMED
  (2026-06-09 — recommended option adopted; human deferred the explicit gate).**
- **ARCH-RISK-002 — Transcript persistence format (IRREVERSIBLE, CONFIRMED 2026-06-09).** The
  Transcript is recommended as an **append-only JSONL event log** (one JSON event per line) over a
  single structured JSON document. Append-only JSONL fits the domain (an ordered, append-only
  audit trail — RULE-010, REQ-NFR-008), survives a crash mid-run (each event is durable as
  written, no rewrite of a whole document), and matches the streamed-events model. It is **costly
  to reverse** because the on-disk format is the **data-integrity contract** for the audit trail
  and the substrate the V1 *resumable single-task continuation* feature will read back; changing
  it later breaks existing transcripts and any tooling/feature that consumes them. — affects:
  `transcript` (and the V1 resume feature that extends REQ-022) — mitigation: keep the entry
  schema typed and versioned so additive evolution is possible without a format change. **CONFIRMED
  (2026-06-09 — recommended option adopted; human deferred the explicit gate).**
- **ARCH-RISK-003 — Read-anywhere read-exposure (accepted upstream).** The read path may access
  files outside the root (secrets in sibling dirs). — affects: `tool-read`, `path-sandbox` —
  mitigation: writes remain confined (RULE-003); every read is recorded in the Transcript; risk
  accepted by human decision (OQ-3) and carried into 08a.
- **ARCH-RISK-004 — Cross-platform shell/path fragility.** Windows vs. POSIX path and shell
  differences could weaken root confinement or break run-command. — affects: `command-runner`,
  `path-sandbox` — mitigation: contained behind the `CommandRunner` seam; PathSandbox resolves and
  validates absolute real paths; explicit cross-platform tests (REQ-NFR-007, SCOPE-RISK-005).
- **ARCH-RISK-005 — Token-accounting accuracy for the Budget.** If `tokensUsed` is mis-estimated,
  the budget ceiling could be under- or over-enforced. — affects: `budget-stop`, `llm-client` —
  mitigation: accrue the SDK's reported usage (input+output) per call where available (DQ-001);
  treat the ceiling as a hard pre-turn guard (RULE-006).

---

## Verification Notes

Traceability traced during drafting (for the Critic's coherence check):

- **REQ coverage:** every MVP functional REQ-ID maps to ≥1 named component — REQ-001/002 (CLI,
  Config), REQ-003 (RepoContext), REQ-004/005 (AgentRun, LlmClient, ToolRegistry), REQ-006…009 +
  023 (the five Tools), REQ-010 (Diff/Patch Engine), REQ-011 (WriteEdit/ApplyPatch + ApprovalGate),
  REQ-012/016 (ApprovalGate + Allowlist), REQ-013 (RepoContext + RunCommand), REQ-014/015
  (Budget/StopCondition), REQ-017/019/024 (Reporter), REQ-018 (Config), REQ-020 (CLI exit /
  Budget-Stop), REQ-021 (PathSandbox), REQ-022 (Transcript), REQ-025 (Allowlist Manager).
  NFRs: REQ-NFR-002 (LlmClient + CommandRunner seams), REQ-NFR-003 (Budget), REQ-NFR-004
  (LlmClient retry + errors-as-results), REQ-NFR-005 (PathSandbox + ApprovalGate),
  REQ-NFR-006 (Config fail-fast + Reporter), REQ-NFR-007 (CommandRunner + PathSandbox),
  REQ-NFR-008 (Transcript). REQ-NFR-001 spans all (Vitest-tested).
- **Entity coverage:** every Core Entity is handled — AgentRun→`agent-run`; Iteration/
  ConversationMessage→`agent-run`; Tool/ToolCall/ToolResult→`tool-registry` + tools; WorkingRoot/
  RepoContext→`path-sandbox`/`repo-context`; Edit/Diff/Patch→`diff-engine`/`tool-writeedit`/
  `tool-applypatch`; CommandExecution→`tool-runcommand`/`command-runner`; ApprovalPolicy/
  ApprovalDecision/Allowlist/AllowlistEntry→`approval-gate`/`allowlist`; Budget/StopCondition/
  RunOutcome→`budget-stop`; RunSummary→`reporter`; Transcript/TranscriptEntry→`transcript`;
  Config→`config`.
- **Domain rules enforced by a named component:** RULE-001/003(write side)→PathSandbox;
  RULE-002→Diff/Patch Engine; RULE-004/005→ApprovalGate; RULE-006/007→Budget/StopCondition;
  RULE-008→LlmClient + ToolRegistry; RULE-009→RepoContext + RunCommand; RULE-010→Transcript;
  RULE-011→CLI/Budget-Stop; RULE-012/013→ToolRegistry/Diff-Patch; RULE-014→Allowlist Manager;
  RULE-015→LlmClient + CommandRunner seams (whole harness); RULE-016→Config Resolver.
- **Scope fit:** component set is exactly the MVP loop + five tools + safety gates + transcript +
  reporter; no V1/Future capability (no cross-run memory, batch, parallel tools, GUI) is present.
- **Graduated sections present:** Security → 08a forward-pointer + inline boundary list; Failure
  Modes → 08b forward-pointer + inline seam list. Full treatments deliberately deferred to their
  Tier-3 stages.

Irreversible-decision gate (CONFIRMED 2026-06-09 — human deferred the explicit gate; recommended
options adopted, both reversible behind their named seams):

- [x] **ARCH-RISK-001 — Tool-use protocol** → **Anthropic native structured tool-use** (confined to `llm-client`).
- [x] **ARCH-RISK-002 — Transcript persistence format** → **append-only JSONL** (typed/versioned `TranscriptEntry`).

Critic checklist:

- [x] Every MVP REQ-ID from `01-requirements.md` is supported by ≥1 named component.
- [x] The component set fits within the MVP scope defined in `02-scope.md`.
- [x] Every Core Entity from `03-domain-model.md` is handled by ≥1 named component.
- [x] Component responsibilities are non-overlapping and boundaries are clean.
- [x] Domain Rules from `03-domain-model.md` are enforced by a named component or boundary.
- [x] Architecture Risks are noted for thin areas + both irreversible decisions.
- [x] Security and Failure Modes sections present (Tier-3 forward-pointers + inline lists).
- [x] Irreversible decisions' sign-off recorded in Summary — **DONE** (both confirmed 2026-06-09;
      recommended options adopted, folded into the Summary).
