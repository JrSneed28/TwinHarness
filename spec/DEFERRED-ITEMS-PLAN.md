# Deferred-Items Plan — PR #19 follow-on

**Status:** APPROVED (plan only) — execution not started. Reviewed by 4 independent
critic rounds (final verdict: *APPROVED — no critiques*). No source/build/test
changes performed.

**Scope:** the three items PR #19 ("Investigation fixes: Phases 0–7") explicitly
flags as **Deferred**. This document is separate from, and additive to,
`spec/INVESTIGATION-FIXES-PLAN.md` — it does not modify that plan.

**Branch:** `claude/twinharness-investigation-zouiej` (the PR #19 head).

---

## The three deferred items (from the PR body)

1. **Phase 2B full module resolution** — tsconfig/jsconfig `paths`/`baseUrl` + bare
   workspace-package specifiers currently stay `unresolved`/`external`, never guessed.
2. **lcov → relevance/impact wiring** — the containment half landed
   (`parseLcovContained`), but it is imported by nothing; no coverage signal feeds
   relevance.
3. **Tier-gating of high-risk tools** — needs a *distinct destructive-op
   confirmation gate*, NOT the advanced-coordination feature gate, to avoid locking
   out legitimate T0/T1 runs.

---

## Cross-cutting guardrails (every item)

- **`npm run verify` stays green:** typecheck → build → tests → `git diff
  --exit-code dist/`. `dist/` is git-tracked (esbuild bundle + tsc output);
  **rebuilding and committing `dist/` is a required step in every item** —
  otherwise the gate fails.
- **MCP parity:** `TOOL_DEFS.length === 62`, names/order unchanged
  (`tests/mcp-parity.test.ts:72`). Changes are confined to `run`-closure bodies, new
  pure modules, or **additive optional** inputSchema properties. Before adding any
  optional `confirm` property, confirm no per-tool property-shape assertion pins that
  tool — only `th_repo_check`'s empty-properties is pinned
  (`tests/mcp-parity.test.ts:31`).
- **Determinism:** serialization stays byte-identical when resolved content is
  unchanged. New serialized fields are emitted ONLY when their source data is present,
  and are sorted + bounded. All resolution operates over the in-memory **sorted**
  fileSet — never `readdir` order.
- **RULE-004 (trust boundary):** new config reads (tsconfig/jsconfig, lcov) are pure
  text/JSON parses — never `require()`'d or executed, and fail-closed.
- Each item lands as its own commit with REQ-anchored tests; `npm run verify` is run
  after each.

---

## Pre-work decision gate (blocks #1) — schema + basis

- Introduce a NEW edge basis **`"alias"`** (tsconfig/jsconfig + workspace-bare
  resolution), DISTINCT from `"parsed"` (relative/literal resolution). Add it to the
  `EDGE_BASES` closed union (`schema.ts:565`) and the `validateRepoMapShape` allowlist
  (`schema.ts:771`).
- Because `EDGE_BASES` is a parser-enforced closed union, adding a value is
  forward-incompatible → bump `REPO_MAP_SCHEMA_VERSION` **2 → 3** (`schema.ts:35`).
  Follow the existing P1-1/4 pattern: NO in-place migration; a version mismatch
  regenerates the derived map (`th migrate` stays STATE-only). Note `parseRepoMap`
  checks version BEFORE shape (`schema.ts:629-630` returns `map_version` ahead of the
  shape check at `:633`).
- **Schema-version test updates are of THREE distinct kinds** (do not blanket-bump):
  - **(a) asserted-OUTPUT version** — tests asserting a freshly built/parsed map
    reports version 2 → change expected value to 3 (`repo.test.ts:284`, `:373`; golden
    `tests/fixtures/repo-map-golden.json:2`).
  - **(b) valid-INPUT version whose role FLIPS** — `repo.test.ts:353` and `:1517` feed
    `schema_version: 2` as the *current/valid* version to exercise a language/shape
    failure (expecting `map_schema`). Because version is checked before shape, these
    inputs must become `schema_version: 3` or they wrongly return `map_version`.
  - **(c) unknown-version tests that STAY UNCHANGED** — the `schema_version: 999` cases
    (`repo.test.ts:359`, `:1531`) assert `map_version`; no edit.
  - `migrate.test.ts:105` asserts STATE `schema_version === 2` — **DO NOT touch.**
- **Ranking contract:** `"alias"` edges earn NO `importProximity` and are NOT followed
  by `resolvedImportNeighbors` / `computeImpact` (which filter `basis !== "parsed"`,
  `query.ts:248`, `:925`). They are recorded for inspection/telemetry only. Promotion
  to ranking power is a SEPARATE later change gated on P2-8 precision telemetry —
  **explicitly out of scope here.**

---

## Deferred #1 — Phase 2B module resolution

Files: `src/core/repo-map/extract.ts`, `scanner.ts`, `schema.ts`.

### #1a — tsconfig/jsconfig `paths` + `baseUrl`
- NET-NEW pure, deterministic **JSONC reader** (minimal comment + trailing-comma
  stripper → `JSON.parse`; on ANY parse failure → no aliases, fall back to
  `unresolved`; never `require()`'d) — called out as net-new code with its own
  RULE-004 + determinism REQ-anchored tests.
- Resolve an aliased specifier; accept ONLY if it lands on a file in the scanned
  fileSet; reject `..`-escape; non-landing → `unresolved`. Resolved → `basis:"alias"`.
- Deterministic tie-break: tsconfig longest non-wildcard prefix wins, then
  POSIX-sorted; candidate suffixes use the existing `TS_RESOLVE_EXTS` order
  (`extract.ts:266`).

### #1b — workspace bare-package resolution
- Build a package-name → root map **purely in-memory** by (i) expanding workspace glob
  patterns (currently NOT done — `scanner.ts:257-258`) and (ii) reading each child
  manifest's `name`.
- Deterministic tie-break: map built over POSIX-sorted package-root paths, first-wins
  on duplicate names; a specifier head matching multiple package names → longest
  package name, then POSIX-sorted first-wins; a candidate not landing on a real in-repo
  file → `unresolved` (never guess). Resolved → `basis:"alias"`.
- Strictly more work than #1a; its own commit.

### Cost + fixtures
- Alias edges count against `MAX_TOTAL_EDGES`/`MAX_TOTAL_SYMBOLS` (`scanner.ts:71-73`,
  REQ-NFR-007); extend `repo-bounded-cost` benchmark.
- The golden fixture has NO imports/edges today (it DOES already have `symbols`). ADD
  import statements (this forces the single reviewed golden regen): relative
  (`parsed`), tsconfig-paths (`alias`), workspace-bare (`alias`), non-resolvable bare
  (`unresolved`/`external`). Assert alias edges earn no `importProximity` and are absent
  from `resolvedImportNeighbors`.

---

## Deferred #2 — lcov → relevance/impact wiring

Files: `src/core/repo-map/lcov.ts` → `scanner.ts`, `query.ts`, `schema.ts`.

- **Scanner:** when an lcov report is present, call `parseLcovContained(knownFiles)`;
  persist a bounded, sorted `coverage` field, capped against the cost envelope.
  Emitted ONLY when a report exists → no-coverage repos (incl. the golden fixture)
  stay byte-identical. Rides on the v3 schema; absent == legacy.
- **Query / `computeRelevance`:** add a coverage-derived file→test association signal
  with a NON-`parsed` basis (`"coverage"`), weight below the lowest path-token/component
  signal (≤ `siblingComponent` = 40, `query.ts:157`), so it can never outrank a
  resolved edge or path-token.
- **P2-8 telemetry integrity:** `relatedZeroCoupling` is a DERIVED COMPLEMENT
  `emittedRelated.length - relatedCoupled` (`query.ts:617-623`); existing
  path-token/name-convention related items are ALREADY zero-coupling by design (e.g.
  `testRelated` sets score without `coupled=true`). The fix is therefore narrow:
  exclude coverage-only items from BOTH numerator and denominator of the precision base
  so coverage introduces NO NEW inflation and the EXISTING P2-8 semantics are preserved
  unchanged. (Not a claim the metric becomes "unpolluted" — only that coverage adds
  nothing to it.)
- **Tests:** coverage-present fixture (separate from the byte-identical golden); an
  escaping/stale lcov path yields no edge; the coverage signal sits below
  resolved+path-token; coverage-only items change NEITHER `relatedCoupled` NOR
  `relatedZeroCoupling`; deterministic ordering.

---

## Deferred #3 — destructive-op confirmation gate

File: `src/mcp-server.ts`.

- The genuine unguarded destructive surfaces are the `destructiveHint:true` tools:
  `th_verify_clear` (ungated, `:1575`), `th_interview_start` (ungated, `:1588`),
  `th_collab_fragment` (`:1565`, currently only tier-gated at `"collab"` — a
  feature-availability gate, NOT a destructive-confirmation gate).
- Add a NEW **`assertDestructiveAck(args)`** helper — DISTINCT from `assertTierAllows`
  and **tier-independent by construction** (takes only `args`; T0/T1 with `confirm`
  proceed). Apply to all three (`th_collab_fragment` keeps BOTH gates: tier for
  availability, ack for data-loss). Requires explicit `confirm:true`; absent →
  structured `confirmation_required` refusal mirroring the `tier_locked` shape; never
  throws. Composed: `run: (paths, args) => assertDestructiveAck(args) ?? <existing
  guards> ?? actualRun(...)`.
- **Reconciliation with the PR body's loose list** (`th_verify_run` / `th_repo_map`
  write / gate setters):
  - `th_verify_run` already gated via the P6-2 `approvedHash` / `isCommandSetApproved`
    mechanism (`verify.ts:54`, `:141-143`, enforced at `:183`) → no change.
  - Gate setters already guarded (`th_write_gate_set` tighten-only; `th_state_set`
    gate-owned refusal; typed gate tools via the precondition ladder) → no change.
  - `th_repo_map` write is `destructive:false` + idempotent (`mcp-server.ts:1546`) and
    re-runs byte-identically — NOT data loss → **explicitly OUT** (a gate there adds
    friction with no safety benefit and risks locking legitimate T0/T1 map refreshes,
    the exact outcome the PR wanted to avoid).
- **Contract test is BEHAVIORAL**, not static set-equality (run closures are opaque,
  `mcp-server.ts:331`): iterate `TOOL_ANNOTATIONS` for `destructiveHint:true`, locate
  each `TOOL_DEF`, invoke `run(paths, {})` (no confirm) and assert a
  `confirmation_required` result — so any future destructive tool that forgets the ack
  is caught. Plus: proceeds when `confirm:true`; T0/T1 not locked out; `TOOL_DEFS`
  length/names unchanged.

---

## Sequencing

1. **Pre-work decision gate** (schema v3 + `"alias"` basis + ranking contract) —
   underpins #1 and #2.
2. **#3** — isolated; no schema/golden impact; smallest `dist/` delta.
3. **#1a then #1b** — single reviewed golden regen when import fixtures are added.
4. **#2** — depends on #1's edge-ranking being settled so the coverage weight/basis
   sits below it.

Each step: REQ-anchored tests + `dist/` rebuild/commit + `npm run verify` green. Final
push to `claude/twinharness-investigation-zouiej`.

---

## Review provenance

Plan converged over four independent critic rounds:

| Round | Verdict | Key correction |
|-------|---------|----------------|
| 1 | CHANGES | alias `basis:"parsed"` would violate P2-8; schema-version decision; golden-risk mis-stated; `dist/` rebuild omitted |
| 2 | CHANGES | #3 targeted the wrong tool (`th_repo_map` is `destructive:false`); real destructive surfaces missed; `relatedZeroCoupling` complement hole; JSONC parser net-new; #1b tie-break undefined |
| 3 | CHANGES | 4 low-severity precision/wording fixes (no blocking defects) |
| 4 | **APPROVED — no critiques** | all fixes verified; enumeration complete |
