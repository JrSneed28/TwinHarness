/**
 * context-page.ts — ContextPage schema, identity computation, locator
 * normalization, sensitive classification, and CAS cold-store helpers.
 *
 * S0 (OBSERVE-only): records everything, changes no externally visible behavior.
 * Savings target = 0%. All page data lives under `.twinharness/context-pages/`
 * (NEVER in state.json).
 *
 * Key dependencies (reused, not reinvented):
 *   hashContent / shortHash / GENESIS_PREV_HASH  ← src/core/hash.ts
 *   looksBinary                                   ← src/core/repo-map/extract.ts
 *   BLAST_RADIUS_FLAGS / BlastRadiusFlag          ← src/core/state-schema.ts
 *   ProjectPaths                                  ← src/core/paths.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { hashContent, shortHash } from "./hash";
import { looksBinary } from "./repo-map/extract";
import { BLAST_RADIUS_FLAGS, type BlastRadiusFlag } from "./state-schema";

// ---------------------------------------------------------------------------
// ContextPage schema (D-04)
// ---------------------------------------------------------------------------

export const CONTEXT_PAGE_SCHEMA_VERSION = "1";

/** The kind of source that produced a context page. */
export type SourceKind =
  | "file"
  | "range"
  | "symbol"
  | "search"
  | "bash"
  | "mcp"
  | "test";

/** How the page's content is represented in the ledger / residency store. */
export type ReductionKind = "FULL" | "delta" | "hash-only";

/**
 * D-04 — one unit of context delivered to an agent.  All 18 fields are
 * required on the type; callers set `sensitive` and `raw_objref` after
 * classification / cold-storage.
 */
export interface ContextPage {
  schema_version: string;
  page_id: string;
  logical_key: string;
  content_hash: string;
  source_kind: SourceKind;
  source_locator: string;
  range_or_params: string | null;
  est_tokens: number;
  complete: boolean;
  session_id: string;
  agent_id: string | null;
  agent_type: string | null;
  epoch: number;
  seq: number;
  delivered_at: string;
  raw_objref: string | null;
  sensitive: boolean;
  reduction_kind: ReductionKind;
}

// ---------------------------------------------------------------------------
// D-05: page identity
// ---------------------------------------------------------------------------

/**
 * D-05 (exact): page_id = shortHash(schema_version + source_kind + logical_key
 * + content_hash).  Deterministic and clock-free; same inputs always yield the
 * same 12-char hex string.
 *
 * `content_hash` must already be computed via `hashContent(rawContent)` before
 * calling this function.
 */
export function computePageId(
  p: Pick<ContextPage, "schema_version" | "source_kind" | "logical_key" | "content_hash">,
): string {
  return shortHash(p.schema_version + p.source_kind + p.logical_key + p.content_hash);
}

// ---------------------------------------------------------------------------
// D-06: locator normalization
// ---------------------------------------------------------------------------

/**
 * D-06: produce a deterministic `logical_key` string from a source_kind and
 * kind-specific descriptor parts.  The output is the canonical locator stored
 * on the page — equal content at equal coordinates must always map to the same
 * key (REQ-NFR-001 determinism).
 *
 * Parts by source_kind:
 *   file   : { path }
 *   range  : { path, startLine, endLine }
 *   symbol : { path, symbol }
 *   search : { tool, query, flags?, cwd? }
 *   bash   : { argv: string | string[], cwd? }   — volatile env/tmp paths stripped
 *   mcp    : { tool, params: object }             — params canonical-JSON sorted
 *   test   : { cmd: string | string[], cwd? }
 */
