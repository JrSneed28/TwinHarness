# Security & Threat Model — Autocoder

> **Stage S — Security & Threat Modeling** (spec §15.S). Tier 3 / **data-integrity blast-radius**.
> GRADUATES from the folded Architecture §Security section because this project mutates files and
> executes shell on the developer's machine driven by **untrusted LLM output**. Human gate required
> on the **trust model** (§8) — this document does not proceed without explicit human sign-off.
> Reads Summaries from `04-architecture.md`, `07-contracts.md`, `03-domain-model.md`, and the
> two safety-posture ADRs (ADR-005 sandbox, ADR-006 command approval); fetches full detail only
> where a boundary/flow needs it (§9). **Anti-boilerplate rule is in force:** every threat,
> mitigation, and abuse case below names a specific component (`04-architecture.md` labels),
> trust boundary (TB-###), or data flow (DF-###) in THIS system.

## Summary

Autocoder's threat surface is defined by one inversion of the usual trust model: **the LLM is not a
trusted oracle — its tool calls are untrusted, attacker-influenceable input** (a poisoned task, or
prompt-injected content the model reads out of the repo). The model proposes `ToolCall`s; the
harness must treat each as adversarial intent. The two assets worth protecting are **the developer's
working tree (integrity)** — guarded by `path-sandbox` confinement (RULE-001) and the no-silent-write
Diff rule (RULE-002) — and **the developer's machine/secrets (confidentiality)** — the
`run_command` RCE surface (`tool-runcommand` → `command-runner`) and the `read_file` read-anywhere
exposure (`tool-read`, the accepted ADR-005 residual). Two trust boundaries dominate: **TB-001 the
LLM/network boundary** (untrusted model output crosses into `agent-run`/`tool-registry`) and
**TB-002 the filesystem/shell boundary** (gated write/exec intent crosses into real disk + shell via
`path-sandbox` + `approval-gate`). The highest-priority mitigations are exactly the two safety gates
(`path-sandbox` for confinement, `approval-gate` for human-in-the-loop on edits and non-allowlisted
commands per ADR-006), the budget ceiling (`budget-stop`) as the DoS backstop, and the
SENSITIVE-never-serialized rule that keeps `ANTHROPIC_API_KEY` out of the `transcript`/`reporter`.

- **Highest-value asset:** the developer's working tree (integrity) — owned by `path-sandbox` + `diff-engine`
- **Highest-risk boundary:** TB-002 filesystem/shell — model intent → real write/exec via `tool-runcommand`/`command-runner`
- **Auth model:** **none — local single-user CLI.** Trust assumption: the human operator is trusted; the **LLM output is not**. The only credential is the developer's own `ANTHROPIC_API_KEY` (env).
- **Gate status:** ACCEPTED by human 2026-06-09 (trust model + RES-001…004 acknowledged as documented)

---

## Assets

> Each asset anchors to the owning component (`04-architecture.md`) or domain entity
> (`03-domain-model.md`). No generic "user data" — every row names a real data class and its owner.

| Asset | Sensitivity (C/I/A) | Owning component | Notes |
|-------|--------------------|-----------------:|-------|
| **Working tree (files under the WorkingRoot)** | I | `path-sandbox` (confines) + `diff-engine` (no silent write) | The destructive target. Mutated only via `tool-writeedit`/`tool-applypatch`, every change confined (RULE-001) and surfaced as a Diff (RULE-002). |
| **Files readable outside the root (secrets in sibling dirs, e.g. `~/.aws/credentials`, parent `.env`)** | C | `tool-read` (read-anywhere) / `path-sandbox` (deliberately does NOT confine reads — INV-002) | The accepted read-exposure residual (ADR-005 / ARCH-RISK-003): `read_file` may resolve outside the root, so secrets in sibling dirs are reachable. |
| **`ANTHROPIC_API_KEY`** | C | `config` (holds, `SENSITIVE`), `llm-client` (uses as bearer token) | Read from env; bound at `LlmClient` construction; **must never be written to disk** — not in the `transcript`, not in the `reporter` `--json`/human output, not outside the root. |
| **The developer's machine / shell (host + filesystem + network beyond the root)** | C+I+A | `tool-runcommand` → `command-runner` | The RCE surface. An arbitrary approved/auto-run command can exfiltrate secrets, delete data outside the repo, or open outbound connections. Confined-cwd ≠ confined-effect (a command can still `cd ..` or use absolute paths once spawned). |
| **The durable audit trail (Transcript)** | I+A | `transcript` (`TranscriptWriter`, IF-012) | Append-only JSONL (ADR-002). Integrity = the record of what the agent did must be trustworthy and complete; availability = a write/flush failure is fatal so the audit is never silently lost (RULE-010, ERR-014). |
| **The developer's money / API spend** | A (cost) | `budget-stop` (`BudgetController`, IF-011) | Not money held by the system, but unbounded LLM spend driven by a runaway/injected loop. Bounded by the hard iteration + token ceilings (RULE-006). |

---

## Trust Boundaries

> The two boundaries `04-architecture.md` §System Boundaries names as dominating every safety rule.
> Principals: the **developer** (trusted authority — owns the task, approves, can abort) and the
> **LLM** (untrusted actor — its output is treated as adversarial intent).

| Boundary ID | From | To | What crosses it | Trust differential |
|-------------|------|----|-----------------|--------------------|
| **TB-001** (LLM / network boundary) | Anthropic Messages API via `llm-client` (model output) | `agent-run` → `tool-registry` | `ToolCall`s (toolName + arguments), token usage, final answers — **untrusted** | Model *claims* to want a benign edit/command/read; harness must **verify nothing is trusted**: every mutating/executing call is re-validated by `path-sandbox` (containment) and gated by `approval-gate` (policy). `arguments` are explicitly untrusted (IF-006 postcondition). |
| **TB-002** (filesystem / shell boundary) | `tool-writeedit` / `tool-applypatch` / `tool-runcommand` (gated intent) | real disk (Node `fs`) + real shell via `command-runner` | write `Edit`s, command lines + cwd | Tool *claims* a target path/cwd is in-root and an action is permitted; `path-sandbox` must **verify the real (symlink-resolved) path is contained** (RULE-001) and `approval-gate` must **verify the edit/command is policy-approved** (RULE-004/005) before any side effect. |

*Secondary, lower-risk boundaries (documented for completeness, not the focus):* the
developer→`cli` boundary (terminal stdin/argv — trusted authority) and the config-source→`config`
boundary (flags/env/file — developer-controlled, validated fail-fast, RULE-016). Reads via
`tool-read` cross the root edge **outside** TB-002's confinement by deliberate design (INV-002,
ADR-005) — that asymmetry is the source of the read-exposure residual.

