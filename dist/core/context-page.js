"use strict";
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
exports.CONTEXT_PAGE_SCHEMA_VERSION = void 0;
exports.computePageId = computePageId;
exports.normalizeLocator = normalizeLocator;
exports.classifySensitive = classifySensitive;
exports.contextPagesRoot = contextPagesRoot;
exports.coldStorePut = coldStorePut;
exports.coldStoreGet = coldStoreGet;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const hash_1 = require("./hash");
const extract_1 = require("./repo-map/extract");
const state_schema_1 = require("./state-schema");
// ---------------------------------------------------------------------------
// ContextPage schema (D-04)
// ---------------------------------------------------------------------------
exports.CONTEXT_PAGE_SCHEMA_VERSION = "1";
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
function computePageId(p) {
    return (0, hash_1.shortHash)(p.schema_version + p.source_kind + p.logical_key + p.content_hash);
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
function normalizeLocator(source_kind, parts) {
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
            const argvArr = Array.isArray(rawArgv)
                ? rawArgv.map((a) => String(a))
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
                ? rawCmd.map((c) => String(c)).join(" ")
                : String(rawCmd ?? "");
            const cwd = parts.cwd !== undefined ? String(parts.cwd) : "";
            const cwdPart = cwd ? `,cwd=${cwd}` : "";
            return `test|${cmd}${cwdPart}`;
        }
        default: {
            // Unknown source_kind — fall back to a JSON representation (fail-safe)
            return String(parts.path ??
                parts.query ??
                canonicalJson(parts));
        }
    }
}
/**
 * Strip volatile tokens from a single shell-argument token: env-var assignments
 * (`KEY=value`) and paths under system temp directories.
 */
function stripVolatile(arg) {
    // Drop bare env-var assignments (KEY=value at the start of an arg)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg))
        return "";
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
function canonicalJson(obj) {
    if (obj === null || typeof obj !== "object") {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return "[" + obj.map(canonicalJson).join(",") + "]";
    }
    const record = obj;
    const parts = Object.keys(record)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(record[k]));
    return "{" + parts.join(",") + "}";
}
// ---------------------------------------------------------------------------
// Sensitive classification
// ---------------------------------------------------------------------------
/** File-path patterns that always indicate sensitive content. */
const PATH_DENYLIST = [
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
const SECRET_CONTENT_PATTERNS = [
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
const BLAST_RADIUS_PATH_KEYWORDS = {
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
function classifySensitive(page, _paths, content) {
    try {
        const locator = page.source_locator;
        // 1. Path denylist
        for (const pat of PATH_DENYLIST) {
            if (pat.test(locator))
                return true;
        }
        // 2. Blast-radius path keywords
        for (const flag of state_schema_1.BLAST_RADIUS_FLAGS) {
            const kwPat = BLAST_RADIUS_PATH_KEYWORDS[flag];
            if (kwPat && kwPat.test(locator))
                return true;
        }
        // 3. Regex secret-scan: run against the source_locator itself (catches
        //    bash commands or MCP params that embed an inline secret) and also
        //    against the response content when provided (AC-7 / R2).
        for (const pat of SECRET_CONTENT_PATTERNS) {
            if (pat.test(locator))
                return true;
        }
        if (content !== undefined) {
            for (const pat of SECRET_CONTENT_PATTERNS) {
                if (pat.test(content))
                    return true;
            }
        }
        return false;
    }
    catch {
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
function contextPagesRoot(paths) {
    return path.join(paths.stateDir, "context-pages");
}
/**
 * Absolute path for a CAS object file: `<root>/objects/<hh>/<hash>`.
 * Git-style two-character shard keeps directory entries manageable.
 */
function casObjectPath(pagesRoot, hash) {
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
function coldStorePut(paths, content, sensitive) {
    try {
        const hash = (0, hash_1.hashContent)(content);
        // Binary check: skip non-text content
        const buf = Buffer.from(content, "utf8");
        if ((0, extract_1.looksBinary)(buf))
            return null;
        // Sensitive: return objref (the hash) but never write raw bytes
        if (sensitive)
            return hash;
        const root = contextPagesRoot(paths);
        const objPath = casObjectPath(root, hash);
        // CAS: skip write when the object is already present (content-addressed)
        if (fs.existsSync(objPath))
            return hash;
        // Write the object — mkdirSync first to ensure the 2-char shard dir exists
        fs.mkdirSync(path.dirname(objPath), { recursive: true });
        fs.writeFileSync(objPath, content, "utf8");
        return hash;
    }
    catch {
        return null;
    }
}
/**
 * D-08: Read content from the CAS cold store by its 64-char hex hash.
 * Returns undefined when the object is absent or on any error.
 */
function coldStoreGet(paths, hash) {
    try {
        // D-08: object refs are 64-char lowercase hex (sha-256). Reject anything
        // else BEFORE touching the filesystem — a tampered/tolerantly-read ledger
        // record could otherwise smuggle a path-traversal ref (e.g. "../../secret").
        if (!/^[0-9a-f]{64}$/.test(hash))
            return undefined;
        const root = contextPagesRoot(paths);
        const objPath = casObjectPath(root, hash);
        if (!fs.existsSync(objPath))
            return undefined;
        return fs.readFileSync(objPath, "utf8");
    }
    catch {
        return undefined;
    }
}
