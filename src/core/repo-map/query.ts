/**
 * `th repo relevant` — pure weighted scorer over a LOADED RepoMap.
 *
 * `computeRelevance(map, selector): RelevanceResult` is the single scoring
 * function for SLICE-2. It performs ZERO filesystem access (RULE-007, ADR-002)
 * and operates entirely on the in-memory map passed to it. The result carries:
 *   readFirst / related / tests / owningComponents / doNotTouch / risks /
 *   verifyCandidates / truncated
 * and matches the IF-002 camelCase contract exactly.
 *
 * `computeImpact(map, selector): ImpactResult` is the impact-propagation
 * function for SLICE-3. It performs ZERO filesystem access (RULE-007, ADR-002)
 * and operates entirely on the in-memory map passed to it. The result carries:
 *   selectorKind / selectorValue / impactedComponents / relatedTests /
 *   downstreamFeatures / reqAnchors / artifactStageImplications /
 *   riskFlags / verifyCandidates
 * and matches the IF-003 camelCase contract exactly.
 *
 * Anchor: REQ-RU-021 — full result shape (all seven categories).
 * Anchor: REQ-RU-022 — per-result WHY explanation; every Item has a non-empty why.
 * Anchor: REQ-RU-023 — maxResults bound (default 20; ≤0 treated as default).
 * Anchor: REQ-RU-031 — impact full result shape (impacted components, tests, features, risk flags, verify candidates).
 */

import type {
  RepoMap,
  FileEntry,
  Component,
  BlastRadiusSignal,
  CandidateCommand,
  ImportEdge,
} from "./schema";

// ---------------------------------------------------------------------------
// Public types (IF-002 camelCase shape)
// ---------------------------------------------------------------------------

/** REQ-RU-022 — every returned item carries a non-empty WHY. */
export interface Item {
  path: string;
  why: string;
  score: number;
}

/** Blast-radius signal narrowed to the relevant scope. */
export interface Signal {
  flag: string;
  matchingPaths: string[];
  triggerPatterns: string[];
}

/** Suggested verify command — NEVER executed (RULE-004). */
export interface Cmd {
  label: string;
  raw: string;
  sourceFile: string;
  kind: "build" | "test" | "lint" | "other";
}

/**
 * IF-002 `RelevanceResult` — the full structured data payload.
 * Invariant: readFirst.length + related.length + tests.length ≤ maxResults.
 * truncated:true iff maxResults dropped a scored item.
 */
export interface RelevanceResult {
  selectorKind: "slice" | "req" | "file" | "query";
  selectorValue: string;
  readFirst: Item[];
  related: Item[];
  tests: Item[];
  owningComponents: string[];
  doNotTouch: string[];
  risks: Signal[];
  verifyCandidates: Cmd[];
  truncated: boolean;
  /**
   * P2-8 — precision telemetry. `relatedZeroCoupling` counts `related` suggestions
   * that rest ONLY on a path-token/component heuristic with NO resolved-edge or
   * symbol-match backing — i.e. "related but zero coupling". This is the GATE
   * signal (rev 2 S1/P2-8): it must be measurable before regex/unresolved edges are
   * ever allowed to rank above path-token. Additive (omit-when-default not needed —
   * it is a plain number).
   */
  precision: {
    /** Number of `related` items whose only basis is path-token/component. */
    relatedZeroCoupling: number;
    /** Number of `related` items backed by a resolved import or symbol match. */
    relatedCoupled: number;
  };
  /**
   * P4-4 — true when the underlying scan was PARTIAL (a cap was hit), so the map is
   * INCOMPLETE and this relevance answer may be missing files the scan never saw.
   * Sourced from the persisted `scanReport.capHit` (deterministic marker, P1-2) on the
   * loaded map — NOT a run-varying count. Additive; consumers (and the md renderer)
   * show a PARTIAL banner. `scanIncomplete` is an alias kept for symmetry with the
   * context-pack/MCP shape.
   */
  partial: boolean;
  scanIncomplete: boolean;
}

/** Selector types understood by computeRelevance. */
export type SelectorKind = "slice" | "req" | "file" | "query";

export interface Selector {
  kind: SelectorKind;
  /** The raw selector value (slice ID, REQ-ID, file path, or query string). */
  value: string;
  /**
   * For --slice: the resolved component names (populated by the handler via
   * requireState; absent for req/file/query selectors).
   */
  sliceComponents?: string[];
}

/** Options for computeRelevance. */
export interface RelevanceOptions {
  /**
   * Cap on combined emitted items (readFirst + related + tests).
   * Default 20; ≤0 treated as default (REQ-RU-023).
   */
  maxResults?: number;
}

// ---------------------------------------------------------------------------
// Internal scoring constants
// ---------------------------------------------------------------------------

