# Technical Design — Autocoder

> **Stage 6 — Detailed Technical Design** (spec §15.6). Streams; surfaces product-meaningful
> behavior choices as Open Design Questions for the Orchestrator (no interactive gate). Reads the
> Summary blocks of `04-architecture.md`, `03-domain-model.md`, and the ADR list in `05-adrs/`
> by default; fetches full artifacts only when a component's behavior needs the detail (§9).
> Deliberately **stops where code is clearer than prose** — trivial pass-through components are
> named and skipped. Every component design anchors to REQ-IDs from `01-requirements.md` (§11).

## Summary

This design specifies the internal behavior the architecture left abstract for Autocoder's
non-trivial components. The **AgentRun** loop controller is given a concrete
`iterate → callModel → dispatchTool → observe → record` cycle and the full lifecycle state machine
(Initializing → GatheringContext → Iterating ⇄ AwaitingApproval → Terminating → Succeeded/Stopped/
Failed) with a **pre-turn budget guard** (RULE-006) and single-StopCondition classification into a
RunOutcome + exit code (RULE-007, RULE-011). The **PathSandbox** — the data-integrity blast-radius
control — gets a precise resolve-realpath-then-containment escape check applied to writes and exec
but deliberately *not* to reads (ADR-005, RULE-001/003). The **LlmClient** gets message/tool-schema
construction, token-usage extraction, and a concrete bounded-backoff retry policy (REQ-NFR-004,
ADR-008). The **ApprovalGate** gets exact edit- and command-decision logic with a precisely defined
allowlist matching semantics (ADR-006). The five **tools**, the **Diff/Patch engine**, the
**Budget/StopCondition controller**, the **Transcript writer**, and **Config resolution** are each
specified to the depth a Builder needs without inventing. The system-wide error stance is fixed:
sandbox and config fail **closed**; expected tool failures become **error ToolResults**, never
crashes (ADR-007, RULE-008); only truly fatal conditions take the `unrecoverable-error` stop path.

- **Components designed:** AgentRun (loop + lifecycle state machine), LlmClient (transport + retry +
  token accounting), PathSandbox (escape check), ApprovalGate (edit/command decision + allowlist
  matching), the five Tools (read / list-search / write-edit / apply-patch / run-command),
  Diff/Patch engine (generate + parse/apply atomically), Budget/StopCondition controller (accrual +
  guard + classification), Transcript writer (typed/versioned JSONL, flush-per-entry), Config
  resolver (precedence + fail-fast).
- **Key algorithms / state machines:** AgentRun lifecycle state machine; the per-turn loop
  algorithm; PathSandbox containment check; LlmClient retry/backoff; allowlist matching; unified-diff
  generation and atomic hunk application; pre-turn budget guard; StopCondition classification.
- **Human-approved behavior choices:** the three blast-radius postures this design implements are
  already human-gated upstream — sandbox asymmetry (OQ-3 / ADR-005), command-approval model (OQ-2 /
  ADR-006), and the iteration+token ceiling (OQ-4). The open behavior choices in this stage
  (allowlist match granularity, ambiguous string-replace, success precedence) are recorded as
  **Open Design Questions** with adopted defaults — none is blocking.

---

## Component Designs

> Anti-boilerplate note: each component below is named from the architecture's component list and
> anchored to its REQ-IDs. Trivial components are explicitly named and skipped at the end of this
> section so the Critic knows the omission was deliberate.

### AgentRun Orchestrator (`agent-run`)

**Realizes:** REQ-004, REQ-005, REQ-013, REQ-014, REQ-015
**Purpose (one sentence):** Own the run lifecycle and drive the single sequential agent loop —
build context, repeatedly ask the model for the next action, dispatch tool calls one at a time
through the safety gates, feed results back, and terminate on exactly one StopCondition.

Internal logic. AgentRun holds the accumulating conversation (the ordered list of
ConversationMessages: system prompt, user task, assistant turns, tool_result turns), the iteration
counter, and a reference to the Budget controller. On construction it has a resolved Config, a
validated WorkingRoot, an injected LlmClient and CommandRunner (RULE-015), and a Transcript writer.
Its run method executes the per-turn cycle (see *Per-Turn Loop Algorithm*) until the
StopCondition classifier returns a non-null reason, then hands the StopCondition to the
Budget/StopCondition controller for classification into a RunOutcome and exit code. AgentRun owns
the **fatal-vs-expected boundary** (ADR-007): expected tool failures arrive as error ToolResults
and are simply fed back; only conditions that make continuation impossible (LlmClient retries
exhausted, Transcript write failure, an internal invariant breach) raise to the
`unrecoverable-error` stop path. Tool calls within a turn are dispatched **strictly sequentially** —
one ToolCall fully resolved (gated, executed, recorded) before the next (ADR-003, no parallel
tools).

**Entry point(s):** `run()` invoked by the CLI after dependency wiring (state = Initializing).
**Exit point(s):** returns a `RunOutcome` (status + StopCondition + filesChanged + testsResult +
iterationsUsed + tokensUsed + exitCode); emits RunStarted/IterationStarted/RunStopped/RunCompleted
events to the Transcript and Reporter throughout.
**Invariants maintained:** at most one current lifecycle state; iterationsUsed never exceeds
Budget.maxIterations and tokensUsed never exceeds Budget.tokenBudget at any turn boundary (RULE-006);
the loop always reaches exactly one terminal state (RULE-007); every dispatched ToolCall produces
exactly one recorded ToolResult before the next is dispatched.

