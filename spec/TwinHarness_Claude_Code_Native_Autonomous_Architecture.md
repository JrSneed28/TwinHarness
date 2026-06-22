# TwinHarness: Claude Code–Native Autonomous Delivery Architecture

**A revision of the TwinHarness architecture for autonomous project delivery and provable completion—using the Claude Code ecosystem without the Agent SDK**

**Research date:** June 21, 2026  
**Claude Code documentation baseline:** current public documentation and changelog reviewed through June 21, 2026  
**TwinHarness baseline reviewed:** v0.7.0 at commit `7bcb0479926731d60844c219e7fc6b2dde546f58`

---

## Executive abstract

For TwinHarness to autonomously take projects from a blank repository to a production release—and make **“TwinHarness says complete”** a meaningful, verifiable statement—it must evolve from a workflow guardrail into a full autonomous software-delivery platform with an independent assurance layer.

That evolution does **not** require the Claude Agent SDK.

The current Claude Code ecosystem already provides a powerful native operating environment:

- specialized subagents with isolated context, tools, models, skills, memory, hooks, and worktree options;
- dynamic workflows for large-scale decomposition, fan-out, synthesis, migration, audit, testing, and adversarial review;
- agent teams for collaborative multi-session work;
- agent view and the desktop app for supervising multiple background sessions;
- Skills for reusable procedures and domain guidance;
- Plugins for distributing agents, Skills, hooks, MCP servers, LSP servers, monitors, executables, and defaults;
- MCP for controlled integration with TwinHarness, GitHub, issue trackers, browsers, CI, environments, databases, and deployment systems;
- lifecycle hooks for deterministic interception of tool use, permissions, configuration changes, agent activity, worktrees, tasks, and sessions;
- `/goal`, `/loop`, routines, scheduled tasks, channels, and GitHub events for persistent and event-driven work;
- native permissions, managed configuration, and Bash sandboxing;
- Claude Code on the web, Remote Control, Chrome integration, Code Review, ultrareview, and artifacts for broader development, review, and operations workflows.

Together, these features can make Claude Code the adaptive engineering engine for TwinHarness: it can gather requirements, plan systems, decompose work, run parallel implementation, review changes, test behavior, prepare releases, monitor deployment, and remediate failures.

They do **not**, by themselves, prove that the resulting software is correct, approved, or identical to what was released.

A Claude Code session ending, a dynamic workflow completing, an agent team agreeing, `/goal` reporting success, a routine showing green, a review finding no defects, or an artifact presenting passing results are all useful workflow signals. None is sufficient as authoritative release evidence.

TwinHarness should therefore be split into three layers:

1. **Claude Code orchestration layer**  
   Plugins, Skills, subagents, dynamic workflows, agent teams, hooks, MCP, routines, channels, artifacts, and project configuration plan and perform engineering work.

2. **Controlled execution layer**  
   Isolated worktrees, containers or virtual machines, CI workers, browser environments, test systems, staging environments, and release workers build, test, scan, and deploy exact project snapshots.

3. **Independent assurance layer**  
   A normal TwinHarness service—not an AI agent—maintains requirements, task leases, complete snapshots, policies, evidence, authenticated approvals, atomic gates, artifact lineage, deployment records, and signed completion attestations.

Claude Code may propose that a project is complete. Only the assurance layer may certify it.

The target claim is:

> TwinHarness autonomously plans, builds, reviews, verifies, and releases projects within an explicitly approved project, risk, and deployment envelope. It reports complete only when independent evidence proves that the exact current source and released artifact satisfy the configured requirements, verification policy, approval policy, and production-health policy.

The decisive property is:

> A mistaken, compromised, or overconfident Claude Code agent must be unable to make TwinHarness report “complete” unless the defined completion facts are independently true.

---

# 1. Scope and design assumptions

This document addresses how TwinHarness can:

- start with a blank or minimally initialized repository;
- turn a project objective into a controlled project contract;
- create architecture, plans, tasks, code, tests, documentation, and infrastructure;
- coordinate parallel Claude Code work;
- operate across small, medium, advanced, and large projects;
- run autonomous release workflows;
- produce a completion statement that proves the current code was tested and approved;
- do so without building its orchestration on the Agent SDK.

It does not assume that every possible project can safely be completed with zero human involvement. Autonomy must be bounded by:

- project class;
- supported technology;
- risk level;
- available testability;
- environment access;
- irreversible impact;
- legal and organizational authority;
- an explicitly approved release envelope.

For simple and reversible systems, the envelope may be broad. For authentication, payments, destructive migrations, regulated data, or safety-sensitive behavior, the envelope should be narrow and require specific human approvals.

---

# 2. Current TwinHarness: what should be retained

TwinHarness already contains valuable foundations. The architecture should evolve rather than be discarded.

## 2.1 Existing strengths

The reviewed version has several good mechanical properties:

- atomic file replacement for state;
- schema evolution and migration handling;
- cross-process locking;
- fail-closed handling of corrupted or too-new state;
- hash-linked decision and command-approval records;
- typed MCP operations;
- command approval and timeout cleanup;
- centralized gate-rung registration;
- hook integration through a compiled CLI;
- explicit acknowledgement that the write gate is not a security sandbox;
- cross-platform CI intent.

These are useful primitives for an assurance kernel.

## 2.2 Existing trust gaps

The current design is not sufficient for an authoritative completion claim because:

- the project identity does not fully capture all relevant file content;
- live-QA Tester results can be self-attested;
- gate validation and gate mutation are not one atomic transaction;
- generic human-gated stages are not mechanically backed by authenticated approvals;
- a code project can reach completion with no configured verification commands;
- verification can be bound to the state after commands rather than proving all commands tested the final state;
- evidence is not strongly bound to the TwinHarness and evidence-policy version;
- some path-containment behavior is inconsistent;
- initialization bypasses the normal state lock;
- delegation-scope cleanup can remain active after work stops;
- local installation changes Git hook configuration as a side effect.

These issues become more dangerous as autonomy and parallelism increase. More agents do not compensate for weak evidence; they create more opportunities for stale state, races, conflicting work, and misleading consensus.

---

# 3. What the latest Claude Code ecosystem adds

Claude Code now exposes multiple complementary mechanisms. TwinHarness should assign each a precise job rather than treating them as interchangeable “agents.”

## 3.1 Subagents

Subagents run delegated work in their own context and return a summary to the parent. Current subagents can be configured with:

- a dedicated system prompt;
- model and effort selection;
- tool allowlists and denylists;
- permission behavior;
- preloaded Skills;
- persistent user, project, or local memory;
- hooks;
- maximum turns;
- background behavior;
- worktree isolation.

