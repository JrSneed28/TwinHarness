"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeRelevance = computeRelevance;
exports.computeImpact = computeImpact;
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
};
// ---------------------------------------------------------------------------
// Helper utilities (pure)
// ---------------------------------------------------------------------------
function toPosix(p) {
    return p.replace(/\\/g, "/");
}
function sortedUniq(arr) {
    return [...new Set(arr)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
/** Case-insensitive substring match. */
function containsCI(haystack, needle) {
    return haystack.toLowerCase().includes(needle.toLowerCase());
}
/**
 * P2-6 — name-convention file→test link: does `testPath` look like the test for
 * `srcPath`? Strips test markers (.test/.spec suffix, foo_test.go, test_foo.py) from
 * the test's basename and compares the resulting stem to the source's stem. Pure
 * string logic, language-agnostic, false-negative-favouring.
 */
function testMatchesSourceByName(testPath, srcPath) {
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
function stableSort(items) {
    items.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        const ap = a.file.path;
        const bp = b.file.path;
        return ap < bp ? -1 : ap > bp ? 1 : 0;
    });
}
/** Convert a CandidateCommand (snake_case) to the camelCase Cmd output type. */
function toCmd(c) {
    return {
        label: c.label,
        raw: c.raw,
        sourceFile: c.source_file,
        kind: c.kind,
    };
}
/** Convert a BlastRadiusSignal (snake_case) to the camelCase Signal output type. */
function toSignal(s) {
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
function resolvedImportNeighbors(edges, seedPaths) {
    const out = new Map();
    if (!edges)
        return out;
    for (const e of edges) {
        if (e.basis !== "parsed")
            continue; // resolved-only
        if (seedPaths.has(e.from) && !seedPaths.has(e.to)) {
            if (!out.has(e.to))
                out.set(e.to, "imported-by"); // seed imports `to`
        }
        if (seedPaths.has(e.to) && !seedPaths.has(e.from)) {
            if (!out.has(e.from))
                out.set(e.from, "imports"); // `from` imports a seed
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
function resolveSeeds(map, selector) {
    const seedPaths = new Set();
    const seedComponents = new Set();
    switch (selector.kind) {
        case "file": {
            // Exact POSIX-normalized path match against the map's file entries.
            const target = toPosix(selector.value);
            for (const f of map.files) {
                if (f.path === target) {
                    seedPaths.add(f.path);
                    if (f.component)
                        seedComponents.add(f.component);
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
                    if (f.component)
                        seedComponents.add(f.component);
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
                    if (f.component)
                        seedComponents.add(f.component);
                }
                // Also match files that carry a REQ-ID containing the keyword.
                for (const rid of f.req_ids) {
                    if (containsCI(rid, kw)) {
                        seedPaths.add(f.path);
                        if (f.component)
                            seedComponents.add(f.component);
                    }
                }
            }
            break;
        }
    }
    return { seedPaths, seedComponents };
}
function scoreFiles(map, selector, seedPaths, seedComponents) {
    const scored = [];
    // Build a set of blast-radius matching paths for fast lookup.
    const blastPaths = new Set();
    for (const sig of map.blast_radius_signals) {
        for (const mp of sig.matching_paths)
            blastPaths.add(mp);
    }
    // P2-5 — resolved 1-hop import neighbors of the seed set (parsed edges only).
    const importNeighbors = resolvedImportNeighbors(map.edges, seedPaths);
    for (const file of map.files) {
        let score = 0;
        const whyParts = [];
        // P2-8 — did this file earn HARD coupling (resolved import / symbol match)?
        let coupled = false;
        if (selector.kind === "file") {
            const target = toPosix(selector.value);
            if (file.path === target) {
                score += WEIGHTS.exactPath;
                whyParts.push(`exact match for --file ${target}`);
            }
            else if (file.component && seedComponents.has(file.component)) {
                score += WEIGHTS.siblingComponent;
                whyParts.push(`same component (${file.component}) as --file target`);
            }
        }
        if (selector.kind === "req") {
            const reqId = selector.value;
            if (file.req_ids.includes(reqId)) {
                score += WEIGHTS.reqIdOnFile;
                whyParts.push(`carries anchor ${reqId}`);
            }
            else if (file.component && seedComponents.has(file.component)) {
                score += WEIGHTS.siblingComponent;
                whyParts.push(`same component (${file.component}) as ${reqId} files`);
            }
        }
        if (selector.kind === "slice") {
            const comps = new Set(selector.sliceComponents ?? []);
            if (file.component && comps.has(file.component)) {
                score += WEIGHTS.sliceComponent;
                whyParts.push(`owned by component ${file.component} (slice ${selector.value})`);
            }
            else if (file.component && seedComponents.has(file.component)) {
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
            whyParts.push(neighbor === "imports"
                ? "imports a selected file (resolved import edge)"
                : "imported by a selected file (resolved import edge)");
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
            if (score < WEIGHTS.testRelated)
                score = Math.max(score, WEIGHTS.testRelated);
        }
        // P2-6 — mechanical file→test mapping. A test file is linked to a seed SOURCE
        // file by any of: (a) name convention foo↔foo.test, (b) a resolved test→source
        // import edge, (c) a shared REQ-ID. Each link is labelled in the WHY (the
        // confidence tier is implicit in the basis: import/name/req).
        if (file.is_test && !seedPaths.has(file.path)) {
            const linkReasons = [];
            // (a) name convention.
            for (const seed of seedPaths) {
                if (seed === file.path)
                    continue;
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
                const seedReqs = new Set();
                for (const sf of map.files) {
                    if (seedPaths.has(sf.path))
                        for (const r of sf.req_ids)
                            seedReqs.add(r);
                }
                const shared = file.req_ids.find((r) => seedReqs.has(r));
                if (shared)
                    linkReasons.push(`covers REQ-ID ${shared} shared with a selected file`);
            }
            if (linkReasons.length > 0) {
                score = Math.max(score, WEIGHTS.testRelated);
                whyParts.push(linkReasons[0]);
                // A resolved import link (reason mentions "resolved edge") is hard coupling.
                if (linkReasons[0].includes("resolved edge"))
                    coupled = true;
            }
        }
        if (score > 0) {
            const why = whyParts.join("; ");
            scored.push({ file, score, why, coupled });
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
function computeRelevance(map, selector, opts = {}) {
    // REQ-RU-023: maxResults default and ≤0 defence.
    const maxResults = opts.maxResults !== undefined && opts.maxResults > 0
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
    const readFirstCandidates = [];
    const testCandidates = [];
    const relatedCandidates = [];
    for (const sf of scored) {
        if (sf.file.is_test) {
            testCandidates.push(sf);
        }
        else if (seedPaths.has(sf.file.path)) {
            readFirstCandidates.push(sf);
        }
        else {
            relatedCandidates.push(sf);
        }
    }
    // Step 5: apply maxResults cap across the three arrays combined.
    let budget = maxResults;
    let truncated = false;
    function applyBudget(candidates) {
        const out = [];
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
    const owningComponentSet = new Set();
    for (const sf of scored) {
        if (sf.file.component)
            owningComponentSet.add(sf.file.component);
    }
    const owningComponents = sortedUniq([...owningComponentSet]);
    // Step 7: doNotTouch = generated_paths (sorted, POSIX).
    const doNotTouch = sortedUniq(map.generated_paths.map((p) => toPosix(p)));
    // Step 8: risks — blast-radius signals intersecting the scored scope.
    const relevantFilePaths = new Set(scored.map((sf) => sf.file.path));
    const risks = map.blast_radius_signals
        .filter((sig) => sig.matching_paths.some((mp) => relevantFilePaths.has(mp)))
        .map(toSignal);
    // Step 9: verifyCandidates — inert only (RULE-004); take from candidate_commands.
    const verifyCandidates = map.candidate_commands.map(toCmd);
    // Step 10 (P2-8): precision telemetry over the EMITTED related set. A related
    // item is "zero-coupling" when it rests only on a path-token/component heuristic
    // (no resolved import / symbol match). This count is the validation gate before
    // any regex/unresolved edge may be promoted above path-token (rev 2 S1).
    const emittedRelated = relatedCandidates.slice(0, related.length);
    let relatedCoupled = 0;
    for (const sf of emittedRelated)
        if (sf.coupled)
            relatedCoupled++;
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
function computeImpact(map, selector) {
    // Step 1: resolve the seed file paths and seed components from the selector.
    const seedPaths = new Set();
    const seedComponents = new Set();
    if (selector.kind === "file") {
        const target = toPosix(selector.value);
        for (const f of map.files) {
            if (f.path === target) {
                seedPaths.add(f.path);
                if (f.component)
                    seedComponents.add(f.component);
            }
        }
    }
    else {
        // component selector: match by component name (exact) OR path prefix.
        const compName = toPosix(selector.value);
        for (const f of map.files) {
            if (f.component === compName ||
                (f.component && f.component.startsWith(compName + "/"))) {
                seedPaths.add(f.path);
                seedComponents.add(f.component);
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
    const impactedFilePaths = new Set(seedPaths);
    for (const f of map.files) {
        if (f.component && seedComponents.has(f.component)) {
            impactedFilePaths.add(f.path);
        }
    }
    // Step 3: derive impactedComponents from the seed components (non-test owning components).
    const impactedComponents = [];
    const seenComponents = new Set();
    for (const compName of sortedUniq([...seedComponents])) {
        if (seenComponents.has(compName))
            continue;
        seenComponents.add(compName);
        let why;
        if (selector.kind === "file") {
            why = `contains --file target ${toPosix(selector.value)}`;
        }
        else {
            why = `matches --component selector "${selector.value}"`;
        }
        impactedComponents.push({ name: compName, why });
    }
    // Also include components that have files sharing a seed component
    // (sibling components touched by the impact scope).
    // Currently we report the direct seed components only (as per IF-003 scope).
    // Step 4: related tests — test files whose req_ids overlap with the scope req_ids,
    // OR test files in the seed components.
    const scopeReqIds = new Set();
    for (const f of map.files) {
        if (impactedFilePaths.has(f.path)) {
            for (const rid of f.req_ids)
                scopeReqIds.add(rid);
        }
    }
    const relatedTests = [];
    const seenTestPaths = new Set();
    for (const f of map.files) {
        if (!f.is_test)
            continue;
        if (seenTestPaths.has(f.path))
            continue;
        let whyParts = [];
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
    const downstreamFeatures = [];
    const seenFeatures = new Set();
    for (const ep of map.entrypoints) {
        if (seenFeatures.has(ep.name))
            continue;
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
    const artifactStageImplications = [];
    if (reqAnchors.length > 0) {
        artifactStageImplications.push(`${reqAnchors.length} REQ-ID(s) in scope — review docs/01-requirements.md for impact on acceptance criteria`);
    }
    if (impactedComponents.length > 0) {
        const compList = impactedComponents.map((c) => c.name).join(", ");
        artifactStageImplications.push(`Component(s) affected: ${compList} — update docs/09-implementation-plan.md if slice scope changes`);
    }
    // Step 8: riskFlags — blast-radius signals whose matching_paths intersect the impact scope.
    // REQ-RU-031: risk flags surface when signals intersect the impact scope.
    const riskFlags = map.blast_radius_signals
        .filter((sig) => sig.matching_paths.some((mp) => impactedFilePaths.has(mp)))
        .map(toSignal);
    // Step 9: verifyCandidates — inert only (RULE-004).
    const verifyCandidates = map.candidate_commands.map(toCmd);
    // Step 10 (P2-7): split DIRECT impact (seed + 1-hop resolved importers) from
    // POSSIBLE impact (same-component siblings, path-token). Per-edge basis+confidence.
    const directImpact = [];
    const directSeen = new Set();
    for (const sp of sortedUniq([...seedPaths])) {
        directImpact.push({
            path: sp,
            why: selector.kind === "file"
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
            if (e.basis !== "parsed")
                continue;
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
    const possibleImpact = [];
    for (const fp of sortedUniq([...impactedFilePaths])) {
        if (directSeen.has(fp))
            continue;
        possibleImpact.push({
            path: fp,
            why: "same component as the impact scope (path-token heuristic — verify)",
            basis: "path-token",
            confidence: "low",
        });
    }
    // Caveat: the impact rests on heuristics when there were NO resolved importers
    // beyond the seed, OR when any edge touching a seed was unresolved/external.
    const hadUnresolvedSeedEdge = map.edges?.some((e) => e.basis === "unresolved" && seedPaths.has(e.from)) ?? false;
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