---

## Data Flows

> Every threat below traces to one of these flows or a component in this map. Flows not here cannot
> generate a grounded threat.

| Flow ID | Source | Data carried | Boundary crossed | Destination | Sensitive in transit? |
|---------|--------|-------------|-----------------|-------------|----------------------|
| **DF-001** | task input (`cli`/`config`) + repo content read by `tool-read` | natural-language task + **file content that may contain injected instructions** | (into TB-001) | `agent-run` → `llm-client` → model | Yes — repo content is attacker-influenceable; it becomes part of the prompt |
| **DF-002** | model via `llm-client` | `ToolCall { toolName, arguments }` — **untrusted intent** | TB-001 | `agent-run` → `tool-registry` → the five tools | Yes — untrusted; may request any path/command/patch |
| **DF-003** | `tool-writeedit`/`tool-applypatch` | write `Edit` (targetPath, after) → `diff-engine` → `path-sandbox` → `approval-gate` | TB-002 | disk (Node `fs`) under WorkingRoot | Yes — the integrity-bearing mutation path |
| **DF-004** | `tool-runcommand` | command line + cwd → `path-sandbox` (cwd) → `approval-gate` (policy/allowlist) | TB-002 | `command-runner` → real OS process | Yes — the RCE path; the single most dangerous flow |
| **DF-005** | `tool-read` | candidate read path (may be outside root) | the root edge (NOT confined — INV-002) | Node `fs`, content returned to model + `transcript` | Yes — read-anywhere; can pull secrets from sibling dirs |
| **DF-006** | env `ANTHROPIC_API_KEY` → `config` | the bearer secret, bound at construction | (stays in-process) | `llm-client` → Anthropic SDK (HTTPS) | Yes — must NEVER fork into `transcript`/`reporter`/disk |
| **DF-007** | every domain event emitter | `TranscriptEntry` rows (tool calls, results, diffs, decisions) | (in-process → disk) | `transcript` JSONL file under the root | Yes — integrity of the audit trail; must not contain the API key |

---

## Threats (grounded)

