/**
 * Assertion-presence sensor + receipt store + the mutation-kill external store/validator
 * (Axis-B slice-6 / BSC-2). The completion gate currently counts a REQ as "tested" when its
 * anchor appears in a RECOGNIZED test file (`coverage.ts:isRecognizedTestFile`), but a test
 * file that carries NO non-trivial assertion — an empty `it()`, a smoke test that only
 * constructs a value, a tautology like `expect(true).toBe(true)` — clears that bar. "Tested"
 * is asserted with no executable check that can FAIL. This module is the SENSOR: it derives,
 * per REQ-ID, the recomputable assertion-presence summary and mints a schema-registered
 * {@link AssertionPresenceReceipt} whose ground is re-derivable at gate time, so a REQ whose
 * tests carry no non-trivial assertion is mechanically detectable (2a). It ALSO owns the
 * external mutation-report store + validator (2b) — the stronger, independently-grounded
 * form: a controlled runner proves the suite actually KILLS injected faults.
 *
 * BINDING CONTRACT (the single most important correctness rule of the slice, Principle 6):
 *   - The sensor is REGEX/LEXER-GRADE ONLY. It NEVER imports `typescript` or any AST library
 *     (a devDependency-only tool); the `expect(...)` count is a hand-rolled balanced-paren
 *     scan whose `expect`-token search is LEXER-AWARE (string literals + line/block comments
 *     are skipped, so a commented/stringified `expect(...)` is never miscounted as a real
 *     assertion). The pinned assertion + trivial definition is hashed INTO the ground, so producer
 *     and validator can never drift on what "asserted" means.
 *   - The ground is DETERMINISTIC: REQ summaries sorted lexically by `reqId`, each
 *     `testFiles[]` lexically sorted + POSIX-normalized, NO clock / NO random / NO `Date`.
 *     The serialized ground is byte-identical regardless of `readdirSync` order — the
 *     `scanDirForReqIds` determinism hazard (`anchors.ts` returns first-seen readdir order)
 *     is neutralized by sorting on the way out.
 *   - Recognized-but-UNPARSED test files (Go `_test.go`, Python `test_*.py`, anything not a
 *     JS/TS source extension) are FAIL-CLOSED unobserved — never silently counted as
 *     asserted. A REQ whose test files are ALL unparsed gets `assertionFree:true` so the gate
 *     fail-closes on it (it becomes an offender unless waiver-covered). A MIXED REQ with ≥1
 *     parseable file counts only the parseable assertions.
 *
 * KNOWN LIMITATIONS (disclosed, not silently ignored — review notes 6/7):
 *   - DETERMINISM UNDER CAP-TRUNCATION: the sensor's input recognition inherits
 *     `anchors.ts:scanDirForReqIds`'s file-count / total-bytes caps. If a `tests/` tree exceeds
 *     those caps, the scan TRUNCATES and the truncated set is `readdirSync`-order-dependent — so
 *     the ground is NOT fully deterministic in the cap-truncated regime. The real TwinHarness
 *     `tests/` dir is far below the cap, so the ground is deterministic in practice; a
 *     cap-robust deterministic partial scan (e.g. order-stable truncation) is OUT OF SCOPE for
 *     this slice and tracked as future work, not a silent hazard.
 *   - NO-ARG SMOKE MATCHERS COUNT AS NON-TRIVIAL: an `expect(<non-literal>).toBeDefined()` /
 *     `.toBeTruthy()` (a matcher with no argument over a non-literal subject) is classified
 *     NON-trivial (it is not literal-vs-literal and not a tautology). This is a known
 *     FALSE-NEGATIVE class of the offender detector — a smoke assertion that can technically
 *     fail but asserts little. Acceptable for a PRESENCE-not-efficacy sensor (the genuine
 *     efficacy grade is the 2b external mutation-kill receipt); tightening it is future work.
 *
 * Storage mirrors `src/core/verification-driver.ts` / `src/core/realization.ts` EXACTLY: a
 * DEDICATED, lock-isolated append-only SHA-256 hash-chained
 * `<stateDir>/assertion-presence-receipts.jsonl`, a tolerant reader, a tail-scan for the next
 * `prevHash`, an atomic-append writer that runs under the CALLER's `withStateLock` span, and a
 * tamper-detecting chain walk. The mutation-kill receipts live in a SEPARATE lock-isolated
 * `<stateDir>/external-mutation-receipts.jsonl` (parallel to the external driver/realization
 * stores) — the out-of-process controlled runner appends there without taking the in-process
 * lock; the security boundary is the private key, not the path.
 *
 * `producer_identity` carries ZERO trust weight in-process (the in-process 2a pass status is
 * `valid`, NEVER `valid-grounded`): an audit breadcrumb only. The genuine un-forgeable
 * property is the 2b {@link MutationKillReceipt}, signed by an external keyed producer at a
 * write-surface TwinHarness cannot reach.
 *
 * It REUSES the shared digest/snapshot primitives (`currentReceiptSnapshotCoord`,
 * `SnapshotCoord`, `hashContent`) and signing infra (`receipt-signing.ts`); the sensor's
 * input recognition reuses `coverage.ts:isRecognizedTestFile` + `anchors.ts:scanDirForReqIds`.
 * It does NOT import or touch `tester.ts` (the F8 call path stays byte-identical).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { KeyObject } from "node:crypto";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface, resolveWithinRoot } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";
import { scanDirForReqIds } from "./anchors";
import { isRecognizedTestFile } from "./coverage";
import {
  type AssertionReqSummary,
  type AssertionPresenceGround,
  type AssertionPresenceReceipt,
  type MutationKillGround,
  type MutationKillReceipt,
  type SnapshotCoord,
  currentReceiptSnapshotCoord,
} from "./receipts";
import { externalKeyId, loadExternalPublicKey, verifyCanonical } from "./receipt-signing";

// Re-export the schema types so Lane B/C/D import the assertion-presence surface from ONE module.
export type {
  AssertionReqSummary,
  AssertionPresenceGround,
  AssertionPresenceReceipt,
  MutationKillGround,
  MutationKillReceipt,
} from "./receipts";

// ---------------------------------------------------------------------------
// The deterministic, regex/lexer-grade SENSOR (Principle 6 — binding contract)
// ---------------------------------------------------------------------------

/**
 * File extensions whose contents the sensor PARSES for `expect(...)` assertions. Everything
 * else recognized as a test (Go `_test.go`, Python `test_*.py`, …) is UNPARSED → fail-closed
 * unobserved. Lowercased; the predicate lowercases the name before matching.
 */