### LlmClient Adapter (`llm-client`) — DI seam, LOCKED

**Realizes:** REQ-004, REQ-005, REQ-NFR-002, REQ-NFR-004, feeds REQ-015
**Purpose (one sentence):** The single interface wrapping the Anthropic SDK — serialize the
conversation + the five tool schemas into a Messages API call, parse the response into tool_use
blocks or a final answer, extract reported token usage, and apply bounded-backoff retry on transient
failures.

Internal logic. (1) **Request construction:** map the accumulating ConversationMessages to the
Messages API shape (system prompt, alternating user/assistant turns, tool_result content blocks);
attach the ToolRegistry's five tool schemas as the `tools` field (native structured tool-use,
ADR-001). (2) **Response parsing:** read the response content blocks — `tool_use` blocks become
ToolCalls (toolName + arguments object as the model emitted them — treated as **untrusted input**,
validated downstream by the tools and PathSandbox); a stop_reason of `end_turn` with no tool_use
and a text block becomes the final answer. (3) **Token accounting:** read the SDK-reported
`usage.input_tokens + usage.output_tokens` for the call and return it so the Budget controller can
accrue it (DQ-001 default: trust SDK-reported usage; if a usage field is absent, fall back to a
character-based estimate and mark the entry estimated). (4) **Retry:** wrap the SDK call in the
retry/backoff policy below. The seam exposes one operation — send(conversation, toolSchemas) →
{toolCalls | finalAnswer, usage} — so tests inject a deterministic stub (RULE-015).

**Retry/backoff policy (concrete — REQ-NFR-004, ADR-007/ADR-008):**
- **Retryable (transient):** HTTP 429 (rate limit), HTTP 500/502/503/529 (server/overload), network
  timeouts, and connection-reset/socket errors.
- **Fatal (not retried — raise to unrecoverable-error):** HTTP 401/403 (bad/expired API key — surfaces
  in Initializing via Config fail-fast where possible, but also guarded here), HTTP 400 (malformed
  request — a harness bug, not transient), and any non-transient 4xx.
- **Max attempts:** 5 total (1 initial + 4 retries).
- **Backoff formula:** exponential, `delay = base * 2^(attempt-1)` with **base = 1000 ms**, capped at
  **30 000 ms**. Sequence ≈ 1s, 2s, 4s, 8s (then cap).
- **Jitter:** full jitter — actual sleep is `random(0, delay)` to avoid thundering-herd alignment.
- **Retry-After honor:** if a 429/529 response carries a `Retry-After` header, use it as the floor for
  the next delay.
- Each retry emits an `LLMRetry` TranscriptEntry (attempt number, error class, delay). Exhausting all
  attempts is a fatal `unrecoverable-error` StopCondition, not an error ToolResult (it is the LLM
  transport itself failing, not a tool call).

**Entry point(s):** `send(conversation, toolSchemas)` called once per Iteration's Requested state.
**Exit point(s):** returns `{ toolCalls[] | finalAnswer, usage }`; throws only on fatal (non-retryable
or retries-exhausted) failure.
**Invariants maintained:** never mutates the conversation it is given (read-only transport); reported
usage is always non-negative; a single send performs at most `maxAttempts` SDK calls.

### PathSandbox (`path-sandbox`) — data-integrity blast-radius control

**Realizes:** REQ-021, REQ-NFR-005, REQ-NFR-007 (cross-platform), enforces RULE-001 + RULE-003 write side
**Purpose (one sentence):** Deterministically decide whether a given write or exec target is
contained within the resolved WorkingRoot, rejecting traversal / absolute-outside / symlink-escape
attempts **before** the operation; reads are never confined (ADR-005 asymmetry).

**Containment check (the blast-radius rule — define precisely so a Builder cannot get it subtly
wrong):**
1. **Normalize the root once at startup:** resolve the WorkingRoot to an absolute, symlink-resolved
   real path (`realpath`) and validate it exists and is a directory. Store this canonical root.
2. **For a WRITE target:** resolve the candidate path to absolute against the canonical root, then
   resolve the **real path of the deepest existing ancestor** (the target itself may not exist yet
   on a create) — i.e. walk up to the nearest existing component, `realpath` it, then re-append the
   non-existing tail. This defeats a symlinked parent directory that points outside the root.
3. **Containment test:** the resolved target's real path must equal the canonical root **or** be a
   descendant of it. Descendant test = the canonical root path followed by the platform path
   separator is a prefix of the target's real path (compare on normalized, case-folded paths on
   case-insensitive platforms — Windows; case-sensitive elsewhere, REQ-NFR-007). A target equal to
   the root is allowed; a target that resolves to the root's parent or any sibling is rejected.
4. **For an EXEC target:** the command's cwd must pass the same containment test (cwd = root or a
   descendant). The command *string* is not path-validated here — confinement is enforced by the
   sandboxed cwd plus the ApprovalGate; PathSandbox guarantees the process is spawned inside the root.
5. **For a READ target:** **no containment check** — return allowed for any resolvable path (ADR-005
   read-anywhere). The asymmetry is deliberate and must not be "tidied up" into symmetric confinement.
6. **Rejection is fail-closed:** any path that fails to resolve, escapes via `..`, is an absolute path
   landing outside the root, or whose real path (after symlink resolution) lands outside the root is
   **rejected before the op**, producing an `EditRejected` / error ToolResult (never a silent allow).