/** Default maxResults when unset or ≤0 (REQ-RU-023). */
const DEFAULT_MAX_RESULTS = 20;

/**
 * Score weights. Higher = more important = more likely to land in readFirst.
 * These numbers are internal and MUST NOT appear in human text (score is
 * present only in the structured data — IF-002/IF-010).
 */
const WEIGHTS = {
  /** Exact file-path match to the selector (--file or --query matching path). */
  exactPath: 100,
  /** File carries the REQ-ID in its req_ids (--req selector). */
  reqIdOnFile: 90,
  /** File belongs to an owning component of the selected slice. */
  sliceComponent: 80,
  /** File path contains the query keyword (case-insensitive substring). */
  queryPathMatch: 70,
  /** REQ-ID appears in a file's req_ids (query hits a query token). */
  queryReqMatch: 60,
  /**
   * P2-5 — 1-hop RESOLVED import proximity (a `basis:"parsed"` edge directly
   * in/out of a seed file). Set ABOVE siblingComponent because a resolved import is
   * HARD EVIDENCE of coupling, where a shared component is only a path-token
   * heuristic. Only resolved edges earn this; unresolved/external edges earn
   * NOTHING (rev 2 S1: regex/unresolved may never outrank path-token until P2-8
   * telemetry validates them — and we never built a regex tier above this).
   */
  importProximity: 55,
  /** File is a sibling of an exact-match file (same component) — path-token tier. */
  siblingComponent: 40,
  /** P2-5 — query keyword matches an EXPORTED symbol name (parsed evidence). */
  symbolNameMatch: 45,
  /** File matches a blast-radius signal's matching_paths. */
  blastRadius: 30,
  /** Related test file for a selected source file. */
  testRelated: 50,
  /**
   * DEFERRED #2 — lcov coverage association (basis "coverage"). Weighted STRICTLY
   * BELOW `siblingComponent` (40) — the lowest path-token/component signal — so a
   * coverage-only item can NEVER outrank a resolved edge or a path-token. It is a
   * soft "exercised by the same suite" hint, not coupling evidence: coverage-only
   * items are excluded from the P2-8 precision base (REQ-NFR-004 / rev 2 S1).
   */
  coverageSignal: 20,
} as const;

// ---------------------------------------------------------------------------
// Helper utilities (pure)
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function sortedUniq(arr: string[]): string[] {
  return [...new Set(arr)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Case-insensitive substring match. */
function containsCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * P2-6 — name-convention file→test link: does `testPath` look like the test for
 * `srcPath`? Strips test markers (.test/.spec suffix, foo_test.go, test_foo.py) from
 * the test's basename and compares the resulting stem to the source's stem. Pure
 * string logic, language-agnostic, false-negative-favouring.
 */
function testMatchesSourceByName(testPath: string, srcPath: string): boolean {
  const tBase = testPath.split("/").pop() ?? testPath;
  const sBase = srcPath.split("/").pop() ?? srcPath;
  const sStem = sBase.replace(/\.[a-z0-9]+$/i, "");
  // Derive the candidate source stem implied by the test name.
  let tStem = tBase.replace(/\.[a-z0-9]+$/i, ""); // drop extension
  tStem = tStem
    .replace(/\.(test|spec)$/i, "")
    .replace(/_test$/i, "")
    .replace(/^test_/i, "");
  return tStem.length > 0 && tStem.toLowerCase() === sStem.toLowerCase();
}

/**
 * Deterministic stable tie-break: primary score DESC, secondary path ASC.
 * This makes results reproducible across runs (no random sort order).
 */
function stableSort(items: ScoredFile[]): void {
  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = a.file.path;
    const bp = b.file.path;
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  });
}

/** Convert a CandidateCommand (snake_case) to the camelCase Cmd output type. */
function toCmd(c: CandidateCommand): Cmd {
  return {
    label: c.label,
    raw: c.raw,
    sourceFile: c.source_file,
    kind: c.kind,
  };
}

/** Convert a BlastRadiusSignal (snake_case) to the camelCase Signal output type. */
function toSignal(s: BlastRadiusSignal): Signal {
  return {
    flag: s.flag,
    matchingPaths: [...s.matching_paths],
    triggerPatterns: [...s.trigger_patterns],
  };
}

/**
 * P2-5 — set of files within ONE resolved import hop of any seed path. ONLY
 * `basis:"parsed"` edges are followed (unresolved/external edges carry no in-repo
 * target, so they can never contribute a ranking signal — by construction they
 * cannot outrank an honest path-token). Returns seed → reachable-file map for WHY.
 */
