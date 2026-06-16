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
  `Write`, `Edit`, and `NotebookEdit` tool calls; a separate, conservative Bash
  heuristic covers obvious write-like shell commands (redirections, `tee`,
  `dd of=`, `sed -i`) in Phase A by default, and **also in Phase B when
  `write_gate: "strict"` is set** (the opt-in mode added in v0.6.2 — it enforces
  the §16 component-boundary rule on mid-build Bash redirections, denying writes
  to paths owned by a slice that is not in-progress).

These gates are **guardrails for a compliant orchestrating agent**. They are not
a security sandbox. The orchestrator can legitimately:

- Set state fields directly: `th state set implementation_allowed true`
- Resolve blocking drift before writing files
- Write files via `Bash`, which the `Write`/`Edit`-matched `PreToolUse` hook does
  not see directly (only the Bash heuristic applies). That heuristic is
  intentionally conservative and **fail-open**: it is a regex over the literal
  command string, so it does not parse here-documents (`cat <<EOF > file`),
  subshells / command substitution, variable indirection, shell globbing, or
  writes performed by an invoked program (`printf`, `python -c`, `node -e`).
  `write_gate: "strict"` extends the heuristic into Phase B but does **not**
  change this fundamental gap — it narrows the common accidental-redirection
  cases, it does not close the Bash bypass. A determined or non-compliant agent
  can still write through an unparsed Bash construct.

The **gate-mutation audit ledger** (`.twinharness/gate-ledger.jsonl`) records
every gate-relevant state change, so such overrides can be reviewed after the
fact. It supports accountability rather than prevention — but it is **not
tamper-evident**: unlike the SHA-256 hash-chained `decisions.jsonl`,
`gate-ledger.jsonl` is a plain append-only log with no hash chain, so an actor
with write access to `.twinharness/` can edit or delete its entries without
detection. Treat it as a best-effort review aid, not an authoritative or
tamper-proof record.

**CLI vs MCP asymmetry for gate fields.** The gate-owned fields
(`implementation_allowed`, `tier`, `current_stage`, `write_gate`,
`blast_radius_flags`) remain settable through the **human-driven CLI**
`th state set` (the documented unlock/advance path; validated and
audit-ledgered). The **MCP `th_state_set` tool refuses them**:
an agent acting over the MCP surface cannot flip a gate field, and the MCP server
additionally validates every tool call against the tool's closed, typed schema
(extra / wrong-typed / missing-required arguments are rejected before dispatch).
`th decision approve` is likewise CLI-/human-only and is never exposed over MCP.
The managed drift/debate counters are refused on both surfaces (they are owned by
`th drift`/`th debate`). `current_stage` is enum-normalized on the CLI set path,
so a non-pipeline stage value cannot be stored.

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

### Repo-understanding trust boundary

The `th repo` layer (SLICE-0..5 — `th repo map`, `th repo relevant`, `th repo impact`, and the four MCP tools `th_repo_map`, `th_repo_relevant`, `th_repo_impact`, `th_context_pack`) reads **untrusted repository content**: file contents, manifests, lockfiles, and build scripts from the target repository.

The following guarantees hold across all three commands and their MCP equivalents:

- **Candidate commands are never executed.** The scanner reads `scripts`, `Makefile` targets, CI workflow steps, and similar build/test declarations and records them as inert strings (`CandidateCommand.raw`). These candidate commands are recorded and surfaced as suggestions, never executed (RULE-004). The no-exec guarantee is verified by a sentinel-file test in `tests/repo.test.ts` (`REQ-RU-091`).
- **All user-supplied paths are root-contained via `resolveWithinRoot()`.** Every `--file` and path-form `--component` argument is validated by `resolveWithinRoot` before any filesystem read. A path that resolves outside the project root is rejected with `path_outside_root` before any I/O is performed. Containment is re-checked after `realpath` resolution, so a symlink or NTFS junction placed inside the root that points outside it cannot be used to escape — the realpath'd target is compared against the realpath'd root and rejected when it falls outside (REQ-RU-024/032/042/092). This is the same helper used by `th artifact register`, `th coverage`, and `th tier`.
- **No network I/O anywhere in the layer.** The map build (`th repo map`) and both query commands (`th repo relevant`, `th repo impact`) make no outbound network requests (REQ-NFR-008). The layer is entirely local and read-only with respect to external services.
- **Verbatim build-script command strings are persisted; treat the map as sensitive-by-content.** Beyond file paths, detection keywords, and REQ anchor IDs, **verbatim candidate-command strings are persisted to the local, gitignored repo-map.json** — the `raw` text of each discovered `package.json` script, `Makefile` target, and CI step is recorded as inert `CandidateCommand.raw` data (never executed; see the no-exec guarantee above). If a build script embeds a secret inline (e.g. a token in a `scripts` entry), that substring is copied verbatim into `repo-map.json`. The file lives under `.twinharness/` (gitignored) and is never committed; the committed `docs/00-repo-map.md` summary emits only a **count** of candidate commands, not their `raw` text. No file *contents* (source bodies) and no absolute paths are written to the map.
- **Byte-stable, no run-specific data.** The persisted map contains no timestamps, PIDs, absolute paths, or nonces — only POSIX-relative paths and sorted collections. Two runs on an unchanged repo produce byte-identical output (REQ-NFR-001).
- **Generated directories are excluded before being read.** Directories such as `node_modules`, `dist`, `build`, and `target` are identified and excluded from the file walk before any of their contents are opened (REQ-RU-006/041).

### Path handling

`th` commands that accept file-path arguments (`th artifact register`,
`th coverage`, `th tier`, `th repo relevant`, `th repo impact`, etc.) resolve
paths relative to the **project root** via `resolveWithinRoot` and reject
traversals outside it. This is enforced in the CLI; raw Bash subshells bypass it.

---

## Hooks run globally

A user-scope plugin install registers the Stop and PreToolUse hooks for
**every Claude Code project and session** on that machine. Claude Code has no
per-project plugin disable switch.

The hooks **fail open**: if no `.twinharness/state.json` exists in the current
project, both hooks exit immediately with `allow`, so non-TwinHarness projects
are unaffected.

The write-gate also fails open on a **present-but-invalid** `state.json`: by
default a corrupt/unreadable state makes the gate stand down (allow the write
with a warning) rather than block every write in a project whose state merely
drifted — and the Stop-gate still blocks completion until state is repaired. An
operator who needs the stricter posture can **opt into fail-closed** with
`write_gate: "strict"`: when the (otherwise-invalid) `state.json` still carries a
top-level `"strict"` value, the write-gate treats invalid state as a stop
condition and **denies** writes until the file is repaired. This closes the
mid-session "corrupt state to disarm the gate" bypass for strict operators while
leaving default behaviour unchanged. The escape hatch `TH_DISABLE_WRITE_GATE=1`
overrides the gate in all modes.

---

## Secrets

Drift-log entries (`.twinharness/drift.jsonl`) and discovery outputs are
free-text strings written to committed files. **Do not paste secrets, tokens, or
credentials** into idea text, discovery/action descriptions, or drift entries.