**Entry point(s):** `checkWrite(path)`, `checkExecCwd(cwd)`, `checkRead(path)` called by the mutating/
executing tools before any side effect.
**Exit point(s):** returns an allowed-with-canonical-path result, or a rejection with a code
(`PATH_ESCAPE`) and an actionable message; never performs the IO itself.
**Invariants maintained:** **no write or exec ever resolves outside the canonical root** (RULE-001);
reads are never blocked (RULE-003); the check is a pure deterministic function of (canonical root,
candidate path, filesystem symlink state) — heavily negative-tested.

### ApprovalGate (`approval-gate`)

**Realizes:** REQ-012, REQ-016, REQ-NFR-005, enforces RULE-004 + RULE-005
**Purpose (one sentence):** Resolve each mutating/executing ToolCall against the configured
ApprovalPolicy into an ApprovalDecision (auto-approved / approved-by-user / denied), prompting the
human only when the policy requires it; a denial yields an error ToolResult rather than executing.

**Edit-approval decision (RULE-004):**
- editMode = `auto` (`--yes`/`--auto`): the Edit is **auto-approved** without prompting (the Diff is
  still generated and streamed — no silent writes, RULE-002).
- editMode = `confirm-each` (default): show the Diff, prompt the user per file; approve → proceed,
  deny → error ToolResult (`APPROVAL_DENIED`), abort-run → clean Terminating with model-give-up→
  actually a user-abort classified as `Stopped`.

**Command-approval decision (RULE-005, ADR-006):**
- commandMode = `auto` (`--yes`/`--auto`): **all commands auto-run** (the sharp escape hatch —
  ADR-006 negative consequence; recorded as such).
- commandMode = `allowlist-confirm` (default): consult the Allowlist matcher. **Match → auto-run**;
  **no match → prompt the user**; deny → error ToolResult; abort → user-abort Stopped.