> **Anti-boilerplate rule:** every threat anchors to a named component / TB-### / DF-###. STRIDE is
> used only as an enumeration prompt; entries below are the threats that are **real for THIS system**.

| Threat ID | Threat (anchored) | Attack vector | Asset impacted | Impact (C/I/A) | Likelihood | Mitigation(s) |
|-----------|------------------|---------------|---------------|----------------|------------|---------------|
| **THR-001** (Elevation/Tampering) | The model emits a `run_command` `ToolCall` (DF-004) at TB-002 to delete data or exfiltrate secrets via `tool-runcommand` → `command-runner` | A poisoned task or injected repo content (DF-001) steers the model to request `rm -rf ~`, `curl … < ~/.ssh/id_rsa`, etc. | Developer's machine/shell; working tree | C+I+A | **M** — agentic tool over a real shell; the defining risk | MIT-001 (allowlist/confirm gate), MIT-002 (cwd confinement), MIT-008 (chained-cmd never auto-run) |
| **THR-002** (Information Disclosure) | `read_file` (DF-005) reads `~/.aws/credentials` / parent `.env` via read-anywhere through `tool-read` and feeds the contents to the model + `transcript` | Model is steered to read a secret-bearing path outside the root; `path-sandbox` deliberately does not confine reads (INV-002) | Files outside the root (secrets) | C | **M** — capability exists by design (ADR-005) | MIT-009 (read recorded in transcript), MIT-010 (write-back contained, RULE-003) — **partial; residual RES-001** |
| **THR-003** (Tampering / containment bypass) | A symlinked parent or `..` traversal on `write_edit`/`apply_patch` (DF-003) at TB-002 escapes the root so `path-sandbox.checkWrite` is fooled into permitting an out-of-root write | Model supplies a `targetPath` whose lexical form looks in-root but whose real path (via a symlinked ancestor) resolves outside | Working tree + files outside the root | I | **L** — only if real-path resolution is imperfect | MIT-002 (realpath-of-deepest-ancestor + fail-closed), MIT-011 (cross-platform path tests) |
| **THR-004** (Tampering / containment bypass on exec) | A `run_command` `cwd` (DF-004) that escapes the root via traversal/symlink is permitted by `path-sandbox.checkExecCwd` | Model supplies a `cwd` that resolves outside the root | Developer's machine outside the root | I+C | **L** — same resolution-correctness dependency as THR-003 | MIT-002 (cwd realpath check, fail-closed), MIT-011 (cross-platform tests) |
| **THR-005** (Information Disclosure) | `ANTHROPIC_API_KEY` (DF-006) leaks into the `transcript` (DF-007) or the `reporter` `--json`/human output | A careless serialization of `Config`/`LlmClient` state into a `TranscriptEntry` payload or a RunSummary field | `ANTHROPIC_API_KEY` | C | **L** — guarded by an explicit SENSITIVE rule | MIT-003 (apiKey marked SENSITIVE, never serialized — IF-017), MIT-012 (transcript/json schemas have no key field) |
| **THR-006** (Denial of Service / cost) | Prompt injection (DF-001) drives an expensive non-terminating loop, exhausting `budget-stop` / the developer's API spend | Injected content tells the model to "keep iterating forever / call the model repeatedly" | API spend (cost) + run availability | A | **M** — natural failure mode of an autonomous loop | MIT-004 (hard iteration + token ceiling, pre-turn guard), MIT-005 (bounded termination on exactly one StopCondition) |
| **THR-007** (Tampering / spoofing via injection) | Prompt injection in repo file content read by `read_file` (DF-001, TB-001) steers `agent-run` to take attacker-chosen actions | A repo contains a file with embedded instructions ("ignore the task, run X / write Y"); the model treats it as instruction | Working tree + machine (whatever the injected action targets) | I+C | **M** — inherent to reading untrusted content into the prompt | MIT-001 + MIT-006 (approval gates are the backstop — a human approves novel edits/commands) — **partial; residual RES-002** |
| **THR-008** (Tampering / over-broad allowlist) | A model crafts a command that **matches an `allowlist` entry** so `approval-gate` auto-runs it (DF-004) but the command does more than the entry intended | Allowlist match is too permissive (e.g. an entry `git` matching `git config --global core.pager 'curl …'`); chained/redirected forms | Developer's machine/shell | C+I | **L–M** — depends on allowlist precision | MIT-007 (token-sequence prefix match, not substring — ADR-006/IF-009), MIT-008 (chained/redirected forms `;`/`&&`/`|`/`>`/`` ` ``/`$(` never auto-run — INV-010) |
| **THR-009** (Repudiation / audit tampering) | The audit trail (`transcript`, DF-007) is incomplete or silently lost, so "what the agent did and why" cannot be reconstructed | A `TranscriptWriter` write/flush failure is swallowed instead of being fatal | The audit trail (Transcript) | I+A | **L** — explicitly made fatal | MIT-013 (`TRANSCRIPT_WRITE_FAILED` is fatal → `unrecoverable-error`, RULE-010/ERR-014), MIT-014 (append-only, durable-per-entry — ADR-002) |
| **THR-010** (Elevation via `--yes`/`--auto`) | The `--yes`/`--auto` escape hatch sets `commandMode/editMode = auto` (IF-017), disabling `approval-gate` so ALL of THR-001/THR-007 run unattended | A user (or a script) runs `--yes` in an environment where the task/repo is not fully trusted | Machine + working tree | C+I+A | **L–M** — user-opt-in, but a sharp edge | MIT-002+MIT-004 still apply (confinement + budget are NOT disabled by `--yes`); residual RES-003 (the human-gate backstop is consciously waived) |