### Best TwinHarness uses

- repository reconnaissance;
- architecture analysis;
- isolated implementation tasks;
- test generation;
- code review;
- security review;
- documentation review;
- failure diagnosis;
- requirement traceability checks.

### Limits

A subagent’s summary is not trustworthy evidence by itself. The parent sees a compressed representation, not necessarily the complete work or every observed problem. Subagent memory is advisory and mutable. Tool restrictions help constrain behavior but do not establish test provenance.

### Recommendation

Create a small set of stable, role-specific subagents. Avoid a large catalog of vague personas. Each agent should have:

- a narrow purpose;
- a structured required output;
- an explicit allowed tool set;
- a defined writable path set;
- a maximum turn count;
- a named TwinHarness task lease;
- a clear statement that it cannot approve its own work.

---

## 3.2 Isolated worktree sessions

Claude Code supports parallel work using Git worktrees. This is the preferred mechanism for independent code-changing agents because it separates:

- branches;
- working directories;
- uncommitted changes;
- build output;
- session context.

### Best TwinHarness uses

- parallel feature tasks;
- competing implementations;
- migration of independent packages;
- independent test additions;
- bug fixes that should not touch the integration branch;
- review reproductions.

### Limits

Worktrees do not prevent logical conflicts. Two agents can make incompatible architectural decisions or both edit shared contracts. Worktree isolation also does not prove safe integration.

### Recommendation

TwinHarness should issue a `TaskLease` before a worktree is created. The lease should contain:

```yaml
task_id: TH-2041
base_snapshot: sha256:...
branch: twinharness/TH-2041
writable_paths:
  - src/payments/**
  - tests/payments/**
read_only_paths:
  - contracts/**
forbidden_paths:
  - .github/workflows/release.yml
  - infra/production/**
required_skills:
  - implement-task
  - payments-conventions
required_checks:
  - unit
  - typecheck
  - payments-invariants
expires_at: 2026-06-21T18:00:00Z
```

A TwinHarness worktree hook should register creation, bind it to the task and base snapshot, and refuse unleased protected worktrees.

---

## 3.3 Dynamic workflows

Dynamic workflows let Claude Code create an orchestration script that decomposes a large job and coordinates many subagents. They are useful for work that is too broad for a single conversational agent.

### Best TwinHarness uses

- codebase-wide migrations;
- broad security audits;
- large test-generation efforts;
- documentation normalization;
- dependency API migrations;
- language or framework ports;
- cross-package consistency checks;
- adversarial review of a release candidate;
- independent reproduction of many reported issues.

### Limits

Dynamic workflows can use substantially more tokens and remain probabilistic. A generated workflow may:

- decompose the problem incorrectly;
- assign overlapping work;
- synthesize a false consensus;
- overlook a shared assumption;
- accept weak evidence from its workers;
- stop after a plausible but incomplete result.

### Recommendation

Divide workflows into two categories.

#### Exploratory workflow

Claude may generate it dynamically. It can research, classify, propose, review, and identify possible work. Its output is untrusted until checked.

#### Approved execution workflow

The workflow is:

- saved;
- versioned;
- reviewed;
- hashed;
- tested against fixtures;
- limited to a project class;
- constrained by managed permissions;
- associated with a maximum concurrency and usage budget;
- required to emit structured result files.

Only approved workflows should be allowed to mutate protected release branches or request protected TwinHarness operations.

---

## 3.4 Agent teams

Agent teams coordinate multiple independent sessions through a lead, shared tasks, and inter-agent communication.

### Best TwinHarness uses

- architecture exploration;
- competing hypotheses;
- cross-disciplinary design review;
- complex debugging;
- coordinated feature development with strongly separated ownership;
- red-team/blue-team review.

### Limits

Agent teams are experimental. Coordination and shared task state should not be treated as durable project state. Teammates can inherit the same mistaken assumptions, and team agreement is not independent approval.

### Recommendation

Use agent teams for work where peer communication is valuable, but export every consequential decision to TwinHarness as a typed proposal. The project contract, decision log, task graph, evidence, and approval status must remain external to the team conversation.

---

## 3.5 Agent view and desktop parallel sessions

Agent view and the desktop app make it easier for a human operator to supervise several sessions running in parallel.

### Best TwinHarness uses

- project command center;
- dispatching independent tasks;
- identifying blocked sessions;
- steering large milestones;
- reviewing diffs and live previews;
- monitoring PR status.

### Limits

This is an operator experience, not a durable scheduler or an evidence service.

### Recommendation

Expose TwinHarness status through an MCP resource and artifact dashboard so every session can see the same authoritative state. Agent view should display work; TwinHarness should own work.

---

## 3.6 Skills

Skills package reusable instructions and workflows. They load on demand rather than permanently occupying the context window.

### Best TwinHarness uses

- project intake;
- requirement refinement;
- architecture review;
- task implementation;
- testing strategy;
- security review;
- migration planning;
- release preparation;
- incident response;
- domain conventions;
- regulated-process checklists.

### Recommendation

Keep `CLAUDE.md` short and move procedures into Skills. A practical rule:

- **`CLAUDE.md`:** stable facts and non-negotiable project rules;
- **path rules:** subsystem-specific conventions;
- **Skills:** repeatable procedures;
- **TwinHarness state:** approved facts and authoritative lifecycle data.

A Skill should not be able to redefine the completion policy. It may explain how to satisfy a policy, but policy comes from the assurance layer.

---

## 3.7 Plugins

Plugins can package Skills, agents, hooks, MCP servers, LSP integrations, monitors, executables, and limited default settings.

### Best TwinHarness use

The plugin should be the installable Claude Code integration layer.

It should provide:

- namespaced Skills;
- role-specific subagents;
- lifecycle hooks;
- the TwinHarness MCP server configuration;
- local CLI helpers;
- status monitors;
- optional LSP integrations;
- review artifact templates;
- project bootstrap commands.

### Important limitation

The plugin should not be the sole home of authoritative state or policy. Plugin files update, can be disabled, and execute in the user environment. Sensitive policy should be enforced by the TwinHarness service and managed Claude Code settings.

---

## 3.8 MCP

MCP is the central bridge between Claude Code and TwinHarness.

Claude Code can use MCP to reach:

- the TwinHarness state service;
- GitHub and issue trackers;
- CI and test systems;
- browser automation;
- documentation stores;
- observability systems;
- deployment systems;
- approval services.

### Recommendation: use capability-oriented MCP

Avoid broad tools such as:

```text
th_set_state
th_mark_complete
th_write_receipt
th_run_any_command
```

Prefer narrow operations:

