# TwinHarness — Investigation Fixes Execution Plan

**Status:** PROPOSED (plan only) — awaiting approval to execute.
**Source:** 22-point concern investigation (verified against source, 2026-06-19).
**Branch:** `claude/twinharness-investigation-zouiej`

## 0. Guiding decisions (operator-approved)

| # | Decision | Consequence for this plan |
|---|----------|---------------------------|
| D1 | **Build the real import/symbol graph now** | Phase 2 is the centrepiece; relevance/impact/file-to-test are rebuilt on evidence, not directory tokens. |
| D2 | **Tier-gate advanced features, disabled by default** | Phase 5 introduces a feature-activation layer; collab/debate/leases/extra agents become opt-in by tier/size. |
| D3 | **Harden audit, keep TTY gate (no crypto)** | Phase 6 records real invocation provenance and stops self-asserting `"human"`; the gate stays a compliant-agent guardrail, documented as such. |
| D4 | **Schema bump + migration allowed** | New on-disk fields (`scanReport`, confidence, edges, provenance) are versioned; `th migrate` upgrades or flags-stale existing artifacts. |

### Cross-cutting principles
- **Determinism preserved.** All new map fields flow through the single serializer (`schema.ts serializeRepoMap`); the scanner never sorts (ADR-003).
- **Trust boundary preserved.** Repo content stays untrusted; no new subprocess in the scanner (RULE-004). Symbol/import extraction is pure text parsing, never execution.
- **Additive + omit-when-absent** for backward-readable maps; schema-version bump only where a field is load-bearing (D4).
- **CLI is the source of truth; MCP stays a thin adapter** (Phase 7 enforces this mechanically).
- **Every fix ships with a REQ-anchored test** mirroring existing suite discipline.

---

## 1. Phase overview & sequencing

```
Phase 0  Quick wins / honesty            (independent — land first)
Phase 1  Schema-version + migration core (foundation for 2,3,4)
Phase 2  Repo code-graph (import/symbol) (D1 — depends on 1)
Phase 3  Scanner robustness             (depends on 1; parallel to 2)
Phase 4  Freshness + partial + budget   (depends on 0,2,3)
Phase 5  Feature activation / tiering    (D2 — depends on nothing in 1-4; parallel)
Phase 6  Safety hardening                (independent — parallel)
Phase 7  Parity, docs, product boundary  (depends on all; lands last)
```

Phases 0, 5, 6 have no dependency on the graph work and can proceed in parallel with 1–4. Phase 7's doc-generation must run last so generated counts reflect final state.

---

## Phase 0 — Quick wins (low risk, high signal)

Addresses parts of #5, #10, #21 that need no schema change or graph.