**Allowlist matching semantics (security-sensitive — ADR-006 obliges a precise definition):**
The match is performed on the **tokenized command**, not a raw substring. Adopted default
(ODQ-001): a command matches an AllowlistEntry when the command's **executable + leading
subcommand prefix** equals the entry, compared on whitespace-tokenized argv with the entry treated
as a **token-sequence prefix**. Examples: entry `git status` matches `git status` and
`git status --short` but **not** `git push`; entry `npm test` matches `npm test` and `npm test -- --run`
but not `npm run deploy`; entry `ls` matches `ls` and `ls -la`. Shell metacharacters that chain or
redirect (`;`, `&&`, `||`, `|`, `>`, `` ` ``, `$(`) in a candidate command **disqualify the
auto-run match** and force confirmation — an allowlisted prefix must not smuggle a second command
(this is the ADR-006 "over-broad match" abuse case, closed here by failing safe to confirm). Matching
is exact on tokens (no glob, no regex) to keep it auditable.

**Entry point(s):** `resolveEdit(edit, policy)`, `resolveCommand(command, policy, allowlist)`.
**Exit point(s):** an ApprovalDecision; emits ApprovalRequested/ApprovalDecided TranscriptEntries.
**Invariants maintained:** no Edit is persisted and no command runs without a permitting decision
(RULE-004/005); a denial never executes the action; chained/redirected commands are never auto-run.

### ToolRegistry + Dispatcher (`tool-registry`)

**Realizes:** REQ-005, REQ-NFR-004, enforces RULE-012 + RULE-008
**Purpose (one sentence):** Declare the exactly-five tool schemas exposed to the model, dispatch each
ToolCall to its executor, reject any tool name outside the fixed set, and normalize every executor
outcome (success or thrown error) into a `ToolResult`.

Internal logic. Holds a fixed map of five tool names → executors. On dispatch: if the name is not one
of the five → return an error ToolResult (`UNKNOWN_TOOL`) (RULE-012). Otherwise invoke the executor;
wrap the call so any thrown error from an *expected* failure class is caught and converted to an error
ToolResult (RULE-008, ADR-007) rather than propagating. **Truly fatal** errors (an invariant breach,
a Transcript write failure surfaced by a tool) are re-raised for AgentRun's unrecoverable-error path —
the dispatcher distinguishes by error class, not by swallowing everything.

**Entry point(s):** `dispatch(toolCall)`. **Exit point(s):** a normalized `ToolResult` (status ok/error).
**Invariants maintained:** exactly five executable tools; every dispatch yields exactly one ToolResult;
no expected tool failure escapes as an exception.

### Tool: ReadFile (`tool-read`)

**Realizes:** REQ-006, REQ-021 (read-anywhere half / RULE-003)
**Purpose:** Return full or bounded-range file contents from any resolvable path.
Logic: normalize the path; call PathSandbox `checkRead` (always allowed); read the file; if a range
(start line/offset + count) is supplied, return only that slice; default cap reads to a bounded line
count (e.g. first 2000 lines) and signal truncation so the prompt is not flooded. Errors:
file-not-found, is-a-directory, permission-denied → error ToolResult (`READ_FAILED`), never a crash.
**Invariant:** never writes; the only effector permitted outside the root.

### Tool: ListSearch (`tool-search`)

**Realizes:** REQ-007
**Purpose:** List directory entries and search file contents (glob and/or text/regex) within the root.
Logic: list — enumerate directory entries (optionally a glob filter) scoped to the root; search —
match a literal substring or a regex (caller picks the mode) across files under the root, returning
path + line number + matched line, with a bounded result count to cap output. Empty result set is a
**success** ToolResult with zero hits (not an error). Invalid regex → error ToolResult
(`BAD_PATTERN`). **Invariant:** read-only; listing/search scoped to the root.

### Tool: WriteEdit (`tool-writeedit`)

**Realizes:** REQ-008, REQ-010, REQ-011, REQ-021
**Purpose:** Create or modify a file via whole-file write **or** targeted string-replace, producing an
Edit (path, before, after) that flows through Diff → PathSandbox → ApprovalGate before persistence.
Logic. (1) **Whole-file mode:** before = current contents (or null if creating), after = supplied
contents. (2) **String-replace mode:** read current contents; locate the search string.
**Ambiguity/absence handling (ODQ-002 default):** if the search string occurs **zero** times → error
ToolResult (`SEARCH_NOT_FOUND`, no Edit); if it occurs **more than once** → error ToolResult
(`SEARCH_AMBIGUOUS`, count reported, no Edit) **unless** the caller explicitly requested replace-all,
in which case all occurrences are replaced. This fail-on-ambiguous default prevents the model from
silently editing the wrong occurrence. (3) Produce the Edit → Diff engine generates the unified Diff
→ PathSandbox `checkWrite` (reject escapes) → ApprovalGate `resolveEdit` → on approval, write the
file (create parent dirs within the root as needed) → mark Edit Applied → success ToolResult with the
diff summary.
**Invariant:** no Edit reaches Applied without a Diff (RULE-002) and a passing containment check
(RULE-001); write happens only after an approving decision (RULE-004).

### Tool: ApplyPatch (`tool-applypatch`)

**Realizes:** REQ-023, REQ-010, REQ-011, REQ-021, REQ-012, enforces RULE-013
**Purpose:** Apply a unified-diff Patch (one+ hunks across one+ files) to the working tree as a set of
Edits, **atomically** — all hunks apply or none do.
Logic. Parse the Patch into per-file hunk sets (Diff/Patch engine). For each target file: PathSandbox
`checkWrite`; dry-run every hunk against current contents (context lines must match at the stated or
fuzzed offset). If **any** hunk on **any** file fails to apply, or the patch is malformed → reject the
**whole** Patch with a `PatchRejected` actionable error ToolResult and produce **zero** Edits
(RULE-013). Only if **all** hunks across **all** files apply cleanly: generate the Edits + Diffs →
ApprovalGate (per-file edit policy) → persist. Persistence is the last step so a rejection never leaves
partial writes.
**Invariant:** atomic — a non-applying or malformed Patch produces no partial Edits (RULE-013).

### Tool: RunCommand (`tool-runcommand`)

**Realizes:** REQ-009, REQ-013, REQ-016, REQ-021
**Purpose:** Execute a shell command in the root via CommandRunner, capturing exit code, stdout,
stderr; the detected test command's result is the completion signal.
Logic: PathSandbox `checkExecCwd` (cwd = root or descendant) → ApprovalGate `resolveCommand` (allowlist
or confirm) → on approval, CommandRunner runs the command with cwd = root and a **timeout** (ODQ-003
default: 120 s, configurable) → capture exit/stdout/stderr (output bounded/truncated for the prompt) →
success ToolResult **even on non-zero exit** (a failing test run is a *result*, not a tool error —
ADR-007); only spawn failure / timeout is an error ToolResult (`COMMAND_FAILED` / `COMMAND_TIMEOUT`).
If the command equals the detected test command, set `isTestRun` and surface pass/fail to the Budget/
Stop logic (RULE-009).
**Invariant:** never executes outside the root cwd (RULE-001); never auto-runs a non-allowlisted
command in default mode (RULE-005); a non-zero exit is a result, not a crash.

### CommandRunner (`command-runner`) — DI seam, LOCKED

**Realizes:** REQ-009, REQ-NFR-002, REQ-NFR-007
**Purpose:** The single interface wrapping OS process execution. **No non-trivial harness logic** —
it spawns a process in a given cwd with a timeout and captures exit/stdout/stderr; cross-platform
shell selection (cmd vs. sh) is contained here. Production uses Node `child_process`; tests inject a
stub. Designed at the interface level only (the body is a thin SDK/`child_process` wrapper — code is
clearer than prose here).

### Diff/Patch Engine (`diff-engine`)

**Realizes:** REQ-010, REQ-008, REQ-023, enforces RULE-002 + supports RULE-013
**Purpose:** Generate a unified Diff (before → after) for every Edit (display, REQ-010); parse and
apply input Patch documents for ApplyPatch (REQ-023).
**Diff generation:** compute a line-level unified diff (standard LCS-based diff, e.g. a `diff`
library) with file headers and `@@` hunk markers, suitable for terminal display and Transcript
recording. New file = before treated as empty; deletion = after treated as empty.
**Patch parse/apply:** parse the unified-diff text into typed hunks (per-file, with context/added/
removed lines and line ranges). Apply each hunk by matching its context against current contents
(small fuzz factor for line offset drift permitted; mismatch = hunk failure). All-or-none semantics
live in ApplyPatch (this engine reports per-hunk applicability; the tool enforces atomicity).
Malformed patch text (unparseable headers, inconsistent line counts) → parse error surfaced as a
rejection. **Invariant:** pure deterministic; no Edit is representable without a Diff (RULE-002).

### Budget / StopCondition Controller (`budget-stop`)

**Realizes:** REQ-014, REQ-015, REQ-NFR-003, REQ-020, enforces RULE-006 + RULE-007 + RULE-011
**Purpose:** Accrue iterations and token usage, enforce the hard ceilings **before each turn**,
classify the terminating reason into one StopCondition, and derive the RunOutcome status + exit code.
**Token accounting (DQ-001):** after each LlmClient send, add `usage.input + usage.output` to
`tokensUsed`; iterationsUsed increments once per completed turn. Accrual is monotonic.
**Pre-turn guard (the budget guard, RULE-006):** before AgentRun starts a new Iterating turn, check
`iterationsUsed >= maxIterations` (→ `max-iterations-reached`) and `tokensUsed >= tokenBudget`
(→ `budget-exhausted`). Either true → return that StopCondition and forbid another iteration. The
guard runs **before** the model call so a near-budget turn is **not** started — Autocoder never
half-runs an iteration it cannot afford (a partial iteration is prevented, not aborted mid-flight).
**StopCondition classification:** task-success (test command exists and last test run passed —
authoritative, ODQ-004; else model declared done) → Succeeded/exit 0; max-iterations / budget-exhausted
/ model-give-up → Stopped/exit non-zero; unrecoverable-error → Failed/exit non-zero (RULE-011).
**Invariant:** a run can never exceed either ceiling (RULE-006); exactly one StopCondition fires
(RULE-007); exit 0 iff Succeeded (RULE-011).

### Transcript Writer (`transcript`)

**Realizes:** REQ-022, REQ-NFR-008, enforces RULE-010
**Purpose:** Durably record every domain event as an ordered, typed, append-only JSONL log
sufficient to reconstruct the run (ADR-002).
**Entry schema (typed + versioned):** each TranscriptEntry is one JSON object per line with:
`schemaVersion` (string, for additive evolution — ADR-002 mitigation), `seq` (monotonic integer),
`timestamp` (ISO-8601), `type` (enum: run-started, context-gathered, iteration-started, tool-called,
approval-requested, approval-decided, edit-proposed, edit-applied, edit-rejected, patch-rejected,
command-run, tests-run, tool-result, budget-exceeded, llm-retry, run-stopped, run-completed,
allowlist-changed), and `payload` (type-specific inputs/outputs sufficient to reconstruct).
**Write discipline:** open the per-run transcript file in append mode at run start; serialize each
entry to a single line and **flush per entry** (write + fsync-class flush) so a crash mid-run loses
at most the in-flight entry — each prior event is already durable (crash-durability, the reason
JSONL was chosen over a rewritten single document, ADR-002). A failed transcript write is **fatal**
(`unrecoverable-error`) — the audit trail is a data-integrity contract and must not be silently
dropped (RULE-010, ADR-007 fatal class).
**Invariant:** entries are append-only and strictly ordered by `seq`; no entry is ever rewritten or
deleted; the on-disk format is forward-evolvable via `schemaVersion`.

### Config Resolver (`config`)

**Realizes:** REQ-018, REQ-002, REQ-015, REQ-016, REQ-025, REQ-NFR-006, enforces RULE-016
**Purpose:** Merge configuration from flags, environment, and an optional config file into one
resolved Config; fail fast on missing required values; persist allowlist mutations.
**Precedence (highest wins):** **flags > environment > config file > built-in defaults.** Resolved
keys: apiKey (`ANTHROPIC_API_KEY`, env primary), modelId (default current Claude model), root
(default cwd; `--cwd`/`--root`), editMode (default confirm-each), commandMode (default
allowlist-confirm), maxIterations (default 25), tokenBudget (default ≈ 1,000,000), allowlist (default
= detected test/build command + safe read-only commands).
**Fail-fast (RULE-016):** required = apiKey present and root resolves to an existing directory. A
missing apiKey or invalid root **fails in Initializing** with an actionable message and a non-zero
exit, **before any iteration** (REQ-NFR-006). **Persistence:** allowlist add/remove writes back to
the config file (RULE-014). **Invariant:** the resolved Config is complete and validated before
AgentRun is constructed; misconfiguration never reaches the loop.

### Deliberately skipped (trivial — no non-trivial design)

- **CLI / Entry Layer (`cli`)** — argv parsing + dependency wiring + exit-code setting. A thin
  composition root; behavior is obvious from the architecture's data flow. No internal algorithm to
  specify.
- **RepoContext Builder (`repo-context`)** — directory listing + project-type/test-command detection
  (e.g. read `package.json` scripts). Straightforward read-only assembly; detection heuristics are
  config-overridable and not behaviorally subtle. (The one product-meaningful aspect — whether a test
  command was detected — is captured in ODQ-004's success precedence.)
- **Allowlist Manager (`allowlist`)** — holds entries and exposes inspect/add/remove that delegate
  persistence to Config. The only non-trivial part (matching) is designed under ApprovalGate above.
- **Reporter (`reporter`)** — renders the same RunOutcome as a human stream and as `--json`. The
  `--json` schema is a contracts-stage concern; the rendering itself is a straightforward projection
  with no branching logic worth specifying here.
- **CommandRunner (`command-runner`)** — designed at the interface level only above; the body is a
  thin `child_process` wrapper where code is clearer than prose.

---

## Key Algorithms / Workflows

### Per-Turn Loop Algorithm

**Owned by:** `agent-run`
**Realizes:** REQ-004, REQ-005, REQ-013, REQ-014, REQ-015

1. **Initialize** (once): resolve Config, validate WorkingRoot, wire LlmClient + CommandRunner,
   open the Transcript, emit RunStarted. Fail-fast here ends in Failed (RULE-016). → GatheringContext.
2. **Gather context** (once): build RepoContext (listing, project type, detected test command); emit
   ContextGathered; seed the conversation with system prompt + Task. → Iterating.
3. **Pre-turn budget guard** (every turn): ask Budget/Stop to check ceilings. If a ceiling is hit,
   set the StopCondition and go to step 9 — **do not start the turn** (RULE-006).
4. **Call model:** LlmClient.send(conversation, toolSchemas) with bounded-backoff retry. On
   retries-exhausted/fatal → StopCondition = unrecoverable-error → step 9. Accrue token usage;
   increment iteration; emit IterationStarted.
5. **Branch on response:** if a final answer with no tool calls → set candidate StopCondition
   (task-success or model-give-up per the answer) → step 8 (success verification). If tool calls →
   step 6.
6. **Dispatch tools sequentially** (one at a time): for each ToolCall, ToolRegistry dispatches to the
   tool; mutating/executing calls pass PathSandbox then ApprovalGate (suspend at AwaitingApproval for
   confirm-each / non-allowlisted; a user-abort → StopCondition = user-abort/Stopped → step 9); capture
   one ToolResult per call; emit ToolCalled/ApprovalDecided/Edit*/CommandRun/ToolResult entries.
7. **Record + feed back:** append every ToolResult to the conversation; record all entries to the
   Transcript. → back to step 3.
8. **Success verification (ODQ-004):** if a test command was detected, the authoritative success
   signal is a passing run of it — if the latest test run passed, StopCondition = task-success; if no
   test command exists, accept the model's declaration as task-success (note "tests not run"). → step 9.
9. **Terminate:** Budget/Stop classifies the StopCondition → RunOutcome (status + exit code); flush
   the Transcript (run-stopped, run-completed); Reporter emits the human + `--json` summary; CLI sets
   exit. → Succeeded / Stopped / Failed (terminal).

**Edge cases:** zero tool calls on the first turn (model answers immediately — handled by step 5);
a turn whose tools are all denied (loop continues with error results — ADR-007); a near-budget state
(prevented by step 3 before any model call). **Complexity/cost:** O(iterations) model calls, each
bounded by Budget; strictly sequential, no concurrency.

### PathSandbox Containment Check

**Owned by:** `path-sandbox` — **Realizes:** REQ-021, RULE-001/003. Specified precisely in the
PathSandbox component design above (resolve real path of deepest existing ancestor → descendant test
against canonical root → reject on escape for write/exec; never confine reads). Not repeated here.

### Allowlist Matching

**Owned by:** `approval-gate`/`allowlist` — **Realizes:** REQ-016, RULE-005, ADR-006. Token-sequence
prefix match on argv with chained/redirected commands disqualified. Specified in the ApprovalGate
component design above. Not repeated here.

### Unified-Diff Generation & Atomic Patch Application

**Owned by:** `diff-engine` (+ `tool-applypatch` for atomicity) — **Realizes:** REQ-010, REQ-023,
RULE-002/013. Specified in the Diff/Patch Engine and ApplyPatch component designs above. The Builder
should use a maintained diff library for LCS computation rather than hand-rolling it (code is clearer
than prose for the LCS itself).

---

## State Machines

### AgentRun Lifecycle State Machine

**Realizes:** REQ-013, REQ-014, REQ-015
**Defined in domain model:** yes — see `03-domain-model.md` §State Models (AgentRun States); this
adds the concrete guards and side effects.

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| `Initializing` | dependencies wired | valid Config + existing root (RULE-016) | `GatheringContext` | emit RunStarted; open Transcript |
| `Initializing` | config/root invalid | missing apiKey or bad root | `Failed` | fail-fast message; exit non-zero (REQ-NFR-006) |
| `GatheringContext` | context built | RepoContext assembled | `Iterating` | emit ContextGathered; seed conversation |
| `Iterating` | start next turn | **budget guard: iterationsUsed < max AND tokensUsed < tokenBudget** (RULE-006) | `Iterating` | call model; dispatch tools; record results |
| `Iterating` | budget guard fails | iterationsUsed ≥ max OR tokensUsed ≥ budget | `Terminating` | StopCondition = max-iterations / budget-exhausted; emit BudgetExceeded |
| `Iterating` | mutating edit / non-allowlisted command | confirm-each / not allowlisted | `AwaitingApproval` | emit ApprovalRequested |
| `Iterating` | final answer | model declared done/give-up | `Terminating` | StopCondition = task-success (verified) / model-give-up |
| `Iterating` | LlmClient retries exhausted / fatal | non-retryable or attempts > max | `Terminating` | StopCondition = unrecoverable-error |
| `AwaitingApproval` | user approves | — | `Iterating` | execute action; capture ToolResult |
| `AwaitingApproval` | user denies | — | `Iterating` | error ToolResult (APPROVAL_DENIED); continue loop |
| `AwaitingApproval` | user aborts run | — | `Terminating` | StopCondition = user-abort (classified Stopped) |
| `Terminating` | classify StopCondition | task-success | `Succeeded` | flush Transcript; emit RunCompleted; exit 0 |
| `Terminating` | classify StopCondition | max-iter / budget / give-up / user-abort | `Stopped` | flush Transcript; emit RunCompleted; exit non-zero |
| `Terminating` | classify StopCondition | unrecoverable-error | `Failed` | flush Transcript; emit RunCompleted; exit non-zero |

**Terminal states:** `Succeeded`, `Stopped`, `Failed` — no further transition (RULE-007).
**Invalid transitions:** any attempt to start an iteration when the budget guard fails (must go to
Terminating, never Iterating — RULE-006); any path that leaves the loop without a StopCondition
(non-termination is not a permitted state — RULE-007).

### Edit State Machine

**Realizes:** REQ-010, REQ-011, REQ-012, REQ-021
**Defined in domain model:** yes — see `03-domain-model.md` §State Models (Edit States).

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| (new) | tool produces Edit | Diff generated (RULE-002) | `Proposed` | emit EditProposed (Diff shown) |
| `Proposed` | approval resolves | auto (`--yes`) or user-confirmed | `Approved` | ApprovalDecided |
| `Proposed` | user declines | confirm-each deny | `Denied` | error ToolResult (APPROVAL_DENIED) |
| `Approved` | write attempt | targetPath inside root (RULE-001) | `Applied` | write file; emit EditApplied |
| `Approved` | containment fails or IO error | path escape / write error | `Rejected` | error ToolResult (PATH_ESCAPE / WRITE_FAILED); emit EditRejected |
| `Proposed` | path escape pre-write | containment fails | `Rejected` | error ToolResult (PATH_ESCAPE); emit EditRejected |

**Terminal states:** `Applied`, `Denied`, `Rejected`. **Invalid transitions:** reaching `Applied`
without a Diff (RULE-002) or without a passing containment check (RULE-001) — both rejected.

---

## Error Handling

| Component | Error condition | Owner of handling | Response / recovery | Exposed to caller? |
|---|---|---|---|---|
| `llm-client` | transient API error (429/5xx/timeout) | `llm-client` | retry ≤5 attempts, exp backoff base 1s cap 30s + full jitter; emit LLMRetry | no (retried internally) |
| `llm-client` | retries exhausted / fatal (401/403/400) | `agent-run` | StopCondition = unrecoverable-error → Failed | yes (run outcome) |
| `path-sandbox` | write/exec path escapes root | `path-sandbox` | **fail-closed** — reject before op; error ToolResult (PATH_ESCAPE) | yes (to model as error result) |
| `approval-gate` | user denies edit/command | `approval-gate` | error ToolResult (APPROVAL_DENIED); loop continues | yes (to model) |
| `approval-gate` | user aborts run | `agent-run` | StopCondition = user-abort → Stopped | yes (run outcome) |
| `tool-read` | file not found / not readable | `tool-read` | error ToolResult (READ_FAILED) | yes (to model) |
| `tool-search` | invalid regex | `tool-search` | error ToolResult (BAD_PATTERN) | yes (to model) |
| `tool-writeedit` | search string absent | `tool-writeedit` | error ToolResult (SEARCH_NOT_FOUND), no Edit | yes (to model) |
| `tool-writeedit` | search string ambiguous (>1, no replace-all) | `tool-writeedit` | error ToolResult (SEARCH_AMBIGUOUS), no Edit | yes (to model) |
| `tool-applypatch` | malformed / non-applying patch | `tool-applypatch` | **atomic reject** — PatchRejected error, zero Edits (RULE-013) | yes (to model) |
| `tool-runcommand` | command non-zero exit | `tool-runcommand` | **success** ToolResult with exit/stdout/stderr (a result, not an error — ADR-007) | yes (to model) |
| `tool-runcommand` | spawn failure / timeout | `tool-runcommand` | error ToolResult (COMMAND_FAILED / COMMAND_TIMEOUT) | yes (to model) |
| `tool-registry` | unknown tool name | `tool-registry` | error ToolResult (UNKNOWN_TOOL) (RULE-012) | yes (to model) |
| `budget-stop` | ceiling reached | `budget-stop`/`agent-run` | clean Terminating with StopCondition (RULE-006) | yes (run outcome) |
| `transcript` | write/flush failure | `agent-run` | **fatal** — unrecoverable-error → Failed (audit must not be silently lost — RULE-010) | yes (run outcome) |
| `config` | missing apiKey / invalid root | `config`/`cli` | **fail-fast** in Initializing, actionable message, non-zero exit (RULE-016) | yes (process exit) |

**Error propagation model:** two distinct channels. (1) **Expected tool/loop failures** use a
**result type** — normalized error `ToolResult`s fed back into the conversation so the model can
self-correct (ADR-007, RULE-008); these never throw past `tool-registry`. (2) **Fatal conditions**
(LLM retries exhausted, transcript write failure, config fail-fast, internal invariant breach)
propagate as the `unrecoverable-error` StopCondition (or fail-fast at startup) and terminate the run
cleanly into Failed. The boundary between the two is owned by `agent-run`/`tool-registry` and is drawn
by error **class**, never by blanket catch-all. **Fail-open vs. fail-closed:** the sandbox and config
**fail closed** (reject/abort on any doubt — data-integrity blast-radius); tool operation failures
**fail soft** (return a result, keep the loop alive) by deliberate design (ADR-007).

---

## Concurrency / Ordering / Idempotency

### Concurrency constraints

- **`agent-run`** — **strictly single-threaded and sequential** (ADR-003). One tool call is fully
  resolved (gated, executed, recorded) before the next; there are no parallel tools, no queues, no
  schedulers. The only "concurrency" is the LlmClient's internal retry, which is sequential from the
  loop's view. This is the dominant simplifying constraint of the whole design.
- **`transcript`** — single writer (the run process); append-only file opened once; no concurrent
  writers, so no locking needed.

### Ordering constraints

- **`agent-run`** — Iterations are strictly ordered by index; ToolResults within a turn are recorded
  in dispatch order; the budget guard always runs *before* the model call for a turn.
- **`transcript`** — entries are written in monotonic `seq` order; the write order is the audit order
  (RULE-010).

### Idempotency

- **Tool calls** — **not idempotent in general** and **not deduplicated**: a single run is one
  process, the model never replays an identical ToolCall by accident, and there is no cross-run
  resume in the MVP (resume is a V1 feature — ADR-002). No idempotency key is needed for the MVP.
- **`tool-writeedit` / `tool-applypatch`** — naturally near-idempotent on content (writing the same
  contents twice yields the same file), but each invocation still produces its own Diff + approval;
  no special dedup logic.
- **`config` allowlist add/remove** — idempotent on set membership (adding an existing entry is a
  no-op; removing an absent entry is a no-op) (RULE-014).

---

## Invariants

- **INV-001** — No write or command execution ever resolves outside the canonical WorkingRoot —
  enforced by: `path-sandbox` (fail-closed containment check) — anchors: REQ-021, RULE-001.
- **INV-002** — Reads are never blocked by confinement (read-anywhere asymmetry preserved) —
  enforced by: `path-sandbox` `checkRead` — anchors: REQ-021, RULE-003.
- **INV-003** — No file reaches the Applied state without a corresponding Diff having been generated
  and shown first (no silent writes) — enforced by: `diff-engine` + `tool-writeedit`/`tool-applypatch`
  — anchors: REQ-010, RULE-002.
- **INV-004** — A run never exceeds either Budget ceiling; the budget guard runs before every turn and
  no iteration starts once a ceiling is reached — enforced by: `budget-stop` + `agent-run` — anchors:
  REQ-015, RULE-006.
- **INV-005** — Every run terminates on exactly one StopCondition; non-termination is impossible —
  enforced by: `agent-run` + `budget-stop` — anchors: REQ-014, RULE-007.
- **INV-006** — Process exit code is 0 if and only if the RunOutcome is Succeeded — enforced by:
  `budget-stop` + `cli` — anchors: REQ-020, RULE-011.
- **INV-007** — An ApplyPatch either applies all hunks across all files or produces zero Edits
  (atomicity) — enforced by: `tool-applypatch` — anchors: REQ-023, RULE-013.
- **INV-008** — Every expected tool failure surfaces as an error ToolResult, never an uncaught crash;
  only fatal classes reach the unrecoverable-error path — enforced by: `tool-registry` + `agent-run`
  — anchors: REQ-NFR-004, RULE-008.
- **INV-009** — The Transcript is append-only and strictly seq-ordered; entries are never rewritten or
  deleted, and a failed write fails the run rather than silently losing audit — enforced by:
  `transcript` — anchors: REQ-022, REQ-NFR-008, RULE-010.
- **INV-010** — No non-allowlisted command auto-runs in default mode; chained/redirected commands are
  never auto-run even if a prefix matches — enforced by: `approval-gate`/`allowlist` — anchors:
  REQ-016, RULE-005.
- **INV-011** — The harness (all of the above) is deterministic given stubbed LlmClient + CommandRunner
  — enforced by: the DI seams (ADR-004) — anchors: REQ-NFR-002, RULE-015.

---

## Open Design Questions

> Recorded for the Orchestrator. This stage streams (no interactive AskUserQuestion). All are
> **non-blocking** — each carries an adopted default the Builder can implement; the human may
> override before Stage 8.

- **ODQ-001** — **Allowlist match granularity (token-sequence prefix vs. exact vs. glob).** Adopted
  default: **token-sequence prefix on argv**, with chained/redirected commands (`;`, `&&`, `|`, `>`,
  `$(`, backticks) disqualified from auto-run and forced to confirm. — blocking: no — owner:
  `approval-gate`/`allowlist` — consequence if deferred: contracts/tests in Stage 7/8 must encode this
  match contract; a looser choice would widen the auto-run surface (ADR-006 over-broad-match abuse
  case), so the safe prefix-with-disqualifiers default holds unless the human relaxes it.
- **ODQ-002** — **WriteEdit string-replace on absent/ambiguous search string.** Adopted default:
  zero matches → `SEARCH_NOT_FOUND` (no Edit); >1 match → `SEARCH_AMBIGUOUS` (no Edit) **unless**
  replace-all was explicitly requested. — blocking: no — owner: `tool-writeedit` — consequence if
  deferred: a silent "edit the first match" default would risk wrong-occurrence mutation; fail-on-
  ambiguous is the data-integrity-safe choice and is what the Builder should implement.
- **ODQ-003** — **RunCommand timeout default.** Adopted default: **120 s per command, configurable**;
  timeout → `COMMAND_TIMEOUT` error ToolResult (not a crash). — blocking: no — owner:
  `tool-runcommand`/`command-runner` — consequence if deferred: too-short risks killing legitimate
  test/build runs; too-long weakens runaway protection; 120 s with config override is the reasonable
  middle.
- **ODQ-004** — **Success precedence: tests-pass vs. model-declares-done.** Adopted default
  (matches domain DQ-004 / RULE-009): when a test command is detected, a **passing run of it is the
  authoritative success signal**; absent a runnable test command, the model's declaration is accepted
  as success and the outcome notes tests were not run. — blocking: no — owner: `budget-stop`/
  `agent-run`/`repo-context` — consequence if deferred: without this precedence the model could
  self-declare success on broken code; tests-authoritative is the product's core promise and must be
  the implemented default.
- **ODQ-005** — **Token-usage source when the SDK omits a usage field.** Adopted default (DQ-001):
  trust SDK-reported `input + output` usage; if absent, fall back to a character-based estimate and
  mark the Transcript entry `estimated`. — blocking: no — owner: `llm-client`/`budget-stop` —
  consequence if deferred: an inaccurate estimate could under- or over-enforce the budget ceiling;
  treating the ceiling as a hard pre-turn guard (RULE-006) bounds the impact either way.
