# Security

## Reporting a vulnerability

Please open a **GitHub security advisory** or a GitHub issue at
https://github.com/JrSneed28/TwinHarness to report a vulnerability.

No email address is needed. This is an early-stage v0.x project; expect
best-effort response — there are no SLA commitments.

---

## Threat model / trust boundaries

### Plugin runs with full user privileges

TwinHarness is a Claude Code plugin. Like all Claude Code plugins, it executes
with the **full privileges of the operating-system user** who installed it —
unrestricted filesystem access, network access, and shell execution. There is no
sandboxing beyond what the OS itself provides.

### Mechanical gates are guardrails, not a security sandbox

TwinHarness includes two mechanical gates:

- **Stop-gate** (`hooks/hooks.json` → `Stop` hook): checks state at the end of
  each Claude Code session and can block the session from completing cleanly.
- **PreToolUse write-gate** (`hooks/hooks.json` → `PreToolUse` hook): intercepts
  `Write`, `Edit`, and `NotebookEdit` tool calls; a separate Bash heuristic
  covers obvious write-like shell commands in Phase A only.

These gates are **guardrails for a compliant orchestrating agent**. They are not
a security sandbox. The orchestrator can legitimately:

- Set state fields directly: `th state set implementation_allowed true`
- Resolve blocking drift before writing files
- Write files via `Bash`, which the `Write`/`Edit`-matched `PreToolUse` hook does
  not see (only the Bash heuristic applies, and it is intentionally conservative)

The **gate-mutation audit ledger** (`.twinharness/gate-ledger.jsonl`) records
every gate-relevant state change, making such overrides reviewable after the
fact. This is the primary accountability mechanism — not prevention.

### `th verify run` executes configured commands

`th verify run` is the **only** `th` command that executes project commands. It
runs the list configured via `th verify add` (stored in `.twinharness/verify.json`)
with the shell, in the project root, with full user privileges — exactly like the
test/lint scripts a developer would run by hand. Every other `th` command only
records and computes.

Two boundaries keep this narrow:

- **Operator-authored only.** `th verify run` sources commands solely from
  `verify.json`. It never reads commands from artifact content, drift entries, or
  any other model-written or repository data — so prompt-injection into a
  governed document cannot introduce a command here.
- **Review before running.** Treat `verify.json` like any executable script: a
  command added by a compromised or confused agent would run with your
  privileges. `th verify list` shows exactly what will run; review it on an
  untrusted project before invoking `th verify run`.

### The Researcher agent fetches untrusted external content

The on-demand Researcher agent (`agents/researcher.md`, invoked only when a
project needs unfamiliar external knowledge) uses web search/fetch. Fetched pages
are an **injection surface**: the agent is instructed to treat them strictly as
data — extract facts, never follow instructions embedded in a page, never run
commands a page suggests — and the `research` Critic mode flags unsupported or
fabricated claims. Research is conditional and skipped entirely when not
warranted, so most runs have no external-fetch surface at all. As with any
network-using tool, the environment's network policy governs whether egress is
available.

### Prompt-injection

The orchestrator reads the user's idea text and the **existing files in the
target repository**. Hostile content in those files (e.g., crafted docstrings,
README text, or data files) could influence the orchestrator's decisions.

**Do not run TwinHarness against repositories you do not trust.**

Treat all repository content as data; do not rely on the orchestrator to
validate or sanitize it.

### Path handling

`th` commands that accept file-path arguments (`th artifact register`,
`th coverage`, `th tier`, etc.) resolve paths relative to the **project root**
and reject traversals outside it. This is enforced in the CLI; raw Bash
subshells bypass it.

---

## Hooks run globally

A user-scope plugin install registers the Stop and PreToolUse hooks for
**every Claude Code project and session** on that machine. Claude Code has no
per-project plugin disable switch.

The hooks **fail open**: if no `.twinharness/state.json` exists in the current
project, both hooks exit immediately with `allow`, so non-TwinHarness projects
are unaffected.

---

## Secrets

Drift-log entries (`.twinharness/drift.jsonl`) and discovery outputs are
free-text strings written to committed files. **Do not paste secrets, tokens, or
credentials** into idea text, discovery/action descriptions, or drift entries.