const PARSEABLE_TEST_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

/** True iff `relPosix`'s extension is one the sensor can `expect(...)`-scan. */
function isParseableTestFile(relPosix: string): boolean {
  const lower = relPosix.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return PARSEABLE_TEST_EXTENSIONS.has(lower.slice(dot));
}

/**
 * PINNED literal predicate (hashed into the ground — do NOT deviate). True iff `s` is a
 * deterministic literal with no runtime evaluation: a number, a quoted string / template, or
 * one of the reserved literals. Used by the trivial-assertion rule. Deterministic, no eval.
 */
function isLiteral(s: string): boolean {
  const t = s.trim();
  if (t === "") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return true; // number
  if (/^(['"`]).*\1$/.test(t)) return true; // quoted string / template literal
  if (/^(true|false|null|undefined|NaN)$/.test(t)) return true; // reserved literal
  return false;
}

/**
 * Find the index of the `(` that opens an `expect` call at or after `from`, ignoring any
 * `expect` that is part of a longer identifier (e.g. `expectThing`). The search is LEXER-AWARE:
 * it skips string literals and line/block comments so an `expect(` token that lives INSIDE a
 * string or comment is NEVER treated as a real assertion (it does not execute). `matchingParen`
 * only protects the paren scan AFTER an open paren; the token search itself must skip strings/
 * comments too, else a commented/stringified `expect(x).toBe(y)` would be miscounted as a
 * non-trivial assertion and let an assertion-free REQ pass the rung. Returns `-1` when none.
 */
function nextExpectOpenParen(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    // Skip string literals and comments so a token inside them is never matched.
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(text, i, c);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    // A `/` that is neither `//` nor `/*` may open a REGEX LITERAL whose body can contain
    // quotes/backticks (e.g. `/[`'\"]/`). If we did not skip it, the scan would mistake an
    // embedded quote for a string start and desync over the rest of the file. `skipRegexOrSlash`
    // is SELF-BOUNDED: it consumes a single-line regex body to its closing `/`, but bails (one
    // char) at a newline or unbalanced tail, so a real DIVISION `a / b` is harmless.
    if (c === "/") {
      i = skipRegexOrSlash(text, i);
      continue;
    }
    // A code-position `expect` token: not preceded/continued by an identifier char (`fooexpect`
    // / `expectThing`), and the next non-space char is `(` (`foo.expect(` still counts — a `.`
    // before is fine).
    if (
      text.startsWith("expect", i) &&
      !/[A-Za-z0-9_$]/.test(i === 0 ? "" : text[i - 1]!) &&
      !/[A-Za-z0-9_$]/.test(text[i + 6] ?? "")
    ) {
      let j = i + 6;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "(") return j;
    }
    i++;
  }
  return -1;
}

/**
 * Consume a `/`-led token that is NOT a comment: a regex literal `/…/` (honoring `\` escapes
 * and `[...]` char classes, inside which `/` does not close) returns the index just past the
 * closing `/`; a `/` that reaches a newline or EOF without closing (i.e. a DIVISION operator,
 * not a regex) returns `start + 1` so the caller simply advances one char. Self-bounded — never
 * skips across a newline, so misclassifying division as a regex can only over-skip within one
 * line, never desync the whole-file scan (the regression a naive string-skip caused).
 */
function skipRegexOrSlash(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return start + 1; // unterminated on this line ⇒ a division `/`, not a regex
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1; // closing regex delimiter
    i++;
  }
  return start + 1; // EOF without close ⇒ treat as a lone `/`
}

/**
 * Scan forward from the index of an open `(` and return the index of its MATCHING close `)`,
 * tracking nested parens, plus single/double/template-string and line/block-comment state so
 * a paren inside a string or comment never miscounts. Returns `-1` on an unbalanced tail.
 */
function matchingParen(text: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i]!;
    // String literals: skip to the closing quote (respecting escapes).
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(text, i, c);
      continue;
    }
    // Comments.
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Given the index of an opening quote `quote` at `text[start]`, return the index just PAST the
 * closing quote, honoring backslash escapes. (Template-literal `${...}` interpolation is not
 * separately balanced — a `)` inside an interpolation is rare in an `expect(...)` argument and
 * a missed one only over/under-counts an assertion deterministically, never throws.)
 */
function skipString(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return text.length;
}

/**
 * The matcher modifier chain segments skipped when locating the FIRST real matcher after an
 * `expect(...)` (e.g. `expect(x).not.toBe(y)` — skip `.not`, take `.toBe`). Lowercased compare.
 */
const MATCHER_MODIFIERS: ReadonlySet<string> = new Set(["not", "resolves", "rejects"]);

/**
 * Starting just after an `expect(A)` close paren at `afterExpect`, find the FIRST matcher
 * `.<name>(B)` (skipping `.not` / `.resolves` / `.rejects` modifier links) and return its
 * argument text `B`, or `undefined` when the matcher takes no argument (e.g. `.toBeDefined()`)
 * or no matcher is present. Deterministic; never throws.
 */