```text
th_project_read
th_contract_propose
th_decision_propose
th_task_claim
th_task_report
th_snapshot_request
th_review_submit
th_verification_request
th_verification_read
th_approval_request
th_release_propose
th_attestation_read
```

Every mutation request should carry:

- project ID;
- task lease;
- caller/session identity;
- role;
- expected state version;
- expected source snapshot;
- idempotency key;
- requested policy operation.

The server must revalidate all fields. Agent-supplied text is never proof.

### MCP security model

MCP descriptions, resources, and outputs are untrusted input. An external MCP server may be compromised or prompt-inject the session. TwinHarness should:

- maintain an allowlist of servers by role;
- restrict operations by environment;
- use managed MCP configuration where available;
- keep production credentials behind a separate proxy;
- log tool invocation and result digests;
- avoid exposing a general database or shell tool to builder sessions;
- distinguish read capabilities from mutation capabilities;
- require short-lived tokens;
- never accept a remote test pass solely because an MCP result says “passed.”

---

## 3.9 Hooks

Hooks are deterministic lifecycle interception points and are one of the most important Claude Code features for TwinHarness.

Recommended mapping:

| Hook event | TwinHarness use |
|---|---|
| `Setup` | verify project installation and compatibility; add non-authoritative context |
| `SessionStart` | register session, project, Claude Code version, plugin version, and selected role |
| `UserPromptSubmit` | attach task identity and reject forged control tokens |
| `PreToolUse` | enforce task lease, path scope, tool class, and MCP capability |
| `PermissionRequest` | route protected requests to TwinHarness policy or a human |
| `PostToolUse` | record operation metadata and changed-path observations |
| `PostToolBatch` | identify broad or unexpected batches of changes |
| `SubagentStart` | register parent-child lineage and role |
| `SubagentStop` | close activity record and require a structured result |
| `TaskCompleted` | mark agent work as reported, never verified |
| `WorktreeCreate` | bind worktree to task and base snapshot |
| `WorktreeRemove` | ensure work was captured or explicitly discarded |
| `ConfigChange` | invalidate assumptions or evidence affected by configuration drift |
| `PreCompact` | checkpoint task references before context summarization |
| `Stop` | prevent a protected task from silently ending without a report |
| `SessionEnd` | release leases and finalize audit metadata |

### Critical rule

Hooks can block, notify, record, or request evaluation. They should not independently issue the final completion attestation. A missed, disabled, or failed hook must not create a valid release state.

---

## 3.10 `/goal`

`/goal` keeps a session working until a separate evaluator model judges a stated condition to be satisfied.

### Best TwinHarness uses

- “Continue until all assigned TwinHarness tasks have a terminal status.”
- “Continue until the verification service reports either pass or a non-retryable failure.”
- “Continue until every blocking review finding has a disposition.”
- “Continue until the staging health gate finishes.”

### Limits

The evaluator sees the session’s surfaced state. It is not an independent repository, environment, or evidence verifier.

### Recommendation

The goal should refer to TwinHarness API state rather than a subjective statement.

Weak:

```text
/goal Finish the project and make sure it is production ready.
```

Better:

```text
/goal Continue until th_project_status reports:
- no runnable tasks remain,
- no blocking findings remain,
- the required verification profile has a terminal result,
- and release_proposal is either accepted or rejected.
Do not claim completion yourself.
```

---

## 3.11 `/loop`, scheduled tasks, routines, and GitHub events

Claude Code offers several automation surfaces.

| Mechanism | Where it runs | Best TwinHarness use |
|---|---|---|
| `/loop` | current open session | short-lived polling and local monitoring |
| Desktop scheduled task | operator machine | local maintenance that needs local files |
| Routine | Anthropic-managed cloud session | scheduled triage, reports, low-risk PR creation |
| GitHub event routine | managed cloud | issue/PR/release-triggered workflows |
| GitHub Actions | project CI | repository-bound checks and controlled automation |
| Channel | active session via MCP | push CI, monitoring, or approval events into a session |

### Recommendation

Use routines and GitHub events for:

- backlog grooming;
- issue classification;
- dependency update proposals;
- documentation drift checks;
- nightly test-failure analysis;
- draft PR creation;
- release-note preparation;
- observability summaries.

Do not allow a routine to directly:

- approve its own output;
- issue a completion attestation;
- bypass branch protection;
- deploy with unrestricted credentials;
- clear verification requirements;
- execute destructive production migrations.

A routine’s infrastructure success should be recorded separately from task success.

---

## 3.12 Channels

Channels let an MCP server push events into an active Claude Code session.

### Best TwinHarness uses

- CI completion notifications;
- review findings;
- approval decisions;
- deployment health alerts;
- incident events;
- test-environment readiness;
- budget warnings.

### Recommendation

Use channels to wake or inform an agent. The event payload should contain a reference to authoritative TwinHarness data rather than embedding untrusted evidence in free-form text.

Example:

```json
{
  "type": "verification.completed",
  "projectId": "P-12",
  "runId": "V-991",
  "resultDigest": "sha256:...",
  "status": "failed"
}
```

The agent should call `th_verification_read` to retrieve the validated result.

---

## 3.13 Code Review and ultrareview

Claude Code’s Code Review and ultrareview add useful multi-agent defect discovery.

### Best TwinHarness uses

- independent pre-merge review;
- broad bug discovery;
- security and regression screening;
- candidate findings for required remediation;
- an additional review source for high-impact changes.

### Limits

Code Review does not itself approve or block a pull request. Ultrareview is a research-preview service, may change, and is not a proof of complete correctness.

### Recommendation

Import findings as review evidence with:

- source;
- reviewed snapshot or PR;
- review timestamp;
- result digest;
- severity;
- verification state;
- disposition.

Use them as one layer in a review policy, not the only layer.

---

## 3.14 Artifacts

Artifacts are suitable for presenting rich review material.

### Best TwinHarness uses

- architecture diagrams;
- requirement traceability;
- annotated diffs;
- release dashboards;
- migration plans;
- test evidence summaries;
- risk and waiver summaries;
- canary health reports.

### Limit

An artifact is a presentation surface. It is not an authenticated approval record or signed evidence store.

### Recommendation

Include a TwinHarness approval control or deep link in the artifact, but store the actual approval through the assurance service.

---

## 3.15 Context, memory, and large repositories

Claude Code loads `CLAUDE.md`, auto memory, skill descriptions, and MCP tool names into context. File reads, tool results, and conversation history then consume the remaining window. Automatic compaction summarizes older context.

### Risks for TwinHarness

- old requirements or warnings may be compacted;
- a large plugin can consume startup context;
- broad MCP catalogs create noise;
- long test output may crowd out design context;
- auto memory can preserve stale or mistaken assumptions;
- worktrees share some repository-level memory behavior.