export function normalizeLocator(
  source_kind: SourceKind,
  parts: Record<string, unknown>,
): string {
  switch (source_kind) {
    case "file": {
      return String(parts.path ?? "");
    }

    case "range": {
      const p = String(parts.path ?? "");
      const start = Number(parts.startLine ?? 0);
      const end = Number(parts.endLine ?? 0);
      return `${p}:L${start}-L${end}`;
    }

    case "symbol": {
      const p = String(parts.path ?? "");
      const sym = String(parts.symbol ?? "");
      return `${p}#${sym}`;
    }

    case "search": {
      const tool = String(parts.tool ?? "search");
      const query = String(parts.query ?? "");
      // Canonicalize flags: sort chars so flag order does not matter
      const rawFlags = parts.flags !== undefined ? String(parts.flags) : "";
      const flags = rawFlags.split("").sort().join("");
      const cwd = parts.cwd !== undefined ? String(parts.cwd) : "";
      const flagsPart = flags ? `,flags=${flags}` : "";
      const cwdPart = cwd ? `,cwd=${cwd}` : "";
      return `${tool}|query=${query}${flagsPart}${cwdPart}`;
    }

    case "bash": {
      const rawArgv = parts.argv;
      const argvArr: string[] = Array.isArray(rawArgv)
        ? (rawArgv as unknown[]).map((a) => String(a))
        : [String(rawArgv ?? "")];
      // Strip volatile env assignments and temp-path tokens
      const stripped = argvArr
        .map(stripVolatile)
        .filter((a) => a.length > 0);
      const argv = stripped.join(" ");
      const cwd = parts.cwd !== undefined ? String(parts.cwd) : "";
      const cwdPart = cwd ? `,cwd=${cwd}` : "";
      return `bash|${argv}${cwdPart}`;
    }

    case "mcp": {
      const tool = String(parts.tool ?? "mcp");
      const params = parts.params ?? {};
      return `${tool}|${canonicalJson(params)}`;
    }

    case "test": {
      const rawCmd = parts.cmd;
      const cmd = Array.isArray(rawCmd)
        ? (rawCmd as unknown[]).map((c) => String(c)).join(" ")
        : String(rawCmd ?? "");
      const cwd = parts.cwd !== undefined ? String(parts.cwd) : "";
      const cwdPart = cwd ? `,cwd=${cwd}` : "";
      return `test|${cmd}${cwdPart}`;
    }

    default: {
      // Unknown source_kind — fall back to a JSON representation (fail-safe)
      return String(
        (parts.path as string | undefined) ??
        (parts.query as string | undefined) ??
        canonicalJson(parts),
      );
    }
  }
}

/**
 * Strip volatile tokens from a single shell-argument token: env-var assignments
 * (`KEY=value`) and paths under system temp directories.
 */
function stripVolatile(arg: string): string {
  // Drop bare env-var assignments (KEY=value at the start of an arg)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) return "";
  // Replace /tmp/…  /var/folders/…  and Windows equivalents with a placeholder
  return arg
    .replace(/\/(tmp|temp|var\/folders)\/\S*/gi, "<tmp>")
    .replace(/[A-Za-z]:[/\\](?:temp|tmp)[/\\]\S*/gi, "<tmp>");
}

/**
 * Produce a canonical (key-sorted, deterministic) JSON string.  Nested
 * objects have their keys sorted at ALL nesting levels; array element order
 * is preserved, but object elements inside arrays have their keys sorted too.
 * Used to canonicalize MCP params so logical_key is insertion-order-independent.
 */
function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + (obj as unknown[]).map(canonicalJson).join(",") + "]";
  }
  const record = obj as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(record[k]));
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Sensitive classification
// ---------------------------------------------------------------------------

/** File-path patterns that always indicate sensitive content. */
const PATH_DENYLIST: RegExp[] = [
  /\.env(\.|$)/i,
  /credentials?\.(json|ya?ml|toml|ini|txt)$/i,
  /secrets?\.(json|ya?ml|toml|ini|txt)$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /id_dsa/i,
  /[/\\]\.ssh[/\\]/i,
  /aws[_\-]?credentials/i,
  /kubeconfig/i,
  /service[_\-]?account.*\.(json|ya?ml)$/i,
  /\.netrc$/i,
  /docker[/\\]?config\.json$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /\.pgpass$/i,
  /private[_\-]?key/i,
];