function firstMatcherArg(text: string, afterExpect: number): string | undefined {
  let i = afterExpect;
  for (;;) {
    // Require a `.` (after optional whitespace) to continue the chain.
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] !== ".") return undefined;
    i++;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    // Read the member name.
    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9_$]/.test(text[i]!)) i++;
    const name = text.slice(nameStart, i).toLowerCase();
    if (name === "") return undefined;
    // A modifier link (`.not` / `.resolves` / `.rejects`) is skipped; continue the chain.
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (MATCHER_MODIFIERS.has(name) && text[i] !== "(") {
      continue; // bare modifier member → keep walking to the real matcher
    }
    // The first member followed by a call `(...)` is the matcher.
    if (text[i] === "(") {
      const close = matchingParen(text, i);
      if (close < 0) return undefined;
      return text.slice(i + 1, close);
    }
    // A member with no call (unlikely after expect) — no matcher arg.
    return undefined;
  }
}

/** Counts produced by scanning one parseable test file's `expect(...)` chains. */
interface FileAssertionCounts {
  /** Total `expect(...)` chains found. */
  total: number;
  /** Of those, the trivial (cannot-fail) ones. */
  trivial: number;
}

/**
 * Count the `expect(...)` assertions in one parseable test file's text and classify each as
 * trivial or not under the PINNED rule (hashed into the ground — do NOT deviate):
 *
 *   An assertion = an `expect(` call. For `expect(A)`, take the FIRST matcher `.<name>(B)`
 *   after it (skipping `.not`/`.resolves`/`.rejects`); `B` may be undefined.
 *   TRIVIAL (cannot-fail) iff:
 *     - `isLiteral(A) && (B === undefined || isLiteral(B))`               (literal-vs-literal /
 *       literal-with-no-arg matcher, e.g. `expect(true).toBe(true)`, `expect(1).toBeGreaterThan(0)`)
 *     - OR `(A !== "" && A === B)` (tautology, e.g. `expect(x).toBe(x)`)
 *   Both `A` and `B` are compared trimmed.
 */
function countAssertionsInText(text: string): FileAssertionCounts {
  let total = 0;
  let trivial = 0;
  let cursor = 0;
  for (;;) {
    const open = nextExpectOpenParen(text, cursor);
    if (open < 0) break;
    const close = matchingParen(text, open);
    if (close < 0) break; // unbalanced tail — stop counting (deterministic)
    total++;
    const argA = text.slice(open + 1, close).trim();
    const argBraw = firstMatcherArg(text, close + 1);
    const argB = argBraw === undefined ? undefined : argBraw.trim();
    const literalCase = isLiteral(argA) && (argB === undefined || isLiteral(argB));
    const tautologyCase = argA !== "" && argB !== undefined && argA === argB;
    if (literalCase || tautologyCase) trivial++;
    cursor = close + 1;
  }
  return { total, trivial };
}

/** Options for {@link computeAssertionPresenceGround}. */
export interface ComputeAssertionGroundOptions {
  /** The tests directory to scan (default `<root>/tests`, same default as `computeBreakdown`). */
  testsDir?: string;
}

/**
 * The deterministic, regex/lexer-grade SENSOR (Principle 6 — binding contract). Computes the
 * per-REQ assertion-presence ground from the recognized test files under `testsDir`:
 *
 *  1. `scanDirForReqIds(testsDir)` → REQ-ID → files (root-relative, forward-slash). Keep ONLY
 *     files where `isRecognizedTestFile` is true (a prose/fixture file under `tests/` is not a
 *     test and never anchors assertion presence).
 *  2. For each REQ: `testFiles` = the recognized files anchoring it, lexically sorted (already
 *     POSIX-normalized by `scanDirForReqIds`).
 *  3. PARSEABLE files (JS/TS extensions) are read + `expect(...)`-scanned; UNPARSED recognized
 *     files (Go/Python/etc.) are fail-closed unobserved — never counted as asserted. A REQ with
 *     NO parseable file gets `assertionCount=0, nonTrivialAssertions=0, assertionFree=true`, so
 *     the gate fail-closes on it. A MIXED REQ counts only its parseable files' assertions.
 *  4. `assertionCount` = total `expect()` across parseable testFiles; `nonTrivialAssertions =
 *     assertionCount - trivial`; `assertionFree = nonTrivialAssertions === 0`.
 *
 * DETERMINISM (P6, binding): the REQ summaries are sorted lexically by `reqId` and each
 * `testFiles[]` is sorted, so the serialized ground is byte-identical regardless of
 * `readdirSync` order. NO clock, NO random.
 */
export function computeAssertionPresenceGround(
  paths: ProjectPaths,
  opts: ComputeAssertionGroundOptions = {},
): AssertionPresenceGround {
  const testsDir = opts.testsDir ?? path.resolve(paths.root, "tests");
  const anchors = scanDirForReqIds(testsDir);

  const summaries: AssertionReqSummary[] = [];
  for (const [reqId, files] of anchors) {
    // Recognized test files only, lexically sorted + POSIX-normalized.
    const testFiles = files.filter((f) => isRecognizedTestFile(f)).sort();
    if (testFiles.length === 0) continue; // anchor only in a non-test file → not "tested" here

    let assertionCount = 0;
    let trivial = 0;
    for (const rel of testFiles) {
      if (!isParseableTestFile(rel)) continue; // UNPARSED → fail-closed unobserved
      const abs = resolveWithinRoot(testsDir, rel);
      if (abs === null) continue; // path-escape (defensive; scan paths are contained)
      let content: string;
      try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue; // unreadable → unobserved (fail-closed)
      }
      const counts = countAssertionsInText(content);
      assertionCount += counts.total;
      trivial += counts.trivial;
    }

    const nonTrivialAssertions = assertionCount - trivial;
    summaries.push({
      reqId,
      testFiles,
      assertionCount,
      nonTrivialAssertions,
      assertionFree: nonTrivialAssertions === 0,
    });
  }

  summaries.sort((a, b) => (a.reqId < b.reqId ? -1 : a.reqId > b.reqId ? 1 : 0));
  return summaries;
}

