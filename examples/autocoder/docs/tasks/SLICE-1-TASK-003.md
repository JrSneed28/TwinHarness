# SLICE-1 / TASK-003 — Config resolution + working-root validation + fail-fast

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-002, REQ-018, REQ-NFR-006
**Slice:** SLICE-1 — Task entry, config resolution & working-root boundary
**Depends on:** SLICE-1 / TASK-002 complete (flags are parsed before they can be merged)

---

## Goal

Implement the `config` resolver: merge configuration from flags > environment > config file >
built-in defaults into one resolved `Config`, resolve and validate the WorkingRoot (default cwd, or
`--cwd`/`--root`; must be an existing directory), and **fail fast** with an actionable stderr message
and a non-zero exit when `ANTHROPIC_API_KEY` is missing or the root is invalid — before any iteration
(`CONFIG_INVALID`, RULE-016).

---

## REQ-IDs

- **REQ-002** — The agent resolves and validates a working directory (target repo): defaults to the
  current directory, configurable via `--cwd`/`--root`; the resolved root is the boundary for all
  filesystem operations.
- **REQ-018** — The CLI reads configuration from flags, environment variables, and an optional config
  file, including the Anthropic API key (env `ANTHROPIC_API_KEY`), model id, working root, approval
  modes, iteration ceiling, and budget.
- **REQ-NFR-006** — *Usability:* misconfiguration (e.g., missing API key) fails fast with an
  actionable message.

---

## Relevant Contracts / Interfaces

```
IF-017 — Config schema. Precedence (highest wins): flags > environment > config file > defaults.
  apiKey:        string  [required] — from env ANTHROPIC_API_KEY; fail-fast if missing [SENSITIVE — never serialized]
  modelId:       string  [optional, default: current Claude model]
  root:          string  [required, default: process cwd] — resolved WorkingRoot; must be an existing directory
  editMode:      enum("confirm-each","auto") [optional, default: "confirm-each"]
  commandMode:   enum("allowlist-confirm","auto") [optional, default: "allowlist-confirm"]
  maxIterations: integer [optional, default: 25]  ; > 0
  tokenBudget:   integer [optional, default: ~1000000] ; > 0
  allowlist:     AllowlistEntry[] [optional, default: detected test/build cmd + safe read-only cmds]

Validation rules:
  - apiKey present AND root an existing directory are the fail-fast preconditions (RULE-016);
    both validated BEFORE AgentRun is constructed.
  - --yes/--auto sets BOTH editMode and commandMode to "auto".

ERR-015 CONFIG_INVALID (Channel B, fail-fast): missing ANTHROPIC_API_KEY or invalid root →
  actionable stderr message, non-zero exit, in Initializing → Failed before any iteration.
```

---

## Relevant Design Notes

- Precedence is **flags > env > file > defaults** (RULE-016); enforce exactly this order.
- The resolved `root` becomes the canonical WorkingRoot — `path-sandbox` will `realpath` and validate
  it as a directory at startup (SLICE-3 consumes this); this task only resolves + existence-checks it.
- `apiKey` is **SENSITIVE** — it is read from env and must never be serialized into the Config object
  that is logged, the transcript, or `--json` (the redaction itself is tested in SLICE-8, but do not
  introduce a serialization path here that would leak it).

---

## Acceptance Test(s)

- `test_REQ002_defaults_to_cwd_root` — with no `--root`, the resolved root equals the process cwd.
- `test_REQ002_root_flag_sets_boundary` — `--root <dir>` sets the resolved root to that directory.
- `test_REQ002_invalid_root_failfast` — an invalid (non-existent) root → `CONFIG_INVALID` fail-fast,
  non-zero exit, before any iteration.
- `test_REQ018_config_precedence_flags_over_env_over_file` — flags override env override file override
  defaults for a value present at multiple layers.
- `test_REQ018_missing_apikey_failfast` — missing `ANTHROPIC_API_KEY` → `CONFIG_INVALID` fail-fast.
- `test_REQNFR006_missing_apikey_actionable_message` — the missing-key failure prints an actionable
  stderr message and exits non-zero.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The resolved `Config` matches IF-017; any newly-pinned default promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-002/018/REQ-NFR-006 still map to passing tests).

---

## Out of Scope for This Task

- Enforcing path confinement on writes/execs (SLICE-3 / SLICE-4 / SLICE-5 — `path-sandbox`).
- The api-key-never-serialized *assertion* against transcript/`--json` (SLICE-8 / TASK-017).
- Allowlist add/remove persistence (SLICE-9 / TASK-018) — only resolve the default allowlist here.
- Anything touching `agent-run` loop semantics (SLICE-2).
