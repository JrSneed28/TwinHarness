# SLICE-5 / TASK-011 — CommandRunner seam + Allowlist + ApprovalGate.resolveCommand

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-016, REQ-NFR-007
**Slice:** SLICE-5 — Run commands & tests-as-signal under the command-approval policy
**Depends on:** SLICE-4 / TASK-009 complete (extends `approval-gate`)

---

## Goal

Implement the `command-runner` DI seam (spawn-only: run a command in a cwd, capture
`{exitCode,stdout,stderr,timedOut}`; cross-platform shell selection), the `allowlist` component
(hold the configured set, token-prefix matching), and `approval-gate.resolveCommand` (resolve a
command against the command policy + allowlist into an `ApprovalDecision`) — so allowlisted commands
auto-run and non-allowlisted / chained / redirected / destructive commands require confirmation.

---

## REQ-IDs

- **REQ-016** — Before running any shell command, the agent applies a command-approval safety policy:
  commands on a configurable allowlist auto-run; every non-allowlisted command requires user
  confirmation; `--yes`/`--auto` may auto-run all.
- **REQ-NFR-007** — *Portability:* command execution accounts for cross-platform differences (shell
  selection cmd vs sh).

---

## Relevant Contracts / Interfaces

```
IF-007 CommandRunner.run(command, cwd, timeoutMs):
  command: string [required] (already approved + cwd-validated upstream);
  cwd: string [required] (already confirmed inside root by PathSandbox); timeoutMs: integer > 0
  → { exitCode: integer (non-zero is VALID, not an error), stdout: string, stderr: string,
      timedOut: boolean }
  This seam performs NO policy/confinement logic — it only spawns. Cross-platform shell selection
  (cmd vs sh) is contained here (REQ-NFR-007).

IF-009 ApprovalGate.resolveCommand(command, policy, allowlist):
  policy: { commandMode: "allowlist-confirm" | "auto" };
  allowlist: AllowlistEntry[] { pattern: string (token-sequence prefix) }
  → ApprovalDecision: "auto-approved" | "approved-by-user" | "denied" | "user-abort"
  Matcher tokenizes argv and treats each entry as a TOKEN-SEQUENCE PREFIX (ADR-006).
  Chained/redirected commands (`;` `&&` `||` `|` `>` backtick `$(`) are NEVER auto-run — they force
  confirmation (INV-010).

Config.allowlist default = detected test/build cmd + safe read-only cmds (e.g. "npm test",
  "git status", "ls", "cat", "grep").
```

---

## Relevant Design Notes

- **Token-sequence prefix** matching (ADR-006): `"git status"` matches `git status -s` but NOT
  `git statusfoo` (substring-only matches must NOT auto-run —
  `test_REQ016_allowlist_prefix_match_is_token_exact`).
- **Chained/redirected forms never auto-run** even if the head token is allowlisted (INV-010).
- `--yes`/`--auto` sets `commandMode:"auto"` (auto-run all).
- The seam is a thin wrapper exercised via a deterministic stub in tests (RULE-015) — no real
  subprocess in tests.

---

## Acceptance Test(s)

- `test_REQ016_allowlisted_command_auto_runs` — an allowlisted (token-prefix) command auto-runs.
- `test_REQ016_nonallowlisted_prompts` — a non-allowlisted command prompts for confirmation.
- `test_REQ016_chained_command_not_autorun` — a chained command is not auto-run.
- `test_REQ016_destructive_command_requires_confirmation` — a destructive command is gated (ABU-001).
- `test_REQ016_allowlist_prefix_match_is_token_exact` — substring-only matches do NOT auto-run
  (ABU-006).
- `test_REQ016_chained_command_never_auto_runs` — chained/redirected forms never auto-run (ABU-005).
- `test_REQNFR007_command_runner_shell_selection` — shell selection (cmd vs sh) is contained in
  `CommandRunner`.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `CommandRunner` / `resolveCommand` / `allowlist` match IF-007 / IF-009 / IF-017; any newly-
      pinned detail promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-016 / REQ-NFR-007 still map to passing tests).

---

## Out of Scope for This Task

- The `run_command` tool body, exec-cwd confinement, and tests-as-signal (SLICE-5 / TASK-012).
- Allowlist inspect/add/remove UX + persistence (SLICE-9 / TASK-018) — only matching here.
- Edit approval (`resolveEdit`) — done in SLICE-4 / TASK-009.
