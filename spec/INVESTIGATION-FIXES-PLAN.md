# TwinHarness — Investigation Fixes Execution Plan

**Status:** PROPOSED — rev 2.1 (incorporates two adversarial-review passes). Awaiting approval to execute.
**Source:** 22-point concern investigation (verified against source, 2026-06-19).
**Branch:** `claude/twinharness-investigation-zouiej`

> **Rev 2.1 changelog** (second review pass — re-review confirmed B1/B2/B3/S1/S2/S3 + 3 gaps RESOLVED; these are the remaining minor targeting fixes):
> - **P2-9 re-targeted** to the *actual* consumers `librarian.md` (owner) + `orchestrator.md:165` — the four agents originally named don't reference the surface.
> - **P5-2** names the in-closure tier resolver (`requireState(paths).tier` via a shared `assertTierAllows` helper) — a state read, not a re-classification.
> - **P4-10** freshness-cost cache extended to the `checkRepoMap` gate path (`gate-preconditions.ts:106`), not just MCP tools.
> - **P2-4** rationale corrected: the real binary-hash defect is *lossy-utf8 collision* (missed staleness), not eternal `modified`; both still require the all-or-nothing Buffer fix.

> **Rev 2 changelog** (after expert critique, all claims re-verified against code):
> - **B1** P1-2 rewritten — persist only the *deterministic* `capHit` enum + a boolean `partial`; never the run-varying counts (would break the byte-identical golden, `repo-map-golden.test.ts:182`).
> - **B2** P5-2 rewritten — advanced tools stay in `TOOL_DEFS` (count contract `mcp-parity.test.ts:72` preserved); tier-gating is a **runtime gate inside the `run` closure**, not conditional registration.
> - **B3** P2-4 now paired with a freshness-hash audit so both the stored-hash and the `th repo check` re-scan paths change together (`repo.ts:94,734`).
> - **S1** Phase 2 split into 2A/2B; regex-tier edges may **never outrank** until validated by telemetry; tsconfig-`paths` resolution deferred to 2B.
> - **S2** Added an edge/symbol cost budget + benchmark gate (REQ-NFR-007).
> - **S3** P1-4 replaced — repo-map is a *derived* artifact: bump `REPO_MAP_SCHEMA_VERSION`, fail old maps closed, **regenerate** (no in-place migration; `th migrate` stays state-only).
> - **Gaps** added: agent-prompt label propagation (P2-9), context-pack shape compat test (P4-9), lcov containment (folded into P2-6), freshness-cost benchmark (P4-10).

## 0. Guiding decisions (operator-approved)

| # | Decision | Consequence for this plan |
|---|----------|---------------------------|
| D1 | **Build the real import/symbol graph now** | Phase 2 is the centrepiece; relevance/impact/file-to-test are rebuilt on evidence, not directory tokens. |
| D2 | **Tier-gate advanced features, disabled by default** | Phase 5 introduces a feature-activation layer; collab/debate/leases/extra agents become opt-in by tier/size. |
| D3 | **Harden audit, keep TTY gate (no crypto)** | Phase 6 records real invocation provenance and stops self-asserting `"human"`; the gate stays a compliant-agent guardrail, documented as such. |
| D4 | **Schema bump + migration allowed** | Versioned on-disk fields (confidence, edges, provenance). *State* uses `th migrate`; the *repo-map* is a derived artifact and is **regenerated** on version mismatch, not migrated (see P1-4). |

### Cross-cutting principles
- **Determinism preserved.** All new map fields flow through the single serializer (`schema.ts serializeRepoMap`); the scanner never sorts (ADR-003). **No run-varying value (e.g. `filesScanned`, traversal-order-dependent counts) is ever persisted** — only bounded, deterministic signals. The byte-identical golden (`repo-map-golden.test.ts:182`) is a hard gate every Phase-1/2 change must pass.
- **Trust boundary preserved.** Repo content stays untrusted; no new subprocess in the scanner (RULE-004). Symbol/import extraction is pure text parsing, never execution.
- **Additive + omit-when-absent** for backward-readable maps; schema-version bump only where a field is load-bearing (D4).
- **CLI is the source of truth; MCP stays a thin adapter** (Phase 7 enforces this mechanically).
- **Every fix ships with a REQ-anchored test** mirroring existing suite discipline.

---

## 1. Phase overview & sequencing