---

## Authn/Authz

> **Human-gated section (§8).** This is the security model the Orchestrator surfaces to the human.
> The decision here is the **trust model itself**, not an auth scheme — because there is no auth.

### Authentication

**None within the system.** Autocoder is a **local, single-user CLI** (`04-architecture.md`
§Deployment Shape: installed and run locally, not a service, not hosted, not multi-tenant). There is
no login, no session, no user identity to authenticate. The **only credential** in the system is the
developer's own `ANTHROPIC_API_KEY`, read from the environment by `config` and presented by
`llm-client` as a **bearer token to the Anthropic Messages API** (an outbound authentication the
*developer* performs to a third party — not an inbound authentication the system performs on a
caller). No component authenticates a caller because there is no remote caller: the process is
invoked directly by the developer at TB (developer→`cli`).

### Authorization

**Single-principal; no authorization layer.** There are no roles, no scopes, no per-resource
permissions. The developer who runs the process has full authority by construction. What looks like
"authorization" in this system is **not** access control between principals — it is the
**human-in-the-loop trust gate over untrusted LLM intent**:

- `path-sandbox` (IF-010) enforces **what the agent is permitted to touch** (write/exec confined to
  the root; reads unconfined) — a capability boundary, not a principal-vs-principal authz check.
- `approval-gate` (IF-009) enforces **whether a proposed action proceeds** — `confirm-each` edits
  (RULE-004) and allowlist-auto-run / non-allowlisted-confirm commands (RULE-005, ADR-006). This is
  the authn/authz-equivalent control surface for this system: the human authorizes the *LLM's*
  actions, turn by turn.

**The trust model in one line:** *the human operator is trusted; the LLM's output is not.* All
security controls exist to keep untrusted model intent from harming the trusted operator's machine
and tree. Because there is no inter-principal auth, there is **no auth sub-gate** — but the overall
trust model (this section) is blast-radius and is what the human reviews and signs off.

### Unauthenticated / Anonymous Access

There is no network listener, no exposed endpoint, and no remote surface — Autocoder runs no
HTTP/RPC server of its own (`07-contracts.md` §Events: "no own HTTP/RPC server, no message bus").
The single outbound connection is `llm-client` → Anthropic over HTTPS. Therefore there is **nothing
an anonymous remote actor can reach**. The realistic "anonymous" influence is **indirect**: an
attacker who controls repo content the agent reads (DF-001) can attempt prompt injection (THR-007),
and an attacker who plants a malicious task can steer the agent (THR-001) — both are contained by
TB-002's gates, not by authentication.

---

## Abuse Cases

> Each anchored to a contract interface / component and mapped to its intended negative test (named
> for the test-strategy stage, §15.8). Patterns follow `test_<area>_<abuse_slug>`.