| ID | Item | Files | Test |
|----|------|-------|------|
| P0-1 | Replace exact `1672 tests` literals with the existing soft-floor phrasing (`1000+`) or drop the number; align README ↔ CHANGELOG | `README.md:5,238`, `CHANGELOG.md:31` | extend `doc-truth.test.ts` to ban any 4-digit `\d{4} tests` literal |
| P0-2 | Surface partial-scan in the **transient** `th repo map` output more prominently + structured log already exists — verify wording | `src/commands/repo.ts:161-181` | `repo.test.ts` partial-banner assertion |
| P0-3 | Add `PowerShell` + `patch`/`git apply` to the documented write-gate bypass list (#18 doc gap) | `SECURITY.md:46` | `security-doc-lint.test.ts` |
| P0-4 | Add a `cli.ts` startup Node-version guard reusing `doctor` message; add upgrade pointer in README (#20) | `src/cli.ts:main()`, `README.md:89` | `version.test.ts` / new `node-guard.test.ts` |

**Acceptance:** docs internally consistent; old Node prints friendly message; partial scans visibly flagged at scan time.

---

## Phase 1 — Schema versioning + migration core (foundation)

Addresses #5 (persist), enables #2/#7/#8/#9 (confidence + edges) and #3/#4 (scan metadata). Implements **D4**.

| ID | Item | Detail |
|----|------|--------|
| P1-1 | Add `schema_version` to `RepoMap` on-disk form | `schema.ts`: emit + validate; bump from implicit v1 → v2. `parseRepoMap` accepts v1 (treats absent fields as unknown). |
| P1-2 | **Persist `scanReport`** (the #5 root cause) | Stop stripping `capHit`/`filesScanned`; serialize a `scan` block. Keep `repoRoot` stripped (run-specific). Update `schema.ts:219` strip list + `parseRepoMap`. |
| P1-3 | Introduce a **confidence/basis model** | New shared type `Provenance = { basis: "exact" | "manifest" | "parsed" | "path-token" | "name" | "component"; confidence: "high"|"medium"|"low" }`. Attach to components, entrypoints, ownership hints, blast-radius signals, public-API. Generalises the lone `public_api.confidence` (#2/#9). |
| P1-4 | `th migrate` upgrades v1 → v2 maps; stale-flags maps it cannot upgrade so they get re-scanned | `src/commands/migrate.ts` + `migrate.test.ts` |
| P1-5 | Golden-map fixtures regenerated for v2 | `tests/repo-map-golden.test.ts`, `tests/fixtures` |

**Acceptance:** a partial or stale map is distinguishable on disk; every inferred fact carries a basis+confidence; v1 maps still load or auto-migrate.

---

## Phase 2 — Repo code-graph: import & symbol extraction (D1, the big lift)

Root fix for #2, #7, #8, #9 and the structural enabler for #6. Pure text parsing, no execution.

### 2A. Extraction (scanner side)
| ID | Item | Detail |
|----|------|--------|
| P2-1 | **Exported-symbol extraction** | Per-language lightweight parsers (regex-tier first: TS/JS `export`, Python `def`/`class`/`__all__`, Go `func`/`type` caps, Rust `pub`, Java `public`). Store `FileEntry.symbols: {name,kind}[]` (omit-when-absent). Reuses the single existing read (`scanner.ts:453`). |
| P2-2 | **Import/module edges** | Parse `import`/`require`/`use`/`from`; resolve specifiers to in-repo paths (honour tsconfig `paths`, package roots). Store as a new top-level `edges: {from,to,kind:"import"}[]`. Unresolved specifiers recorded as external (not dropped). |
| P2-3 | **Public-API detection beyond manifest** | Combine `package.json exports` + barrel/`index` files + exported-symbol density; emit `public_api` entries with `basis:"parsed"` vs `"manifest"`. |
| P2-4 | **Binary/encoding guard** (#6) | NUL-byte sniff before extraction; text-extension allowlist; skip anchor/symbol extraction on binary; hash binaries from a `Buffer` (no UTF-8 lossy normalisation) in `hash.ts hashPathContent`. Prevents false REQ anchors from binary byte-soup. |

### 2B. Consumption (query side — rebuild on edges)
| ID | Item | Detail |
|----|------|--------|
| P2-5 | **Relevance ranking v2** (#7) | New signals above `siblingComponent`: `importProximity` (1-hop in/out edges), `symbolNameMatch` (query ↔ exported symbol), seed-REQ propagation to non-`--req` selectors, git recent-change bonus (reads `git log` via existing safe path or `fileHashes` delta). Each result keeps a `why` **and** a `basis`. |
| P2-6 | **File-to-test mapping** (#8) | Mechanical edges: (a) name convention `foo↔foo.test`; (b) test→source import edge; (c) shared symbol; (d) shared REQ; (e) lcov ingestion when a coverage report exists. Each labelled with confidence tier. |
| P2-7 | **Impact analysis v2** (#9) | Split `directImpact` (seed + 1-hop importers) from `possibleImpact` (transitive / same-component). Per-edge `basis`+`confidence`. Add explicit caveat in human output when transitive closure was bounded. Path-name similarity downgraded to `low`/`path-token`. |
| P2-8 | **Precision telemetry** (#7) | Emit count of "related-but-zero-coupling" suggestions; add order-sensitive ranking tests (tightly-coupled file must outrank a loosely-related sibling). |

**Acceptance:** relevance/impact cite real import/symbol edges with confidence; a same-directory sibling with no code link is labelled low-confidence; file→test links are mechanical and labelled; binaries never produce anchors.

**Effort note:** this is the largest phase. Recommend landing 2A (extraction + schema) and 2B incrementally behind the confidence labels from Phase 1, so partial delivery is still honest.

---

## Phase 3 — Scanner robustness for unconventional repos

Addresses #3, #4, #6 (config side).

| ID | Item | Detail |
|----|------|--------|
| P3-1 | **Depth-aware / package-root detection** (#3) | Any directory containing a manifest becomes a package root; detect `src/lib/tests/docs` **relative to each package root**, not just `depth===0` (`scanner.ts:360`). Fixes monorepos, nested packages, multiple apps, sub-root source in one change. |
| P3-2 | **Component derivation generalised** (#3) | `componentForFile` derives components from package roots, not only top-level `SOURCE_ROOT_NAMES`. |
| P3-3 | **Workspace detection** (#3) | Parse `workspaces` (npm/yarn), `pnpm-workspace.yaml`, Cargo `[workspace]`. Add `pnpm-workspace.yaml`, `pubspec.yaml`, `Podfile`, `CMakeLists.txt`, `Justfile`, `Taskfile.yml` to manifest tables. |
| P3-4 | **Extend `EXT_LANG`** (#3) | Add C/C++/Objective-C/Swift/Dart/Scala/Shell/SQL so mixed-language / mobile repos report languages. |
| P3-5 | **Configurable exclusions + reasons** (#4) | `.twinharnessignore`-style project file + `ScanOptions` include/exclude. Make `vendor`/`bin`/`obj` context-aware (only prune at module roots / when a sibling manifest indicates deps). Optional `.gitignore` as a *signal*, never blind trust. Record an **exclusion reason per path**; surface in `th repo map`. |
| P3-6 | **"Low-confidence structure" warning** (#3) | When files > N but `source_roots`/`components` empty, emit a visible warning in `scanReport` so a missed layout is never silent. |

**Acceptance:** a monorepo produces non-empty components/roots; excluded paths report *why*; Go `vendor`/script `bin` no longer silently vanish; missed structure is surfaced, not silent.

---

## Phase 4 — Freshness, partial-scan integration & context budgeting

Addresses #5 (downstream), #10, #11. Depends on Phase 1 (persisted scanReport) + Phase 2 (relevance shape).

| ID | Item | Detail |
|----|------|--------|
| P4-1 | **Freshness in `th context pack`** (#10, highest-value) | Before injecting `runRepoRelevant`, call `runRepoCheck`; prepend a `STALE repo-map` label + `repoMapFresh` field. (`context.ts:185`) |
| P4-2 | **Freshness in `th doctor`** (#10) | Add a repo-map check calling `runRepoCheck`, reporting added/removed/modified counts like the artifact-drift check. (`doctor.ts`) |
| P4-3 | **Freshness in MCP repo tools** (#10) | `th_repo_relevant`/`th_repo_impact` results carry a `freshness`/`stale` field so MCP agents see staleness inline. (`mcp-server.ts:719-737`) |
| P4-4 | **Partial-scan surfaced downstream** (#5) | `RelevanceResult`/`ImpactResult`/context pack carry a `partial`/`scanIncomplete` flag (sourced from persisted scanReport); markdown renderer shows a `PARTIAL` banner. |
| P4-5 | **Brownfield gate handles partial** (#5) | `checkRepoMap` (`gate-preconditions.ts:106`) treats a partial map as warn-or-block for unlock, not silently fresh. |
| P4-6 | **`th context pack --max-tokens`** (#11) | Enforce a budget: rank, truncate lowest, report omissions ("omitted N items, why"). Surface the dropped `truncated` flag (`context.ts:186`). |
| P4-7 | **Agent-/selector-specific packs** (#11) | Add REQ-, file-, and failure-specific packs (selectors already exist in `runRepoRelevant`); per-agent views in `th delegate pack`. Validate artifact Summary block at `th artifact register` to bound head-fallback bloat. |
| P4-8 | **Configurable scan caps** (#5) | Wire `ScanOptions` caps to a CLI flag / config for large repos; ensure `th repo check` uses matching overrides. |

**Acceptance:** stale/partial maps cannot silently feed packs, gates, or MCP tools; context packs respect a token budget and report omissions.

---

## Phase 5 — Feature activation / tiering (D2)

Addresses #1, #12 (loading), #14, #15, #22 (modularity).

| ID | Item | Detail |
|----|------|--------|
| P5-1 | **Feature-activation layer** | A tier/size-driven capability set (extend `th tier`). Advanced coordination (collab, debate, artifact/section leases, sub-leases) **off by default**, activated by tier ≥ T2 or parallel-authorship detection. Document a clear "use when" per feature. |
| P5-2 | **Tier-gate MCP advanced tools** (#12) | Register advanced/coordination tools conditionally; high-risk tools (`th_verify_run`, `th_repo_map` write, gate setters) require explicit enabling. Keep the **permanent absence** of `th_decision_approve` (verified RULE-011). |
| P5-3 | **Section-lease + fragment stale-recovery** (#15, correctness gap) | `activeSectionLeases`/`runArtifactLeases` reconcile against a governing slice or TTL sweep, mirroring `staleLeases`; add fragment GC/TTL. Closes the "dead holder wedges section forever" bug. |
| P5-4 | **Agent consolidation** (#14) | Fold `test-author` into a Builder triad-mode (or document as worktree-mate, not standalone); unify the reconciler/merge-coordinator "single-writer" doctrine; clarify red-team vs Critic(security/failure-modes) ownership. |
| P5-5 | **Ledger unification** (#1) | Present drift/debate/decision blocking counters behind one "open human obligation" abstraction in `th next`/docs (mechanics unchanged, surface unified). |
| P5-6 | **Agent-boundary lint** (#14) | `th`-level test asserting each "read-only" agent denies Write/Edit/Agent — makes role boundaries mechanical, not prose. |

**Acceptance:** a T0/T1 project never loads coordination machinery; advanced features have explicit activation thresholds; section leases recover; agent count justified or reduced.

---

## Phase 6 — Safety hardening

Addresses #16 (minor), #17 (D3), #18 (doc), #19.

| ID | Item | Detail |
|----|------|--------|
| P6-1 | **Human-only audit provenance** (#17, D3) | Persist real invocation source on the approval event: `isTTY` result, `ppid`/parent-comm, hostname, pid. Stop defaulting `approver` to `"human"` — require explicit non-default actor or mark unattributed approvals suspect. Persist the approval structured-log (currently stderr-only/silenceable). Document the TTY gate as a compliant-agent guardrail, not a sandbox. |
| P6-2 | **Verify-command provenance + approval** (#19) | Record actor/timestamp per command in `verify.json`; require explicit human confirmation (or hash-pin) before first execution of a new/changed command set. |
| P6-3 | **Verify env hygiene + redaction** (#19) | Pass a curated `env` to `spawnSync` (not full inherit); redact known secret patterns from `outputTail` before persist/print. |
| P6-4 | **Verify Windows process-tree kill** (#19) | Use `taskkill /T /F` (Windows) / negative-PID kill (POSIX) so grandchildren die on timeout. |
| P6-5 | **Verify optional read-only mode** (#19) | Flag to refuse repo-mutating verification for untrusted projects. |
| P6-6 | **Decision UX clarifications** (#16) | Surface in `th decision list/check` that `rejected`/`superseded` still gate; lint discouraging `stage:` links on reversible choices. |
| P6-7 | **Write-gate honesty signal** (#18) | Emit guardrail-not-sandbox caveat at `write_gate: strict` opt-in and in `th doctor`; optionally `ask` (not silent allow) when a write-shaped command's target was dropped for a metachar/variable. |

**Acceptance:** approvals carry tamper-evident provenance; verify commands are attributed, approved-before-first-run, env-scrubbed, and kill cleanly on Windows; write-gate framing visible at point of use.

---

## Phase 7 — Parity, doc generation, product boundary

Addresses #12 (descriptions), #13, #21, #22. Lands last (counts must reflect final state).

| ID | Item | Detail |
|----|------|--------|
| P7-1 | **CLI↔MCP command-parity test** (#13) | Derive the CLI command set from `dispatch`/HELP and assert each non-excluded command has a `TOOL_DEFS` entry, with an explicit `EXCLUDED` set (realise the never-implemented `EXPECTED_TOOL_ALLOWLIST` at `mcp-server.ts:1175`). Pin the intended divergence set (emergency/force/gate-owned). Convert "no orchestration logic" into a real thinness guard. |
| P7-2 | **MCP machine-readable annotations** (#12) | Add `readOnlyHint`/`destructiveHint`/`idempotentHint` per tool; add a `category` for cheap grouping. Compact-by-default + `verbose` flag on heavy tools (`coverage_report`, `doctor`, `scorecard`). Consolidate overlapping oracles (`next`/`next_wave`/`dispatch`; `doctor`/`scorecard`). |
| P7-3 | **Generated command reference** (#21) | Generate the command reference from CLI definitions; exhaustive coverage test (CLI dispatcher → USAGE). |
| P7-4 | **Pin MCP tool-name prose** (#21) | Test diffing USAGE's enumerated tool names against `TOOL_DEFS.map(t=>t.name)`. |
| P7-5 | **Product-boundary docs** (#22) | Add a **Non-Goals** section; a "How it compares" section (Aider/OpenHands/Spec Kit/BMAD/prompt packs, one line each); split README features into **Core vs Advanced (opt-in)**; reorder quickstart above architecture; lead every surface with the plain promise. State activation defaults for collab/debate/sub-Builders. |

**Acceptance:** a new CLI command without MCP coverage fails CI; docs counts derive from the registry/filesystem; product promise, non-goals, and positioning are stated once and consistently.

---

## 2. Per-concern coverage matrix

| # | Concern | Phase(s) | Primary items |
|---|---------|----------|---------------|
| 1 | Operational complexity | 5,7 | P5-1, P5-5, P7-5 |
| 2 | Repo map heuristic | 1,2 | P1-3, P2-1/2/3 |
| 3 | Unconventional repos | 3 | P3-1..4,6 |
| 4 | Generated-dir over-filter | 3 | P3-5 |
| 5 | Partial scans | 0,1,4 | P1-2, P4-4/5/8 |
| 6 | Binary/encoding | 2 | P2-4 |
| 7 | Relevance ranking | 2 | P2-5, P2-8 |
| 8 | File-to-test | 2 | P2-6 |
| 9 | Impact certainty | 1,2 | P1-3, P2-7 |
| 10 | Freshness integration | 4 | P4-1/2/3 |
| 11 | Context budgeting | 4 | P4-6/7 |
| 12 | MCP overload | 5,7 | P5-2, P7-2 |
| 13 | MCP/CLI parity | 7 | P7-1 |
| 14 | Agent count | 5 | P5-4/6 |
| 15 | Collaboration | 5 | P5-1/3 |
| 16 | Decision governance | 6 | P6-6 |
| 17 | Human-only | 6 | P6-1 |
| 18 | Write-gate | 0,6 | P0-3, P6-7 |
| 19 | Verify safety | 6 | P6-2..5 |
| 20 | Node 20 | 0 | P0-4 |
| 21 | Doc drift | 0,7 | P0-1, P7-3/4 |
| 22 | Product boundary | 7 | P7-5 |

All 22 concerns are mapped; none dropped.

## 3. Risk & rollback

- **Schema v2 (D4):** gated by `th migrate` + v1 read-compat; rollback = pin `schema_version` reader to v1 and disable new emitters.
- **Graph extraction (D1):** land behind confidence labels first; if a language parser is unreliable, emit `basis:"path-token"` fallback rather than wrong edges.
- **Tier-gating (D2):** feature-activation defaults are conservative (off); existing T2/T3 flows retain current behaviour via tier mapping, so no silent capability loss.
- **Each phase is independently shippable** and test-gated; CI (`npm run verify`) must stay green per phase.

## 4. Suggested execution order

1. Phase 0 (immediate, low-risk).
2. Phase 1 (foundation).
3. Phases 2 + 3 in parallel; 5 + 6 in parallel alongside.
4. Phase 4 (after 1–3).
5. Phase 7 (last).
