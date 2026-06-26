# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.7.0] — 2026-06-18

### Removed — BREAKING

- **The entire `th proof` / operational-proof-suite feature is removed.** This is a
  breaking change for any caller that depended on the proof surface:
  - **CLI:** the `th proof run|component|report|baseline update|scenario start|finish|list`
    command group and its `--self-test`/`--brief`/`--corpus-root`/`--output-root`/`--scenario-root`
    flags are gone.
  - **MCP:** the `th_proof_run`, `th_proof_component`, and `th_proof_report` tools are
    de-registered (−3). The shipped 0.7.0 MCP registry holds **62 tools**.
  - **Producer trail:** the MCP adapter no longer writes the dedicated
    `<stateDir>/proof-calls.jsonl` call trail (the `appendProofCall` instrumentation is removed
    from `callTool`'s success and error paths).
  - **Packaging:** the `twinharness-proof` skill, the `th-proof`/`th-proof-component` command
    files, the bundled `proof/corpus/` fixtures, and `src/core/proof/**` are all deleted.
- `src/core/telemetry.ts` and `src/core/health.ts` are **retained** — they remain load-bearing
  for `th next`, `th route`, `th scorecard`, `th doctor`, and `th verify`.

---

## [Unreleased]

Post-0.6.2 infrastructure work (Phases 1–6 + SLICE-0..5 repo-understanding layer + self-epic governance + coordination-primitive hardening), not yet cut as a versioned release. **1100+ tests, green on CI** (1 platform-conditional skip in `tests/concurrency.test.ts`; was 460 at 0.6.2).

### Fixed — interactive approval read (TTY) (2026-06-26)

- **`th decision approve` / `th verify approve` now work at a real interactive terminal,
  including the Windows console.** The shared confirmation helper
  (`requireTTYConfirmation`, `src/commands/decision.ts`) previously read the y/N answer
  with `fs.readFileSync(0, "utf8")`, which reads stdin **to EOF**: on a controlling TTY,
  pressing Enter did not return (it blocked until Ctrl+D/Ctrl+Z), and on the Windows
  console the read threw outright, hitting the fail-closed `catch` so a legitimate human
  could **never** approve (barrier 1 passed on `isTTY`, barrier 2 always declined). The
  helper now reads fd 0 one byte at a time and stops at the first newline, returning on a
  single keystroke + Enter on every platform (CRLF tolerated; EOF without a newline still
  accepted; unreadable stdin still fails closed). The real fd-0 path — previously covered
  by nothing, since every test injects `stdinLine` — is now pinned by
  `tests/tty-interactive-read.test.ts` (compiled-handler subprocess with a hard timeout
  that turns the old EOF-block into a deterministic failure).
- **Approval provenance now records the parent command name on Windows and macOS.**
  `readParentComm` was Linux-only (`/proc/<ppid>/comm`), so the sealed
  `provenance.parentComm` forensic field was empty on the platforms where the read bug bit
  hardest. It now falls back to `tasklist` (Windows) / `ps -o comm=` (macOS/BSD),
  best-effort and non-fatal (any failure → `"unknown"`; provenance is forensic, not a gate).

### UX/UI designer split — new Stage 4a UX (2026-06-17)

- **`agents/ui-designer.md` renamed to `agents/ux-ui-designer.md`** (history preserved via
  `git mv`). One agent now runs two ordered, fresh-context design stages when the project has a
  UI: **Stage 4a — UX** produces `docs/04a-ux-design.md` (UX research, personas/journeys,
  information architecture, task flows) with its own taste-driven human direction gate, then
  **Stage 4b — UI** produces `docs/04b-ui-design.md` (visual direction, screens, wireframes,
  tokens) as before. The agent routes to **opus**.
- **New `ux-design` stage + cascade.** `STAGE_PIPELINE` (`src/core/stages.ts`) gains a `ux-design`
  row (`produces: docs/04a-ux-design.md`, `criticMode: ux-design`, `humanGate: true`,
  `tiers: T1/T2/T3`) between `architecture` and `ui-design`; `ARTIFACT_PIPELINE`
  (`src/core/pipeline.ts`) inserts `docs/04a-ux-design.md` between `docs/04-architecture.md` and
  `docs/04b-ui-design.md` so staleness cascades 04a → 04b → downstream.
- **New `ux-design` Critic mode** (`skills/twinharness/reference/critic-modes-design.md` +
  index) and a new artifact skeleton `templates/04a-ux-design.md`. Live references to the old
  `ui-designer` agent name were updated across the skill/spec/template docs.

### PR #14 code-review remediation (2026-06-16)

- **`th build plan` exit code `7` is a documented, test-locked contract (finding #6).** When the
  slice `depends_on` graph is unsatisfiable — a dependency **cycle** (no valid wave order) or a
  **dangling** reference (a dep on an unknown slice that can never complete) — `runBuildPlan`
  (`src/commands/build.ts`) returns `failure({ exitCode: 7, error: "dependency_graph_unsatisfiable" })`
  while still emitting the full plan data so `--json`/MCP consumers see both at once. This exit code
  is now an explicit part of the CLI contract (alongside `th repo check`'s 0/4/5/1 taxonomy) and is
  regression-locked by `tests/schedule.test.ts`; the MCP adapter surfaces it verbatim in
  `structuredContent.exitCode` (`tests/mcp-adapter.test.ts`). No behavior change — documentation +
  test coverage of already-shipped behavior.

- **`structuredContent.exitCode` is a reserved key with deterministic precedence (finding #5).** In
  `toToolResult` (`src/mcp-server.ts`) the envelope `CommandResult.exitCode` is spread **last**, so it
  always wins over any `exitCode` a future command might nest inside `result.data`; a nested
  `data.exitCode` can never silently shadow the real process exit code. No command nests `exitCode`
  today (latent/forward-looking guard) — pinned by a characterization test so the precedence can't
  regress.

- **Repo-scanner anchor scope is a documented, pinned contract (finding #2, ADR-004).** The
  bounded-cost single walk (`src/core/repo-map/scanner.ts`) collects a REQ-ID anchor only from
  in-scope files: a REQ-ID present ONLY in an oversize file (`> MAX_READ_BYTES`) or ONLY under a
  generated/producer directory is INTENTIONALLY excluded. The docstring's implied "byte-identical to
  an uncapped two-pass" equivalence is corrected to make the exclusion explicit (it upholds PERF-001
  + REQ-NFR-001). New `tests/scanner-anchor-scope.test.ts` golden pins the generated/producer
  exclusion (oversize was already pinned by `tests/repo-bounded-cost.test.ts`). Decision recorded in
  `docs/05-adrs/ADR-004`. No behavior change.

- **`sleepSync` uses a single module-level lock word + a no-throw bounded fallback (finding #7, PERF-007).**
  `src/core/sleep.ts` previously allocated a fresh `Int32Array(new SharedArrayBuffer(4))` on **every**
  call — GC churn during the exact contention burst PERF-007/008 keep cheap, since it is called once
  per failed attempt inside `withStateLock` (`src/core/state-store.ts`) and the atomic-io retry loops.
  The lock word is never signalled (always `0`), so it is now allocated **exactly once** at module
  load as a shared singleton. The allocation is also guarded: on a hardened / non-cross-origin-isolated
  runtime where `SharedArrayBuffer` is absent the constructor THROWS, and because `withStateLock` does
  not wrap `sleepSync`, that turned a recoverable contention wait into an uncaught raw stack instead of
  a `LockTimeoutError`. The word is now built in a `try/catch` IIFE (`null` on failure) so **importing
  the module can never throw**, and `sleepSync` **can never throw**: if the word is `null` or
  `Atomics.wait` throws at call time it falls through to a bounded `while (Date.now() < until)` spin
  that still returns after ~`ms`. That fallback reintroduces CPU spin **only** on those hardened
  runtimes (correctness over a raw throw); the zero-CPU `Atomics.wait` path is **unchanged everywhere
  it works**, and the behavioral contract is identical (non-finite/≤0 returns immediately; real
  durations are honored and accumulate). New tests in `tests/sleep.test.ts` pin both guarantees
  (no-throw when `Atomics.wait` throws, no-throw on the absent-`SharedArrayBuffer` null-word path) and
  the singleton (the `SharedArrayBuffer` constructor is not invoked per call).

- **Coverage test-file recognition residuals accepted + pinned (finding #4, ADR-005).** Two GOV-1
  edges in `isRecognizedTestFile` (`src/core/coverage.ts`) are ACCEPTED rather than tightened: (a) the
  path rule counts a fixture/prose file under a NESTED test-named dir as "tested" (a safe false
  positive — tightening would under-count legitimately-named tests under `tests/`); (b) a
  `*.test.d.ts` declaration file is not name-recognized (correct — a declaration has no runtime
  assertions). Both are documented in the predicate and pinned by a table test in
  `tests/coverage.test.ts`. Decision recorded in `docs/05-adrs/ADR-005`. No behavior change.

### Added (PR #14 review remediation — GOV-2 ledger hardening, 2026-06-16)

- **Opt-in HMAC keyed seal for the gate ledger (finding #8, SECURITY).** Mirroring the decision
  ledger, `core/ledger.ts` gains `computeLedgerKeyedHash` + `verifyLedgerSeals` (warn-only) and
  `appendLedger` now attaches an HMAC `keyedHash` over each entry's canonical text **when
  `TH_LEDGER_KEY` is set** (a NEW env, a separate trust domain from `TH_DECISION_KEY`; never
  auto-generated; an unset/empty key seals nothing). `keyedHash` is excluded from the canonical text,
  so the keyless `recordHash`/chain is **byte-identical** with or without a key — legacy ledgers stay
  fully back-compatible. The seal catches an attacker who re-hashes the keyless chain after editing a
  field but cannot forge the HMAC without the key. `th doctor` adds a `ledger seals` check
  (WARN-only, even under `--strict`, so a wrong/missing key never turns a committed ledger red).

- **Sealed in-chain high-water anchor (finding #8).** `appendHighWater` writes a sealed
  `{ event:"high-water", count:N }` entry (N = sealed entries before it) into the hash chain itself —
  re-homed from the rejected UNSEALED `state.json` counter (ADR-001 sidecar precedent). It is emitted
  after a `gate-state-change` flip. Editing/reordering/mid-deleting it breaks `verifyLedgerChain` like
  any sealed entry. **Documented residual:** it does NOT detect tail truncation — the chain walk is
  length-agnostic, so a truncated tail is a valid prefix (`verifyLedgerChain` → `ok`); a negative
  characterization test pins this so no future reader mistakes the anchor for truncation closure, and
  the design deliberately avoids a circular `count <= length` "regression" check. `th doctor` counts
  anchors separately from gate-mutation entries.

### Changed (PR #14 review remediation — dev toolchain, 2026-06-16)

- **vitest 3 → 4; Node floor raised to >= 20 (finding #16).** Bumps `vitest` to `^4`, clearing 5
  dev-chain CVEs (vite → nested esbuild: RCE via `NPM_CONFIG_REGISTRY`, and the Windows dev-server
  arbitrary-file-read) that surfaced in `npm audit` — `npm audit` now reports **0 vulnerabilities**.
  These never shipped: vitest is `devDependencies` only and the runtime bundle is `tsc + esbuild`,
  so `dist/` is byte-unchanged by this bump. vitest 4 requires Node `>= 20`, so `engines.node` is
  raised `>=18` → `>=20` (Node 18 is EOL since 2025-04) and the README prerequisite/badge follow.
  `vitest.config.ts` gains a 15s default `testTimeout`/`hookTimeout`: vitest 4's heavier per-run
  import phase overlaps with execution, so the first real-subprocess test (`runCLI` spawning a cold
  `node dist/cli.js`) could exceed the old 5s default under full-suite load — a false-red (it passes
  in isolation), not a product change. Full suite green ×2 under v4 (1363 pass / 1 skip); rollback is
  a single-commit revert of `package.json` + `package-lock.json` + `vitest.config.ts`.

### Fixed (audit remediation, 2026-06-16)

- **`th verify`/coverage-report tests are now genuinely cross-platform.** `tests/verify.test.ts`
  and `tests/coverage-report.test.ts` previously invoked POSIX `true`/`false`/`sleep` via
  `runCommands` (`spawnSync(shell: true)` → `cmd.exe` on Windows), so they only passed when Git
  Bash's coreutils happened to be on PATH and *failed* on a bare-Windows runner. The docs
  previously mis-described them as platform skips — they were never skips at all. The commands are
  now portable `node -e "…"` stand-ins that resolve on every OS, and the docs (README, this file)
  are corrected to the real state: **1 platform-conditional skip**.

- **Documented the single intentional test skip.** `tests/concurrency.test.ts:142`
  (`it.skipIf(win32 || uid === 0)`) is the suite's only skip — a POSIX-only permission-error case
  that Windows and root cannot reproduce. It is intentional and covered on Linux/macOS CI; a
  doc-truth guard now asserts the suite has exactly one skip declaration and that the docs no
  longer claim the stale "N Windows-only platform skips".

- **`th build plan` now emits a dependency-respecting wave order (ARCH-001).** `scheduleWaves`
  (`src/core/schedule.ts`) was dependency-blind — it serialized slices only on shared-component
  overlap and ignored `depends_on`, so a slice could be planned in the same or an earlier wave than
  a slice it hard-depends on. It is now dependency-aware: a slice's wave index is strictly greater
  than the max wave index of its `depends_on`, in addition to the existing component-conflict rule.
  `runBuildPlan` (`src/commands/build.ts`) overlays `validateDeps` to surface dependency cycles and
  dangling references. `scheduleWaves` (static plan) and `computeWave` (live dispatch) remain
  deliberately distinct. Pure/deterministic; new `tests/schedule.test.ts` coverage.

- **Bounded REQ-anchor scan restores the BOUNDED-COST guarantee (PERF-001).** `scanDirForReqIds`
  (`src/core/anchors.ts`) previously `readFileSync`-read every regular file with no size, count, or
  byte cap, defeating the advertised bound on a large repo. It now gates each read behind the
  scanner's existing per-file byte cap and honors the file-count / total-byte caps and exclusions,
  so an oversize/binary file is skipped and the scan returns its capped (PARTIAL) result. Guarded by
  a path-agnostic `tests/repo-bounded-cost.test.ts` asserting "bytes read ≤ cap" at the `scanRepo`
  boundary.

- **Cross-process state lock no longer CPU-pegs while waiting (PERF-007).** The lock acquisition
  path (`src/core/state-store.ts`) and the atomic write/read retry path (`src/core/atomic-io.ts`)
  busy-waited (`while (Date.now() < until) {}`), spinning a full core during contention. Both now
  use a shared zero-CPU `sleepSync` (`src/core/sleep.ts`) built on `Atomics.wait` over a
  `SharedArrayBuffer`-backed `Int32Array`. Wait durations and all lock/retry semantics are
  unchanged; the duplicated busy-wait is retired. New `tests/sleep.test.ts`; concurrency serialization
  unchanged.

- **`blast_radius_flags` is now gate-owned (GOV-4) — documented behavior change.** The Tier-0 veto
  floor `blast_radius_flags` was writable by an agent over MCP `th_state_set`, contradicting
  `SECURITY.md`. It is now in `GATE_OWNED` (`src/core/state-fields.ts`), so MCP `th_state_set
  blast_radius_flags …` is **refused** with `error:"gate_owned_field"` (was `ok:true`). The CLI
  `th state set blast_radius_flags …` — the only legitimate write path — is unaffected.

- **MCP server version is single-sourced from `package.json` (ARCH-006 / CQ-004 / PKG-007).**
  `src/mcp-server.ts` advertised a hardcoded `SERVER_VERSION = "0.6.2"` literal that could silently
  desync from the dynamic CLI version on a bump. It now reads `package.json` at runtime via
  `readServerVersion()`, mirroring the CLI's `readCliVersion()` (same candidate resolution, zero
  runtime deps). `tests/version-sync.test.ts` asserts the served version equals `package.json`.

- **`th coverage check` "tested" dimension now requires a real test file (GOV-1) — behavior change.**
  `collectDirReqIds` (`src/core/coverage.ts`) counted a REQ-ID as tested if its anchor appeared in
  *any* file, so a prose/README/fixture anchor under `tests/` could satisfy the gate with no real
  test. The tested dimension now counts a REQ-ID only when its anchor lives in a recognized test
  file (`*.test.*` / `*.spec.*` / `*_test.*` / `test_*.*`, or under a `tests/`/`__tests__/`/`spec/`
  dir); the requirement and implementation dimensions are unchanged. Execution truth remains
  `th verify run` + the stop-gate. New probe tests in `tests/coverage.test.ts`; USAGE clarified.

- **Opt-in `write_gate: "strict"` fail-closed on invalid state (GOV-3).** The PreToolUse write-gate
  historically *failed open* on present-but-invalid `state.json` (allow + "standing down" warning),
  while the stop-gate fails closed. A new opt-in branch (`src/commands/hook.ts`) **denies** the write
  when state is present-but-invalid **and** the raw bytes carry top-level `write_gate: "strict"`.
  Default/`ask`/`deny`/`off` modes are **unchanged** (still fail open) — no breaking change. New
  `tests/write-gate-strict.test.ts`; the ~56-case pretool-gate negative suite stays green.

- **Corrected `SECURITY.md` claims (SEC-001, GOV-2).** Two published claims were inaccurate:
  (1) the repo-map "no secrets persisted" claim — `.twinharness/repo-map.json` in fact persists
  **verbatim candidate-command strings** (the committed `docs/00-repo-map.md` emits only a count);
  the stale "No file contents, no secrets, and no absolute paths are written to disk" clause is
  removed and replaced with the accurate enumeration. (2) the gate-ledger "primary accountability
  mechanism" claim — `gate-ledger.jsonl` is a plain append-only log and is **not tamper-evident**
  (unlike the SHA-256 hash-chained `decisions.jsonl`); the claim is softened to "best-effort review
  aid." A falsifiable `tests/security-doc-lint.test.ts` pins the corrected text and the absence of
  the stale claims. *(The gate-ledger hash-chain itself is a post-1.0 follow-up — **now landed, see Phase 3 below**.)*

#### Phase 3 — maintainability / performance dedup + remaining Mediums (2026-06-16)

- **Single capped repo-map walk (PERF-003/004, subsumes PERF-001).** `scanRepo` did two
  tree walks (a main walk + a separate REQ-anchor re-read of every file); they are now one
  walk that reads each file at most once (under the per-file byte cap) and derives anchors
  + manifest data from that single buffer. Verified byte-identical to the prior two-pass
  output on the real repo (211 702 bytes / 463 files / 359 anchors); new read-once + golden
  byte-stability tests guard it.
- **O(N) decision-ledger appends (PERF-009).** `appendDecisionEvent` re-read and re-parsed
  the entire hash-chained ledger on every append (O(N²)); it now derives `prevHash` from a
  tail read (last valid line only). `next.ts` reads the decision ledger once per command.
  Chain bytes/integrity unchanged.
- **Explicit lease serialization order + canonical byte-stability test (ARCH-004).** The
  lease ledger's implicit `{ts,…event}` key order is now an explicit `LEASE_FIELD_ORDER`
  (byte-identical to before); a new round-trip test pins canonical byte-stability across
  every optional field for the state / decision / lease serializers.
- **Gate-ledger is now tamper-evident (GOV-2).** `gate-ledger.jsonl` is SHA-256 hash-chained
  like `decisions.jsonl` (per-entry `recordHash`/`prevHash`, ts sealed). `th doctor` verifies
  the chain — a warning by default, a hard fail under `th doctor --strict`. Back-compat:
  pre-migration unsealed lines are an unverifiable prefix, not a tamper signal. `SECURITY.md`
  is **re-elevated** to "tamper-evident", with three honest limits (legacy prefix; keyless
  full-rewrite; wholesale deletion of the sealed run); the doc lint is flipped accordingly.
  *(This supersedes the post-1.0 note above.)*
- **Dedup cluster (CQ-001/002/003/005/006/007).** Extracted a shared append-only markdown-
  ledger module behind drift-log/debate-log (byte-identical output); deleted dead
  `findDecision`; migrated byte-identical `requireState` sites; extracted `loadPersistedMap`;
  decomposed the 679-line `runHookPretoolGate` write-gate into behavior-identical phase-gate
  helpers (all gate negative-suites green).
- **Boundary / coupling fixes (ARCH-002/003/005/007).** Typed `PathContainmentError` mapped
  to a structured `--json` failure (exit 2) at the CLI boundary (no more raw stacks, e.g.
  `th collab fragment --name "../x"`); the MCP adapter now carries the numeric `exitCode` in
  `structuredContent`; the state validator warns on unknown top-level keys (non-fatal); the
  repo-map freshness/exit-code taxonomy moved into `core/repo-map/freshness.ts`. Also fixed a
  verify-report flake: `writeVerifyReport` is now atomic and `readVerifyReport` retries
  transient contention (a present report no longer reads as absent under load).
- **Lock fairness + oversized docs (PERF-008, PERF-002, DOC-004..007).** The state-lock retry
  uses full-jitter exponential backoff (≤80 ms) instead of a fixed 20 ms wait (no thundering
  herd; zero-CPU `Atomics.wait`; lock semantics unchanged). Split `critic-modes.md` (819→index
  +3 parts) and `pipeline-stages.md` (637→index+4 parts) under the ~500-line budget; added the
  missing README group rows and USAGE state-field / exit-code / hook-wiring tables.
- **Test hardening (TEST-004..009).** BYPASS-KNOWN write-gate regression suite; build-artifact
  guards `skipIf` instead of throwing; bounded polls / deterministic timeouts; coordination
  prose-grep suites labelled `DOC-LINT`; `STALE_MS` imported rather than hardcoded.

#### Phase 4 — cross-OS CI + dependency posture + batched lows (2026-06-16)

- **Cross-OS CI matrix (TEST-002 follow-through).** GitHub Actions runs build + dist-sync +
  the suite + a `th version` smoke on Linux / macOS / Windows, all under `shell: pwsh` so the
  de-POSIX-ified tests are exercised without Git Bash.
- **Dependency-audit posture (SEC-002/003).** The shipped/production tree is clean
  (`npm audit --omit=dev` → 0). CI adds an informational full-tree audit that surfaces the 5
  dev-toolchain highs (vite/vitest → nested esbuild) and the bundled `@modelcontextprotocol/sdk`
  without failing the build — those advisories do **not** ship, and clearing them requires a
  breaking vitest 4 migration tracked as a separate follow-up.
- **Batched low-severity cleanups (TEST-010/011, CQ-010/011/013).** `TH_NO_LOG=1` in vitest
  global setup (removes ~1200 telemetry log lines from test output); required-doc existence is
  now asserted (not silently skipped); `readFileOrUndefined` deduped; dead `allInProgress`
  dropped; stale lock-timeout comment corrected.

### Added (coordination-primitive hardening, 2026-06-15)

- **Decision obligations block completion (RULE-007).** The Stop-gate (`evaluateStopGate`,
  `src/commands/hook.ts`) now refuses completion while an unapproved decision gates the current
  stage, mirroring the existing open-drift and open-debate blocks. It reuses the single
  `gatingObligations(reduceDecisions(readDecisionEvents()))` predicate that `th next` already
  uses, so the stop-gate and the next-action oracle can never disagree. Tolerant of a missing
  ledger / absent `current_stage`; Tier-0 and non-decision runs are unaffected.

- **MCP coordination-primitive tools.** Twelve new MCP tools wrap existing CLI handlers verbatim:
  `th_build_dispatch`, `th_build_plan`, `th_artifact_claim`/`th_artifact_release`/`th_artifact_leases`,
  `th_collab_init`/`th_collab_fragment`/`th_collab_list`/`th_collab_merge`, and
  `th_debate_add`/`th_debate_list`/`th_debate_resolve`. MCP tool count: 23 → 35. The adapter stays
  a thin pass-through (no command logic added); `th_decision_approve` remains permanently absent
  (decision approval is a human gate, never an MCP tool).

- **Brownfield repo-map FRESHNESS gate (not just existence).** `brownfieldPrerequisite`
  (`src/commands/tier.ts`) now delegates to the `th repo check` freshness oracle (`runRepoCheck`)
  instead of a bare `existsSync`. A STALE repo-map (drifted from the working tree) now hard-vetoes
  `th tier veto-check` (exit 3, `brownfield_repo_map_stale`) exactly as a MISSING one does, and is
  surfaced as a `brownfield_prerequisite_stale` advisory by `th tier classify`. `th next` emits a
  new `refresh-repo-map` obligation when a brownfield run has a stale/absent map — guarded to
  pre-implementation only (`!implementation_allowed`) so an in-flight build, whose own writes
  naturally stale the map, never deadlocks.

- **Collision-safe `th collab fragment`.** `writeFragment` (`src/core/collab.ts`) now refuses to
  overwrite an existing fragment unless `--force` is passed, throwing a distinct `FragmentExistsError`
  that the command layer converts to a `fragment_exists` failure. Path-traversal validation errors
  keep propagating as throws (unchanged security behavior). Exposed via the `force` flag on the CLI
  and the `th_collab_fragment` MCP tool.

- **`th next` prefers `th build dispatch`.** The `dispatch-wave` obligation now recommends the
  single-payload `th build dispatch` (per-slice model/effort in one spawn set) as the primary
  command, while keeping the still-required per-slice `in-progress` + `th build claim` steps
  (dispatch is read-only and does not mutate state).

### Added (self-epic — governance, stale-detection & MCP parity, 2026-06-15)

- **MCP sub-lease parity (REQ-101..105).** `th_build_sub_claim` and `th_build_sub_release` are
  now registered MCP tools, wrapping the existing `runBuildSubClaim`/`runBuildSubRelease`
  handlers verbatim. Input schemas are `{ parentSlice, components }` and `{ subId }` respectively
  (`additionalProperties: false`). Agents driving TwinHarness over MCP now have the same
  component sub-lease capability as CLI Builders. MCP tool count: 16 → 18 (IF-009, IF-010).

- **`th repo check` — repo-map staleness detection (REQ-201..206).** A new `th repo check`
  subcommand (`runRepoCheck`, `src/commands/repo.ts`) compares `.twinharness/repo-map.json`
  against the live working tree using per-file SHA-256 content hashes. Exit codes: 0 = fresh,
  4 = stale (files added/removed/modified), 5 = no map, 1 = parse failure.
  `--json` output reports `{ fresh, shape, added[], removed[], modified[] }`. When `fileHashes`
  is absent from an older map, the command returns stale with `reason: "no_hashes"` (conservative
  graceful degradation, ADR-002). `runRepoMap` was extended to populate the new additive
  `fileHashes` field on `RepoMap` (map-level `Record<string, string>`, serialized only when
  non-empty — REQ-NFR-004). Exposed as `th_repo_check` MCP tool. MCP tool count: 18 → 19 (IF-001, IF-011, DS-002).

- **Brownfield tiering prerequisite gate (REQ-301..305).** `th tier veto-check` now refuses
  (exit 3, `brownfield_prerequisite_missing`) on a brownfield run (`project_mode === "brownfield"`)
  that is missing either `.twinharness/repo-map.json` or `docs/00-existing-codebase-analysis.md`.
  The structured error lists the absent artifact(s) by canonical path. `th tier classify` surfaces
  the same check as an advisory signal (exits 0 with `brownfield_prerequisite_missing` field).
  Greenfield and uninitialized runs are byte-identical to pre-epic behavior (REQ-304). Implemented
  via a `brownfieldPrerequisite` helper in `src/commands/tier.ts` using the existing `readState`
  function (IF-007).

- **Decision governance — `th decision detect|add|approve|check|list` (REQ-401..408/412/413).**
  A new decision-governance subsystem records, human-approves, and enforces significant run
  choices with tamper-evident durability:
  - **`src/core/decisions.ts`** — new core module: append-only JSONL event log at
    `.twinharness/decisions.jsonl`, SHA-256 hash-chained (ADR-001), reduced latest-event-wins
    per id into current `Decision` state. Mirrors the `src/core/leases.ts` sidecar pattern.
    Single source of truth for governance via `gatingObligations` (RULE-007).
  - **`th decision add`** — records a `proposed` decision with `title`, `rationale`, `links`,
    and proposer attribution; mints a stable `DECISION-NNN` id; never auto-approves (REQ-402).
  - **`th decision approve`** — human-only CLI gate (RULE-011); permanently absent from MCP.
    Enforces a two-layer barrier: (1) interactive-TTY confirmation — aborts in any agent shell,
    CI pipeline, or pipe (`no_tty`); (2) interactive `y/N` prompt (`confirmation_declined`).
    No `--yes` bypass (ADR-003, ratified 2026-06-15). Supports `--reject` and `--supersede`.
    Verifies the hash-chain tail before every append (`chain_broken` on failure — DRIFT-011).
  - **`th decision check`** — exits 6 (`DECISION_GATE_EXIT`) while any unapproved decision is
    linked to the current stage via `stage:<current_stage>` (canonical form — DRIFT-012).
  - **`th decision detect`** — advisory, read-only; surfaces candidate decisions from ADR files,
    drift log, scope-change markers, and blast-radius flags (REQ-405, RULE-006).
  - **`th decision list`** — returns all decisions (reduced, sorted by id) for orchestrator and
    `th next` consumption (REQ-406).

- **`th next` decision-obligation rung (REQ-501..504).** `runNext` gains a
  `resolve-decision-obligation` rung inserted after `classify-tier` and before `produce-artifact`.
  When any unapproved decision is linked to the current stage, `th next` returns
  `{ kind: "resolve-decision-obligation", action: "Approve DECISION-NNN ..." }`. The obligation
  is derived from the same `gatingObligations` predicate as `th decision check` (RULE-007) so
  the two cannot disagree. When no obligation exists, `th next` output is byte-for-byte unchanged
  (REQ-504, IF-008, DS-003).

- **Seven new MCP tools registered (REQ-408, INV-005).** `th_decision_detect`,
  `th_decision_add`, `th_decision_check`, and `th_decision_list` are appended to `TOOL_DEFS`
  (count 19 → 23; IF-012..IF-015). `th_decision_approve` is deliberately and permanently absent.
  Intermediate tool count after this step: 23. Verified by `tests/mcp-adapter.test.ts` and
  `tests/mcp-parity.test.ts`.

### Added (earlier post-0.6.2 work)

- **`th delegate` — Context Preservation / Delegation Layer (Phase 6).** A mechanical delegate-vs-keep-main oracle (`th delegate plan`) from intent/file-count/writes/noisy signals, a bounded child-agent handoff assembler (`th delegate pack`, reusing `th context pack` for a slice), the strict Delegation Capsule skeleton (`th delegate capsule`), and a presence-only capsule validator (`th delegate check`). Exposed as the MCP tools `th_delegate_plan` / `th_delegate_pack` / `th_delegate_check`. Keeps the main Orchestrator context a control-plane resource — heavy reads/edits/debugging/reviews/inspection are delegated to child agents that return a compact capsule, with long-form detail in `.twinharness/delegations/DEL-###/`. Read-only; no `state.json` mutation; CLI stays zero-runtime-dependency.
- **`th repo` — deterministic repo-understanding layer (SLICE-0..5).** Three CLI commands and four MCP tools give brownfield TwinHarness runs a mechanical spine for adopting an existing codebase (REQ-RU-001..096):
  - `th repo map [--write|--no-write] [--format <summary|json|md>]` — scans the repo; writes `.twinharness/repo-map.json` (byte-stable, versioned, `schema_version: 1`) and `docs/00-repo-map.md` (compact human summary). Bare invocation writes; `--no-write` is dry/preview. Deterministic: two runs on an unchanged repo are byte-identical.
  - `th repo relevant (--slice | --req | --file | --query) [--maxResults <n>]` — precision context retrieval over the persisted map: read-first files, related files, tests, owning components, do-not-touch paths, blast-radius risks, verify candidates — each with a WHY. Read-only.
  - `th repo impact (--file | --component)` — pre-edit blast-radius analysis: impacted components, related tests, downstream features, REQ anchors, risk flags, verify candidates. Reads the persisted map; reads no state.
  - Four MCP tools (`th_repo_map`, `th_repo_relevant`, `th_repo_impact`, `th_context_pack`) registered in `dist/mcp-server.js` as thin one-liner adapters over the same handlers (tool count 9 → 16 with the delegate layer; REQ-RU-044..052).
  - The layer treats all repository content as untrusted data: candidate build/test commands are recorded as inert strings and never executed (RULE-004; sentinel-verified in `tests/repo.test.ts`). All user-supplied paths are root-contained via `resolveWithinRoot`. No network I/O. No timestamps or absolute paths in the persisted map.
- **`th route` — automatic model/effort routing (Phase 2).** A mechanical routing oracle recording the recommended model/effort per stage; surfaced as a Routing line in `th scorecard`.
- **`th` as a plugin-scoped MCP server (Phase 4).** `dist/mcp-server.js` exposes the CLI's read/compute surface as MCP tools (`th_next`, `th_build_claim`, …); the CLI itself stays zero-runtime-dependency.
- **Component sub-leases (Phase 5).** `th build sub-claim` / `sub-release` scope a sub-Builder to a subset of an in-progress parent slice's components, nested under the parent's top-level lease and guarded against overlapping siblings.
- **`th next --explain` (Phase 5).** Adds a WHY rationale to the next-action oracle, explaining why the chosen obligation outranks the others.
- **SubagentStop hook (Phase 3).** A narrow state-validity guard at every delegated-subagent boundary (`th hook subagent-stop`), distinct from the completion Stop-gate.

### Changed

- **Phase 1 hardening:** shared command guards, a table-driven arg parser, the DOC-TRUTH test suite (docs are checked against mechanical reality), and a CI matrix.

### Fixed

- **`th next` now mirrors the final-verification verify-suite gate.** At `final-verification`, when verify commands are configured but `th verify run` has never been recorded, `th next` surfaces a new `run-verify` obligation — matching what the Stop-gate (`evaluateStopGate`) already blocks completion on. (A red suite was already surfaced as `investigate-failure`.)
- **`th build claim` requires the slice to be `in-progress`.** A claim on a `pending`/`done`/`blocked` slice is now refused (`slice_not_in_progress`), mirroring `th build sub-claim`'s parent check and the Phase-B write-gate. The documented protocol has always been "set in-progress, then claim."
- **`strict` write-gate wording reconciled.** The README feature bullet and the published JSON Schema described `strict` as only adding Phase-B Bash enforcement; both now state the full definition — `deny` semantics **plus** Phase-B Bash-mediated-write enforcement (a superset of `deny`) — matching the changelog, spec, and code. `strict` is also now listed in the README and USAGE write-gate mode tables.
- **Flaky verify tests.** Both `REQ-VERIFY-005` cases used a tight 150 ms command budget that intermittently failed under full-suite parallel load (a real shell spawn needs more headroom): the "fast command" case now uses the default budget, and the timeout-kill case uses a load-robust 2 s budget. Both pass deterministically.

## [0.6.2] — 2026-06-14

Gap-remediation release: end-to-end test coverage, write-gate hardening, a product surface (preview/scorecard/telemetry), brownfield support, release automation, and contributor DX. **460 tests** (was 413).

### Added

- **Brownfield support (G5).** `th init --brownfield` records `project_mode: "brownfield"`; a new on-demand **Codebase-Inspector** agent (the 10th agent) maps an existing repo into `docs/00-existing-codebase-analysis.md`. In brownfield mode Slice 0 becomes a characterization test around the adoption seam, the architecture overlays existing components, and the Builder reuses code that already satisfies a requirement instead of reimplementing it.
- **`th preview [--tier T<n>]` (G6).** Pre-run view of the engaged stages for a tier — human gates, Critic modes, and a stages/gates/reviews summary.
- **`th scorecard` (G7).** Read-only one-screen post-run summary: tier/stage, coverage, slice progress, suite status, drift, and revise escalations (`--json` for the structured form).
- **`th telemetry on|off|status` (G7).** Opt-in, **local-only** run telemetry (`<stateDir>/telemetry.{json,jsonl}`); off by default, never makes a network call, and `th scorecard` appends a snapshot only when enabled.
- **`write_gate: "strict"` mode (G4).** `deny` semantics plus conservative Phase-B Bash-mediated-write enforcement of the §16 component-boundary rule — narrows, does not close, the documented Bash bypass (here-docs/subshells/variable-indirection/globbing remain unparsed).
- **Release automation (G8).** `.github/workflows/release.yml` cuts a GitHub Release from a pushed `v*` tag, using the matching `CHANGELOG.md` section as the body.
- **Contributor DX (G9).** `npm run verify` one-shot gate (typecheck → build → test → dist-sync), a zero-dependency `core.hooksPath` pre-commit hook (rebuild-dist guard + typecheck, no new dependency), and GitHub issue/PR templates.
- **Deterministic end-to-end orchestration test (G3)** (`tests/orchestration-e2e.test.ts`): drives a full run — init → tier → artifact → slices → build waves → write-gate → coverage → final-verification stop-gate — through the CLI, with no LLM.

### Changed

- **Claude Code version pin (G10, documentation-only).** `.claude-plugin/plugin.json` declares `metadata.requiresClaudeCode` (`>=1.0.0`; hook + agent schema v1); `th doctor` echoes it as a non-fatal compatibility note that never changes the exit code.
- Agent count 9 → 10 (added Codebase-Inspector). Optional `project_mode` and the `strict` `write_gate` value were added to the state schema and the published JSON Schema — both additive, so existing artifact hashes are unaffected (no migration).

### Removed

- **Bundled worked examples** (`examples/autocoder/`, `examples/twinrunner/`) removed from the repository. They were development-reference artifacts, not part of the installed plugin (never in `package.json` `files` or the plugin manifest), so installs are unaffected. Examples will be regenerated from real end-to-end runs.

## [0.6.1] — 2026-06-13

Robustness hardening from a self-audit of the 0.6.0 coordination features. **413 tests** (was 392).

### Fixed

- **Stale component leases could wedge the build (§16).** A Builder that crashed (or a forgotten `th build release`) between `claim` and release left a lease holding components forever, blocking every overlapping/dependent slice. Leases now reconcile against slice state: a lease whose owning slice is `done`/`blocked`/missing is **stale** and ignored by `th build next-wave` and `th build claim`. `th slice set-status <id> done|blocked` **auto-releases** the slice's lease, `th build leases` lists the stale set separately, and `th doctor` warns on stale leases.
- **Dependency deadlocks were silent.** A `depends_on` cycle, a dangling reference, or a dep on a never-finishing slice left `th build next-wave` returning an empty wave forever while `th next` cheerily said "dispatch the next wave". `next-wave` now detects an unsatisfiable graph (cycle/dangling) and a **stall** (pending slices, nothing dispatchable, nothing in progress) and reports it; `th next` surfaces a new `stalled-build` obligation; `th doctor` validates the `depends_on` graph.
- **`th verify run` could hang forever.** A configured command that blocks (watch mode, server, stdin wait, deadlocked test) had no timeout. Each command now runs under a wall-clock budget (`DEFAULT_COMMAND_TIMEOUT_MS`, 5 min) with stdin closed; a timed-out command is killed and recorded as a failure so the run always terminates.
- **Research artifacts didn't affect downstream staleness.** `docs/00-research/` (and `docs/04b-ui-design.md`) were absent from the cascade graph, so correcting research never flagged requirements/architecture/contracts as stale. Both are now in `ARTIFACT_PIPELINE`; `docs/00-research` is the most-upstream artifact, so a change to it cascades to everything.

### Changed

- **Final-verification stop-gate now requires a green suite when one is configured.** If verify commands are set, `evaluateStopGate` blocks completion at `final-verification` when the last `th verify run` is missing or red. When no commands are configured the check is inert; the CLI still doesn't *certify* correctness (tests + human do) — it just refuses to let a run claim done with a known-red or never-run suite.

## [0.6.0] — 2026-06-13

### Added

- **Debugger agent (`agents/debugger.md`) + `th debug`:** an on-demand, fresh-context, evidence-first defect tracer invoked on a failing suite, an ungrounded Critic defect, or a behavior↔contract contradiction. `th debug pack [--slice ID | --req REQ]` assembles a deterministic evidence bundle (failing commands + output tails, slice/REQ anchors, recent drift, open findings); `th debug log add|list` is an append-only evidence ledger (`debug-log.md`, mirroring `drift-log.md`). New Critic mode `debug-review` rejects an unanchored root cause, a fix that crosses component boundaries, or a silent requirement contradiction. The Debugger proposes and proves; the Builder fixes; tests + human certify correctness.
- **Researcher agent (`agents/researcher.md`):** an on-demand, **conditional** information-gatherer the Orchestrator invokes only when a project needs unfamiliar external knowledge. It scopes questions to REQ-IDs, gathers via web search/fetch, cites every claim, separates fact from opinion, adversarially verifies, and emits `docs/00-research/<topic>.md` (a directory artifact). New Critic mode `research` fails uncited/fabricated claims, stale version-sensitive facts, and findings that bear on no REQ-ID. Fetched content is treated as untrusted data (see SECURITY.md).
- **Live build coordination — `th build next-wave|claim|release|leases`:** `next-wave` is the live oracle for the slices dispatchable in parallel *right now* (status pending, `depends_on` done, components free of in-progress slices and active leases). `claim`/`release` are dynamic **component leases** (`build-leases.jsonl`); `claim` refuses an overlapping claim (exit 1) — the collision guard that closes the race the static plan can't see when drift expands a slice's component set mid-build. Serialized under the existing cross-process state lock.
- **Slice `depends_on`:** an optional slice field (parsed from a `Depends on: SLICE-x` line by `th slices sync`) so the wave-runner respects true ordering (walking-skeleton-then-features) beyond component disjointness. Optional and omitted when empty, so existing slices serialize byte-identically.

### Changed

- **`th next` extended** with three build-time obligations: a failing `th verify run` report → `investigate-failure` (engage the Debugger); the implementation stage with pending slices → `dispatch-wave`; with only in-flight Builders → `await-builders`.

### Security

- The Researcher fetches **untrusted external content** (a prompt-injection surface): it treats pages as data, never follows embedded instructions, never runs commands they suggest, and the `research` Critic mode flags unsupported/fabricated claims. Documented in SECURITY.md.

## [0.5.0] — 2026-06-13

### Fixed

- **ADR artifact registration (directory artifacts):** `th artifact register` now accepts a **directory** and hashes its contents deterministically, so the T3 ADR set registers as one entry keyed `docs/05-adrs` — exactly what the stage contract (`produces: docs/05-adrs/`) and the playbook already instruct (`th artifact register docs/05-adrs/ --version 1`). Previously the command rejected anything that wasn't a single file, so that documented step failed and the worked example had to register eight ADR files one by one. `th stale --artifact docs/05-adrs` now round-trips on the directory too.

### Added

- **`th coverage report`:** the planned / implemented / tested / passing breakdown per REQ-ID (a read-only status view; the hard gate stays `th coverage check`). `planned` = the REQ is in a slice, `implemented` = it is anchored in the code dir (`--code`, default `src`), `tested` = it is anchored in a test, `passing` = whole-suite, sourced from the optional `th verify run` report (`—` when none exists).
- **`th verify add|list|clear|run`:** configure and run the project's own test/check commands. `th verify run` is the single, deliberately-quarantined command that executes operator-authored commands (everything else still only records and computes); it writes a report under the state dir that `th coverage report` and `th doctor` read for the "suite green/failing" signal. Commands live in `.twinharness/verify.json`, never in `state.json`, so the state schema and its content-hash stability are untouched.
- **`th context pack [--slice <ID>]`:** mechanically assembles the §9 handoff bundle — the Summary block of every approved artifact, plus (with `--slice`) that slice's record, components, and the other slices it shares components with (§16 conflict awareness). Computes a candidate bundle; routing is still the Orchestrator's call.
- **`th next`:** the next-action **oracle** — given durable state + on-disk anchors it returns the single highest-priority mechanical obligation the run owes next (resolve blocking drift → escalate a capped revise loop → re-register a silently-changed artifact → classify the tier → produce/register the current stage's artifact → coverage gate → finish slices → human sign-off → advance the stage). Like `th stage current`, it reports a mechanical obligation; it never chooses strategy (F7 — the playbook can fall out of the post-compaction context window).

### Changed

- **`th doctor` is now a full run-health audit:** beyond environment + state validity it audits the live run — artifact integrity (on-disk hash vs the recorded approved hash, surfacing silently-edited governed docs), slice progress, coverage status, the test-suite signal, and revise-loop escalations. Findings are warnings (they inform); only a hard environment/state failure exits non-zero.
- Shared a single run-health core (`src/core/health.ts`, `src/core/coverage.ts`) behind `th doctor`, `th next`, and `th coverage report` so the audit and the oracle can never disagree about drift, slice state, or revise caps.

### Security

- **`th verify run` executes operator-authored commands** (with the shell, in the project root) — the one exception to the "records and computes; never re-runs" boundary, quarantined in `src/core/verify.ts`. It only ever runs commands a human added via `th verify add`; it never sources commands from artifact content. See `SECURITY.md`.

## [0.4.0] — 2026-06-12

### Added

- **Schema versioning + `th migrate`:** `state.json` now carries an optional `schema_version` (stamped by `th init`; legacy files are treated as v1). `th migrate` upgrades a legacy/old file forward and refuses to downgrade one written by a newer `th`.
- **`th doctor`:** self-diagnostic for environment and project health (Node version, plugin layout, state validity, schema currency, stale state-lock, open blocking drift, audit-ledger size). Exit non-zero only on a hard failure.
- **`th context estimate`:** approximates the prompt-surface token cost (~4 chars/token) across skill/agent/command files and flags any over Claude Code's ~500-line / ~5,000-token guidance — visibility for the context-budget work (F7).
- **`th stage current|describe|list`:** a mechanical per-stage contract (produces / Critic mode / human-gate) derived from the pipeline table, so the orchestrator can re-derive a stage's obligations without depending on the prose playbook surviving the context window (F7).
- **`th manifest export`:** a deterministic run snapshot aggregating state, drift entries, and the gate ledger into one stable JSON (ledger timestamps dropped) for review, diffing, archival, or golden-fixture assertions.
- **Published JSON Schemas:** `schemas/state.schema.json` and `schemas/brief.schema.json` (draft-07) for editor validation, kept in sync with the hand-rolled validators by `tests/schemas.test.ts` (no runtime JSON-schema dependency added).
- **`SECURITY.md`** (threat model: gates bind only a compliant agent, Bash bypass, global hook firing, prompt injection, path containment) and **`CONTRIBUTING.md`** (the committed-`dist/` invariant, plugin-packaging invariants, dev loop).

### Changed

- **Right-sized the orchestrator playbook (F7):** `skills/twinharness/SKILL.md` (854 → ~210 lines) and `agents/critic.md` (797 → ~110 lines) were split into a lean always-loaded core plus on-demand reference files under `skills/twinharness/reference/` (`pipeline-stages.md`, `build-and-verify.md`, `critic-modes.md`). The cores now fit inside Claude Code's ~500-line / ~5,000-token post-compaction re-attach window, so long runs no longer lose the tail of the playbook; the lean files point to the reference files, which load only when a given stage/mode is active. No behavioral content was dropped (relocated verbatim); `tests/prompt-references.test.ts` enforces the size limits and reference-link integrity.
- **Deduplicated the remaining oversized agent prompts (F7 follow-up):** `agents/orchestrator.md` (575 → ~210 lines) now points at the same `reference/` files instead of carrying a second copy of the stage pipeline, and `agents/spec.md` (446 → ~46 lines) keeps its universal rules plus a mode-index table, with the 10 per-mode section lists moved verbatim to `skills/twinharness/reference/spec-modes.md`. Every always-loaded prompt file is now within the ~500-line/~5,000-token guidance (`th context estimate` flags only the on-demand reference files, by design).
- Plugin/marketplace/package author metadata set to a real maintainer (`JrSneed28`) instead of the `TwinHarness` placeholder.

### Security

- **Path-traversal containment (S1):** `th artifact register`, `th coverage check` (`--reqs/--plan/--tests/--scope`), and `th tier classify|veto-check` now reject file/brief paths that resolve outside the project root (new `resolveWithinRoot` helper) instead of reading and content-hashing arbitrary files like `../../etc/hostname`.
- **Prototype-pollution guard (S3):** `th state set` refuses dotted keys containing `__proto__`, `prototype`, or `constructor` segments (e.g. `revise_loop_counts.__proto__.x`) before any assignment runs.
- **Bash-write defense-in-depth (F8):** a second `PreToolUse` matcher (`Bash`) heuristically catches obvious shell writes (`> file`, `>>`, `tee`, `dd of=`, `sed -i`) into in-root implementation paths during Phase A (pre-implementation). Conservative and fail-open — it never gates Bash in Phase B and allows anything it can't clearly parse; it narrows, but does not close, the documented Bash bypass.
- **Managed `drift_open_blocking` (F5 follow-up):** `th state set` now refuses the blocking-drift counter — it is owned by `th drift add` / `th drift resolve`. This closes the bypass where an agent could clear the stop-gate's blocking condition (`state set drift_open_blocking 0`) without resolving the underlying requirement-layer drift.

### Added

- **Gate-mutation audit ledger (F5):** an append-only `.twinharness/gate-ledger.jsonl` records every gate-relevant state change (`implementation_allowed`, `tier`, `blast_radius_flags`, `write_gate`, `drift_open_blocking`) and blocking-drift open/resolve, with timestamps. The gates only bind a compliant agent; this makes overrides auditable after the fact. Observability only — it never blocks a mutation and makes no provenance claim (the CLI cannot tell who invoked it).

### Fixed

- **Invalid slice status in the orchestrator playbook (F1):** `SKILL.md` and `agents/orchestrator.md` instructed `th slice set-status <SLICE-ID> complete`, but `complete` is not a valid status (`pending|in-progress|done|blocked`) and the CLI rejected it — leaving the slice un-advanced and the Phase-B write-gate flagging it. Corrected to `done`. A new `tests/prompt-contract.test.ts` scans the prompts and fails if any documented `set-status` value is not a real status.
- **Test-anchor convention could not match the REQ-ID extractor (F2):** the documented `test_REQ001_<slug>` naming has no hyphen, so the `REQ-[A-Z0-9]…` extractor (and therefore `th anchors scan` / `th coverage check`) never matched it. `agents/builder.md` and `SKILL.md` now require the canonical hyphenated anchor (`REQ-001`, `REQ-NFR-002`) in the test description/comment, with a descriptive function name for readability. New `tests/anchor-convention.test.ts` pins the round-trip.
- **NotebookEdit writes bypassed the write-gate (F3):** the PreToolUse gate matched `NotebookEdit` but read only `tool_input.file_path`; NotebookEdit passes `notebook_path`, so notebook writes were always allowed. The gate now falls back to `notebook_path`. New pretool-gate tests cover the Phase-A notebook case and the doc-path allow case.
- **Stop-gate completion check at final-verification (F6):** the Stop hook now also blocks completion when `current_stage` is `final-verification` and any slice is not yet `done`/`blocked` — catching a claimed-complete run with unbuilt slices. Deliberately narrow: it fires only at `final-verification`, never at earlier stages, so legitimate mid-build pauses are not interrupted. The human correctness gate on the verification report still applies.
- **Lost updates under parallel builds (F10):** every `th` invocation is a separate process, and parallel Builders doing concurrent `drift add` / `slice set-status` / `artifact register` / `state set` could lose a read-modify-write — a dropped requirement-layer `drift add` would leave the stop-gate able to pass a run it should block. State mutations now run under a cross-process advisory lock (`withStateLock`, atomic `mkdir` on `<stateDir>/.state.lock`, with timeout and stale-lock stealing). New `tests/concurrency.test.ts` spawns 20 parallel `drift add` processes and asserts no increment or DRIFT-id is lost; CI now builds before testing so the test exercises the shipped CLI.

### Changed

- **Removed the dead `MultiEdit` matcher token (F4):** MultiEdit was removed from Claude Code in 2.0; the PreToolUse matcher is now `Write|Edit|NotebookEdit`.
- **Calibrated over-stated enforcement language (F5/F8):** the README and `spec/write-gate-design.md` no longer describe the write-gate as "physically enforced" / code that "cannot" be bypassed. Both gates are strong defaults on the Write/Edit path; Bash-mediated writes (`echo >`, `sed -i`) are explicitly out of scope, and the orchestrating agent can set state fields directly.

### Added

- **Continuous integration:** `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --exit-code dist/` on every push and pull request — enforcing the committed-`dist/` invariant on PRs (previously checked only by a unit test).

---

## [0.3.0] — 2026-06-10

### Added

- **PreToolUse write-gate** (`th hook pretool-gate`): a `PreToolUse` hook entry in `hooks/hooks.json` with matcher `Write|Edit|MultiEdit|NotebookEdit` intercepts file writes before they reach the filesystem.
  - **Phase A (pre-implementation):** while `implementation_allowed` is false, any write to a non-doc/non-state path fires with configurable semantics — `ask` (default), `deny`, or `off`.
  - **Phase B (mid-build):** once slices exist and implementation is allowed, writes to paths owned by a slice that is not `in-progress` are flagged as a likely component-boundary violation; in-progress slices' paths and unowned paths are always allowed.
  - Optional `write_gate: "ask" | "deny" | "off"` field in `state.json`; absent means `ask`. Configurable via `th state set write_gate ask|deny|off`.
  - `TH_DISABLE_WRITE_GATE=1` environment escape hatch for one-session bypass.
  - Fail-open throughout: no `state.json` → instant allow; invalid state → allow with warning; doc/state paths (`docs/**`, `.twinharness/**`, `.agentic-sdlc/**`, `.claude/**`, `drift-log.md`, root `*.md`, `.gitignore`) → always allowed.
  - Gate reason text names the current stage and the legitimate unlock path; agents are instructed to escalate to the human rather than retry (anti-spin, mirroring stop-gate handling).
  - See `spec/write-gate-design.md` for the full design.

---

## [0.2.0] — 2026-06-10

### Added

- Two new agents (7 total): `doc-writer` (Stage 10.5 — tier-scaled documentation; Critic-reviewed in `documentation` mode; no human gate) and `ui-designer` (Stage 4b — conditional on project having a UI; presents 2–3 design-direction previews via `AskUserQuestion` before detailed design streams; Critic-reviewed in `ui-design` mode).
- `th slices sync [--plan F] [--dry-run] [--remove-missing]` — parse `docs/09-implementation-plan.md` into `state.slices`; statuses preserved on re-sync.
- `th slice set-status <SLICE-ID> <status>` — set a single slice's status.
- `th stale --artifact <file>` — look up a registered artifact by file key before re-registering (safe cascade re-verification entry point).
- `th version` — print the CLI version.
- `--source <s>` flag for `th drift add` — log who added the entry (no longer hardcoded to Builder).
- `--scope <file>` flag for `th coverage check` — override MVP scope file (default `docs/02-scope.md`); coverage now scans tests/ fully recursively across any language and applies an MVP filter from the scope file's `## MVP Scope` section.
- Critic gained `scope`, `documentation`, and `ui-design` modes.
- Model & effort routing policy documented in `SKILL.md` and `agents/orchestrator.md`: sonnet by default; opus where wrong answers are expensive; haiku for trivial recaps.
- `spec/` directory; `spec/TwinHarness-Plan.md` (renamed from repo root) and `spec/build-plan.md`.
- `homepage` and `repository` fields in `.claude-plugin/plugin.json`.

### Changed

- State directory renamed `.agentic-sdlc` → `.twinharness`; automatic legacy fallback means existing projects with `.agentic-sdlc/state.json` keep working without migration.
- `th build plan` is now fed by `th slices sync` (reads `state.slices`, not the raw plan document directly).
- ARTIFACT_PIPELINE order fixed: `07-contracts` → `08a-security` → `08b-failure` → `08-test-strategy` → `09` → `10`.
- Trace render now associates SLICE/TASK tokens per-REQ instead of dumping all tokens on every row.
- `th state set` now rejects unknown top-level keys (exit with `unknown_field` error).
- `th drift resolve` validates the drift ID exists, rejects double-resolves, and only decrements the blocking counter for requirement-layer entries.
- Stage 10.5 Documentation added between implementation and final verification in the full pipeline.
- Stage 4b UI Design added (conditional) between Architecture and Contracts/Test Strategy.

### Fixed

- `th stale --since` documentation clarified: returns ALL registered downstream artifacts of the changed file in pipeline order — it does not diff summaries.
- Protocol docs corrected: cascade re-verification starts with `th stale --artifact` BEFORE re-registering; PreToolUse hook does not exist (Stop hook only).
- `th drift add --source` heading no longer hardcodes "Builder" when `--source` is provided.

### Removed

- `.omc/` directory and all associated ignore rules removed from the repo and `.gitignore`.

---

## [0.1.1] — 2026-06-09

### Added

- `USAGE.md` — full usage guide (install through advanced CLI reference).
- `package-lock.json` version synced to match `package.json` `0.1.1`.

---

## [0.1.0] — initial release

### Added

- Initial plugin: 5 agents (orchestrator, spec, critic, vertical-slice, builder), `th` CLI, Stop hook gate, 8 build slices.
- Core `th` commands: `init`, `state`, `tier`, `artifact`, `coverage`, `build plan`, `anchors`, `trace`, `stale --since`, `drift`, `revise`, `hook stop-gate`.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` for Claude Code plugin installation.
- REQ-anchored vitest suite covering CLI behavior and plugin-packaging integrity.