// ---------------------------------------------------------------------------
// Ground serialization + digest (deterministic, byte-stable)
// ---------------------------------------------------------------------------

/** Canonical key order for one {@link AssertionReqSummary} (byte-stable nested JSON). */
const SUMMARY_FIELD_ORDER: ReadonlyArray<keyof AssertionReqSummary> = [
  "reqId",
  "testFiles",
  "assertionCount",
  "nonTrivialAssertions",
  "assertionFree",
];

/** Canonical key order for {@link MutationKillGround} (byte-stable nested JSON). */
const MUTATION_GROUND_FIELD_ORDER: ReadonlyArray<keyof MutationKillGround> = [
  "mutants_generated",
  "mutants_killed",
  "mutants_survived",
  "score",
  "scope",
];

/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder<T extends object>(obj: T, order: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) out[key as string] = obj[key];
  return out;
}

/** Re-emit one assertion-presence summary in its fixed key order (`testFiles` already sorted). */
function reorderSummary(summary: AssertionReqSummary): Record<string, unknown> {
  return reorder(summary, SUMMARY_FIELD_ORDER);
}

/**
 * Canonical JSON of an assertion-presence ground: the array (already sorted by `reqId`) with
 * each summary's keys in the FIXED {@link SUMMARY_FIELD_ORDER}. Byte-identical regardless of
 * `readdirSync` order (the determinism property of the sensor).
 */
export function serializeAssertionGround(ground: AssertionPresenceGround): string {
  return JSON.stringify(ground.map(reorderSummary));
}

/** Content digest of an assertion-presence ground = SHA-256 of its canonical serialization. */
export function assertionGroundDigest(ground: AssertionPresenceGround): string {
  return hashContent(serializeAssertionGround(ground));
}

// ---------------------------------------------------------------------------
// AssertionPresenceReceipt — canonical text + hashing (mirrors verification-driver.ts)
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing an {@link AssertionPresenceReceipt}. `recordHash`
 * is an EXCLUDED trailer; `undefined` keys are dropped (so an omitted `legacy` is byte-stable);
 * the `ground` array is re-emitted via the sorted summary serializer's element ordering and the
 * `snapshot_coord` via its fixed key order. This receipt is in-process-only (NO signing fields).
 */
const ASSERTION_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof AssertionPresenceReceipt> = [
  "kind",
  "refId",
  "ground",
  "snapshot_coord",
  "producer_identity",
  "legacy",
  "prevHash",
];

/**
 * Deterministic canonical text of an assertion-presence receipt for hashing. Field order is
 * fixed; `undefined` keys and `recordHash` are dropped; the `ground` is re-emitted via the
 * sorted serializer's element ordering and the snapshot object in its fixed key order;
 * `JSON.stringify` with no indentation. `hashContent` then CRLF→LF normalizes (harmless).
 */
export function assertionPresenceCanonicalText(
  receipt: Omit<AssertionPresenceReceipt, "recordHash">,
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ASSERTION_CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "ground") {
      ordered[key] = (val as AssertionPresenceGround).map(reorderSummary);
    } else if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for an assertion-presence receipt = SHA-256 of its canonical text. */
export function computeAssertionPresenceRecordHash(
  receipt: Omit<AssertionPresenceReceipt, "recordHash">,
): string {
  return hashContent(assertionPresenceCanonicalText(receipt));
}

// ---------------------------------------------------------------------------
// AssertionPresenceReceipt — storage (mirrors verification-driver.ts)
// ---------------------------------------------------------------------------

/** `<stateDir>/assertion-presence-receipts.jsonl` — the in-process assertion-presence ledger. */
export function assertionPresenceReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "assertion-presence-receipts.jsonl");
}

