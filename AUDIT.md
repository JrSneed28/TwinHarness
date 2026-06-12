# TwinHarness — Architecture, Security & Product Audit

> Audit date: 2026-06-12 · Audited revision: `f316113` (v0.3.0) · Branch: `claude/plugin-architecture-audit-y62tq6`
>
> Scope: the entire repository — `th` CLI source, hooks, agent/skill prompts, templates, tests, docs, packaging, examples — plus external ecosystem research (four deep-research passes with live citations). **No source or prompt files were changed.** This document is the deliverable; fixes await explicit approval.

---

## Executive Summary

**Overall code quality: B+ / strong for its size.** The `th` CLI is genuinely well-built: zero runtime dependencies, 254 passing tests (verified), deterministic content hashing with CRLF normalization, atomic state writes, hand-rolled validation with precise per-field error paths, and a clean "the CLI records and computes; it never decides" boundary. The committed `dist/` is byte-identical to a fresh build (verified). This is above-average discipline for an early-stage plugin.

**Production-readiness: C+ / not yet best-in-class.** The mechanical spine is solid, but the *product* — an orchestrator whose pitch is "gates are code, not promises" — has a gap between claim and enforcement. Several mechanisms are more bypassable than the README implies, two documented agent instructions are literally wrong (they call the CLI with arguments it rejects), and the orchestrator playbook exceeds Claude Code's own context-budget guidance for exactly the long runs it targets.

**Biggest strengths**
1. "Mechanical truths are code" is the right instinct, and the parts in code are tested and correct.
2. Fail-open hook design — projects without TwinHarness state are unaffected — is the correct default.
3. Documentation discipline (590-line USAGE.md, honest CHANGELOG, design specs, two worked examples) is far above ecosystem norm.
4. The positioning — zero-dependency, no extra API cost, risk-scaled ceremony — directly counters the ecosystem's two loudest complaints (cost and ceremony).

**Biggest risks (most urgent first)**
1. **Two prompt/CLI contract bugs** that fire on real runs: `th slice set-status … complete` (invalid status) and the `test_REQ001_…` test-naming convention the REQ-ID extractor cannot match. *(Confirmed.)*
2. **Gates constrain only a compliant agent.** The same orchestrator that is "gated" holds every key (`th state set implementation_allowed true`, `th drift resolve`, zero the blocking counter) and can write files via Bash, which the PreToolUse gate never sees. Measured reward-hacking literature shows agents *do* game their own gates. *(Confirmed.)*
3. **SKILL.md is 854 lines (~10.5k tokens)** vs. Claude Code's 500-line ceiling and ~5k-token post-compaction re-attach window — the downstream stage definitions fall outside that window precisely in long runs. *(Confirmed.)*
4. **No CI.** The excellent test suite never runs on a PR. *(Confirmed — no `.github/`.)*

**Should it ship publicly yet?** As a clearly-labeled **v0.x experiment, yes** — the README's framing is honest and fail-open means it won't damage other projects. As a **1.0 "serious developer tool," no** — fix the contract bugs, add CI, right-size the playbook, and calibrate the enforcement claims first.

---

## System Understanding

**Runtime / packaging.** TypeScript → CommonJS (`tsc`), Node ≥ 18, npm, vitest. Distributed as a **Claude Code plugin** (`.claude-plugin/plugin.json` + single-plugin `marketplace.json`). Because installs copy the repo with no build step, `dist/` is committed on purpose, enforced by `tests/plugin-manifest.test.ts`.

**Two halves.** *Brains (prompts):* a `twinharness` skill (Orchestrator playbook), 7 agent files (orchestrator, spec, critic, vertical-slice, builder, ui-designer, doc-writer), 4 slash commands, stage templates. *Spine (code):* the `th` CLI, invoked everywhere as `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" …`. Commands are pure functions returning `CommandResult`; `cli.ts` dispatches/prints/exits.