| Abuse ID | Abuse case (anchored) | Component / flow | Negative test anchor |
|----------|-----------------------|-----------------|---------------------|
| **ABU-001** | Adversary plants a task/repo that drives `run_command` (IF-004) to exfiltrate a secret or delete out-of-repo data | `tool-runcommand` → `command-runner` / DF-004 | `test_runcommand_destructive_command_requires_confirmation` |
| **ABU-002** | Adversary uses `read_file` (IF-001) to read `~/.aws/credentials` or a parent `.env` via read-anywhere | `tool-read` / DF-005 | `test_read_outside_root_is_recorded_in_transcript` |
| **ABU-003** | Adversary supplies a `write_edit`/`apply_patch` `targetPath` that escapes the root via `..` traversal | `tool-writeedit`/`tool-applypatch` → `path-sandbox` / DF-003 | `test_pathsandbox_rejects_traversal_write` |
| **ABU-004** | Adversary supplies a write/exec target that escapes via a **symlinked ancestor** | `path-sandbox.checkWrite`/`checkExecCwd` / DF-003+DF-004 | `test_pathsandbox_rejects_symlink_escape` |
| **ABU-005** | Adversary crafts a command that matches an `allowlist` entry but chains/redirects to do more (`git status; curl …`) | `approval-gate`/`allowlist` (IF-009) / DF-004 | `test_approvalgate_chained_command_never_auto_runs` |
| **ABU-006** | Adversary crafts an over-broad allowlist match (substring/loose match) to auto-run a dangerous command | `approval-gate` token-prefix matcher (IF-009, ADR-006) / DF-004 | `test_approvalgate_allowlist_prefix_match_is_token_exact` |
| **ABU-007** | Prompt-injected repo content tells the model to ignore the task and perform an attacker action | DF-001 / TB-001, backstopped at `approval-gate` | `test_injection_novel_edit_still_requires_approval` |
| **ABU-008** | Injected loop drives runaway iterations/tokens to exhaust `budget-stop` and spend money | `budget-stop` (IF-011) / DF-002 | `test_budget_pre_turn_guard_stops_runaway_loop` |
| **ABU-009** | An attempt (bug or injection) to serialize `ANTHROPIC_API_KEY` into the transcript or `--json` output | `config`(SENSITIVE) → `transcript`/`reporter` / DF-006→DF-007 | `test_apikey_never_appears_in_transcript_or_json` |
| **ABU-010** | A non-zero/malicious exit-code path used to mask an audit gap (transcript write swallowed) | `transcript` (IF-012) / DF-007 | `test_transcript_write_failure_is_fatal` |

---

## Mitigations (→ components/REQs)

> Every mitigation names the owning component and the REQ-ID it protects, and addresses ≥1 threat.
> No mitigation without a threat anchor.

