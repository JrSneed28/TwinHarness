"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorpusLoadError = exports.REQUIRED_TIERS = void 0;
exports.loadCorpus = loadCorpus;
exports.validateCorpus = validateCorpus;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * The tiers a valid corpus MUST cover (graduated coverage, AC #2). A brief is
 * counted by its declared `tierHint`; a corpus missing any of these fails validation.
 */
exports.REQUIRED_TIERS = ["T1", "T2", "T3"];
const BRIEF_SIZES = new Set(["tiny", "small", "medium"]);
const PROJECT_TYPES = new Set(["greenfield", "brownfield"]);
const TIER_HINTS = new Set(["T0", "T1", "T2", "T3"]);
/** Thrown when the corpus index or a brief's meta.json is missing or malformed. */
class CorpusLoadError extends Error {
    code = "corpus_load";
    constructor(message) {
        super(message);
        this.name = "CorpusLoadError";
    }
}
exports.CorpusLoadError = CorpusLoadError;
function readJson(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        throw new CorpusLoadError(`cannot read ${file}`);
    }
    try {
        return JSON.parse(raw);
    }
    catch (e) {
        throw new CorpusLoadError(`invalid JSON in ${file}: ${e.message}`);
    }
}
function validateMeta(meta, dir) {
    if (typeof meta !== "object" || meta === null) {
        throw new CorpusLoadError(`meta.json in ${dir} must be an object`);
    }
    const m = meta;
    if (typeof m.id !== "string" || m.id.length === 0)
        throw new CorpusLoadError(`meta.json in ${dir}: id must be a non-empty string`);
    if (typeof m.size !== "string" || !BRIEF_SIZES.has(m.size))
        throw new CorpusLoadError(`meta.json in ${dir}: size must be tiny|small|medium`);
    if (typeof m.domain !== "string" || m.domain.length === 0)
        throw new CorpusLoadError(`meta.json in ${dir}: domain must be a non-empty string`);
    if (typeof m.tierHint !== "string" || !TIER_HINTS.has(m.tierHint))
        throw new CorpusLoadError(`meta.json in ${dir}: tierHint must be T0..T3`);
    if (typeof m.type !== "string" || !PROJECT_TYPES.has(m.type))
        throw new CorpusLoadError(`meta.json in ${dir}: type must be greenfield|brownfield`);
    if (m.acceptanceCriteria !== undefined && (!Array.isArray(m.acceptanceCriteria) || m.acceptanceCriteria.some((c) => typeof c !== "string"))) {
        throw new CorpusLoadError(`meta.json in ${dir}: acceptanceCriteria must be an array of strings`);
    }
    if (m.seedDir !== undefined && typeof m.seedDir !== "string")
        throw new CorpusLoadError(`meta.json in ${dir}: seedDir must be a string`);
    return {
        id: m.id,
        size: m.size,
        domain: m.domain,
        tierHint: m.tierHint,
        type: m.type,
        acceptanceCriteria: m.acceptanceCriteria ?? [],
        seedDir: m.seedDir,
    };
}
/**
 * Load the bundled corpus rooted at `root` (e.g. `<repo>/proof/corpus`). Reads
 * `index.json`, then each enumerated brief's `meta.json`, resolving absolute
 * `briefDir` and (for brownfield) `seedDir` paths. Throws {@link CorpusLoadError}
 * on a missing/malformed index or meta.
 */
function loadCorpus(root) {
    const indexFile = path.join(root, "index.json");
    const index = readJson(indexFile);
    if (typeof index !== "object" || index === null || !Array.isArray(index.briefs)) {
        throw new CorpusLoadError(`${indexFile} must contain a "briefs" array`);
    }
    const briefs = [];
    for (const name of index.briefs) {
        if (typeof name !== "string" || name.length === 0) {
            throw new CorpusLoadError(`${indexFile}: every "briefs" entry must be a non-empty directory name`);
        }
        const briefDir = path.join(root, name);
        const meta = validateMeta(readJson(path.join(briefDir, "meta.json")), name);
        const brief = {
            id: meta.id,
            size: meta.size,
            domain: meta.domain,
            tierHint: meta.tierHint,
            type: meta.type,
            acceptanceCriteria: meta.acceptanceCriteria ?? [],
            briefDir,
        };
        if (meta.seedDir)
            brief.seedDir = path.join(briefDir, meta.seedDir);
        briefs.push(brief);
    }
    return { root, briefs };
}
/**
 * Validate that the corpus satisfies the spec coverage contract: every
 * {@link REQUIRED_TIERS} tier has at least one brief AND at least one brownfield
 * brief is present. Returns the reasons it fails (empty `issues` ⇒ ok).
 */
function validateCorpus(corpus) {
    const issues = [];
    const tiers = new Set(corpus.briefs.map((b) => b.tierHint));
    for (const tier of exports.REQUIRED_TIERS) {
        if (!tiers.has(tier))
            issues.push(`missing tier ${tier} (no brief declares tierHint ${tier})`);
    }
    if (!corpus.briefs.some((b) => b.type === "brownfield")) {
        issues.push("no brownfield brief present (the corpus must include at least one brownfield brief)");
    }
    return { ok: issues.length === 0, issues };
}