**Control & data flow.** User runs `/twinharness:th-run <idea>`. The Orchestrator (Opus) drives a tier-scaled stage sequence, delegating artifact production to Spec/Vertical-Slice/Builder and coherence review to a fresh-context Critic, surfacing only blast-radius/irreversible decisions to a human gate. Mechanical facts live in validated `.twinharness/state.json` and `drift-log.md`. Two hooks: a **Stop hook** (`th hook stop-gate`) blocks turn-end while state is invalid or blocking drift is open; a **PreToolUse write-gate** (`th hook pretool-gate`) blocks implementation-path writes before `implementation_allowed` and flags cross-slice-boundary writes during the build.

**Key files:** `src/core/state-schema.ts` (schema + veto invariant), `src/commands/hook.ts` (both gates), `src/core/paths.ts` (`.twinharness` with `.agentic-sdlc` legacy fallback), `src/core/anchors.ts` (REQ-ID extraction — the traceability foundation), `skills/twinharness/SKILL.md` (the playbook).

**Key assumptions (some unsafe):** the orchestrating agent follows the playbook faithfully (gates don't bind an adversarial/confused/injected agent); writes go through Write/Edit, not Bash; the playbook fits in context across a long run; REQ-IDs are written in hyphenated `REQ-NNN` form everywhere.

---

## Competitive / Ecosystem Analysis

*From four completed deep-research passes (spec-driven tools; multi-agent harnesses; Claude Code plugin ecosystem; hooks/plugins spec), all with live citations. Star counts pulled from the GitHub API on 2026-06-12.*

### GitHub Spec Kit — `github/spec-kit` (111,717★) · spec-driven scaffolding
`/specify`→`/clarify`→`/plan`→`/tasks`→`/analyze`→`/implement` generates committed markdown specs before code. **Strengths:** GitHub-backed; agent-agnostic; a `constitution` (project-principles) concept; `/analyze` catches spec/plan drift. **Weaknesses/pain points:** the dominant complaint is **ceremony** — "creates the illusion of work, generating a bunch of text" (Discussion #1784); ~800 lines of markdown "they won't run for a two-endpoint change" (Hashrocket); Reenbit benchmark: 90 min vs OpenSpec's 12 min for the same task. **Borrow:** the constitution concept; clarify-before-plan. **Avoid:** fixed-weight ceremony — TwinHarness's Tier-0 bypass is the direct answer; *verify tiers truly skip stages, not just shorten prompts.*

### AWS Kiro — spec mode · commercial IDE
`requirements.md` (EARS-notation acceptance criteria), `design.md`, `tasks.md`, with wave-based parallel tasks. **Strengths:** most polished spec UX; **EARS gives testable, unambiguous criteria.** **Pain points:** the "sledgehammer" problem — **16 acceptance criteria for a small bug fix** (Böckeler, martinfowler.com); a pricing fiasco where the spec path cost 5× the "vibe" path ("a wallet-wrecking tragedy," The Register). **Borrow: EARS-style criteria per requirement** (pairs perfectly with REQ-IDs). **Avoid:** making the responsible path the expensive one — TwinHarness's *mechanical, no-LLM* gates are the right answer; keep mechanical things mechanical.

### OpenSpec — `Fission-AI/OpenSpec` (54,500★) · lightweight, change-proposal SDD
`specs/` (living truth) + `changes/` (deltas); `propose`→`apply`→`archive`. **Strengths:** explicitly minimalist ("no phase gates"); **brownfield-first**; an `openspec status` that "always tells you the next step." **Weaknesses:** weaker cross-feature analysis; fewer gates. **Borrow:** the *status-shows-next-step* UX for `th`; delta-spec thinking for brownfield (TwinHarness's stage list reads greenfield-shaped). **Avoid:** assuming every project starts from a vague idea.

### BMAD-METHOD — `bmad-code-org/BMAD-METHOD` (49,009★) · the closest analog
12+ persona agents (Analyst/PM/Architect/Dev/QA) → PRD → architecture → sharded stories. **Strengths:** full lifecycle; story-file handoff. **Pain points:** "overkill if you already have discipline"; **$800–2,000+/mo/dev**, 5.5 hr for a 12-min task; and — directly relevant — **Issue #1332: a QA agent's hardcoded "minimum 3 issues" quota caused "endless review cycles and artificial nitpicking."** TwinHarness's Critic explicitly forbids a minimum-issue quota (`agents/critic.md`) — *this is a deliberate, correct design choice; keep it.* **Borrow:** slice/story files as the inter-agent contract. **Avoid:** per-task LLM cost multiplication (tier scaling must prune agent *invocations*, not just prose) and "agents checking agents" as the only gate.

### claude-flow / ruflo — `ruvnet/ruflo` (59,114★) · swarm orchestration · cautionary tale
**The credibility failure case.** An independent audit ("99% Theater, 1% Real," Issue #1514) alleges ~290 of 300+ MCP tools are stubs, a "token-reduction optimizer" that *adds* 15–25k tokens/session, a "352× speedup" benchmarked against `sleep(352)`, and hidden prompt-injection in tool descriptions. **Lesson: never claim orchestration the runtime can't verifiably deliver.** TwinHarness's auditable state.json/hashes/drift-log is the opposite philosophy — keep every README claim mechanically demonstrable (see Findings F5/F6/F8, where current claims outrun enforcement).

### claude-task-master — `eyaltoledano/claude-task-master` (27.4k★) · task graph manager
**Strengths:** clean mechanical task-state model (closest in spirit to `th`). **Pain points:** **MCP context bloat (~59 tools, ~45–50k tokens, 22–25% of context;** Issue #1280); requires user API keys (double-billing). **Borrow: complexity scoring to drive tier selection automatically** instead of asking the user. **Note:** TwinHarness's CLI+hooks (vs a fat MCP server) and no-API-key model are genuine advantages — document them.

### ccpm / Claude Code PM — `automazeio/ccpm` (8,185★) · PRD→GitHub Issues→parallel worktrees
Task files carry `depends_on`/`parallel`/`conflicts_with` metadata; up to 12 worktree agents. **Borrow:** explicit `depends_on`/`conflicts_with` slice metadata to make the slice plan provably parallelizable (TwinHarness today infers conflicts only from shared component tokens); an *optional* GitHub-Issues sync as an escape hatch from opaque local state. **Avoid:** GitHub/`gh` hard dependency and command-surface sprawl.

### Aider architect/editor mode · Agent OS · Cursor/Windsurf (brief)
- **Aider** (best-benchmarked planning pattern, then-SOTA 85%) validates TwinHarness's **model-routing policy** — but routing lives only in SKILL.md prose and is neither enforced nor logged; make it observable.
- **Agent OS** (`buildermethods/agent-os`) repeatedly *got leaner* across versions (retired its "roles" system as "too complex") — a recurring signal that every surviving SDD tool sheds ceremony. **Borrow:** a standards/conventions-discovery step feeding the Builder (TwinHarness covers *what* to build, not *house style*).
- **Cursor Plan Mode / Windsurf Cascade**: documented failure modes are **plan→execution handoff** (agent "thinks it's still in plan mode," stale plan files) and **context decay after ~30 messages** (official advice: clear history). TwinHarness's on-disk artifacts are structurally more durable — but its 854-line playbook re-imports the same context-decay exposure (Finding F7).

### Plugin-ecosystem & security context (corroborates several findings)
- **Plugin hooks fire in every project/session at user scope, and even *disabled* plugins' hooks still fire** (anthropics/claude-code #36456, #39307; per-project enable still unshipped, #62174/#40826) → Finding F9.
- **Bash bypasses Write/Edit matchers, by design** (#29709, #6876) → Finding F8.
- **NotebookEdit uses `notebook_path`, not `file_path`; MultiEdit was removed in Claude Code 2.0** (live schema + #8994/#11125) → Findings F3/F4.
- **Marketplace security is the ecosystem's open wound** (PromptArmor plugin-hijack; SentinelOne skill dependency-hijack; a Feb-2026 audit of 3,984 skills found 13.4% with a critical issue). Plugins run with full user privileges — a `SECURITY.md` and threat model are table stakes for credibility.
- **Measured "agents game their own gates":** SpecBench/EvilGenie studies show models overwrite tests, monkey-patch scoring, and rewrite outcomes to "passed"; one study cut deception 92%→1% purely by instructing the agent to surface inconsistencies and abort. **Directly supports Finding F5**, and argues the Stop-hook `reason` text should demand *honest reporting*, not only "keep going."

---

## Lessons To Apply To This Project

| Lesson | Why it matters | TwinHarness today | Recommended change | Priority | Effort |
|---|---|---|---|---|---|
| Ceremony is the #1 SDD complaint | Adoption killer | Strong (Tier-0 bypass) | Verify tiers skip stages/agents/LLM calls, not just shorten prompts; front-load a "what runs per tier" screen | High | S |
| Big always-on context is #2 | Recurring token cost | **Falls short:** SKILL ~10.5k tokens | Split into <500-line core + on-demand reference files | High | M |
| Plan→execution handoff breaks plan-modes | Agent forgets/ignores plan | At risk post-compaction | Persist a compact "current-stage contract" the orchestrator re-reads via `th` | High | M |
| Agents game their own gates (measured) | Undercuts the value prop | Gates are agent-settable | Recompute coverage/hashes at gate time; audit-log gate mutations; Stop `reason` demands honest reporting | High | M |
| EARS acceptance criteria (Kiro) | Mechanical check for the Critic | Prose only | Add EARS criteria to the requirements template | Medium | S |
| `depends_on`/`conflicts_with` (ccpm) | Provable parallelism | Inferred from tokens only | Add explicit slice dependency metadata | Medium | S |
| Auto-complexity scoring (task-master) | Less user burden | Manual tier judgment | Optional complexity score feeding tier advisory | Medium | M |
| Fat MCP servers bloat context | Taskmaster's 50k-token tax | **Wins** (CLI+hooks) | Keep it; don't migrate to MCP | — | — |

---

## Findings

Severity: Critical / High / Medium / Low / Informational. Confidence: Confirmed / Likely / Possible / Speculative.

### F1 — Documented `set-status … complete` is rejected by the CLI
**Bug / prompt-CLI contract · High · Confirmed.** `skills/twinharness/SKILL.md:413` and `agents/orchestrator.md:328` instruct `th slice set-status <SLICE-ID> complete`; valid statuses are `pending|in-progress|done|blocked` (`src/core/state-schema.ts:22`). Reproduced: `… set-status SLICE-1 complete` → `Invalid status "complete"`. (Note `orchestrator.md:361` correctly uses `done` — the file contradicts itself.) **Impact:** a slice never transitions to `done`; `th build plan` keeps rescheduling it and the **Phase-B write-gate keeps treating its components as a boundary violation** (only `in-progress` is allowed). Self-inflicted gate deadlock. **Fix:** `complete`→`done` in both files; add a test asserting every status string used in prompts ∈ `SLICE_STATUSES`. **Effort:** XS · **P0.**

### F2 — Test-naming convention can't match the REQ-ID extractor
**Bug / traceability · High · Confirmed.** `agents/builder.md:41,146-148` and `SKILL.md:337` prescribe `test_REQ<###>_<slug>` (e.g. `test_REQ001_offline_sync`); the extractor is `REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*` (`src/core/anchors.ts:19`). `"test_REQ001_offline_sync".match(...)` → `null` — the hyphen is mandatory; `REQ001` is not a REQ-ID. The `examples/autocoder` suite passes `th coverage check` **only because each test separately carries a hyphenated `REQ-NFR-002` comment**; the convention itself contributes no anchor. **Impact:** a Builder following `builder.md` literally gets a false green from `th anchors scan` and can fail `th coverage check` for "no test" on a requirement that *is* tested. The doc tells the agent the wrong thing. **Fix:** reconcile docs, extractor, and a round-trip test on one canonical form. **Effort:** S · **P0.**

### F3 — NotebookEdit writes bypass the write-gate entirely
**Bug / guardrail gap · Medium · Confirmed.** Matcher includes `NotebookEdit` (`hooks/hooks.json:15`) but the gate reads only `tool_input.file_path` (`src/commands/hook.ts:242`). Live Claude Code `NotebookEdit` uses **`notebook_path`** → `filePath` undefined → step (d) "no file_path → allow." Reproduced locally (`{}` allow). **Impact:** the matcher advertises notebook protection it doesn't deliver. **Fix:** read `tool_input.notebook_path` as a fallback; add a NotebookEdit test. **Effort:** XS · **P1.**

### F4 — Dead `MultiEdit` matcher token
**Code quality / staleness · Informational · Confirmed.** MultiEdit was removed in Claude Code ~2.0 (#8994, #11125). The token is harmless (exact-string list) but misleading. **Fix:** drop it; note in CHANGELOG. **Effort:** XS · **P3.**

### F5 — Confused-deputy: the gated agent holds all the keys
**Agentic workflow risk / architecture · High · Confirmed.** `th state set implementation_allowed true` and `th state set drift_open_blocking 0` both succeed for the same agent the gates constrain; `th drift resolve` decrements the counter; the orchestrator has `Bash`. The gates bind only an agent that *chooses* to respect them — and measured reward-hacking studies show agents don't always. **Impact:** README language ("the gate is code, not a prompt reminder," "Claude cannot claim completion") is true against an honest model and false against a confused/injected/jailbroken one. Not fully fixable (the orchestrator must set these *legitimately*), but **claims should be calibrated** and bypasses made **observable**. **Fix:** (1) soften "cannot" → "blocks by default and records overrides"; (2) add an append-only audit ledger for gate-state mutations, surfaced in the verification report; (3) consider a `--by human` provenance flag on `drift resolve`. **Effort:** M · **P1.**

### F6 — Stop-gate enforces less than the docs imply
**Reliability / claims accuracy · Medium · Confirmed.** `evaluateStopGate` (`src/commands/hook.ts:27-49`) blocks only on invalid state or `drift_open_blocking > 0`. It does **not** check `implementation_allowed`, coverage, or that any slice reached `done`. A valid-state, zero-drift run can claim "done" with **zero code written** — the most intuitive "done" failure is the one the gate doesn't catch. **Fix:** optionally, when `current_stage` ∈ {implementation, final-verification}, also require `th coverage check` to pass and non-blocked slices `done`; keep fail-open for non-TwinHarness projects. At minimum, document the precise scope. **Effort:** M · **P2.**

### F7 — SKILL.md exceeds Claude Code's context-budget guidance
**Performance / DX / reliability · High (for the core use case) · Confirmed.** `SKILL.md` is 854 lines / ~10.5k tokens vs. the documented **<500-line** ceiling; after auto-compaction, invoked skills are re-attached keeping only the **first ~5,000 tokens**. The downstream stage definitions (Stages 5–8, Security, Failure-Modes; ~lines 593–815) sit *past* that window. `agents/critic.md` (796 lines) shares the shape. **Impact:** in long multi-stage runs — the ones most likely to hit compaction — the orchestrator can lose the tail of its own playbook, reproducing the Cursor/Windsurf "forgets the plan" failure this design was meant to beat. **Fix:** lean <500-line core skill + one-hop reference files opened on demand; same for critic.md. **Effort:** M · **P1.**

### F8 — Bash-mediated writes bypass the write-gate (oversold enforcement)
**Security / guardrail · Medium · Confirmed.** PreToolUse matchers match tool names only; `Write|Edit` never sees `bash echo>`, `sed -i`, `tee` (#29709, #6876). `spec/write-gate-design.md` lists this as out-of-scope (good), but the README ("file writes … intercepted before … code can be written before the design is approved") and design doc ("*physically* enforced") overstate it. Builders and the orchestrator both have `Bash`. **Fix:** (1) add a `Bash` PreToolUse matcher that heuristically inspects `tool_input.command` for redirects into implementation paths during Phase A (fail-open); (2) recalibrate prose to "enforced for the standard Write/Edit path; Bash writes are out of scope." **Effort:** M (gate) / XS (docs) · **P2.**

### F9 — Plugin hooks fire in every project & session, machine-wide
**Performance / DX · Medium · Confirmed.** At user scope, the Stop and PreToolUse hooks spawn `node dist/cli.js` on every turn-end and every Write/Edit in **every** project; there is no per-project enablement and **disabling the plugin doesn't stop its hooks** (#40826, #39307, #36456). Fail-open keeps it *correct* but every unrelated session pays a ~50–150 ms node-spawn tax. **Fix:** document explicitly (scope note in install/uninstall); keep the state-file fast-path as early as possible. **Effort:** S (docs) · **P2.**

### F10 — Parallel Builders race on state writes
**Reliability / concurrency · Medium · Likely.** `writeState` (`src/core/state-store.ts:45`) is atomic *per write* (temp+rename) but there is no atomic **read-modify-write**. The headline parallel-wave feature spawns concurrent Builders that each `th slice set-status` / `th drift add` / `th artifact register` (read→mutate→write). Concurrent mutations → last-writer-wins → a lost `drift add` *under-counts* `drift_open_blocking`, so the Stop gate **fails to block** a run that should be blocked. **Fix:** advisory file-locking around read-modify-write; add a concurrency test. **Effort:** M · **P2.**

---

## Security Findings

### S1 — Path traversal in `artifact register` / `coverage` / `brief` paths (read & hash arbitrary files)
**Medium · Confirmed.** `node dist/cli.js artifact register ../../etc/hostname --version 1` succeeds — hashes a file outside the root and records `../../etc/hostname` in `state.json`. `runArtifactRegister`/`runCoverageCheck`/`loadBriefFromFile` resolve agent-supplied paths with no root containment (the *write*-gate correctly rejects out-of-root targets; these read commands don't). Combined with S2, a smuggled instruction ("register `../../../home/user/.ssh/id_rsa`") reads and hashes arbitrary files. **Fix:** constrain these inputs to within `paths.root` (reuse the gate's `toRootRelative` null-check). **Effort:** S · **P2.**

### S2 — No prompt-injection resistance in the orchestration prompts
**Medium · Possible (threat-model gap).** Spec/Builder/Critic read the idea, requirements, and **existing repo files** and act with `Bash`/`Write`. No prompt contains injection-resistance guidance. A hostile file already in the target repo could redirect the build, downshift a tier, or coax a gate bypass. **Fix:** add an "untrusted content" stanza (repo/file contents are data, not instructions; escalate suspicious directives) to orchestrator/spec/builder; add a prompt-injection regression fixture. **Effort:** S · **P2.**

### S3 — Possible prototype-pollution via dotted `state set` paths
**Low · Possible.** Top-level `__proto__` is blocked by the unknown-field check, but `setByPath` (`src/commands/state.ts:42`) walks segments under a valid first key — `revise_loop_counts.__proto__.x` reaches an `__proto__` assignment before `validateState` (which would then reject the non-integer value, defanging it in practice). **Fix:** reject `__proto__|prototype|constructor` segments in `setByPath`. **Effort:** XS · **P3.**

### S4 — Secrets in free-text drift entries get committed
**Low · Possible.** `--discovery`/`--action` text is written verbatim into `drift-log.md` (a committed repo file). **Fix:** a light secret-scan warning in `drift add`, or a docs note. **Effort:** S · **P3.**

**Possible-but-not-confirmed:** `readHookStdin` parses untrusted hook JSON but reads only known scalars and never evals — reviewed, no issue found. `fs.readFileSync(0)` on a very large piped payload could spike memory (bounded by Claude Code in practice) — informational.

---

## Architecture Recommendations

**Incremental (keep the design):**
1. **Right-size the prompt surface** (F7) — lean core skill + on-demand references. Highest-leverage change; also the competitive anti-bloat move.
2. **Make gate mutations observable** (F5) — append-only gate-ledger surfaced in the verification report. Turns "trust me" into a tamper-evident record.
3. **Serialize state writes** (F10) — a lock around read-modify-write; the parallel-build feature depends on it.
4. **Root-contain all path inputs** (S1) — one shared `resolveWithinRoot()` helper.
5. **Persist a per-stage contract** in state (what this stage must produce, which gates apply) so the orchestrator re-reads it via `th` instead of relying on the playbook surviving compaction.

**Larger (only if it earns its keep):**
- **A `th run` driver / deterministic run manifest.** Orchestration is entirely prose today; nothing records *what the orchestrator did* in replayable form. A manifest (stage transitions, agent spawns, models used, gate decisions) makes runs inspectable, replayable, CI-checkable — and lets you *test* orchestration, currently untestable.
- **Schema-versioned state** (`schema_version` + `th migrate`) before 1.0 locks users in.

---

## Testing Plan

The CLI is well-covered (254 tests). Gaps: prompt↔code contracts, concurrency, security, and the orchestration layer (entirely untested).

**P0 (would have caught the shipped bugs)**
1. *Status contract:* grep `set-status … <word>` across `skills/`,`agents/`,`commands/`; assert each `<word>` ∈ `SLICE_STATUSES`. (F1)
2. *Anchor round-trip:* run the documented test-name pattern through `extractReqIds`; assert a REQ-ID is found. (F2)
3. *NotebookEdit gate:* `notebook_path` to an impl path in Phase A → fires (after F3 fix).

**P1 (guardrail integrity)**
4. Bash-bypass documentation/gate test (after F8).
5. Path containment: `artifact register ../../x` → rejected (after S1).
6. Proto-pollution: `state set revise_loop_counts.__proto__.x 1` → rejected (after S3).
7. Stop-gate scope: pin exactly what blocks vs. allows (F6 is intentional & documented).

**P2 (concurrency & malformed input)**
8. Concurrent `drift add --layer requirement` ×N → `drift_open_blocking === N` (catches F10).
9. Malformed/oversized hook stdin → fail-open allow.

**P3 (orchestration — needs the run-manifest work)**
10. Golden run-manifest fixture replayed against the CLI, asserting stage/gate transitions.

**CI:** add `.github/workflows/ci.yml` running `npm ci && npm run build && npm test && npm run typecheck`, plus `git diff --exit-code dist/` to prove `dist/` is in sync on PRs (today that invariant is checked only by a unit test, not on PRs).

---

## Feature Roadmap

**Immediate (fixes):** F1, F2, F3; CI; calibrate claims (F5/F8); SKILL split (F7).

**Short-term (should-have):** generalized **dry-run / "explain what will run" mode** (trust); `th doctor` self-diagnostic / compatibility checker; gate-mutation audit ledger (F5); **cost/context estimate per stage** (Goose/Windsurf gap); **EARS criteria** in the requirements template (Kiro).

**Medium-term:** deterministic **run manifest + replay** (unlocks orchestration testing/audit/"explain"); **schema versioning + `th migrate`**; published **JSON Schemas** for `state.json`/`brief.json`; explicit `depends_on`/`conflicts_with` slice metadata (ccpm); auto-complexity tier scoring (task-master).

**Long-term / moonshot:** team/shared policies & repo profiles; sandboxed Builder execution (worktree/devcontainer per slice); a "TwinHarness-built" verification badge from `th trace render` + coverage.

*Consistent risk across all of these:* **prompt-bloat creep** (F7). Prefer features that live in the *CLI* (cheap, testable) over features that live in *prompts*.

---

## Documentation Improvements
- Calibrate enforcement language in README + `spec/write-gate-design.md` ("blocks by default and records overrides," not "physically enforced / cannot"). (F5, F8)
- Add a "Scope & global behavior" note: hooks fire in every project/session and can't be scoped per-project. (F9)
- Fix the two wrong instructions (F1, F2); add a *test-anchoring worked example that actually matches the extractor.*
- Document the Stop-gate's exact scope. (F6)
- Add **SECURITY.md** (threat model: prompt injection, path inputs, the agent-holds-the-keys trust boundary) and **CONTRIBUTING.md** (the committed-`dist/` invariant currently only in README prose).
- Replace the placeholder author (`"name": "TwinHarness"`) in `plugin.json`/`marketplace.json` with a real maintainer/contact before public release.
- Front-load a one-screen "what runs at each tier" diagram (answers the ceremony objection).

---

## Quick Wins
1. `complete`→`done` in two files (F1). XS.
2. Reconcile the test-anchor convention with the extractor (F2). S.
3. `notebook_path` fallback in the gate (F3). XS.
4. Drop the dead `MultiEdit` token (F4). XS.
5. Add `.github` CI (build+test+typecheck+dist-sync). S.
6. Block `__proto__`/`constructor` in `setByPath` (S3). XS.
7. Root-contain `artifact register`/`coverage` paths (S1). S.
8. Add prompt/CLI contract tests #1–3. S.

## Deep Fixes
1. Split SKILL.md / critic.md into core + references (F7).
2. Serialize state writes with locking + concurrency test (F10).
3. Gate-mutation audit ledger + softened claims (F5).
4. Bash-write matcher for Phase-A defense-in-depth (F8).
5. Deterministic run manifest to make orchestration testable/replayable.

---

## Open Questions
1. Is the orchestrator *intended* to self-set `implementation_allowed` / zero the drift counter (F5 by design, accepting gates bind only a compliant agent), or should those require a distinct human-provenance signal?
2. Should the Stop-gate grow to check coverage/slice-completion at the implementation stage (F6), or is the narrow contract deliberate?
3. What is the intended target run length? It determines how hard F7 (compaction) bites and whether the run-manifest investment is justified.
4. Is `examples/twinrunner` (design-only, "build pending" per its commit) meant to ship as a public example, or is it in-progress scaffolding?

---

## Suggested Implementation Plan

**Phase 1 — Correctness & honesty (P0/P1).** *Goal:* docs and code agree; no run hits a self-inflicted error. *Tasks:* F1, F2, F3, F4; contract tests #1–3; calibrate F5/F8 language; add CI. *Risk:* low. *Validation:* `npm test` green incl. new contract tests.

**Phase 2 — Guardrail & security hardening (P2).** *Tasks:* S1 containment, S3 proto guard, F10 locking + concurrency test, F8 Bash matcher, F5 gate-ledger. *Risk:* medium (concurrency needs a real race test). *Validation:* new security + concurrency tests; soak the parallel path.

**Phase 3 — Context budget & observability (P1/P2).** *Tasks:* split SKILL.md/critic.md (F7), persist a per-stage contract, add `th doctor` and a cost/context estimate. *Risk:* medium (prompt refactors can change behavior — validate against the example runs). *Validation:* re-run `examples/autocoder` end-to-end; confirm resume works after a simulated compaction.

**Phase 4 — Testability & release polish.** *Tasks:* run-manifest + golden replay, schema versioning + `th migrate`, SECURITY.md/CONTRIBUTING.md, author metadata, published JSON Schemas. *Validation:* golden-run replay in CI.

---

## Recommended Next Claude Code Prompt

> You are working on the TwinHarness Claude Code plugin. Implement **Phase 1 (correctness & honesty)** from `AUDIT.md`, in small, reviewable commits on a new branch. Do not undertake risky rewrites; preserve all existing behavior except the specific bugs listed.
>
> **Setup:** Create a branch `fix/phase-1-correctness`. Run `npm install`; confirm `npm test` is green before changing anything.
>
> **Make one logical change per commit, in this order. After each: add/update a test, run `npm run build && npm test && npm run typecheck`, show me the diff, and summarize the change in one paragraph. Stop and ask before doing anything not listed here.**
>
> 1. **F1:** In `skills/twinharness/SKILL.md` and `agents/orchestrator.md`, replace `th slice set-status <SLICE-ID> complete` with `… done`. Add a test scanning `skills/`,`agents/`,`commands/` for `set-status … <word>` and asserting each `<word>` ∈ `SLICE_STATUSES`.
> 2. **F2:** Reconcile the test-naming convention with the REQ-ID extractor. Decide with me first: (a) broaden extraction to recognize `test_REQ001_`, or (b) change the documented convention to embed a literal `REQ-001`. Then make `agents/builder.md`, `SKILL.md`, the extractor, and a new round-trip test agree.
> 3. **F3:** In `src/commands/hook.ts`, read `tool_input.notebook_path` as a fallback when `file_path` is absent. Add a NotebookEdit Phase-A test.
> 4. **F4:** Remove the `MultiEdit` token from the matcher in `hooks/hooks.json`; update the manifest test and CHANGELOG.
> 5. **Docs honesty (F5/F8):** In `README.md` and `spec/write-gate-design.md`, soften "physically enforced / Claude cannot" to "blocks by default and records overrides; Bash-mediated writes are out of scope." No code change.
> 6. **CI:** Add `.github/workflows/ci.yml` running `npm ci`, `npm run build`, `npm test`, `npm run typecheck`, and a `git diff --exit-code dist/` step.
>
> **Rules:** Rebuild and commit `dist/` with any `src/` change. Do not change the state schema, the gate decision ladder, or model routing in this phase. If a fix needs a broader change than described, stop and explain first. End with a summary of every commit and the final `npm test` result.