function resolvedImportNeighbors(
  edges: ImportEdge[] | undefined,
  seedPaths: Set<string>,
): Map<string, "imports" | "imported-by"> {
  const out = new Map<string, "imports" | "imported-by">();
  if (!edges) return out;
  for (const e of edges) {
    if (e.basis !== "parsed") continue; // resolved-only
    if (seedPaths.has(e.from) && !seedPaths.has(e.to)) {
      if (!out.has(e.to)) out.set(e.to, "imported-by"); // seed imports `to`
    }
    if (seedPaths.has(e.to) && !seedPaths.has(e.from)) {
      if (!out.has(e.from)) out.set(e.from, "imports"); // `from` imports a seed
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seed resolution — maps a selector onto a set of "seed" file paths
// ---------------------------------------------------------------------------

/**
 * Returns the set of file paths that directly match the selector.
 * These seeds drive the subsequent scoring pass.
 */
function resolveSeeds(
  map: RepoMap,
  selector: Selector,
): { seedPaths: Set<string>; seedComponents: Set<string> } {
  const seedPaths = new Set<string>();
  const seedComponents = new Set<string>();

  switch (selector.kind) {
    case "file": {
      // Exact POSIX-normalized path match against the map's file entries.
      const target = toPosix(selector.value);
      for (const f of map.files) {
        if (f.path === target) {
          seedPaths.add(f.path);
          if (f.component) seedComponents.add(f.component);
        }
      }
      break;
    }

    case "req": {
      // All files that carry this REQ-ID in their req_ids.
      const reqId = selector.value;
      for (const f of map.files) {
        if (f.req_ids.includes(reqId)) {
          seedPaths.add(f.path);
          if (f.component) seedComponents.add(f.component);
        }
      }
      break;
    }

    case "slice": {
      // Files belonging to the slice's resolved component set.
      const comps = new Set(selector.sliceComponents ?? []);
      for (const f of map.files) {
        if (f.component && comps.has(f.component)) {
          seedPaths.add(f.path);
          seedComponents.add(f.component);
        }
      }
      break;
    }

    case "query": {
      // Files whose path contains the query keyword (case-insensitive).
      const kw = selector.value;
      for (const f of map.files) {
        if (containsCI(f.path, kw)) {
          seedPaths.add(f.path);
          if (f.component) seedComponents.add(f.component);
        }
        // Also match files that carry a REQ-ID containing the keyword.
        for (const rid of f.req_ids) {
          if (containsCI(rid, kw)) {
            seedPaths.add(f.path);
            if (f.component) seedComponents.add(f.component);
          }
        }
      }
      break;
    }
  }

  return { seedPaths, seedComponents };
}

// ---------------------------------------------------------------------------
// Scoring pass — assigns scores + WHY strings to every file
// ---------------------------------------------------------------------------

interface ScoredFile {
  file: FileEntry;
  score: number;
  why: string;
  /**
   * P2-8 — true when this file earned a HARD-coupling signal (resolved import edge
   * or exported-symbol match) rather than only a path-token/component heuristic.
   */
  coupled: boolean;
  /**
   * DEFERRED #2 — true when this file's ONLY relevance signal is the lcov coverage
   * association (basis "coverage"). Coverage-only items are EXCLUDED from the P2-8
   * precision base (both numerator `relatedCoupled` and denominator `emittedRelated`)
   * so coverage introduces NO new inflation and existing P2-8 semantics are preserved.
   */
  coverageOnly?: boolean;
}

function scoreFiles(
  map: RepoMap,
  selector: Selector,
  seedPaths: Set<string>,
  seedComponents: Set<string>,
): ScoredFile[] {
  const scored: ScoredFile[] = [];

  // Build a set of blast-radius matching paths for fast lookup.
  const blastPaths = new Set<string>();
  for (const sig of map.blast_radius_signals) {
    for (const mp of sig.matching_paths) blastPaths.add(mp);
  }

  // P2-5 — resolved 1-hop import neighbors of the seed set (parsed edges only).
  const importNeighbors = resolvedImportNeighbors(map.edges, seedPaths);

  // DEFERRED #2 — lcov coverage set + whether any SEED is covered. The coverage
  // association only fires when a seed source file is itself in the coverage report
  // (so we relate it to OTHER files the same suite exercises). Absent coverage ⇒
  // empty set ⇒ the signal never fires (byte-identical to a no-coverage map).
  const coverageSet = new Set<string>(map.coverage ?? []);
  const anySeedCovered = [...seedPaths].some((p) => coverageSet.has(p));

  for (const file of map.files) {
    let score = 0;
    const whyParts: string[] = [];
    // P2-8 — did this file earn HARD coupling (resolved import / symbol match)?
    let coupled = false;
    // DEFERRED #2 — track whether the ONLY signal so far is the coverage association.
    let coverageOnly = false;

    if (selector.kind === "file") {
      const target = toPosix(selector.value);
      if (file.path === target) {
        score += WEIGHTS.exactPath;
        whyParts.push(`exact match for --file ${target}`);
      } else if (file.component && seedComponents.has(file.component)) {
        score += WEIGHTS.siblingComponent;
        whyParts.push(`same component (${file.component}) as --file target`);
      }
    }

    if (selector.kind === "req") {
      const reqId = selector.value;
      if (file.req_ids.includes(reqId)) {
        score += WEIGHTS.reqIdOnFile;
        whyParts.push(`carries anchor ${reqId}`);
      } else if (file.component && seedComponents.has(file.component)) {
        score += WEIGHTS.siblingComponent;
        whyParts.push(`same component (${file.component}) as ${reqId} files`);
      }
    }

    if (selector.kind === "slice") {
      const comps = new Set(selector.sliceComponents ?? []);
      if (file.component && comps.has(file.component)) {
        score += WEIGHTS.sliceComponent;
        whyParts.push(`owned by component ${file.component} (slice ${selector.value})`);
      } else if (file.component && seedComponents.has(file.component)) {
        score += WEIGHTS.siblingComponent;
        whyParts.push(`adjacent to slice component ${file.component}`);
      }
    }

    if (selector.kind === "query") {
      const kw = selector.value;
      if (containsCI(file.path, kw)) {
        score += WEIGHTS.queryPathMatch;
        whyParts.push(`path contains query "${kw}"`);
      }
      for (const rid of file.req_ids) {
        if (containsCI(rid, kw)) {
          score += WEIGHTS.queryReqMatch;
          whyParts.push(`REQ-ID ${rid} matches query "${kw}"`);
          break; // one bonus per file
        }
      }
      // P2-5 — query keyword matches an EXPORTED symbol name (parsed evidence).
      if (file.symbols) {
        for (const sym of file.symbols) {
          if (containsCI(sym.name, kw)) {
            score += WEIGHTS.symbolNameMatch;
            whyParts.push(`exports symbol "${sym.name}" matching query "${kw}"`);
            coupled = true;
            break; // one bonus per file
          }
        }
      }
      // Also give sibling bonus if adjacent to seed component.
      if (score === 0 && file.component && seedComponents.has(file.component)) {
        score += WEIGHTS.siblingComponent;
        whyParts.push(`same component (${file.component}) as query-matched files`);
      }
    }

    // P2-5 — RESOLVED 1-hop import proximity (parsed edges only). Hard coupling
    // evidence; ranks ABOVE siblingComponent. A file already scored as an exact/seed
    // match keeps its higher score; a non-seed neighbour gets this bonus so a
    // tightly-coupled importer outranks a merely-same-component sibling.
    const neighbor = importNeighbors.get(file.path);
    if (neighbor && !seedPaths.has(file.path)) {
      score += WEIGHTS.importProximity;
      coupled = true;
      whyParts.push(
        neighbor === "imports"
          ? "imports a selected file (resolved import edge)"
          : "imported by a selected file (resolved import edge)",
      );
    }

    // Blast-radius bonus (applies across all selector kinds).
    if (blastPaths.has(file.path) && score > 0) {
      score += WEIGHTS.blastRadius;
      const flags = map.blast_radius_signals
        .filter((s) => s.matching_paths.includes(file.path))
        .map((s) => s.flag)
        .join(", ");
      whyParts.push(`blast-radius signal: ${flags}`);
    }

    // Test-related bonus: a test file that is a seed via direct path match.
    if (file.is_test && seedPaths.has(file.path)) {
      // Already scored — just ensure it stays high.
      if (score < WEIGHTS.testRelated) score = Math.max(score, WEIGHTS.testRelated);
    }

    // P2-6 — mechanical file→test mapping. A test file is linked to a seed SOURCE
    // file by any of: (a) name convention foo↔foo.test, (b) a resolved test→source
    // import edge, (c) a shared REQ-ID. Each link is labelled in the WHY (the
    // confidence tier is implicit in the basis: import/name/req).
    if (file.is_test && !seedPaths.has(file.path)) {
      const linkReasons: string[] = [];
      // (a) name convention.
      for (const seed of seedPaths) {
        if (seed === file.path) continue;
        if (testMatchesSourceByName(file.path, seed)) {
          linkReasons.push(`name convention links it to ${seed}`);
          break;
        }
      }
      // (b) resolved import edge from this test to a seed.
      if (map.edges) {
        for (const e of map.edges) {
          if (e.basis === "parsed" && e.from === file.path && seedPaths.has(e.to)) {
            linkReasons.push(`imports selected file ${e.to} (resolved edge)`);
            break;
          }
        }
      }
      // (c) shared REQ-ID with a seed file.
      if (linkReasons.length === 0) {
        const seedReqs = new Set<string>();
        for (const sf of map.files) {
          if (seedPaths.has(sf.path)) for (const r of sf.req_ids) seedReqs.add(r);
        }
        const shared = file.req_ids.find((r) => seedReqs.has(r));
        if (shared) linkReasons.push(`covers REQ-ID ${shared} shared with a selected file`);
      }
      if (linkReasons.length > 0) {
        score = Math.max(score, WEIGHTS.testRelated);
        whyParts.push(linkReasons[0]!);
        // A resolved import link (reason mentions "resolved edge") is hard coupling.
        if (linkReasons[0]!.includes("resolved edge")) coupled = true;
      }
    }

    // DEFERRED #2 — lcov coverage association (basis "coverage"). Fires ONLY when a
    // seed source file is itself covered AND this file is also in the coverage set,
    // is NOT a seed, and has earned NO stronger signal yet (score === 0). It is a
    // soft "exercised by the same coverage report" hint, weighted below the lowest
    // path-token signal so it can never outrank a resolved edge or path-token. A file
    // whose only signal is this is flagged `coverageOnly` and excluded from the P2-8
    // precision base.
    if (
      score === 0 &&
      anySeedCovered &&
      !seedPaths.has(file.path) &&
      coverageSet.has(file.path)
    ) {
      score += WEIGHTS.coverageSignal;
      coverageOnly = true;
      whyParts.push("exercised by the same lcov coverage report as a selected file (coverage association)");
    }

    if (score > 0) {
      const why = whyParts.join("; ");
      scored.push({ file, score, why, coupled, ...(coverageOnly ? { coverageOnly: true } : {}) });
    }
  }

  return scored;
}

// ---------------------------------------------------------------------------
// computeRelevance — main export (REQ-RU-021 / REQ-RU-022 / REQ-RU-023)
// ---------------------------------------------------------------------------

/**
 * Pure weighted scorer over a LOADED RepoMap. Performs ZERO filesystem access
 * (RULE-007). Returns all seven result categories with non-empty WHY on every
 * item, capped by maxResults (default 20; ≤0 → default — REQ-RU-023).
 *
 * Selector-matches-nothing → all arrays empty, truncated:false, success (REQ-RU-020).
 *
 * Anchor: REQ-RU-021
 * Anchor: REQ-RU-022
 * Anchor: REQ-RU-023
 */
export function computeRelevance(
  map: RepoMap,
  selector: Selector,
  opts: RelevanceOptions = {},
): RelevanceResult {
  // REQ-RU-023: maxResults default and ≤0 defence.
  const maxResults =
    opts.maxResults !== undefined && opts.maxResults > 0
      ? opts.maxResults
      : DEFAULT_MAX_RESULTS;

  // Step 1: resolve seeds.
  const { seedPaths, seedComponents } = resolveSeeds(map, selector);

  // Step 2: score every file.
  const scored = scoreFiles(map, selector, seedPaths, seedComponents);

  // Step 3: deterministic stable sort (score DESC, path ASC).
  stableSort(scored);

  // Step 4: partition into readFirst / related / tests.
  // readFirst = non-test seed files (high score, directly matched).
  // tests     = test files.
  // related   = everything else that scored > 0.
  const readFirstCandidates: ScoredFile[] = [];
  const testCandidates: ScoredFile[] = [];
  const relatedCandidates: ScoredFile[] = [];

  for (const sf of scored) {
    if (sf.file.is_test) {
      testCandidates.push(sf);
    } else if (seedPaths.has(sf.file.path)) {
      readFirstCandidates.push(sf);
    } else {
      relatedCandidates.push(sf);
    }
  }

  // Step 5: apply maxResults cap across the three arrays combined.
  let budget = maxResults;
  let truncated = false;

  function applyBudget(candidates: ScoredFile[]): Item[] {
    const out: Item[] = [];
    for (const sf of candidates) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      // REQ-RU-022: ensure WHY is non-empty (fallback so invariant is always met).
      const why = sf.why || `scored ${sf.score} for selector ${selector.kind}:${selector.value}`;
      out.push({ path: sf.file.path, why, score: sf.score });
      budget--;
    }
    return out;
  }

  const readFirst = applyBudget(readFirstCandidates);
  const tests = applyBudget(testCandidates);
  const related = applyBudget(relatedCandidates);

  // Step 6: owning components — sorted, deduped (from all seed/scored files).
  const owningComponentSet = new Set<string>();
  for (const sf of scored) {
    if (sf.file.component) owningComponentSet.add(sf.file.component);
  }
  const owningComponents = sortedUniq([...owningComponentSet]);

  // Step 7: doNotTouch = generated_paths (sorted, POSIX).
  const doNotTouch = sortedUniq(
    map.generated_paths.map((p) => toPosix(p)),
  );

  // Step 8: risks — blast-radius signals intersecting the scored scope.
  const relevantFilePaths = new Set(scored.map((sf) => sf.file.path));
  const risks: Signal[] = map.blast_radius_signals
    .filter((sig) => sig.matching_paths.some((mp) => relevantFilePaths.has(mp)))
    .map(toSignal);

  // Step 9: verifyCandidates — inert only (RULE-004); take from candidate_commands.
  const verifyCandidates: Cmd[] = map.candidate_commands.map(toCmd);

  // Step 10 (P2-8): precision telemetry over the EMITTED related set. A related
  // item is "zero-coupling" when it rests only on a path-token/component heuristic
  // (no resolved import / symbol match). This count is the validation gate before
  // any regex/unresolved edge may be promoted above path-token (rev 2 S1).
  // DEFERRED #2 — coverage-only items are EXCLUDED from BOTH the numerator
  // (`relatedCoupled`) AND the denominator (`emittedRelated` / precision base), so a
  // soft coverage association introduces NO new inflation and the EXISTING P2-8
  // semantics (path-token/name-convention items already zero-coupling by design) are
  // preserved unchanged. `relatedZeroCoupling` stays the derived complement over the
  // coverage-free base.
  const emittedRelated = relatedCandidates
    .slice(0, related.length)
    .filter((sf) => !sf.coverageOnly);
  let relatedCoupled = 0;
  for (const sf of emittedRelated) if (sf.coupled) relatedCoupled++;
  const precision = {
    relatedZeroCoupling: emittedRelated.length - relatedCoupled,
    relatedCoupled,
  };

  // P4-4 — partial-scan marker from the loaded map's persisted scanReport.
  const partial = map.scanReport.capHit !== null;

  return {
    selectorKind: selector.kind,
    selectorValue: selector.value,
    readFirst,
    related,
    tests,
    owningComponents,
    doNotTouch,
    risks,
    verifyCandidates,
    truncated,
    precision,
    partial,
    scanIncomplete: partial,
  };
}

// ---------------------------------------------------------------------------
// computeImpact — IF-003 (SLICE-3 / TASK-008)
// ---------------------------------------------------------------------------

/**
 * IF-003 ImpactItem — a named artifact and a non-empty WHY.
 * REQ-RU-022: every item carries a non-empty why.
 */
export interface ImpactItem {
  name: string;
  /** Non-empty human-readable explanation (REQ-RU-022). */
  why: string;
}

/**
 * IF-003 ImpactResult — the full structured data payload for `th repo impact`.
 *
 * Anchor: REQ-RU-031
 * Anchor: REQ-RU-022
 */
/**
 * P2-7 — an impacted FILE with a per-edge basis + confidence so a consumer can tell
 * HARD coupling (a resolved import) from a SOFT heuristic (same component / path
 * token). `basis` mirrors the Provenance vocabulary; `confidence` follows it.
 */
export interface ImpactedFile {
  path: string;
  why: string;
  basis: "parsed" | "component" | "path-token";
  confidence: "high" | "medium" | "low";
}

export interface ImpactResult {
  selectorKind: "file" | "component";
  selectorValue: string;
  impactedComponents: ImpactItem[];
  relatedTests: ImpactItem[];
  downstreamFeatures: ImpactItem[];
  /** Sorted, deduplicated REQ-IDs that surface in the impact scope. */
  reqAnchors: string[];
  /** Informational artifact/stage implications derived from the impact scope. */
  artifactStageImplications: string[];
  /** Blast-radius signals whose matching_paths intersect the impact scope. */
  riskFlags: Signal[];
  /** Suggested verify commands — NEVER executed (RULE-004). */
  verifyCandidates: Cmd[];
  /**
   * P2-7 — files DIRECTLY impacted: the seed + 1-hop RESOLVED importers (parsed
   * edges). High/medium confidence; the only files we assert are coupled.
   */
  directImpact: ImpactedFile[];
  /**
   * P2-7 — files POSSIBLY impacted: same-component siblings (path-token) — a "verify"
   * tier, never asserted as certain.
   */
  possibleImpact: ImpactedFile[];
  /**
   * P2-7 — true when the impact scope rests on path-token/component heuristics with
   * NO resolved-edge backing, or when edges were unresolved. Consumers add a caveat.
   */
  caveat: boolean;
  /**
   * P4-4 — true when the underlying scan was PARTIAL (a cap was hit): the map is
   * INCOMPLETE so importers/impact in unscanned regions are invisible. Sourced from the
   * persisted `scanReport.capHit` (P1-2), not a run-varying count. `scanIncomplete` is
   * an alias for symmetry with the context-pack/MCP shape.
   */
  partial: boolean;
  scanIncomplete: boolean;
}

/** Selector for computeImpact (file path or component name). */
export interface ImpactSelector {
  kind: "file" | "component";
  value: string;
}

/**
 * Pure impact-propagation walk over a LOADED RepoMap. Performs ZERO filesystem
 * access (RULE-007). Returns all result categories with non-empty WHY on every
 * item.
 *
 * Selector-matches-nothing → all arrays empty, SUCCESS (REQ-RU-030).
 * Risk flags surface when blast_radius_signals intersect impact scope (REQ-RU-031).
 *
 * Anchor: REQ-RU-031
 * Anchor: REQ-RU-022
 */
export function computeImpact(
  map: RepoMap,
  selector: ImpactSelector,
): ImpactResult {
  // Step 1: resolve the seed file paths and seed components from the selector.
  const seedPaths = new Set<string>();
  const seedComponents = new Set<string>();

  if (selector.kind === "file") {
    const target = toPosix(selector.value);
    for (const f of map.files) {
      if (f.path === target) {
        seedPaths.add(f.path);
        if (f.component) seedComponents.add(f.component);
      }
    }
  } else {
    // component selector: match by component name (exact) OR path prefix.
    const compName = toPosix(selector.value);
    for (const f of map.files) {
      if (
        f.component === compName ||
        (f.component && f.component.startsWith(compName + "/"))
      ) {
        seedPaths.add(f.path);
        seedComponents.add(f.component!);
      }
    }
    // Also match component records whose name equals the selector.
    for (const c of map.components) {
      if (toPosix(c.name) === compName) {
        seedComponents.add(c.name);
      }
    }
  }

  // If nothing matched, return an empty-but-valid result (REQ-RU-030).
  if (seedPaths.size === 0 && seedComponents.size === 0) {
    return {
      selectorKind: selector.kind,
      selectorValue: selector.value,
      impactedComponents: [],
      relatedTests: [],
      downstreamFeatures: [],
      reqAnchors: [],
      artifactStageImplications: [],
      riskFlags: [],
      verifyCandidates: map.candidate_commands.map(toCmd),
      directImpact: [],
      possibleImpact: [],
      caveat: false,
      // P4-4 — even a no-match result reflects the scan completeness of the loaded map.
      partial: map.scanReport.capHit !== null,
      scanIncomplete: map.scanReport.capHit !== null,
    };
  }

  // Step 2: collect all impacted files — the seed set itself + files in seed components.
  const impactedFilePaths = new Set<string>(seedPaths);
  for (const f of map.files) {
    if (f.component && seedComponents.has(f.component)) {
      impactedFilePaths.add(f.path);
    }
  }

  // Step 3: derive impactedComponents from the seed components (non-test owning components).
  const impactedComponents: ImpactItem[] = [];
  const seenComponents = new Set<string>();
  for (const compName of sortedUniq([...seedComponents])) {
    if (seenComponents.has(compName)) continue;
    seenComponents.add(compName);
    let why: string;
    if (selector.kind === "file") {
      why = `contains --file target ${toPosix(selector.value)}`;
    } else {
      why = `matches --component selector "${selector.value}"`;
    }
    impactedComponents.push({ name: compName, why });
  }

  // Also include components that have files sharing a seed component
  // (sibling components touched by the impact scope).
  // Currently we report the direct seed components only (as per IF-003 scope).

  // Step 4: related tests — test files whose req_ids overlap with the scope req_ids,
  // OR test files in the seed components.
  const scopeReqIds = new Set<string>();
  for (const f of map.files) {
    if (impactedFilePaths.has(f.path)) {
      for (const rid of f.req_ids) scopeReqIds.add(rid);
    }
  }

  const relatedTests: ImpactItem[] = [];
  const seenTestPaths = new Set<string>();
  for (const f of map.files) {
    if (!f.is_test) continue;
    if (seenTestPaths.has(f.path)) continue;

    let whyParts: string[] = [];

    // Test in same component as the seed.
    if (f.component && seedComponents.has(f.component)) {
      whyParts.push(`test in component ${f.component} (part of impact scope)`);
    }

    // Test carries a req_id that appears in the impact scope.
    const overlapping = f.req_ids.filter((rid) => scopeReqIds.has(rid));
    if (overlapping.length > 0) {
      whyParts.push(`covers REQ-IDs in scope: ${overlapping.join(", ")}`);
    }

    if (whyParts.length > 0) {
      seenTestPaths.add(f.path);
      // REQ-RU-022: non-empty why.
      relatedTests.push({ name: f.path, why: whyParts.join("; ") });
    }
  }

  // Step 5: downstream features — entrypoints whose path is in the impact scope
  // or whose name suggests a feature tied to the impacted components.
  const downstreamFeatures: ImpactItem[] = [];
  const seenFeatures = new Set<string>();
  for (const ep of map.entrypoints) {
    if (seenFeatures.has(ep.name)) continue;
    const epPath = toPosix(ep.path);
    if (impactedFilePaths.has(epPath)) {
      seenFeatures.add(ep.name);
      downstreamFeatures.push({
        name: ep.name,
        why: `entrypoint at ${epPath} is in the impact scope`,
      });
    }
  }
  // Also include ownership-hint-derived features whose path_prefix matches a seed component.
  for (const hint of map.ownership_hints) {
    const prefix = toPosix(hint.path_prefix);
    if (seedComponents.has(hint.component) && !seenFeatures.has(hint.component)) {
      seenFeatures.add(hint.component);
      downstreamFeatures.push({
        name: hint.component,
        why: `ownership hint at ${prefix} is in the impact scope (component: ${hint.component})`,
      });
    }
  }

  // Step 6: reqAnchors — sorted, deduped REQ-IDs from all impacted files.
  const reqAnchors = sortedUniq([...scopeReqIds]);

  // Step 7: artifactStageImplications — informational.
  const artifactStageImplications: string[] = [];
  if (reqAnchors.length > 0) {
    artifactStageImplications.push(
      `${reqAnchors.length} REQ-ID(s) in scope — review docs/01-requirements.md for impact on acceptance criteria`,
    );
  }
  if (impactedComponents.length > 0) {
    const compList = impactedComponents.map((c) => c.name).join(", ");
    artifactStageImplications.push(
      `Component(s) affected: ${compList} — update docs/09-implementation-plan.md if slice scope changes`,
    );
  }

  // Step 8: riskFlags — blast-radius signals whose matching_paths intersect the impact scope.
  // REQ-RU-031: risk flags surface when signals intersect the impact scope.
  const riskFlags: Signal[] = map.blast_radius_signals
    .filter((sig) => sig.matching_paths.some((mp) => impactedFilePaths.has(mp)))
    .map(toSignal);

  // Step 9: verifyCandidates — inert only (RULE-004).
  const verifyCandidates: Cmd[] = map.candidate_commands.map(toCmd);

  // Step 10 (P2-7): split DIRECT impact (seed + 1-hop resolved importers) from
  // POSSIBLE impact (same-component siblings, path-token). Per-edge basis+confidence.
  const directImpact: ImpactedFile[] = [];
  const directSeen = new Set<string>();
  for (const sp of sortedUniq([...seedPaths])) {
    directImpact.push({
      path: sp,
      why:
        selector.kind === "file"
          ? "selected file (seed)"
          : `in selected component (seed)`,
      basis: selector.kind === "file" ? "parsed" : "component",
      confidence: selector.kind === "file" ? "high" : "medium",
    });
    directSeen.add(sp);
  }
  // 1-hop RESOLVED importers of any seed (parsed edges only — hard evidence).
  let hadResolvedImporter = false;
  if (map.edges) {
    for (const e of map.edges) {
      if (e.basis !== "parsed") continue;
      if (seedPaths.has(e.to) && !directSeen.has(e.from)) {
        directSeen.add(e.from);
        hadResolvedImporter = true;
        directImpact.push({
          path: e.from,
          why: `imports ${e.to} (resolved import edge)`,
          basis: "parsed",
          confidence: "high",
        });
      }
    }
  }
  // POSSIBLE: same-component files not already in directImpact (path-token heuristic).
  const possibleImpact: ImpactedFile[] = [];
  for (const fp of sortedUniq([...impactedFilePaths])) {
    if (directSeen.has(fp)) continue;
    possibleImpact.push({
      path: fp,
      why: "same component as the impact scope (path-token heuristic — verify)",
      basis: "path-token",
      confidence: "low",
    });
  }
  // Caveat: the impact rests on heuristics when there were NO resolved importers
  // beyond the seed, OR when any edge touching a seed was unresolved/external.
  const hadUnresolvedSeedEdge =
    map.edges?.some((e) => e.basis === "unresolved" && seedPaths.has(e.from)) ?? false;
  const caveat = !hadResolvedImporter || hadUnresolvedSeedEdge || possibleImpact.length > 0;

  return {
    selectorKind: selector.kind,
    selectorValue: selector.value,
    impactedComponents,
    relatedTests,
    downstreamFeatures,
    reqAnchors,
    artifactStageImplications,
    riskFlags,
    verifyCandidates,
    directImpact,
    possibleImpact,
    caveat,
    // P4-4 — partial-scan marker from the loaded map's persisted scanReport.
    partial: map.scanReport.capHit !== null,
    scanIncomplete: map.scanReport.capHit !== null,
  };
}
