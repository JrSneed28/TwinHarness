# PreToolUse Write-Gate — Design (target: v0.3.0)

> Status: **Implemented in v0.3.0 (2026-06-10)**.
> The Stop hook catches a false "done" *after the fact*. This gate makes "no implementation
> before the gates clear" *physically enforced* — the strongest expression of the project's
> own principle: instructions don't enforce, code does (spec §11).

## Resolved design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Semantics when the gate fires | **Configurable: `ask` \| `deny` \| `off`, default `ask`** — new optional `write_gate` state field | `ask` keeps manual sessions one click away from proceeding while still hard-stopping headless agents; `deny` available for strict runs; `off` for opt-out. Absent field ⇒ `ask`. |
| Activation | **Automatic during runs** — active whenever `state.json` exists and gating conditions apply; nothing for the orchestrator to remember | The orchestrator-must-remember pattern is exactly what TwinHarness distrusts. Projects without TwinHarness state are completely unaffected (fast-path allow). |
| Path policy | **Derived from the slice plan**, with an allowlist fallback before slices exist | Components in `state.slices` become the gate's path universe once `th slices sync` has run; before that, block everything except doc/state paths. |

## Hook mechanics

- New CLI command **`th hook pretool-gate`** — same pattern as `th hook stop-gate`: tested
  TypeScript logic, Claude Code hook-protocol JSON on stdout, always exit 0. Reads the
  PreToolUse stdin payload (`tool_name`, `tool_input.file_path`, `cwd`).
- `hooks/hooks.json` gains a `PreToolUse` entry with matcher `Write|Edit|MultiEdit|NotebookEdit`
  so the node spawn (~50–150 ms) only lands on file-writing calls — never Read/Grep/Bash.
- Output shapes: allow ⇒ `{}`; ask ⇒ `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"ask","permissionDecisionReason":"..."}}`; deny ⇒ same with `"deny"`.
- The reason text must name the gate, the current stage, and the legitimate unlock path
  (clear upstream gates → `th state set implementation_allowed true`) — and must instruct an
  agent to escalate to the human rather than retry (anti-spin, mirroring `stop_hook_active`
  handling in the stop-gate).

## Decision ladder (fail-open by design)

1. No `state.json` in the project → **allow** (instant fast path; non-TwinHarness projects unaffected).
2. `TH_DISABLE_WRITE_GATE=1` or `write_gate: "off"` → allow.
3. `state.json` invalid → **allow + `systemMessage` warning** (the Stop gate already
   fail-closes completion; bricking editor workflows on corrupt JSON would be worse).
4. Tool has no `file_path` → allow.
5. Target path is doc/state territory → allow:
   `docs/**`, `.twinharness/**`, `.agentic-sdlc/**` (legacy), `drift-log.md`, root `*.md`,
   `.claude/**`, `.gitignore`. (Spec/Critic/doc-writer/ui-designer keep working through every
   pre-build stage.)
6. **Phase A — pre-implementation** (`implementation_allowed: false`):
   any other path → fire with the configured semantics (`ask` default). This is the primary
   gate: before Stage 10, only artifacts should change.
7. **Phase B — mid-build boundary enforcement** (`implementation_allowed: true` AND
   `state.slices` non-empty): writes to paths owned by a slice whose status is **not**
   `in-progress` → fire (`ask`) — a likely §16 component-boundary violation / drift race.
   Writes to in-progress slices' components, and paths owned by no slice, → allow
   (new files appear constantly during a build; unowned ≠ forbidden).

Phase B is the payoff of slice-derived paths: the per-Builder "do not modify files owned by
another slice" rule in `agents/builder.md` becomes mechanically enforced instead of promised.
It depends on `th slice set-status <id> in-progress` being called as Builders start — already
shipped in v0.2.0 and already part of the orchestrator playbook.

## Component → path mapping (the one convention change)

`state.slices[].components` entries are opaque tokens today (equality-compared for wave
scheduling only). For gating they must be resolvable to paths:

- Treat a component token as a **path prefix/glob** when it is path-like (contains `/`, or
  matches an existing file/dir under the project root). `src/sync/` gates that subtree;
  `src/cli.ts` gates one file.
- Abstract names (`"SyncEngine"`, `"UI"`) are **ignored for gating** (still valid for wave
  scheduling). The vertical-slice agent's instructions gain one line: express
  `components touched` as root-relative paths where possible.
- A slice with only abstract components contributes nothing to Phase B — fail-open, never
  fail-wrong.

## State schema change

- New optional field `write_gate?: "ask" | "deny" | "off"` — validator accepts the three
  values or absence; canonical serializer includes it only when present (preserves the
  hash-stability of existing state files); `th state set write_gate deny` works because the
  field joins the known-keys list.

## Test matrix (REQ-anchored, like the stop-gate suite)

no state → allow · `write_gate off`/env bypass → allow · invalid state → allow+warning ·
doc paths → allow in all phases · code path pre-implementation → ask (and deny when
configured) · Tier-0 (implementation_allowed immediately true) → never fires ·
mid-build write inside in-progress slice → allow · mid-build write to a pending/done slice's
path-like component → ask · abstract component names → no Phase-B effect · legacy
`.agentic-sdlc` projects → identical behavior · reason text contains stage + unlock path.

## Rollout

1. v0.3.0: CLI command + hooks.json entry + schema field + tests + USAGE troubleshooting
   entry ("Why was my edit blocked / how to unlock") + README note.
2. `agents/builder.md` + `agents/vertical-slice.md`: one-line additions (path-like components;
   set-status discipline already present).
3. Bake with default `ask`. Revisit promoting strict runs (blast-radius projects) to
   default `deny` after real-world use.

## Deliberately out of scope

- Inferring *which* Builder/slice a session belongs to (hook input has no slice identity;
  Phase B's status-based rule is the practical approximation).
- Gating Bash-mediated file writes (`echo > file`): PreToolUse on Bash would need command
  parsing — high false-positive risk. The Builders' write path is Write/Edit; Bash writes are
  accepted leakage, consistent with fail-open.