/** Regex patterns that detect secrets inside raw content. */
const SECRET_CONTENT_PATTERNS: RegExp[] = [
  // Explicit password/secret assignments
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  // API key assignments
  /(?:api[_\-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i,
  // Generic secret/token assignments
  /(?:secret|token|auth)\s*[:=]\s*['"]?[A-Za-z0-9_\-/+]{16,}/i,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/,
  // AWS secret access keys
  /(?:aws[_\-]?secret[_\-]?access[_\-]?key)\s*[:=]\s*[A-Za-z0-9/+=]{40}/i,
  // PEM private keys
  // Matches: BEGIN RSA PRIVATE KEY, BEGIN EC PRIVATE KEY, BEGIN PRIVATE KEY, etc.
  /-----BEGIN [A-Z ]*KEY-----/,
  // JWT-shaped tokens (three base64url segments)
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // GitHub personal access tokens and app tokens
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  // Slack tokens
  /xox[baprs]-[A-Za-z0-9\-]{10,}/,
  // Stripe keys
  /sk_live_[A-Za-z0-9]{24,}/,
];

/**
 * Path-keyword patterns associated with each blast-radius flag.  A source
 * locator that matches any of these is treated as sensitive (fail-toward-pin).
 */
const BLAST_RADIUS_PATH_KEYWORDS: Record<BlastRadiusFlag, RegExp> = {
  authentication: /\bauth(?:entication|orize|n)?\b|\blogin\b|\bsession\b|\btoken\b|\bpassword\b/i,
  authorization: /\bauthori[sz](?:e|ation)\b|\bpermission\b|\brole\b|\bacl\b/i,
  "data-integrity": /\bintegrity\b|\bchecksum\b|\bverif(?:y|ication)\b|\bsignature\b/i,
  money: /\bpay(?:ment)?\b|\bcharge\b|\bbill(?:ing)?\b|\binvoice\b|\bwallet\b|\bstripe\b|\bpaypal\b|\bprice\b/i,
  migrations: /\bmigrat(?:ions?|e[ds]?)\b/i,
};

/**
 * Classify whether a page should be treated as sensitive.
 *
 * Uses three overlapping heuristics (union: any positive ⇒ sensitive):
 *   1. Path denylist — well-known sensitive file name/path patterns.
 *   2. Blast-radius keywords — source_locator path overlaps a blast-radius zone.
 *   3. Regex secret-scan — raw content contains secret-shaped strings.
 *
 * Fail-toward-sensitive: any scan error or unhandled exception ⇒ true.
 *
 * @param page    Must have source_locator and source_kind populated.
 * @param _paths  Project paths (reserved for future repo-map integration).
 * @param content Optional raw content string for regex secret-scanning.
 */
export function classifySensitive(
  page: Pick<ContextPage, "source_locator" | "source_kind">,
  _paths: ProjectPaths,
  content?: string,
): boolean {
  try {
    const locator = page.source_locator;

    // 1. Path denylist
    for (const pat of PATH_DENYLIST) {
      if (pat.test(locator)) return true;
    }

    // 2. Blast-radius path keywords
    for (const flag of BLAST_RADIUS_FLAGS) {
      const kwPat = BLAST_RADIUS_PATH_KEYWORDS[flag];
      if (kwPat && kwPat.test(locator)) return true;
    }

    // 3. Regex secret-scan: run against the source_locator itself (catches
    //    bash commands or MCP params that embed an inline secret) and also
    //    against the response content when provided (AC-7 / R2).
    for (const pat of SECRET_CONTENT_PATTERNS) {
      if (pat.test(locator)) return true;
    }
    if (content !== undefined) {
      for (const pat of SECRET_CONTENT_PATTERNS) {
        if (pat.test(content)) return true;
      }
    }

    return false;
  } catch {
    // Any error ⇒ fail-toward-sensitive
    return true;
  }
}

// ---------------------------------------------------------------------------
// D-08: CAS cold store
// ---------------------------------------------------------------------------

/**
 * Root directory for context-pages data: `<stateDir>/context-pages/`.
 * All sub-paths (objects/, ledger shards, telemetry.jsonl, epoch.json,
 * capability.json) live under this root — NEVER in state.json.
 */
export function contextPagesRoot(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "context-pages");
}

/**
 * Absolute path for a CAS object file: `<root>/objects/<hh>/<hash>`.
 * Git-style two-character shard keeps directory entries manageable.
 */
function casObjectPath(pagesRoot: string, hash: string): string {
  const hh = hash.slice(0, 2);
  return path.join(pagesRoot, "objects", hh, hash);
}

/**
 * D-08: Write `content` to the CAS cold store and return the objref (the
 * 64-char hex content hash), or null on any error.
 *
 * Rules:
 *   - Binary content (NUL byte in first 8 KiB) → skipped, returns null.
 *   - `sensitive === true` → objref returned but NO bytes written to disk.
 *   - CAS is immutable: if the object already exists the write is skipped.
 */
export function coldStorePut(
  paths: ProjectPaths,
  content: string,
  sensitive: boolean,
): string | null {
  try {
    const hash = hashContent(content);

    // Binary check: skip non-text content
    const buf = Buffer.from(content, "utf8");
    if (looksBinary(buf)) return null;

    // Sensitive: return objref (the hash) but never write raw bytes
    if (sensitive) return hash;

    const root = contextPagesRoot(paths);
    const objPath = casObjectPath(root, hash);

    // CAS: skip write when the object is already present (content-addressed)
    if (fs.existsSync(objPath)) return hash;

    // Write the object — mkdirSync first to ensure the 2-char shard dir exists
    fs.mkdirSync(path.dirname(objPath), { recursive: true });
    fs.writeFileSync(objPath, content, "utf8");

    return hash;
  } catch {
    return null;
  }
}

/**
 * D-08: Read content from the CAS cold store by its 64-char hex hash.
 * Returns undefined when the object is absent or on any error.
 */
export function coldStoreGet(paths: ProjectPaths, hash: string): string | undefined {
  try {
    const root = contextPagesRoot(paths);
    const objPath = casObjectPath(root, hash);
    if (!fs.existsSync(objPath)) return undefined;
    return fs.readFileSync(objPath, "utf8");
  } catch {
    return undefined;
  }
}