### Recommendation: four-layer context model

1. **Stable core context**  
   Root `CLAUDE.md`, ideally concise, containing architecture orientation, essential commands, security boundaries, and the rule that only TwinHarness can certify completion.

2. **Path-scoped context**  
   `.claude/rules/` and nested guidance for languages, services, or directories.

3. **On-demand procedures**  
   Skills for planning, implementation, review, verification, release, migration, and incidents.

4. **Canonical external state**  
   Requirements, decisions, tasks, snapshots, evidence, and approvals fetched from TwinHarness through MCP.

Auto memory may store useful working heuristics. It must not be the only record of an approved requirement or decision.

---

# 4. A Claude Code–native architecture without the Agent SDK

The absence of the Agent SDK does not mean TwinHarness must remain a single interactive session.

The alternative is a **session-native architecture**:

```text
┌──────────────────────────────────────────────────────────────┐
│ Claude Code surfaces                                         │
│ CLI · Desktop · Web · IDE · Remote Control · Agent View       │
└─────────────────────────────┬────────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│ TwinHarness Claude Code plugin                               │
│ Skills · agents · workflows · hooks · monitors · MCP config   │
└─────────────────────────────┬────────────────────────────────┘
                              │ typed MCP operations + events
┌─────────────────────────────▼────────────────────────────────┐
│ TwinHarness control and assurance service                    │
│ contract · tasks · leases · snapshots · policy · evidence     │
│ approvals · atomic gates · attestations · audit              │
└───────────────┬─────────────────────────┬────────────────────┘
                │                         │
┌───────────────▼────────────┐  ┌────────▼─────────────────────┐
│ Controlled execution       │  │ External automation          │
│ worktrees · CI · containers│  │ routines · GitHub Actions    │
│ browsers · test envs · VM  │  │ channels · review services  │
└───────────────┬────────────┘  └────────┬─────────────────────┘
                │ signed results          │ validated events
                └──────────────┬──────────┘
                               ▼
                      release attestation
```

## 4.1 What replaces an SDK orchestrator

| Need | Claude Code–native replacement |
|---|---|
| specialized workers | subagents and named main-session agents |
| large fan-out | dynamic workflows |
| communicating workers | agent teams |
| independent parallel sessions | worktrees, agent view, desktop, web sessions |
| persistence | session resume, task lists, project state in TwinHarness |
| event-driven automation | routines, GitHub events, Actions, channels |
| tool integration | MCP |
| lifecycle interception | hooks |
| operator UI | desktop, agent view, artifacts |
| durable control state | TwinHarness service |
| execution isolation | CI, containers, VMs, remote sandboxes |
| structured results | required JSON files and typed MCP submissions |
| approval and policy | TwinHarness service and identity provider |
| final attestation | TwinHarness signer |

This design is as capable for the intended lifecycle because the intelligence and parallelism stay in Claude Code while deterministic control moves into normal software.

## 4.2 Why this separation is stronger

A purely conversational orchestrator is vulnerable to:

- context loss;
- prompt injection;
- mistaken summaries;
- inconsistent retries;
- hidden changes;
- self-approval;
- unbounded recursion;
- session termination;
- ambiguous completion.

The TwinHarness service supplies what Claude Code should not be trusted to remember or decide:

- current state version;
- task ownership;
- exact source identity;
- policy;
- evidence validity;
- approval validity;
- gate transitions;
- release continuity.

---

# 5. Compare and contrast

## 5.1 Current TwinHarness versus target TwinHarness

| Area | Current architecture | Target architecture |
|---|---|---|
| Project lifecycle | stage ladder and registered artifacts | project contract, requirement graph, milestones, tasks, decisions, traceability |
| Orchestration | one main session with delegated operations | subagents, worktrees, dynamic workflows, teams, routines, channels, multiple sessions |
| Agent roles | limited workflow roles | narrow builder, reviewer, verifier-assistant, architect, security, operations roles |
| State | local project state file | transactional service with versioned local cache |
| Project identity | Git HEAD plus partial dirty-tree digest | complete content-addressed project snapshot |
| Verification | configured commands run from project environment | mandatory risk-based profiles in isolated workers |
| QA | caller can record pass | trusted runner directly observes and signs result |
| Human gates | descriptive or artifact-based | authenticated approval records bound to exact snapshot/artifact |
| Gate transition | check then separately mutate | one atomic compare-and-swap transaction |
| Audit | local hash-linked records | signed remote append-only ledger with local mirror |
| Release | largely workflow status | immutable artifact chain, signed attestation, protected deployer |
| Deployment | outside strong model | staging, canary, health gate, rollback, final evidence |
| Plugin role | core workflow and state behavior | thin Claude Code integration and UX layer |
| MCP | direct workflow operations | capability broker into assurance service |
| Completion | mechanically gated workflow status | verifiable claim about exact source, artifact, approvals, and deployment |

---

## 5.2 Claude Code feature versus assurance function

| Claude Code feature | What it is good at | What TwinHarness must add |
|---|---|---|
| Subagent | focused independent context | task lease, output schema, independent validation |
| Dynamic workflow | massive decomposition and synthesis | approved workflow policy, result checking, cost limits |
| Agent team | communication and collaboration | durable task graph, conflict policy, external decisions |
| Worktree | file and branch isolation | ownership, snapshot binding, deterministic merge |
| `/goal` | persistence toward a condition | authoritative machine-readable condition |
| Routine | unattended cloud task | scoped credentials, task result validation |
| Hook | deterministic lifecycle control | server-side revalidation and fail-closed policy |
| MCP | tool and data integration | capability isolation, identity, audit, typed operations |
| Skill | reusable procedure | policy-controlled invocation and versioning |
| Memory | useful project heuristics | approved external state and invalidation |
| Code Review | defect discovery | blocking policy and disposition tracking |
| Artifact | review presentation | authenticated approval and signed evidence |
| Sandbox | reduced Bash access | stronger isolation for hostile or high-risk work |
| Session resume | conversational continuity | durable source, task, and evidence state |

---

## 5.3 Session-native design versus an SDK-based design

This architecture deliberately avoids the Agent SDK.

| Dimension | Session-native Claude Code design | Typical SDK design |
|---|---|---|
| Primary control | plugin, Claude sessions, MCP, hooks, workflows | application creates and controls sessions |
| User experience | native Claude Code surfaces | custom application or service |
| Subscription-friendly local use | naturally aligned with normal Claude Code | depends on authentication and deployment |
| Parallelism | subagents, workflows, teams, worktrees, web/desktop sessions | programmatic session workers |
| Scheduling | routines, desktop tasks, GitHub events, Actions | external scheduler |
| Durable state | external TwinHarness service | application database |
| Permissions | managed settings, agent definitions, hooks, MCP | application callbacks and container policy |
| Implementation complexity | less custom AI-session code | more direct programmable control |
| Determinism | depends on external assurance service | also requires external assurance service |
| Best fit | plugin-centered product and developer workflows | standalone agent platform |

