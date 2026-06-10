# ADR-006 — Command-approval model: allowlist auto-run, non-allowlisted confirm

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** Shell commands on a configurable allowlist **auto-run**; every non-allowlisted
command **requires user confirmation** before execution — the chosen default safety posture over the
highest-risk surface (arbitrary shell execution).

---

## Title / ID

**ADR-006** — Command-approval model = allowlist auto-run / non-allowlisted confirm

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* human-gated decision — OQ-2 resolved 2026-06-09 ("allowlist auto-runs, wider auto-run
surface; non-allowlisted confirm"). Governs the command-execution blast-radius surface.

---

## Context

The `tool-runcommand` capability can execute arbitrary shell commands — the single most dangerous
surface in the system (a careless or adversarial task could delete data or exfiltrate secrets;
Risks). The harness must decide the **default approval posture** for command execution before any
command runs (REQ-016, REQ-NFR-005, RULE-005). The two ends of the spectrum are "confirm every
command" (safest, but so noisy that routine runs like the test command become unbearable) and
"auto-run everything" (smooth, but unsafe by default). The right default is a usability-vs-safety
tradeoff over a blast-radius surface, which is why it was human-gated (OQ-2).

This posture is foundational and costly to reverse: it defines the `approval-gate` command policy,
the `allowlist` semantics and default entries, and the `--yes`/`--auto` override behavior, and it is
the contract the security threat model (08a) reasons about.

**Relevant REQ-IDs:** REQ-016, REQ-NFR-005, REQ-025, REQ-009, REQ-018
**Components affected:** `approval-gate`, `allowlist`, `tool-runcommand`, `config`

---

## Decision

> **Chosen:** commands matching the configurable allowlist **auto-run**; every non-allowlisted
> command **requires explicit user confirmation** before execution. The default allowlist includes
> the detected test/build command and common safe read-only commands (`ls`, `cat`, `grep`,
> `git status`). A `--yes`/`--auto` flag may auto-run all commands.

This optimizes for **safe-by-default with usable flow**: the routine, low-risk commands the agent
needs constantly (notably the test command that is the completion signal, REQ-013) run without
nagging, while anything outside the known-safe set is gated behind a human decision — preserving the
developer's control over the highest-risk surface (REQ-NFR-005). The tradeoff consciously accepted is
**friction on novel-but-legitimate commands** (each non-allowlisted command interrupts the run for
confirmation) and the **escape-hatch risk of `--yes`/`--auto`**, which trades all command safety for
unattended flow when the user opts in.

*Human gate triggered:* yes — approved by user on 2026-06-09 (OQ-2: allowlist auto-run / non-allowlisted
confirm).

---

## Consequences

### Positive

- **Safe by default over the highest-risk surface** — `approval-gate` blocks unattended execution of
  arbitrary (non-allowlisted) commands, directly serving the safety non-negotiable (REQ-NFR-005,
  RULE-005).
- **Usable flow for routine work** — the detected test/build command and safe read-only commands
  auto-run, so the completion-signal loop (REQ-013) isn't interrupted by constant prompts.
- **Developer keeps explicit control of the surface** — the `allowlist` is inspectable and
  editable (add/remove, REQ-025), so the user tunes exactly which commands run unattended.

### Negative

- **Friction on legitimate novel commands** — a useful command not yet on the allowlist suspends the
  run at `AwaitingApproval` for confirmation; in long runs this can be repetitive.
- **`--yes`/`--auto` is a sharp escape hatch** — when set, it auto-runs *all* commands, disabling the
  primary safety gate; misuse (e.g. in a script) reintroduces the destructive-action risk the policy
  exists to contain.
- **Allowlist matching is security-sensitive** — `approval-gate`/`allowlist` matching must be precise;
  an over-broad match (e.g. matching a dangerous command as if safe) would silently auto-run
  something the user did not intend, so the matching logic needs careful negative testing.

### Future obligations

- `08a-security-threat-model.md` must treat the allowlist-matching logic and the `--yes`/`--auto`
  override as part of the authn/authz-equivalent control surface and enumerate the abuse cases
  (e.g. a model crafting a command that matches an allowlist entry but does more).
- `07-contracts.md` must specify the `ApprovalPolicy` / `ApprovalDecision` and allowlist-match
  contract.
- `06-technical-design.md` must define the allowlist matching algorithm precisely (exact vs. prefix
  vs. pattern) so matching cannot be accidentally over-broad.

---

## Alternatives Considered

### Option A — Allowlist auto-run / non-allowlisted confirm *(chosen)*

Safe-by-default with a usable flow for known-safe commands. Chosen as the human-gated OQ-2 resolution
— see Decision.

### Option B — Confirm every command (no auto-run)

- **What it is:** every shell command, including the test command, requires explicit user
  confirmation.
- **Why rejected:** unusable for the core loop — the agent runs the test command repeatedly as the
  completion signal (REQ-013), and prompting on every run would make autonomous operation impractical;
  it over-indexes on safety at the cost of the product's basic value.
- **Would be right if:** every command were genuinely high-risk and runs were short with few command
  invocations — not true given the constant, safe test/build invocations.

### Option C — Auto-run everything by default (confirm nothing)

- **What it is:** all commands execute without confirmation unless the user opts into a stricter mode.
- **Why rejected:** unsafe by default over the most dangerous surface — directly contradicts
  REQ-NFR-005 and the destructive-action risk; a single bad model command could delete data or
  exfiltrate secrets with no human in the loop.
- **Would be right if:** the tool ran only in a disposable sandbox/container where destructive
  commands had no real blast radius — not the MVP (it runs on the developer's real machine).

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-016 | drives this decision (command-approval policy) |
| Requirement | REQ-NFR-005 | drives this decision (safety / least authority) |
| Requirement | REQ-025 | served (inspect/add/remove allowlist UX) |
| Requirement | REQ-009 | constrained (command exec gated before `command-runner`) |
| Requirement | REQ-018 | served (allowlist persisted to config) |
| Component | `approval-gate` | owns this decision (command policy resolution) |
| Component | `allowlist` | owns this decision (matching + default entries) |
| Component | `tool-runcommand` | affected (must pass the gate before exec) |
| Component | `config` | affected (allowlist source + persistence) |
| Downstream artifact | `08a-security-threat-model.md` | must enumerate allowlist-match + `--yes` abuse cases |
| Downstream artifact | `07-contracts.md` | the `ApprovalPolicy`/`ApprovalDecision` contract follows from this decision |
| Downstream artifact | `06-technical-design.md` | must define the allowlist matching algorithm precisely |