```
Phase 0  Quick wins / honesty               (independent — land first)
Phase 1  Map versioning + confidence model   (foundation for 2,3,4)
Phase 2  Repo code-graph (cost gate→2A→2B)   (D1 — depends on 1)
Phase 3  Scanner robustness                  (depends on 1; parallel to 2)
Phase 4  Freshness + partial + budget        (depends on 0,1,2,3)
Phase 5  Feature activation / tiering        (D2 — independent of 1-4; parallel)
Phase 6  Safety hardening                    (independent — parallel)
Phase 7  Parity, docs, product boundary      (depends on all; lands last)
```

Phases 0, 5, 6 have no dependency on the graph work and can proceed in parallel with 1–4. Phase 2 internally gates on its cost test before 2A, and 2B (full module resolution) lands incrementally behind P2-8 telemetry. Phase 7's doc-generation must run last so generated counts reflect final state.

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
| P1-2 | **Persist a deterministic partial-scan marker** (the #5 root cause) — *rev 2 (B1)* | Persist **only** `capHit` (the existing `null \| "file-count" \| "total-bytes"` enum) and a derived `partial: boolean`. **Do NOT persist `filesScanned`/`filesSkipped`/`totalBytes`** — they vary with `readdir` traversal order and would break the byte-identical golden (`repo-map-golden.test.ts:182`) and REQ-NFR-001. `repoRoot` stays stripped. Add the two deterministic keys to `serializeRepoMap` (in sorted position) + `parseRepoMap`. |
| P1-3 | Introduce a **confidence/basis model** | New shared type `Provenance = { basis: "exact" \| "manifest" \| "parsed" \| "path-token" \| "name" \| "component"; confidence: "high"\|"medium"\|"low" }`. Attach to components, entrypoints, ownership hints, blast-radius signals, public-API. Generalises the lone `public_api.confidence` (#2/#9). |
| P1-4 | **Repo-map regeneration on version mismatch** (NOT migration) — *rev 2 (S3)* | Bump `REPO_MAP_SCHEMA_VERSION`. `parseRepoMap` already returns `map_version` (`schema.ts:397`); on mismatch, consumers treat the map as stale/absent and the documented recovery ("re-run `th repo map`", `schema.ts:392`) applies. **`th migrate` stays state-only** (`migrate.ts` operates on `state.json` via `readState/writeState` — it has no repo-map path and should not grow one). A derived artifact is cheaper to regenerate than to migrate. |
| P1-5 | Golden-map fixtures regenerated for the new version | `tests/repo-map-golden.test.ts`, `tests/fixtures` |

**Acceptance:** a partial scan is distinguishable on disk via a *deterministic* marker; the byte-identical golden still passes; every inferred fact carries a basis+confidence; an old-version map is cleanly detected and regenerated (no silent stale consumption, no fragile in-place migration).

---

## Phase 2 — Repo code-graph: import & symbol extraction (D1, the big lift)

Root fix for #2, #7, #8, #9 and the structural enabler for #6. Pure text parsing, no execution (RULE-004).

> **Rev 2 re-scope (S1/S2).** Phase 2 is too large to land atomically and carries a *confident-wrong* risk: a regex parser that misreads re-exports / conditional imports / aliased specifiers produces edges that look authoritative. The phase is split so that **only same-language, locally-resolvable edges land first**, cross-package/alias resolution is deferred, and **no regex-derived edge may outrank an honest path-token signal until validated by P2-8 telemetry.** Wrong-but-confident is strictly worse than today's honest heuristic.

### Phase 2 cost gate (S2 — REQ-NFR-007)
Before any 2A work merges: add `edges`/`symbols` to the bounded-cost budget. Caps on total edges and symbols (counted against the 64 MB / 25k envelope), benchmark on a large fixture (`repo-bounded-cost.test.ts`), and confirm the serializer's added sort cost stays within budget. **No graph field ships without a cost test.**

### 2A. Extraction — symbols + locally-resolvable imports (scanner side)
| ID | Item | Detail |
|----|------|--------|
| P2-1 | **Exported-symbol extraction** | Per-language lightweight parsers (TS/JS `export`, Python `def`/`class`/`__all__`, Go exported `func`/`type`, Rust `pub`, Java `public`). Store `FileEntry.symbols: {name,kind}[]` (omit-when-absent). Reuses the single existing read (`scanner.ts:453`). Skipped on binary (P2-4). |
| P2-2 | **Import edges — relative/locally-resolvable only** | Parse `import`/`require`/`use`/`from` and resolve **relative + same-package** specifiers to in-repo paths. Store top-level `edges: {from,to,kind:"import",basis}[]`. Bare/aliased/tsconfig-`paths` specifiers are recorded as `external` with `basis:"unresolved"` — **never guessed**. (Full module resolution → 2B.) |
| P2-3 | **Public-API detection beyond manifest** | Combine `package.json exports` + barrel/`index` files + exported-symbol density; emit `public_api` with `basis:"parsed"` vs `"manifest"`. |
| P2-4 | **Binary/encoding guard + freshness-hash audit** (#6) — *rev 2 (B3)* | NUL-byte sniff before extraction; text-extension allowlist; skip anchor/symbol extraction on binary. **Real defect:** today both the store path (`repo.ts:94`) and re-check path (`repo.ts:734`) UTF-8-read then `hashContent` (CRLF-normalized), so binaries hash *consistently* but **lossily** — distinct binaries collapsing to U+FFFD/CRLF can collide, silently missing real staleness. Fix = `Buffer`-based hash (no utf8 decode, no CRLF normalize) in `hash.ts hashPathContent`, applied to **both** sides together (all-or-nothing — changing one side alone *would* flip binaries to permanently-`modified`). Pin with a store-then-check binary test asserting `fresh`, plus a collision test for two distinct binaries. |

### 2B. Consumption + full resolution (query side — rebuild on edges)
| ID | Item | Detail |
|----|------|--------|
| P2-5 | **Relevance ranking v2** (#7) | New signals: `importProximity` (1-hop resolved in/out edges), `symbolNameMatch` (query ↔ exported symbol), seed-REQ propagation to non-`--req` selectors, git recent-change bonus. Each result keeps a `why` **and** a `basis`. **Ranking rule:** only `basis:"parsed"`/resolved edges may rank above `siblingComponent`; `unresolved`/regex-tier signals are capped at `low` and cannot outrank path-token until P2-8 validates them. |
| P2-6 | **File-to-test mapping** (#8) | Mechanical edges: (a) name convention `foo↔foo.test`; (b) test→source import edge; (c) shared symbol; (d) shared REQ. Each labelled with confidence tier. |
| P2-6b | **lcov ingestion — contained** (#8) — *rev 2 gap* | When a coverage report exists, ingest file→test coverage, but treat the lcov file as **untrusted repo content**: resolve every path through the same repo-containment check the scanner uses (reject paths escaping root, no symlink traversal). lcov is never executed and never grants edges to out-of-repo paths. |
| P2-7 | **Impact analysis v2** (#9) | Split `directImpact` (seed + 1-hop importers) from `possibleImpact` (transitive / same-component). Per-edge `basis`+`confidence`. Caveat in human output when transitive closure was bounded or when edges were `unresolved`. Path-name similarity downgraded to `low`/`path-token`. |
| P2-8 | **Precision telemetry + validation gate** (#7) | Emit count of "related-but-zero-coupling" suggestions; order-sensitive ranking tests (tightly-coupled file must outrank a loosely-related sibling). This telemetry is the **gate** that unlocks regex/unresolved edges to rank above path-token. |
| P2-9 | **Propagate confidence/basis into agent prompts** (#2/#7/#9) — *rev 2 gap (re-targeted rev 2.1)* | The actual consumers of the repo-intelligence surface are **`agents/librarian.md`** (the standing owner of `th repo relevant`/`impact`/`context pack`, see `librarian.md:37-54`) and **`agents/orchestrator.md:165`** (consumes `context pack`). Update *those* prompts to **read and act on** `basis`/`confidence`: treat `low`/`path-token`/`unresolved` as "possible, verify" not fact, and have the Librarian surface the label in its CAPSULE answers. Lint test asserts the consuming agents (librarian, orchestrator) reference the confidence field — not the non-consumers. |

**Acceptance:** relevance/impact cite resolved import/symbol edges with confidence; regex/unresolved signals never masquerade as high-confidence and never outrank honest path-token until validated; file→test links are mechanical and labelled; binaries never produce anchors and never go permanently stale; lcov cannot introduce out-of-repo edges; agents visibly downgrade low-confidence results.

**Effort note:** this is the largest phase by far. Land the cost gate, then 2A, behind Phase 1's confidence labels; 2B (and especially full module resolution) ships incrementally. Partial delivery stays honest because unresolved edges are explicitly labelled, not guessed.

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
| P4-9 | **Context-pack shape compat test** — *rev 2 gap* | The pack is consumed by `agents/librarian.md` + `agents/orchestrator.md:165`. New fields (`repoMapFresh`/`partial`/`truncated`/omission report from P4-1/4/6) are **additive**; pin the existing pack shape with a contract test so an agent-breaking field rename/removal fails CI. Update those two consuming agent prompts in lockstep (shared with P2-9). |
| P4-10 | **Freshness-cost guard** — *rev 2 (S2/P4-3)* | `runRepoCheck` does a full `scanRepo` + re-hash of every file (`repo.ts:680,716`). It is called per MCP repo tool call (P4-3) **AND inside the brownfield gate `checkRepoMap`** (`gate-preconditions.ts:106`). Benchmark it; if per-call cost is material, cache freshness against a cheap signal (mtime/size summary) and full-hash only on demand — and apply the cache to **both** the MCP-tool path and the `checkRepoMap` gate path, not just MCP. Do not ship per-call full-tree hashing unmeasured. |

**Acceptance:** stale/partial maps cannot silently feed packs, gates, or MCP tools; context packs respect a token budget and report omissions; the pack shape agents depend on is contract-pinned; freshness checks inside MCP tools are measured and bounded, not naively re-hashing on every call.

---

## Phase 5 — Feature activation / tiering (D2)

Addresses #1, #12 (loading), #14, #15, #22 (modularity).

| ID | Item | Detail |
|----|------|--------|
| P5-1 | **Feature-activation layer** | A tier/size-driven capability set (extend `th tier`). Advanced coordination (collab, debate, artifact/section leases, sub-leases) **off by default**, activated by tier ≥ T2 or parallel-authorship detection. Document a clear "use when" per feature. |
| P5-2 | **Tier-gate MCP advanced tools — runtime gate, not conditional registration** (#12) — *rev 2 (B2)* | `TOOL_DEFS` is a static `readonly` array and `mcp-parity.test.ts:72` pins `length === 62`; removing tools by tier would break that contract and make presence assertions tier-dependent. `callTool` (`mcp-server.ts:1421`) looks up `def`, validates args, then calls `def.run(paths,args)` — so the tool **stays advertised** and the gate lives **inside the `run` closure**, returning `failure({error:"tier_locked", human:"…enable via th tier…"})`. **Tier resolver:** `run` receives only `(paths,args)`; resolve the active tier via a plain state read (`requireState(paths).state.tier` — the same read existing handlers already do), NOT a re-classification — cheap and already available. Factor it into one shared `assertTierAllows(paths, feature)` helper so every gated closure uses identical logic. Count + name contracts preserved; high-risk tools (`th_verify_run`, `th_repo_map` write, gate setters) gated the same way. Keep the **permanent absence** of `th_decision_approve` (RULE-011). New parity-compatible test: every gated tool returns `tier_locked` (not a crash) when locked. |
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
| 6 | Binary/encoding | 2 | P2-4 (+ freshness-hash audit) |
| 7 | Relevance ranking | 2 | P2-5, P2-8, P2-9 |
| 8 | File-to-test | 2 | P2-6, P2-6b |
| 9 | Impact certainty | 1,2 | P1-3, P2-7, P2-9 |
| 10 | Freshness integration | 4 | P4-1/2/3, P4-10 |
| 11 | Context budgeting | 4 | P4-6/7/9 |
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

- **State schema (D4):** `th migrate` + version read-compat for `state.json`; rollback = pin reader version and disable new emitters. **Repo-map is NOT migrated** — version mismatch ⇒ regenerate (P1-4), so there is no migration to roll back.
- **Determinism (B1):** every Phase-1/2 change runs against the byte-identical golden (`repo-map-golden.test.ts:182`); only deterministic signals are persisted. Run-varying counts are explicitly forbidden on disk.
- **Graph extraction (D1/S1):** land behind confidence labels first; unreliable/aliased specifiers are labelled `unresolved`, never guessed, and **cannot outrank path-token until P2-8 telemetry validates them**. Confident-wrong is the failure mode we are designing against.
- **Bounded cost (S2):** no graph field merges without the Phase-2 cost gate (edge/symbol caps + benchmark).
- **Freshness contract (B3):** binary-hash change is all-or-nothing across store + re-scan paths, pinned by a store-then-check test.
- **MCP parity (B2):** advanced-tool gating is runtime-only; `TOOL_DEFS.length === 62` and name assertions stay green.
- **Tier-gating (D2):** feature-activation defaults are conservative (off); existing T2/T3 flows retain current behaviour via tier mapping, so no silent capability loss.
- **Each phase is independently shippable** and test-gated; CI (`npm run verify`) must stay green per phase.

## 4. Suggested execution order

1. Phase 0 (immediate, low-risk).
2. Phase 1 (foundation — deterministic partial marker + confidence model + version-bump/regenerate).
3. Phase 2 cost gate → 2A; Phase 3 in parallel; Phases 5 + 6 in parallel alongside.
4. Phase 2B (incremental, behind telemetry) + Phase 4 (after 1–3).
5. Phase 7 (last).