The session-native design gives up some fine-grained programmatic session control. It compensates through:

- dynamic workflows;
- named agents;
- strict task leases;
- MCP-mediated state;
- hooks;
- routines;
- GitHub Actions;
- isolated execution workers;
- durable external control state.

For TwinHarness, this is a reasonable trade if the product is intentionally centered on Claude Code.

---

# 6. Revised TwinHarness component architecture

## 6.1 Plugin package

Suggested structure:

```text
twinharness/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── start-project/SKILL.md
│   ├── refine-contract/SKILL.md
│   ├── design-architecture/SKILL.md
│   ├── plan-milestone/SKILL.md
│   ├── implement-task/SKILL.md
│   ├── review-change/SKILL.md
│   ├── investigate-failure/SKILL.md
│   ├── prepare-release/SKILL.md
│   └── respond-to-incident/SKILL.md
├── agents/
│   ├── planning/
│   │   ├── product-analyst.md
│   │   ├── architect.md
│   │   └── test-strategist.md
│   ├── build/
│   │   ├── implementer.md
│   │   └── integration-manager.md
│   ├── review/
│   │   ├── correctness-reviewer.md
│   │   ├── security-reviewer.md
│   │   ├── test-reviewer.md
│   │   └── maintainability-reviewer.md
│   └── operations/
│       ├── release-planner.md
│       └── incident-analyst.md
├── hooks/
│   └── hooks.json
├── monitors/
│   └── monitors.json
├── bin/
│   ├── th
│   └── th-hook
├── .mcp.json
├── .lsp.json
└── README.md
```

## 6.2 Plugin responsibility

The plugin should:

- bootstrap a project;
- expose lifecycle Skills;
- define agent roles;
- register hooks;
- connect to the TwinHarness MCP service;
- render status;
- provide local helper executables;
- guide the user through approval and release reviews;
- verify compatibility with installed Claude Code.

It should not:

- own the only copy of project state;
- contain release-signing keys;
- directly write a “passed” verification record;
- bypass the TwinHarness transaction engine;
- hold permanent production credentials;
- declare completion from a hook.

---

## 6.3 TwinHarness control service

The service can be a standard local daemon or remote application. It does not need to call a model.

Primary modules:

```text
ContractService
TaskGraphService
LeaseService
SnapshotService
PolicyService
EvidenceService
ApprovalService
GateTransactionService
ArtifactLineageService
DeploymentService
AttestationService
AuditService
IdentityService
```

### Storage

Use a transactional database for authoritative state. Preserve local files for portability and inspectability, but treat them as a cache or signed export.

### State versioning

Every mutation uses optimistic concurrency:

```text
expected_state_version: 142
new_state_version: 143
```

A stale agent request is rejected.

---

## 6.4 MCP capability broker

The TwinHarness MCP server should be a thin adapter over the service API.

### Read tools

- project status;
- contract;
- task graph;
- decisions;
- review findings;
- verification status;
- approval status;
- release status.

### Proposal tools

- propose contract change;
- propose decision;
- propose task completion;
- submit review;
- request verification;
- request waiver;
- propose release.

### Protected tools

- approve contract;
- approve risk;
- approve release;
- execute production migration;
- deploy production;
- sign completion.

Protected operations should either be unavailable to agents or require an identity assertion that cannot be manufactured inside the session.

---

# 7. End-to-end project lifecycle

## 7.1 Intake

### Claude Code activity

A planning session invokes:

- product analyst;
- architect;
- security analyst;
- test strategist;
- operations planner.

A dynamic workflow may research similar systems, libraries, regulations, deployment options, and common failure modes.

### TwinHarness output

Create a versioned `ProjectContract`:

```yaml
project_id: TH-PROJ-001
objective: ...
users:
  - ...
functional_requirements:
  - id: REQ-001
    text: ...
acceptance_criteria:
  - id: AC-001
    requirement: REQ-001
    observable: true
nonfunctional_requirements:
  performance:
  security:
  reliability:
supported_platforms:
data_classification:
deployment_target:
out_of_scope:
assumptions:
required_approvals:
autonomy_tier:
release_envelope:
```

### Gate

Implementation cannot begin until:

- ambiguous critical requirements are resolved;
- assumptions are explicit;
- acceptance criteria are testable;
- risk level is assigned;
- project-owner approval exists.

---

## 7.2 Repository bootstrap

A bootstrap Skill creates:

- source layout;
- build system;
- dependency locks;
- test framework;
- CI;
- local development environment;
- root `CLAUDE.md`;
- path rules;
- required Skills;
- TwinHarness policy file;
- architecture and decision directories;
- documentation skeleton;
- release configuration.

TwinHarness then records the initial project snapshot.

---

## 7.3 Architecture

Use independent agents to create and challenge architecture options.

Required outputs:

- component diagram;
- interface contracts;
- data flows;
- trust boundaries;
- threat model;
- storage model;
- deployment model;
- observability plan;
- failure and recovery model;
- migration strategy;
- test strategy;
- open decisions.

The final architecture is stored as typed records and approved. A material change later invalidates affected approvals and verification.

---

## 7.4 Planning and task graph

Claude Code creates a task graph rather than a flat checklist.

Each task includes:

- requirement links;
- dependencies;
- owned paths;
- expected output;
- risk;
- verification class;
- reviewer class;
- estimated resource budget;
- integration point;
- rollback or abandonment behavior.

TwinHarness—not a conversation task list—owns the durable graph.

---

## 7.5 Parallel implementation

Use worktrees for code-changing tasks.

A parent session or dynamic workflow may dispatch many tasks, but every worker must have a TaskLease.

On task report:

1. capture the candidate snapshot;
2. verify changed paths;
3. run required task checks;
4. run an independent review;
5. merge through an integration queue;
6. create a new integration snapshot;
7. rerun affected integration checks;
8. close or renew the lease.

### Merge strategy

Avoid free-form agent merges into the protected branch. Use:

- queued merges;
- deterministic rebase;
- affected-test selection;
- contract conflict detection;
- architecture-decision checks;
- full verification at milestone boundaries.

---

## 7.6 Independent review

Every code task should be reviewed by an agent that did not implement it.

For important work, combine:

- local reviewer subagents;
- dynamic adversarial workflow;
- Code Review;
- ultrareview;
- deterministic static analysis;
- human review where policy requires.

A finding record:

