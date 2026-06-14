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
  /** REQ-ID appears in a file's req_ids (query hits a req token). */
  queryReqMatch: 60,
  /** File is a sibling of an exact-match file (same component). */
  siblingComponent: 40,
  /** File matches a blast-radius signal's matching_paths. */
  blastRadius: 30,
  /** Related test file for a selected source file. */
  testRelated: 50,
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

  for (const file of map.files) {
    let score = 0;
    const whyParts: string[] = [];

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
      // Also give sibling bonus if adjacent to seed component.
      if (score === 0 && file.component && seedComponents.has(file.component)) {
        score += WEIGHTS.siblingComponent;
        whyParts.push(`same component (${file.component}) as query-matched files`);
      }
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

    if (score > 0) {
      const why = whyParts.join("; ");
      scored.push({ file, score, why });
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
  };
}