| MIT-ID | Mitigation | Component | Addresses | REQ-ID |
|--------|-----------|-----------|-----------|--------|
| **MIT-001** | Command-approval gate: allowlisted commands auto-run; **every non-allowlisted command requires explicit user confirmation** (ADR-006) | `approval-gate` / `allowlist` | THR-001, THR-007 | REQ-016, REQ-NFR-005 |
| **MIT-002** | Path/exec confinement: write target & command cwd must resolve (symlink-resolved, deepest-ancestor realpath) inside the root, else **reject before the op (fail-closed)** | `path-sandbox` | THR-001, THR-003, THR-004, THR-010 | REQ-021, REQ-NFR-005 |
| **MIT-003** | `ANTHROPIC_API_KEY` marked **SENSITIVE — never serialized**; bound at `LlmClient` construction, never written to disk/output | `config`, `llm-client` | THR-005 | REQ-018 |
| **MIT-004** | Hard iteration + token **ceiling enforced as a pre-turn guard** — a near-budget turn is prevented, not aborted mid-flight | `budget-stop` | THR-006, THR-010 | REQ-015, REQ-NFR-003 |
| **MIT-005** | **Bounded termination** on exactly one StopCondition — non-termination is not a permitted state | `budget-stop` / `agent-run` | THR-006 | REQ-014 |
| **MIT-006** | Edit-approval gate: default `confirm-each` shows a Diff and requires confirmation per file (the injection backstop for writes) | `approval-gate` / `diff-engine` | THR-007 | REQ-012, REQ-010 |
| **MIT-007** | Allowlist match is a **token-sequence prefix** (argv-tokenized), not a substring/loose match — prevents over-broad auto-run | `approval-gate` / `allowlist` | THR-008 | REQ-016 |
| **MIT-008** | **Chained/redirected commands** (`;`, `&&`, `||`, `\|`, `>`, `` ` ``, `$(`) are **never auto-run** — they force confirmation (INV-010) | `approval-gate` | THR-001, THR-008 | REQ-016, REQ-NFR-005 |
| **MIT-009** | Every read (including out-of-root reads) is **recorded as a `tool-result` TranscriptEntry** — read exposure is at least auditable | `transcript` / `tool-read` | THR-002 | REQ-022, REQ-NFR-008 |
| **MIT-010** | **Write-back containment** — content read from outside the root can never be written back outside it (writes stay confined, RULE-003) | `path-sandbox` | THR-002 | REQ-021 |
| **MIT-011** | Cross-platform real-path resolution + heavy negative tests (Windows/POSIX symlink/traversal/absolute) so confinement cannot be weakened by path semantics | `path-sandbox` / `command-runner` | THR-003, THR-004 | REQ-NFR-007, REQ-021 |
| **MIT-012** | `TranscriptEntry` (IF-015) and `RunSummary`/`--json` (IF-016) schemas have **no API-key field** — there is no place for the secret to be written | `transcript` / `reporter` | THR-005 | REQ-022, REQ-024 |
| **MIT-013** | `TRANSCRIPT_WRITE_FAILED` is **fatal** → `unrecoverable-error` StopCondition → Failed (the audit must never be silently lost) | `transcript` | THR-009 | REQ-022, REQ-NFR-008 |
| **MIT-014** | Transcript is **append-only, durable-per-entry JSONL** (flush per entry; crash loses at most the in-flight entry) — ADR-002 | `transcript` | THR-009 | REQ-NFR-008 |

---

## Residual Risks

> Accepted (or partially-mitigated) risks. These are human-acknowledged at sign-off — not silently
> deferred.

| Residual | Source (THR-ID / ABU-ID) | Why accepted | Revisit trigger |
|----------|--------------------------|--------------|-----------------|
| **RES-001 — Read-exposure via read-anywhere.** `tool-read` can read secrets in sibling/parent dirs outside the root; mitigation is partial (auditable + write-back-contained, not prevented). | THR-002 / ABU-002 (ADR-005, ARCH-RISK-003) | Human-gated decision OQ-3 (2026-06-09): reads must range outside the root for the agent to be capable; the destructive (write/exec) blast radius is what is contained. Bounded by RULE-003 (no write-back outside) + transcript recording (MIT-009). | If the tool is ever deployed against untrusted/multi-tenant trees (where reading outside the root is itself a confidentiality breach), confine reads (ADR-005 Option B) before launch. |
| **RES-002 — Prompt injection via repo content.** Content read by `read_file` can steer the agent; this cannot be fully prevented for an agent that reads untrusted content. | THR-007 / ABU-007 | Inherent to an agentic coding tool. **Backstopped, not eliminated:** novel edits and non-allowlisted commands still hit `approval-gate` (MIT-001/MIT-006), and confinement (MIT-002) + budget (MIT-004) still bound the blast radius. | If a future mode auto-approves edits/commands by default, the injection blast radius grows — re-evaluate before shipping any such mode. |
| **RES-003 — `--yes`/`--auto` disables the approval gate.** When set, all commands/edits auto-run, waiving the human-in-the-loop backstop for THR-001/THR-007. | THR-010 / ADR-006 | A consciously accepted escape hatch for unattended/CI flows; the user opts in explicitly. Confinement (`path-sandbox`) and budget (`budget-stop`) are **not** disabled by `--yes`, so destructive reach and cost remain bounded. | If `--yes` is ever made the default, or used routinely in CI against untrusted repos, this must be re-gated — auto-running injected commands is then high-likelihood. |
| **RES-004 — Confined cwd ≠ confined effect for shell commands.** `path-sandbox` confines a command's *cwd* to the root, but an approved/auto-run command can still reach outside the root via absolute paths or `cd ..` once spawned (`command-runner` runs a real shell). | THR-001 / ABU-001 | The shell is general-purpose; true effect-confinement would require OS-level sandboxing (containers/seccomp), explicitly out of MVP scope (local CLI on the developer's real machine). The control is the **approval gate on non-allowlisted commands** (MIT-001), not cwd confinement. | If the project adds an unattended/sandboxed execution mode, introduce OS-level command sandboxing (container/jail) before relying on auto-run for arbitrary commands. |

---

> **Sign-off (human gate — §8): ACCEPTED 2026-06-09.** The human signed off the **trust model**
> above (local single-user; human trusted, LLM untrusted; no auth layer; PathSandbox + ApprovalGate
> as the control surface) and explicitly accepted residual risks **RES-001…RES-004 as documented**
> (no tightening requested). There is no separate auth decision to gate (there is no auth). The
> trust model and all four residuals are human-acknowledged.