```yaml
finding_id: F-204
source: ultrareview
snapshot: sha256:...
severity: high
category: authorization
location: src/auth/policy.ts:88
claim: ...
reproduction: ...
status: open
```

The builder cannot close a blocking finding merely by asserting it is fixed. A new snapshot and reviewer verification are required.

---

## 7.7 Verification

### Mandatory profile

Every code project has a non-empty profile selected by project class.

Example:

```yaml
profile: production-web-service/v3
required:
  - format
  - lint
  - typecheck
  - unit
  - integration
  - build
  - package-smoke
  - browser-e2e
  - accessibility
  - api-contract
  - migration-rehearsal
  - dependency-scan
  - secret-scan
  - static-security
thresholds:
  unit_coverage: 85
  critical_findings: 0
  high_findings: 0
```

An agent may add checks. It may not remove the required minimum.

### Trusted runner

The runner:

1. receives immutable snapshot `S`;
2. starts a controlled environment;
3. verifies dependencies and toolchain;
4. records pre-run filesystem identity;
5. executes the profile;
6. captures complete command metadata;
7. rejects unexpected source mutation;
8. builds artifact `A`;
9. tests artifact `A`;
10. records post-run identity;
11. signs the result.

The QA agent may drive a browser, but the runner observes the outcome and writes the receipt.

---

## 7.8 Approval

Use an artifact or review dashboard to present:

- requirement coverage;
- architecture changes;
- change summary;
- verification results;
- review findings;
- known risks;
- waivers;
- rollout plan;
- rollback plan.

The actual approval is recorded by the ApprovalService and bound to:

- identity;
- role;
- source snapshot;
- artifact digest;
- policy digest;
- scope;
- expiration;
- rationale.

Any material change invalidates it.

---

## 7.9 Release

The release service validates the complete evidence graph.

Required lineage:

```text
approved contract
    ↓
source snapshot
    ↓
build provenance
    ↓
artifact digest
    ↓
verification bundle
    ↓
review disposition
    ↓
authenticated approvals
    ↓
signed release attestation
    ↓
deployed artifact digest
    ↓
runtime health evidence
```

No rebuild is allowed after approval unless it is byte-identical or is reverified and reapproved.

---

## 7.10 Production observation

A canary release should include:

- traffic percentage;
- dwell duration;
- latency threshold;
- error threshold;
- resource threshold;
- business invariant;
- database health;
- security signals;
- rollback condition.

Channels can notify a Claude Code operations session of events. Claude may diagnose and propose remediation. The deployment controller—not the agent—executes the allowed rollout or rollback policy.

---

# 8. Provable completion

## 8.1 Completion statement

“TwinHarness says complete” should mean:

> The approved requirements were evaluated against the exact identified source snapshot; all mandatory checks ran in approved execution environments; observed results met policy; required approvals apply to that exact source and artifact; the deployed artifact matches the tested artifact; and required production-health conditions passed.

## 8.2 Completion bundle

```json
{
  "schemaVersion": "twinharness-attestation/v1",
  "projectId": "P-001",
  "releaseId": "R-2026.06.21.1",
  "requirementsDigest": "sha256:...",
  "architectureDigest": "sha256:...",
  "sourceSnapshotDigest": "sha256:...",
  "dependencyDigest": "sha256:...",
  "policyDigest": "sha256:...",
  "twinHarnessVersion": "1.x",
  "claudeCodeVersion": "2.x",
  "pluginVersion": "1.x",
  "workflowDigests": ["sha256:..."],
  "verificationBundleDigest": "sha256:...",
  "reviewBundleDigest": "sha256:...",
  "artifactDigests": ["sha256:..."],
  "approvals": [
    {
      "role": "release-authority",
      "identity": "idp:...",
      "scopeDigest": "sha256:...",
      "signature": "..."
    }
  ],
  "deployment": {
    "environment": "production",
    "artifactDigest": "sha256:...",
    "healthEvidenceDigest": "sha256:..."
  },
  "result": "complete",
  "issuedAt": "2026-06-21T00:00:00Z",
  "signature": "..."
}
```

## 8.3 Required proofs

1. **Scope proof**  
   Approved requirements and exclusions are identified.

2. **Traceability proof**  
   Every required item maps to implementation and evidence.

3. **Snapshot proof**  
   The complete current project state is content-addressed.

4. **Execution proof**  
   Required checks ran in controlled environments.

5. **Observation proof**  
   Results were directly observed, not self-reported.

6. **Review proof**  
   Blocking findings were resolved or explicitly waived.

7. **Approval proof**  
   Authorized identities approved the exact scope and artifact.

8. **Artifact proof**  
   The released artifact is the tested artifact.

9. **Deployment proof**  
   Production received the approved digest.

10. **Runtime proof**  
    Post-deployment conditions passed.

11. **Audit proof**  
    The evidence chain is versioned, complete, and tamper-resistant.

---

# 9. Specific changes to the existing TwinHarness codebase

## 9.1 Replace `dirtyTreeDigest`

Implement `ProjectSnapshotV1`.

It should include:

- repository type;
- tracked files;
- relevant untracked files;
- permitted ignored files;
- file contents;
- modes;
- symlink targets;
- submodule commits;
- dependency lockfiles;
- build configuration;
- verification configuration;
- policy files;
- generated-input definitions.

Use a deterministic Merkle tree or sorted manifest.

## 9.2 Replace Tester self-attestation

Remove any path where a caller submits `passed: true` as the authoritative result.

Replace with:

```text
verification request
→ runner nonce
→ controlled execution
→ directly observed result
→ signed receipt
```

## 9.3 Refactor gate mutation

Current check-then-mutate logic should become:

```text
with transaction:
    load state and version
    load current snapshot
    load evidence and approvals
    evaluate gate
    validate signatures
    compare expected values
    append audit event
    commit transition
```

## 9.4 Add approval entities

Create:

```text
ApprovalRequest
ApprovalRecord
ApprovalPolicy
ApprovalRevocation
Waiver
```

Approvals should never be inferred from artifact registration.

## 9.5 Enforce verification profile

For `delivery_mode: code`, no empty profile is permitted.

A no-code or documentation-only project may use a different policy, but must explicitly declare that mode.

## 9.6 Add pre/post verification snapshots

A test run must prove which state was tested. Unexpected mutation invalidates the run.

## 9.7 Version evidence semantics

Every evidence record includes:

- evidence schema;
- evidence-policy version;
- TwinHarness producer version;
- Claude Code version;
- plugin version;
- workflow digest;
- worker environment digest.

## 9.8 Move state authority out of the checkout

Keep exportable local state, but move authoritative transition state into a transactional service for autonomous and release modes.

