/**
 * Bundled graduated-corpus loader + validator (plan Step 0).
 *
 * The corpus is a set of synthetic project briefs under `proof/corpus/`, each a
 * directory carrying a human `brief.md` and a machine `meta.json`. `index.json`
 * enumerates them. {@link loadCorpus} reads the index + every `meta.json` into
 * {@link SampleBrief}s (resolving absolute `briefDir`/`seedDir` paths so a consumer
 * can copy a brownfield seed tree without re-resolving). {@link validateCorpus}
 * enforces the spec coverage contract: the run FAILS if any required tier is
 * missing or no brownfield brief is present.
 *
 * Pure data layer: it reads and computes; it never executes a brief.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BriefSize,
  Corpus,
  CorpusValidation,
  ProjectType,
  SampleBrief,
  TierHint,
} from "./types";

/**
 * The tiers a valid corpus MUST cover (graduated coverage, AC #2). A brief is
 * counted by its declared `tierHint`; a corpus missing any of these fails validation.
 */
export const REQUIRED_TIERS: readonly TierHint[] = ["T1", "T2", "T3"];

const BRIEF_SIZES: ReadonlySet<string> = new Set<BriefSize>(["tiny", "small", "medium"]);
const PROJECT_TYPES: ReadonlySet<string> = new Set<ProjectType>(["greenfield", "brownfield"]);
const TIER_HINTS: ReadonlySet<string> = new Set<TierHint>(["T0", "T1", "T2", "T3"]);

/** The raw `meta.json` shape (validated into a {@link SampleBrief} by loadCorpus). */
interface BriefMeta {
  id: string;
  size: BriefSize;
  domain: string;
  tierHint: TierHint;
  type: ProjectType;
  acceptanceCriteria?: string[];
  /** Relative path (within the brief dir) to a brownfield seed tree. */
  seedDir?: string;
}

/** `<root>/index.json` shape: the ordered list of brief directory names. */
interface CorpusIndex {
  briefs: string[];
}

/** Thrown when the corpus index or a brief's meta.json is missing or malformed. */
export class CorpusLoadError extends Error {
  readonly code = "corpus_load";
  constructor(message: string) {
    super(message);
    this.name = "CorpusLoadError";
  }
}

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new CorpusLoadError(`cannot read ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CorpusLoadError(`invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

function validateMeta(meta: unknown, dir: string): BriefMeta {
  if (typeof meta !== "object" || meta === null) {
    throw new CorpusLoadError(`meta.json in ${dir} must be an object`);
  }
  const m = meta as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length === 0) throw new CorpusLoadError(`meta.json in ${dir}: id must be a non-empty string`);
  if (typeof m.size !== "string" || !BRIEF_SIZES.has(m.size)) throw new CorpusLoadError(`meta.json in ${dir}: size must be tiny|small|medium`);
  if (typeof m.domain !== "string" || m.domain.length === 0) throw new CorpusLoadError(`meta.json in ${dir}: domain must be a non-empty string`);
  if (typeof m.tierHint !== "string" || !TIER_HINTS.has(m.tierHint)) throw new CorpusLoadError(`meta.json in ${dir}: tierHint must be T0..T3`);
  if (typeof m.type !== "string" || !PROJECT_TYPES.has(m.type)) throw new CorpusLoadError(`meta.json in ${dir}: type must be greenfield|brownfield`);
  if (m.acceptanceCriteria !== undefined && (!Array.isArray(m.acceptanceCriteria) || m.acceptanceCriteria.some((c) => typeof c !== "string"))) {
    throw new CorpusLoadError(`meta.json in ${dir}: acceptanceCriteria must be an array of strings`);
  }
  if (m.seedDir !== undefined && typeof m.seedDir !== "string") throw new CorpusLoadError(`meta.json in ${dir}: seedDir must be a string`);
  return {
    id: m.id,
    size: m.size as BriefSize,
    domain: m.domain,
    tierHint: m.tierHint as TierHint,
    type: m.type as ProjectType,
    acceptanceCriteria: (m.acceptanceCriteria as string[] | undefined) ?? [],
    seedDir: m.seedDir as string | undefined,
  };
}

/**
 * Load the bundled corpus rooted at `root` (e.g. `<repo>/proof/corpus`). Reads
 * `index.json`, then each enumerated brief's `meta.json`, resolving absolute
 * `briefDir` and (for brownfield) `seedDir` paths. Throws {@link CorpusLoadError}
 * on a missing/malformed index or meta.
 */
export function loadCorpus(root: string): Corpus {
  const indexFile = path.join(root, "index.json");
  const index = readJson(indexFile) as CorpusIndex;
  if (typeof index !== "object" || index === null || !Array.isArray(index.briefs)) {
    throw new CorpusLoadError(`${indexFile} must contain a "briefs" array`);
  }

  const briefs: SampleBrief[] = [];
  for (const name of index.briefs) {
    if (typeof name !== "string" || name.length === 0) {
      throw new CorpusLoadError(`${indexFile}: every "briefs" entry must be a non-empty directory name`);
    }
    const briefDir = path.join(root, name);
    const meta = validateMeta(readJson(path.join(briefDir, "meta.json")), name);
    const brief: SampleBrief = {
      id: meta.id,
      size: meta.size,
      domain: meta.domain,
      tierHint: meta.tierHint,
      type: meta.type,
      acceptanceCriteria: meta.acceptanceCriteria ?? [],
      briefDir,
    };
    if (meta.seedDir) brief.seedDir = path.join(briefDir, meta.seedDir);
    briefs.push(brief);
  }
  return { root, briefs };
}

/**
 * Validate that the corpus satisfies the spec coverage contract: every
 * {@link REQUIRED_TIERS} tier has at least one brief AND at least one brownfield
 * brief is present. Returns the reasons it fails (empty `issues` ⇒ ok).
 */
export function validateCorpus(corpus: Corpus): CorpusValidation {
  const issues: string[] = [];
  const tiers = new Set(corpus.briefs.map((b) => b.tierHint));
  for (const tier of REQUIRED_TIERS) {
    if (!tiers.has(tier)) issues.push(`missing tier ${tier} (no brief declares tierHint ${tier})`);
  }
  if (!corpus.briefs.some((b) => b.type === "brownfield")) {
    issues.push("no brownfield brief present (the corpus must include at least one brownfield brief)");
  }
  return { ok: issues.length === 0, issues };
}
