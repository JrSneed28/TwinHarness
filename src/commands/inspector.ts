import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { atomicWriteFile } from "../core/atomic-io";
import { shortHash } from "../core/hash";
import { type CommandResult, success, failure } from "../core/output";
import { structuredLog } from "../core/log";
import { NOT_INIT, formatIssues } from "../core/guards";
import { readState } from "../core/state-store";
import { runArtifactRegister, guardApprovedArtifactReauthor } from "./artifact";

/**
 * `th inspector write` — the Codebase-Inspector agent's single governed write path
 * (SG3 P3-A, D2). The inspector is a READ-ONLY agent (`disallowedTools: Write`); it
 * cannot use the `Write` tool, so it emits its source-anchored brownfield analysis
 * through this verb instead. The verb is a NARROW, fixed-target writer: it produces
 * EXACTLY `docs/00-existing-codebase-analysis.md` (the artifact the agent prompt
 * names) and nothing else — the general `th doc write` consolidation is deferred to
 * SG4.
 *
 * Mechanical only (plan §3 boundary rule): the CLI records the content the caller
 * supplies and content-hashes it. It never decides what the analysis SAYS.
 */

/**
 * The ONE file `th inspector write` is permitted to produce. Hard-pinned in the
 * handler (mirrors `th research write`→`docs/00-research/<topic>.md`): a write aimed
 * at any other path is refused HERE, before the path ever reaches
 * `assertGovernedWriteSurface` — the governed-write chokepoint (`paths.ts`) stays
 * UNMODIFIED (its first-segment `docs` allowance already admits this file). Pinning
 * the producer→file binding in the handler pre-installs the seam SG4 generalizes.
 */
export const INSPECTOR_ANALYSIS_FILE = "docs/00-existing-codebase-analysis.md";

export interface InspectorWriteOptions {
  /** The full markdown body to write (the agent assembles it; the CLI records it). */
  content?: string;
  /**
   * The target path. OPTIONAL and, when supplied, must EXACTLY equal
   * {@link INSPECTOR_ANALYSIS_FILE} — any other value is refused by the handler pin.
   * Exists so a caller can be explicit (and so a misdirected write is rejected with a
   * clear token) rather than silently redirected.
   */
  file?: string;
  /** Artifact version recorded on auto-register (default 1). */
  version?: number;
}

/**
 * `th inspector write --content <md> [--file docs/00-existing-codebase-analysis.md] [--version <n>]`
 *
 * 1. HARD-PIN the target to {@link INSPECTOR_ANALYSIS_FILE}; refuse any other `--file`
 *    BEFORE the governed-write chokepoint (handler pin — chokepoint untouched).
 * 2. Write the content atomically through the UNMODIFIED `assertGovernedWriteSurface`
 *    chokepoint (threaded via `atomicWriteFile`'s `root` option).
 * 3. Auto-register the artifact by calling the in-process register CORE handler
 *    (`runArtifactRegister`) — never shelling out to another verb.
 * 4. Return a `receipts: [{file, hash}]` payload in `data`.
 */
export function runInspectorWrite(
  paths: ProjectPaths,
  opts: InspectorWriteOptions,
): CommandResult {
  const content = opts.content;
  if (content === undefined) {
    return failure({
      human: `usage: th inspector write --content <markdown> [--version <n>]\n\nWrites the source-anchored brownfield analysis to ${INSPECTOR_ANALYSIS_FILE} and registers it.`,
      data: { error: "missing_content" },
    });
  }

  // Handler pin (D3): refuse ANY target other than the one fixed analysis file BEFORE
  // touching the governed-write chokepoint. A caller may omit `--file` (the pin is the
  // default) or pass it EXACTLY; anything else is rejected with a stable token.
  if (opts.file !== undefined && normalizeRel(opts.file) !== INSPECTOR_ANALYSIS_FILE) {
    return failure({
      human: `th inspector write only writes ${INSPECTOR_ANALYSIS_FILE} — refusing ${opts.file}.`,
      data: { error: "inspector_path_pinned", requested: opts.file, pinned: INSPECTOR_ANALYSIS_FILE },
    });
  }

  // Validate an EXPLICIT version up front (an absent version is resolved by the guard
  // below — first write ⇒ v1, re-author ⇒ caller must bump). A present-but-invalid
  // value is rejected before any state read or write.
  if (opts.version !== undefined && (!Number.isInteger(opts.version) || opts.version < 1)) {
    return failure({
      human: "usage: th inspector write --content <markdown> [--version <n>] (version must be a positive integer)",
      data: { error: "invalid_version" },
    });
  }

  // Require an initialized project so the auto-register step has a state.json to upsert
  // into (matches `th artifact register`'s precondition; fail fast before writing).
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `Existing state.json is invalid; fix it before writing the analysis:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  // Audit P1: this governed writer writes directly and THEN auto-registers, bypassing the
  // PreToolUse R-14 approved-artifact clobber guard. Consult the shared guard BEFORE
  // writing — refuse to silently overwrite (or downgrade the registered version of) an
  // already-approved analysis. A deliberate re-author passes an explicit higher --version.
  const guard = guardApprovedArtifactReauthor(r.state.approved_artifacts, INSPECTOR_ANALYSIS_FILE, opts.version, `inspector write ${INSPECTOR_ANALYSIS_FILE}`);
  if (!guard.ok) return guard.result;
  const version = guard.version;

  // Write the pinned file through the UNMODIFIED governed-write chokepoint: threading
  // `root` makes `atomicWriteFile` assert the write-surface allowlist (first segment
  // `docs` is already admitted). `INSPECTOR_ANALYSIS_FILE` is a fixed root-relative
  // literal, so the absolute target is deterministic.
  const abs = path.resolve(paths.root, INSPECTOR_ANALYSIS_FILE);
  atomicWriteFile(abs, content, { root: paths.root });

  // Auto-register the artifact via the in-process register CORE handler (never shells
  // out to another verb — Principle 1). It re-hashes the file from disk and upserts
  // `approved_artifacts` under its own state lock.
  const reg = runArtifactRegister(paths, INSPECTOR_ANALYSIS_FILE, version);
  if (!reg.ok) {
    // The bytes are on disk but registration failed (e.g. a contended state lock):
    // surface the register failure verbatim so the caller can retry register without
    // re-writing.
    return reg;
  }

  // The receipt hash is the content hash of exactly what we wrote (CRLF-normalized,
  // matching the artifact registry's text-hash convention via `hashContent`/`shortHash`).
  const hash = shortHash(content);
  const receipts = [{ file: INSPECTOR_ANALYSIS_FILE, hash }];
  structuredLog({ cmd: "inspector write", file: INSPECTOR_ANALYSIS_FILE, version, hash });
  return success({
    data: { file: INSPECTOR_ANALYSIS_FILE, version, hash, receipts },
    human: `wrote ${INSPECTOR_ANALYSIS_FILE} and registered it v${version} (${hash})`,
  });
}

/** Normalize a caller-supplied path to a forward-slash root-relative key for the pin compare. */
function normalizeRel(p: string): string {
  return p.split(path.sep).join("/").replace(/^\.\//, "");
}
