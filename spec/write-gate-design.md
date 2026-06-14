# PreToolUse Write-Gate — Design (target: v0.3.0)

> Status: **Implemented in v0.3.0 (2026-06-10)**; conservative Phase-A Bash heuristic added
> post-v0.3.0; opt-in `strict` mode (Phase-B Bash enforcement) added in **v0.6.2 (G4)**.
> The Stop hook catches a false "done" *after the fact*. This gate provides a strong default
> guardrail for the Write/Edit path — "no implementation before the gates clear" enforced on
> the standard write tools — consistent with the project's own principle: instructions don't
> enforce, code does (spec §11). Bash-mediated writes are out of scope by default; the
> conservative Phase-A heuristic and opt-in `strict` Phase-B enforcement *narrow* (do not
> close) that gap (see "Deliberately out of scope" below).

## Resolved design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Semantics when the gate fires | **Configurable: `ask` \| `deny` \| `off` \| `strict`, default `ask`** — new optional `write_gate` state field | `ask` keeps manual sessions one click away from proceeding while still hard-stopping headless agents; `deny` available for strict runs; `off` for opt-out; `strict` = `deny` semantics PLUS Phase-B Bash-mediated-write enforcement (see step i below). Absent field ⇒ `ask`. |
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
8. **Phase B — Bash-mediated boundary enforcement, `write_gate: "strict"` only** (G4):
   when `write_gate` is `strict`, `implementation_allowed: true`, `state.slices` is
   non-empty, and the tool call carries a Bash `command`, apply the same conservative Bash
   matcher used in Phase A (step c2 — `>`, `>>`, `tee`, `dd of=`, `sed -i`) to mid-build
   Bash writes. A target owned **solely** by slices that are not `in-progress` → fire
   (`deny`). Fail-open on everything else: unparseable commands, out-of-root targets,
   doc/state-allowlisted targets, unowned in-root paths, and targets with an in-progress
   owner all fall through. This check runs **before** the "no `file_path` → allow"
   short-circuit (step d), because a Bash tool call has a `command` but no `file_path`/
   `notebook_path` — otherwise it would be unreachable. Default modes (`ask` / `deny` /
   `off` / absent) leave Phase-B Bash writes **ungated**, exactly as before strict shipped.

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

- Optional field `write_gate?: "ask" | "deny" | "off" | "strict"` — validator accepts the
  four values or absence; canonical serializer includes it only when present (preserves the
  hash-stability of existing state files); `th state set write_gate strict` works because the
  field joins the known-keys list.
- `strict` (added in v0.6.2 / G4) is a **backward-compatible superset of `deny`**: it carries
  `deny` semantics everywhere `deny` fires (Phase-A file writes, the Phase-A Bash heuristic),
  and additionally adds the Phase-B Bash-mediated boundary enforcement of step i above. The
  Phase-B Write/Edit boundary check still fires `ask` under strict (it is a likely-drift
  signal, not a hard pre-implementation block) — strict's added bite is on the Bash path,
  where a redirection would otherwise sidestep the §16 rule entirely.

## Test matrix (REQ-anchored, like the stop-gate suite)

no state → allow · `write_gate off`/env bypass → allow · invalid state → allow+warning ·
doc paths → allow in all phases · code path pre-implementation → ask (and deny when
configured) · Tier-0 (implementation_allowed immediately true) → never fires ·
mid-build write inside in-progress slice → allow · mid-build write to a pending/done slice's
path-like component → ask · abstract component names → no Phase-B effect · legacy
`.agentic-sdlc` projects → identical behavior · reason text contains stage + unlock path.

Strict-mode matrix (`tests/write-gate-strict.test.ts`, G4): strict + Phase-B Bash write into
a non-in-progress slice → **deny** (reason names strict + owning slice) · strict + Phase-B
Bash write into an in-progress slice → allow · strict + Phase-B Bash write to an unowned
in-root path / doc-allowlist path / out-of-root path / non-redirecting command → allow
(fail-open) · strict + empty slices → allow · strict + Phase-A file write → deny · strict +
Phase-A Bash write → deny · strict Phase-B **Write/Edit** boundary → still ask (unchanged) ·
default `ask` / explicit `deny` / `off` + Phase-B Bash write → allow (strict not active —
backward-compatible) · `TH_DISABLE_WRITE_GATE=1` overrides strict.

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

  > **Status update (post-v0.3.0 hardening):** a *conservative* Bash matcher now ships as
  > defense-in-depth — Phase A only, catching obvious redirections (`>`, `>>`), `tee`,
  > `dd of=`, and `sed -i` into in-root implementation paths, fail-open on anything it
  > cannot clearly parse. The position above still holds as a *guarantee*: Bash writes
  > remain out of scope; the matcher narrows the gap, it does not close it (see SECURITY.md).

  > **Status update (v0.6.2 — `strict` mode, G4):** the same conservative Bash matcher is
  > now *also* applied in Phase B when `write_gate: "strict"` is set, enforcing the §16
  > component-boundary rule on mid-build Bash redirections (`deny` on a target owned solely
  > by non-in-progress slices). This is **opt-in** and does **not** change default-mode
  > behaviour: `ask` / `deny` / `off` / absent all still leave Phase-B Bash writes ungated.
  >
  > **Honest scope of `strict`.** It *narrows*, it does **not** *close*, the Bash bypass.
  > The matcher is a regex over the literal command string; it still does **not** cover:
  > here-documents (`cat <<EOF > file`), subshells / command substitution
  > (`(cd src && echo x > a.ts)`, `$(...)`), variable indirection (`f=src/a.ts; echo x > "$f"`),
  > shell globbing / brace expansion (`echo x > src/*.ts`), `printf`/`python -c`/`node -e`
  > writers, and any write performed by an invoked program rather than a redirection. As
  > with Phase A it is **fail-open**: anything it cannot clearly parse falls through to allow.
  > The fundamental caveat from SECURITY.md is unchanged — these are guardrails for a
  > *compliant* agent, not a sandbox. A determined or non-compliant agent can still write via
  > an unparsed Bash construct; `strict` raises the bar for the common, accidental redirection
  > cases, nothing more.