## 9.9 Harden path and lifecycle handling

Complete the previously identified fixes:

- segment-aware parent path checks;
- final symlink/junction containment checks;
- initialization under lock;
- explicit scope release;
- shorter renewable delegation leases;
- no install-time Git hook override;
- concurrency and crash testing.

---

# 10. Security and isolation recommendations

## 10.1 Managed settings

For protected sessions, deploy managed settings that cannot be weakened by project content.

Recommended principles:

- deny sensitive home-directory reads;
- deny credential files;
- restrict MCP servers;
- deny production deployment tools in builder roles;
- disable dangerous permission bypass;
- require sandbox availability;
- disable unsandboxed fallback;
- use allowed network domains;
- restrict writable paths.

## 10.2 Native sandbox

Claude Code’s native sandbox is valuable for Bash and subprocesses. It should be enabled, with hard failure if unavailable.

It is not enough for:

- malicious repositories;
- hostile package lifecycle scripts;
- high-value credentials;
- strong multi-tenant isolation;
- kernel-level threats;
- production signing keys.

Use stronger containers, gVisor, or microVMs for those cases.

## 10.3 Credentials

Separate identities for:

- source read;
- branch write;
- PR write;
- verification;
- artifact signing;
- staging deployment;
- production deployment;
- approval signing.

Builder sessions should not possess release-signing or production-deployment credentials.

---

# 11. Automation patterns without the Agent SDK

## Pattern A: interactive project lead

A user launches Claude Code with the TwinHarness plugin.

The session:

- reads project state through MCP;
- runs planning or implementation Skills;
- delegates to subagents;
- creates worktrees;
- requests verification;
- presents artifacts;
- requests approval.

Best for supervised development.

## Pattern B: long-running local milestone

Use:

- `/goal`;
- dynamic workflows;
- background commands;
- channels;
- agent view;
- resumable sessions.

The goal references TwinHarness machine state, not subjective readiness.

Best for complex local work with occasional supervision.

## Pattern C: routine-driven maintenance

A routine:

- reads TwinHarness tasks;
- opens a work branch;
- performs a bounded low-risk task;
- creates a draft PR;
- requests verification;
- reports status.

It cannot approve or deploy.

Best for dependency updates, documentation, triage, and repetitive maintenance.

## Pattern D: GitHub event pipeline

A PR event triggers:

- Claude Code review;
- TwinHarness snapshot registration;
- required CI verification;
- security review;
- release proposal if policy allows.

Best for repository-native automation.

## Pattern E: operations response

Monitoring pushes an event through a channel.

An operations agent:

- retrieves validated telemetry through MCP;
- analyzes the issue;
- proposes rollback or remediation;
- executes only operations allowed by the incident policy.

Best for diagnosis and policy-bounded response.

---

# 12. Project-size operating models

## 12.1 Small project autopilot

Suitable when:

- requirements are bounded;
- architecture is conventional;
- deployment is reversible;
- complete end-to-end testing is practical;
- no high-impact data or financial risk exists.

Flow:

```text
contract approval
→ autonomous build
→ independent verification
→ artifact review
→ release-envelope check
→ canary
→ complete
```

## 12.2 Medium production project

Add:

- milestone architecture approvals;
- integration environments;
- security review;
- migration rehearsal;
- performance verification;
- staged rollout;
- human approval for material changes.

## 12.3 Large complex project

Add:

- subsystem contracts;
- release trains;
- sparse worktrees;
- path-scoped context;
- deterministic integration queues;
- subsystem verification bundles;
- multiple dynamic workflows;
- dedicated human owners;
- long-term task and decision state;
- capacity and recovery exercises.

For a large project, “autonomous” should mean autonomous execution inside an approved governance envelope, not autonomous invention of business goals.

---

# 13. Release autonomy tiers

## Tier 0: advisory

Claude proposes plans and code. Humans perform all protected actions.

## Tier 1: autonomous implementation

Claude can create branches, tests, docs, and draft PRs. Humans merge and release.

## Tier 2: verified candidate

TwinHarness can issue a signed release candidate after independent verification. Human approves production.

## Tier 3: bounded autonomous release

TwinHarness may release without a per-release human click when all changes stay inside a pre-approved envelope.

Example envelope:

```yaml
allowed:
  - patch dependency update
  - documentation
  - internal refactor
forbidden:
  - schema change
  - authentication change
  - billing change
  - new external data flow
max_diff_lines: 500
required_profile: low-risk-service/v2
rollout:
  canary_percent: 5
  dwell_minutes: 30
  auto_rollback: true
```

## Tier 4: broad autonomy

Requires mature evidence, strong isolation, reproducible builds, operational history, external audit storage, robust rollback, and demonstrated reliability.

---

# 14. Failure handling

TwinHarness must be designed to stop safely.

Mandatory escalation conditions:

- contradictory requirements;
- uncertain product intent;
- unapproved architecture change;
- flaky mandatory test;
- unavailable verification environment;
- evidence mismatch;
- repeated remediation loop;
- merge conflict affecting a contract;
- policy or plugin version drift;
- budget exhaustion;
- suspected prompt injection;
- untrusted MCP behavior;
- sandbox unavailable;
- production anomaly beyond envelope.

A trustworthy autonomous system is not one that never stops. It is one that knows when its evidence is insufficient.

---

# 15. Testing TwinHarness itself

Before TwinHarness can certify projects, its trusted core needs stronger assurance.

Required testing:

- property-based state-transition tests;
- model checking of gate invariants;
- concurrent gate-race tests;
- crash and power-loss tests;
- filesystem fault injection;
- parser fuzzing;
- path, symlink, and junction tests;
- Windows/macOS/Linux compatibility;
- lock tests on network and overlay filesystems;
- plugin upgrade/downgrade tests;
- Claude Code compatibility matrix;
- missing-hook tests;
- malicious MCP fixtures;
- prompt-injection red-team tests;
- workflow runaway and budget tests;
- artifact-lineage mismatch tests;
- evidence replay tests;
- approval revocation tests;
- canary and rollback drills;
- independent security audit.

The completion kernel should be small, deterministic, dependency-light, and separate from the orchestration code.

---

# 16. Implementation roadmap

## Phase 0: repair current trust gaps

Deliver:

- complete snapshots;
- independent Tester results;
- atomic gates;
- authenticated approvals;
- non-empty verification profiles;
- pre/post binding;
- evidence versioning;
- path and lifecycle fixes.

**Exit condition:** known mechanical paths cannot produce a false completion result.

## Phase 1: modernize the plugin

Deliver:

- Skills-first layout;
- role-specific agents;
- current hook coverage;
- MCP capability split;
- plugin compatibility checks;
- managed-settings template;
- worktree integration;
- status monitor;
- review artifact templates.