/** Validate the shape of a parsed assertion-presence line; malformed lines are skipped (tolerant). */
export function isValidAssertionPresenceReceipt(parsed: unknown): parsed is AssertionPresenceReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "assertion-presence") return false;
  if (typeof r.refId !== "string" || r.refId === "") return false;
  if (typeof r.producer_identity !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (r.legacy !== undefined && typeof r.legacy !== "boolean") return false;
  // Ground: a present array of well-shaped per-REQ summaries.
  if (!Array.isArray(r.ground)) return false;
  for (const s of r.ground) {
    if (typeof s !== "object" || s === null) return false;
    const sm = s as Record<string, unknown>;
    if (typeof sm.reqId !== "string" || sm.reqId === "") return false;
    if (!Array.isArray(sm.testFiles) || !sm.testFiles.every((f) => typeof f === "string")) return false;
    if (typeof sm.assertionCount !== "number" || !Number.isFinite(sm.assertionCount)) return false;
    if (typeof sm.nonTrivialAssertions !== "number" || !Number.isFinite(sm.nonTrivialAssertions)) return false;
    if (typeof sm.assertionFree !== "boolean") return false;
  }
  // Snapshot coordinate must be present + shaped.
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every assertion-presence receipt in the in-process store, in file order.
 * Missing file → `[]`. Bad lines are silently skipped — tolerant, never throws. Chain breaks
 * surface via {@link verifyAssertionPresenceChain}.
 */
export function readAssertionPresenceReceipts(paths: ProjectPaths): AssertionPresenceReceipt[] {
  return readJsonlValues(assertionPresenceReceiptsPath(paths), isValidAssertionPresenceReceipt);
}

/**
 * The `recordHash` of the in-process ledger's last VALID assertion-presence receipt — the seed
 * {@link appendAssertionPresenceReceipt} needs to seal the next link. Tail-scans the file so N
 * appends stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
export function readLastAssertionPresenceRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(assertionPresenceReceiptsPath(paths), isValidAssertionPresenceReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk assertion-presence receipts in file order with a running `expectedPrev = GENESIS`. For
 * each: recompute `recordHash` from its canonical text — a mismatch means the record was
 * edited; if `prevHash !== expectedPrev` the line was inserted/deleted/reordered. Return
 * `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical posture to
 * `verification-driver.verifyDriverChain`.
 */
export function verifyAssertionPresenceChain(receipts: AssertionPresenceReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeAssertionPresenceRecordHash(rest);
    if (recomputed !== recordHash) {
      return { ok: false, brokenAt: i, reason: "edited" };
    }
    if (r.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    expectedPrev = r.recordHash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// AssertionPresenceReceipt — producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------

/** Input to {@link appendAssertionPresenceReceipt}. */
export interface MintAssertionPresenceInput {
  /** Self-asserted producer identity (zero in-process trust weight). */
  producerIdentity: string;
  /** Optional tests-dir override (forwarded to the sensor; default `<root>/tests`). */
  testsDir?: string;
}

/**
 * Append one in-process assertion-presence receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there), exactly like
 * `appendDriverReceipt`.
 *
 * SENSOR-at-mint: the ground is computed FRESH by {@link computeAssertionPresenceGround} (the
 * ONLY thing recordable — never a caller-supplied summary). The receipt records the ground +
 * the current snapshot coordinate, derives `prevHash` from the tail, computes `recordHash`,
 * asserts the write-surface, and atomically appends. This receipt is in-process-only (no
 * signing fields). Returns the sealed receipt.
 */
export function appendAssertionPresenceReceipt(
  paths: ProjectPaths,
  input: MintAssertionPresenceInput,
): AssertionPresenceReceipt {
  const ground = computeAssertionPresenceGround(paths, { testsDir: input.testsDir });
  return sealAndAppendAssertion(paths, {
    kind: "assertion-presence",
    refId: assertionRefId(paths),
    ground,
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: input.producerIdentity,
  });
}

/**
 * The run identity a fresh receipt grounds: the current `gitHead`, or `"no-git"` on a non-git
 * checkout. A re-run at a new HEAD mints a receipt under a new refId, so the gate finds the
 * LATEST receipt for the current snapshot.
 */
function assertionRefId(paths: ProjectPaths): string {
  return currentReceiptSnapshotCoord(paths).gitHead ?? "no-git";
}

/**
 * The shared seal+append chokepoint for assertion-presence receipts: derive `prevHash` from the
 * tail, compute `recordHash`, assert the governed write-surface, mkdir, atomically append.
 */
function sealAndAppendAssertion(
  paths: ProjectPaths,
  receipt: Omit<AssertionPresenceReceipt, "prevHash" | "recordHash">,
): AssertionPresenceReceipt {
  assertGovernedWriteSurface(paths.root, assertionPresenceReceiptsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastAssertionPresenceRecordHash(paths);
  const withPrev: Omit<AssertionPresenceReceipt, "recordHash"> = { ...receipt, prevHash };
  const recordHash = computeAssertionPresenceRecordHash(withPrev);
  const sealed: AssertionPresenceReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(assertionPresenceReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ---------------------------------------------------------------------------
// AssertionPresenceReceipt — content validation (the digest-recompute / validator)
// ---------------------------------------------------------------------------

/**
 * The content-validation status of an assertion-presence receipt's GROUND, independent of the
 * gate's higher-level offender/absent classification (which Lane C owns):
 *  - `assertion_unobserved` — RESERVED for the gate's no-receipt fail-closed case (no receipt
 *                             present at all). Defined here; emitted by Lane C, not by
 *                             {@link validateAssertionPresenceContent} (which always has a receipt).
 *  - `target_mismatch`      — the recomputed ground's digest ≠ the receipt's recorded ground
 *                             digest (test files changed after recording — the F8 diffable-ground bite).
 *  - `stale`                — the recorded `snapshot_coord` diverged (gitHead/treeDigest).
 *  - `valid`                — the ground recomputes identically and the snapshot matches.
 */
export type AssertionContentStatus = "assertion_unobserved" | "target_mismatch" | "stale" | "valid";

/** The content-validation outcome + diagnostics. */
export interface AssertionContentValidation {
  status: AssertionContentStatus;
  /** On `stale`: which coordinate(s) diverged (`gitHead` / `treeDigest`). */
  staleReasons?: string[];
  /**
   * The reqIds with `assertionFree === true` in the RECOMPUTED ground — exposed for the gate's
   * convenience (the offender/assertion-free CONTENT decision is the gate's, Lane C). Lexically
   * sorted. Present on every status (computed from the fresh recompute).
   */
  offenders?: string[];
}

/**
 * Compare a recorded coordinate against the current one under the F8 rule: a coordinate
 * discriminates ONLY when BOTH the recorded and the current value are non-null. A null on
 * either side is non-discriminating and never contributes staleness.
 */
function snapshotStaleReasons(recorded: SnapshotCoord, current: SnapshotCoord): string[] {
  const reasons: string[] = [];
  if (recorded.gitHead !== null && current.gitHead !== null && recorded.gitHead !== current.gitHead) {
    reasons.push("gitHead");
  }
  if (
    recorded.treeDigest !== null &&
    current.treeDigest !== null &&
    recorded.treeDigest !== current.treeDigest
  ) {
    reasons.push("treeDigest");
  }
  return reasons;
}

/** The reqIds with `assertionFree === true` in a ground, lexically sorted (the offender set). */
function assertionFreeOffenders(ground: AssertionPresenceGround): string[] {
  return ground
    .filter((s) => s.assertionFree)
    .map((s) => s.reqId)
    .sort();
}

/**
 * Re-derive an assertion-presence receipt's GROUND at gate time and classify it — the
 * digest-recompute / validator (the F8 "recomputable ground" property). Recompute the ground
 * fresh; if its digest ≠ the receipt's recorded ground digest → `target_mismatch` (test files
 * changed after recording). Else snapshot staleness under the F8 rule → `stale`. Else `valid`.
 *
 * The `offenders` field (reqIds with `assertionFree===true` from the RECOMPUTED ground) is
 * exposed for the gate's convenience on every status; the offender/assertion-free CONTENT
 * decision belongs to the gate (Lane C). `assertion_unobserved` is the gate's no-receipt token
 * and is NEVER returned here (this function always has a receipt).
 */
export function validateAssertionPresenceContent(
  paths: ProjectPaths,
  receipt: AssertionPresenceReceipt,
): AssertionContentValidation {
  const recomputed = computeAssertionPresenceGround(paths);
  const offenders = assertionFreeOffenders(recomputed);

  if (assertionGroundDigest(recomputed) !== assertionGroundDigest(receipt.ground)) {
    return { status: "target_mismatch", offenders };
  }

  const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, currentReceiptSnapshotCoord(paths));
  if (staleReasons.length > 0) return { status: "stale", staleReasons, offenders };

  return { status: "valid", offenders };
}

// ---------------------------------------------------------------------------
// MutationKillReceipt — canonical text + hashing (controlled-runner, ALWAYS signed)
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing/signing a {@link MutationKillReceipt}. `signature`
 * and `recordHash` are EXCLUDED trailers (computed over the IDENTICAL bytes); the `ground` is
 * re-emitted in its fixed key order and the snapshot likewise. `producer_kind` is the fixed
 * `"controlled-runner"` literal — part of the signed input.
 */
const MUTATION_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof MutationKillReceipt> = [
  "kind",
  "refId",
  "ground",
  "snapshot_coord",
  "producer_kind",
  "key_id",
  "prevHash",
];

/**
 * Deterministic canonical text of a mutation-kill receipt for hashing/signing. Field order is
 * fixed; `undefined` keys, `recordHash`, and `signature` are dropped; the `ground` is re-emitted
 * in its fixed key order and the snapshot likewise; `JSON.stringify` with no indentation.
 */
export function mutationKillCanonicalText(receipt: Omit<MutationKillReceipt, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of MUTATION_CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "ground") {
      ordered[key] = reorder(val as MutationKillGround, MUTATION_GROUND_FIELD_ORDER);
    } else if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for a mutation-kill receipt = SHA-256 of its canonical text (signature excluded). */
export function computeMutationKillRecordHash(receipt: Omit<MutationKillReceipt, "recordHash">): string {
  return hashContent(mutationKillCanonicalText(receipt));
}

// ---------------------------------------------------------------------------
// MutationKillReceipt — storage (external, lock-isolated, like external-driver-receipts.jsonl)
// ---------------------------------------------------------------------------

/**
 * `<stateDir>/external-mutation-receipts.jsonl` — the EXTERNAL controlled-runner producer's
 * store. A SEPARATE file for LOCK-ISOLATION (parallel to `external-driver-receipts.jsonl`): the
 * out-of-process producer appends here without taking the in-process `withStateLock` span. The
 * SECURITY boundary is NOT this path — it is the private key held only by the producer; a forged
 * line written here is rejected by {@link readMutationKillValidated} (no verifying signature ⇒
 * `forged`).
 */
export function externalMutationReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "external-mutation-receipts.jsonl");
}

const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** Validate the shape of a parsed mutation-kill line; malformed lines are skipped (tolerant). */
export function isValidMutationKillReceipt(parsed: unknown): parsed is MutationKillReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "mutation-kill") return false;
  if (typeof r.refId !== "string" || r.refId === "") return false;
  if (r.producer_kind !== "controlled-runner") return false;
  if (typeof r.key_id !== "string" || r.key_id === "") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (
    r.signature !== undefined &&
    (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))
  ) {
    return false;
  }
  // Ground must be present + shaped (all numeric fields finite, scope a string).
  const g = r.ground;
  if (typeof g !== "object" || g === null) return false;
  const gm = g as Record<string, unknown>;
  for (const k of ["mutants_generated", "mutants_killed", "mutants_survived", "score"] as const) {
    if (typeof gm[k] !== "number" || !Number.isFinite(gm[k])) return false;
  }
  if (typeof gm.scope !== "string") return false;
  // Snapshot coordinate must be present + shaped.
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every mutation-kill receipt in the EXTERNAL store, in file order. Missing file →
 * `[]`. Bad lines skipped — tolerant, never throws. The signature is verified at gate time by
 * {@link readMutationKillValidated}, NOT here — this reader is shape-only, so a forged-but-well-
 * shaped line is returned and then classified `forged` downstream.
 */
export function readExternalMutationReceipts(paths: ProjectPaths): MutationKillReceipt[] {
  return readJsonlValues(externalMutationReceiptsPath(paths), isValidMutationKillReceipt);
}

/**
 * The `recordHash` of the EXTERNAL store's last valid mutation-kill receipt — the `prevHash`
 * seed for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the standalone producer (`--kind mutation-kill`).
 */
export function readLastExternalMutationRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(externalMutationReceiptsPath(paths), isValidMutationKillReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * Walk mutation-kill receipts in file order with a running `expectedPrev = GENESIS`. For each:
 * recompute `recordHash` from its canonical text — a mismatch means the record was edited; if
 * `prevHash !== expectedPrev` the line was inserted/deleted/reordered. Return
 * `{ ok:false, brokenAt:N }` at the FIRST break; else advance.
 */
export function verifyMutationChain(receipts: MutationKillReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeMutationKillRecordHash(rest);
    if (recomputed !== recordHash) {
      return { ok: false, brokenAt: i, reason: "edited" };
    }
    if (r.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    expectedPrev = r.recordHash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MutationKillReceipt — validator (gate trust axis: valid-grounded / forged / absent)
// ---------------------------------------------------------------------------

/** The validated mutation-kill result the gate consumes (Lane C composes it into the rung). */
export interface ValidatedMutationKill {
  /**
   * - `valid-grounded` — a controlled-runner receipt whose Ed25519 signature verifies (the
   *                      LATEST verifying candidate). The ONLY trusted label.
   * - `forged`         — ≥1 controlled-runner receipt is present but NONE verifies (key absent,
   *                      chain broken, or every signature bad) → BLOCK.
   * - `absent`         — no controlled-runner receipt present at all.
   */
  status: "valid-grounded" | "forged" | "absent";
  /** The verifying receipt on `valid-grounded`; the last present candidate on `forged`. */
  receipt?: MutationKillReceipt;
}

/** Verify a mutation-kill receipt's Ed25519 signature against the loaded external public key. */
function signatureVerifies(receipt: MutationKillReceipt): boolean {
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return false;
  if (typeof receipt.signature !== "string") return false;
  if (receipt.key_id !== externalKeyId(publicKey)) return false;
  const { recordHash: _rh, signature: _sig, ...signedView } = receipt;
  return verifyCanonical(mutationKillCanonicalText(signedView), receipt.signature, publicKey);
}

/**
 * Validate the external mutation-kill store (BSC-2 2b). Walks the external chain once — a
 * tampered chain is fail-closed (no candidate is trusted, so a present claim forces `forged`,
 * never a silent downgrade). Gathers every controlled-runner candidate and verifies each
 * Ed25519 signature with the loaded public key. The LAST verifying candidate (a re-mint wins)
 * ⇒ `valid-grounded`; a present-but-none-verifies set ⇒ `forged`; none present ⇒ `absent`.
 *
 * Mirrors `realization.readRealizationReceiptValidated`'s external precedence, but there is NO
 * in-process fallback (this receipt is ALWAYS externally produced/signed).
 */
export function readMutationKillValidated(paths: ProjectPaths): ValidatedMutationKill {
  const receipts = readExternalMutationReceipts(paths);
  const candidates = receipts.filter((r) => r.producer_kind === "controlled-runner");
  if (candidates.length === 0) return { status: "absent" };

  const chainOk = verifyMutationChain(receipts).ok;
  const publicKey = loadExternalPublicKey();
  if (publicKey !== null && chainOk) {
    // The LAST verifying candidate in file order (a re-mint wins).
    let verified: MutationKillReceipt | undefined;
    for (const cand of candidates) {
      if (signatureVerifies(cand)) verified = cand;
    }
    if (verified) return { status: "valid-grounded", receipt: verified };
  }
  // Present claim(s) but none verified (key absent, chain broken, or all signatures bad) → forged.
  return { status: "forged", receipt: candidates[candidates.length - 1] };
}

// ---------------------------------------------------------------------------
// AssertionWaiver — the signed, path/digest-scoped escape valve (BSC-2 Lane C, D3)
// ---------------------------------------------------------------------------

/**
 * An external-signed, per-REQ, digest-scoped waiver that exonerates a SINGLE assertion-free
 * REQ-ID from the assertion-presence rung (the escape valve for an honestly assertion-free
 * REQ — e.g. a pure type-level or generated-code REQ). It is NOT agent-self-issuable: the
 * SECURITY boundary is the Ed25519 PRIVATE key held only by the external producer (the
 * in-process surface holds the verify-only public key and provably cannot forge one —
 * mirrors the scan-exception ack + the slice-1b grounded/forged asymmetry).
 *
 * SCOPED BY GROUND DIGEST (re-derivable, path-bound): `groundDigest` is
 * `assertionGroundDigest([thatReqsSummary])` — the digest of the SINGLE REQ's RECOMPUTED
 * {@link AssertionReqSummary} at waive time. The summary embeds the REQ's sorted `testFiles`
 * + assertion counts, so editing the REQ's test files (or its assertion shape) changes the
 * digest and INVALIDATES the waiver. A waiver therefore covers EXACTLY the assertion shape
 * it was signed against, never a later-edited one. `signature` and `recordHash` are TRAILERS
 * excluded from the canonical text (computed over the IDENTICAL canonical input), exactly
 * like a scan-exception ack / terminal receipt.
 */
export interface AssertionWaiver {
  kind: "assertion-waiver";
  /** The REQ-ID this waiver exonerates (must be non-empty — an empty reqId exempts NOTHING). */
  reqId: string;
  /** `assertionGroundDigest([summary])` of the REQ's recomputed summary at waive time (64 hex). */
  groundDigest: string;
  /** The repository snapshot coordinate at sign time (audit context; not the binding axis). */
  snapshot_coord: SnapshotCoord;
  /** ALWAYS `"external"` — there is no in-process producer. Part of the signed canonical input. */
  producer_kind: "external";
  /** Short, non-secret id of the public key that verifies this waiver (`externalKeyId`). */
  key_id: string;
  /** Ed25519 signature over the canonical text (excluded trailer). Absent ⇒ exempts NOTHING. */
  signature?: string;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS waiver's canonical text (signature excluded). */
  recordHash: string;
}

/**
 * `<stateDir>/assertion-waivers.jsonl` — the EXTERNAL-signed waiver store. A SEPARATE file
 * for LOCK-ISOLATION (parallel to `external-mutation-receipts.jsonl` / `scan-exceptions.jsonl`):
 * the out-of-process producer appends here without taking the in-process `withStateLock` span.
 * The SECURITY boundary is NOT this path — it is the private key; a forged line written here is
 * rejected by {@link validWaivedReqs} (no verifying signature ⇒ exempts NOTHING).
 */
export function assertionWaiversPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "assertion-waivers.jsonl");
}

/**
 * Canonical field order for a waiver (signature + recordHash excluded — they are trailers).
 * The SINGLE formula the external producer (at sign time) and the in-process validator (at
 * gate time) both use, so they can never diverge on the binding.
 */
const ASSERTION_WAIVER_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof AssertionWaiver> = [
  "kind",
  "reqId",
  "groundDigest",
  "snapshot_coord",
  "producer_kind",
  "key_id",
  "prevHash",
];

/**
 * Deterministic canonical text of a waiver for signing + hashing: fixed field order, the
 * nested `snapshot_coord` re-emitted in its fixed key order, `signature`/`recordHash` dropped;
 * `JSON.stringify` with no indentation. `hashContent` then CRLF→LF normalizes (harmless).
 */
export function assertionWaiverCanonicalText(
  waiver: Omit<AssertionWaiver, "signature" | "recordHash">,
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ASSERTION_WAIVER_CANONICAL_FIELD_ORDER) {
    const val = (waiver as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for a waiver = SHA-256 of its canonical text. */
export function computeAssertionWaiverRecordHash(
  waiver: Omit<AssertionWaiver, "signature" | "recordHash">,
): string {
  return hashContent(assertionWaiverCanonicalText(waiver));
}

/** Tolerant shape check for a waiver line (a malformed line is skipped, never trusted). */
export function isValidAssertionWaiver(parsed: unknown): parsed is AssertionWaiver {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "assertion-waiver") return false;
  if (typeof r.reqId !== "string" || r.reqId === "") return false;
  if (typeof r.groundDigest !== "string" || !HEX64.test(r.groundDigest)) return false;
  if (r.producer_kind !== "external") return false;
  if (typeof r.key_id !== "string" || r.key_id === "") return false;
  if (
    r.signature !== undefined &&
    (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))
  ) {
    return false;
  }
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/** Read every (well-shaped) waiver, file order. Signatures verified at gate time, NOT here. */
export function readAssertionWaivers(paths: ProjectPaths): AssertionWaiver[] {
  return readJsonlValues(assertionWaiversPath(paths), isValidAssertionWaiver);
}

/** The `recordHash` of the waiver store's last valid line — the producer's `prevHash` seed. */
export function readLastExternalAssertionWaiverRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(assertionWaiversPath(paths), isValidAssertionWaiver);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * Walk waivers in file order with a running `expectedPrev = GENESIS`. For each: recompute
 * `recordHash` from its canonical text — a mismatch means the record was edited; if
 * `prevHash !== expectedPrev` the line was inserted/deleted/reordered. Return
 * `{ ok:false, brokenAt:N }` at the FIRST break; else advance.
 */
export function verifyAssertionWaiverChain(waivers: AssertionWaiver[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < waivers.length; i++) {
    const w = waivers[i]!;
    const { recordHash, signature: _sig, ...rest } = w;
    const recomputed = computeAssertionWaiverRecordHash(rest);
    if (recomputed !== recordHash) {
      return { ok: false, brokenAt: i, reason: "edited" };
    }
    if (w.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    expectedPrev = w.recordHash;
  }
  return { ok: true };
}

/** Verify a waiver's Ed25519 signature against the loaded external public key. */
function waiverSignatureVerifies(waiver: AssertionWaiver, publicKey: KeyObject): boolean {
  if (typeof waiver.signature !== "string") return false;
  if (waiver.key_id !== externalKeyId(publicKey)) return false;
  const { recordHash: _rh, signature, ...signedView } = waiver;
  return verifyCanonical(assertionWaiverCanonicalText(signedView), signature, publicKey);
}

/**
 * The CURRENT ground digest of a single REQ — `assertionGroundDigest([summary])` of the REQ's
 * RECOMPUTED summary. Returns `null` when the REQ has no summary in the fresh recompute (so a
 * waiver for a non-existent / no-longer-tested REQ can never match a digest and exempts NOTHING).
 */
function currentReqGroundDigest(paths: ProjectPaths, reqId: string): string | null {
  const ground = computeAssertionPresenceGround(paths);
  const summary = ground.find((s) => s.reqId === reqId);
  if (summary === undefined) return null;
  return assertionGroundDigest([summary]);
}

/**
 * The set of REQ-IDs validly WAIVED for the current run (BSC-2 Lane C, D3 — the gate subtracts
 * these from the offender set). A waiver exempts its `reqId` ONLY when ALL of:
 *   1. The waiver chain verifies (a tampered chain exempts NOTHING — fail-closed).
 *   2. An external public key is loaded AND the waiver's Ed25519 signature verifies under it
 *      with a matching `key_id` (an unsigned / wrong-key / self-signed line exempts NOTHING —
 *      the in-process surface holds no private key, so it cannot mint one).
 *   3. The waiver's `groundDigest` equals the digest of the REQ's CURRENT recomputed summary
 *      (editing the REQ's test files changes the digest → the waiver no longer matches →
 *      exempts NOTHING; path/digest-scoped, re-derivable).
 *   4. `reqId` is non-empty (an over-broad empty/missing reqId is rejected by the shape check).
 *
 * This is negative-control (d): an over-broad, unsigned, wrong-key, or digest-mismatched
 * waiver exempts NOTHING. With no key loaded (the default fork/local/test path) NO waiver can
 * verify, so the set is empty and the gate enforces fully.
 */
export function validWaivedReqs(paths: ProjectPaths): Set<string> {
  const waivers = readAssertionWaivers(paths);
  if (waivers.length === 0) return new Set();
  // Fail-closed: a tampered chain exempts NOTHING (no line from a tampered store is trusted).
  if (!verifyAssertionWaiverChain(waivers).ok) return new Set();
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return new Set(); // no key ⇒ nothing verifies ⇒ exempt NOTHING

  const exempt = new Set<string>();
  for (const w of waivers) {
    if (!waiverSignatureVerifies(w, publicKey)) continue;
    const current = currentReqGroundDigest(paths, w.reqId);
    if (current === null || current !== w.groundDigest) continue; // digest-scoped (re-derivable)
    exempt.add(w.reqId);
  }
  return exempt;
}