**Exit condition:** TwinHarness works cleanly as a current Claude Code plugin and keeps authoritative state external.

## Phase 2: autonomous project control

Deliver:

- ProjectContract;
- requirement and task graph;
- task leases;
- decision records;
- worktree scheduler;
- integration queue;
- structured task reports;
- `/goal` templates;
- approved dynamic workflows.

**Exit condition:** a bounded small project can be built from scratch through a resumable, controlled Claude Code lifecycle.

## Phase 3: controlled execution and assurance

Deliver:

- isolated runners;
- mandatory verification profiles;
- signed evidence;
- approval service;
- remote audit ledger;
- artifact provenance;
- attestation signer.

**Exit condition:** a release candidate proves which exact source and artifact were independently tested and approved.

## Phase 4: release automation

Deliver:

- signed artifacts;
- SBOM;
- deployment service;
- release envelopes;
- canaries;
- rollback;
- channels;
- runtime health evidence.

**Exit condition:** low-risk changes can autonomously deploy inside a pre-approved envelope.

## Phase 5: complex-project scale

Deliver:

- subsystem contracts;
- multi-workflow coordination;
- large-repository context strategy;
- release trains;
- capacity policy;
- long-term evidence retention;
- operational resilience exercises.

**Exit condition:** advanced projects can progress across milestones without treating agent activity as proof.

---

# 17. Recommended first vertical slice

Build one complete trust-preserving workflow before adding maximum parallelism.

1. User approves a small project contract.
2. A Claude Code lead session claims a task.
3. A worktree-isolated implementer makes the change.
4. An independent reviewer inspects the candidate snapshot.
5. A controlled runner executes a mandatory verification profile.
6. A build service emits an artifact digest and provenance.
7. A human approves through the TwinHarness approval service.
8. The atomic gate engine issues `candidate-complete`.
9. A separate deployer releases the exact artifact to staging.
10. Health evidence closes the staging gate.

Only after this works should TwinHarness scale dynamic workflows, teams, routines, and autonomous production releases.

---

# 18. Recommendations

## Build now

1. Complete snapshot identity.
2. Atomic gate transactions.
3. Independent verification receipts.
4. Authenticated approval records.
5. Mandatory verification profiles.
6. MCP capability separation.
7. Worktree task leases.
8. Skills-first plugin redesign.
9. Managed security configuration.
10. Signed candidate-completion attestation.

## Add next

1. Dynamic workflow registry.
2. Agent-team patterns for architecture and debugging.
3. Routine-based maintenance.
4. Channels for CI and operations.
5. Artifact-based review dashboards.
6. Code Review and ultrareview ingestion.
7. Canary deployment and rollback.

## Delay

1. Unrestricted autonomous production deployment.
2. Running hostile repositories on the user host.
3. Self-modifying completion policy.
4. Agent-accessible release signing.
5. Large-scale fan-out before task leasing and integration controls.
6. Treating agent consensus as approval.

---

# 19. Claims TwinHarness should make carefully

Reasonable claim:

> TwinHarness coordinates Claude Code to autonomously perform software-delivery work and issues a completion attestation when independent policy, evidence, approval, artifact, and deployment checks pass.

Overstated claims to avoid:

- “Claude Code proved the software is correct.”
- “Multiple agents make the result independent.”
- “A successful routine means the task succeeded.”
- “The sandbox makes untrusted repositories safe.”
- “Ultrareview found no bugs, so the release is bug free.”
- “The current Git commit proves every relevant project input.”
- “An agent-driven browser test is independent QA.”
- “A green artifact is an approval.”
- “Autonomous means no human accountability.”

---

# 20. Final position

Claude Code’s current ecosystem is powerful enough to serve as TwinHarness’s complete autonomous engineering environment without the Agent SDK.

Subagents, dynamic workflows, agent teams, worktrees, Skills, Plugins, MCP, hooks, routines, channels, reviews, artifacts, sandboxing, and multi-session interfaces collectively provide:

- specialization;
- parallelism;
- persistence;
- automation;
- integration;
- review;
- operator control;
- extensibility.

The missing ingredient is not another agent interface. It is an independent source of truth.

TwinHarness should evolve so that:

- Claude Code performs and challenges engineering work;
- controlled workers build, test, and deploy;
- TwinHarness records exact state and policy;
- authenticated humans approve what requires judgment;
- an assurance kernel signs only independently established facts.

That architecture can support substantial autonomy while preserving a defensible meaning for “complete.”

---

# Sources and research notes

Official Claude Code sources were prioritized.

1. [Claude Code changelog](https://code.claude.com/docs/en/changelog)
2. [Claude Code overview](https://code.claude.com/docs/en/overview)
3. [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
4. [Run agents in parallel](https://code.claude.com/docs/en/agents)
5. [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
6. [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams)
7. [Manage multiple agents with agent view](https://code.claude.com/docs/en/agent-view)
8. [Introducing dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
9. [Create plugins](https://code.claude.com/docs/en/plugins)
10. [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
11. [Extend Claude with Skills](https://code.claude.com/docs/en/slash-commands)
12. [Hooks reference](https://code.claude.com/docs/en/hooks)
13. [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
14. [Configure permissions](https://code.claude.com/docs/en/permissions)
15. [Claude Code settings](https://code.claude.com/docs/en/settings)
16. [Sandboxing](https://code.claude.com/docs/en/sandboxing)
17. [Keep Claude working toward a goal](https://code.claude.com/docs/en/goal)
18. [Run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks)
19. [Automate work with routines](https://code.claude.com/docs/en/routines)
20. [Push events into a running session with channels](https://code.claude.com/docs/en/channels)
21. [Code Review](https://code.claude.com/docs/en/code-review)
22. [Find bugs with ultrareview](https://code.claude.com/docs/en/ultrareview)
23. [Explore the context window](https://code.claude.com/docs/en/context-window)
24. [How Claude remembers your project](https://code.claude.com/docs/en/memory)
25. [Manage sessions](https://code.claude.com/docs/en/sessions)
26. [Common workflows](https://code.claude.com/docs/en/common-workflows)
27. [Platforms and integrations](https://code.claude.com/docs/en/platforms)

## Research cautions

- Several features discussed here are beta, research preview, or experimental.
- Availability varies by Claude plan, administrator settings, platform, provider, and version.
- Documentation describes intended behavior; TwinHarness must maintain compatibility tests against supported releases.
- Claude Code changes frequently. TwinHarness should pin a supported version range and fail safely when an unqualified version is detected.
- Independent assurance remains necessary even when Anthropic-hosted review or execution features are used.
