import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, type ReadReceipt, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import { type ApprovedArtifact } from "../core/state-schema";
import { shortHashPath, HashLimitError, hashContent } from "../core/hash";
import { structuredLog } from "../core/log";
import { NOT_INIT, formatIssues } from "../core/guards";
import { extractSummary, extractSection } from "../core/summary";

/**
 * `th artifact` — content-hash and record an approved, versioned artifact
 * (spec §12: "each artifact is versioned with a content hash referenced by
 * state.json"; §18 `approved_artifacts`).
 *
 * Mechanical only (plan §3 boundary rule): the CLI computes a deterministic
 * content hash and records the version it is told. It never decides *whether* an
 * artifact is approved — the caller supplies the version when it approves.
 */

/** Normalize a root-relative path to forward slashes for cross-platform stable storage. */
function toRelKey(root: string, file: string): string {
  const abs = path.resolve(root, file);
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * `th artifact register <path> --version <n>` — compute the content hash of a
 * file OR directory (relative to the project root) and upsert it into
 * `approved_artifacts`. Directories (e.g. the T3 ADR set `docs/05-adrs/`) are
 * hashed deterministically over their contents (§15.S; stage contract
 * `produces: docs/05-adrs/`). Re-registering the same path REPLACES its entry
 * (version bump, no duplicate).
 */
export function runArtifactRegister(
  paths: ProjectPaths,
  file?: string,
  version?: number,
): CommandResult {
  return withStateLock(paths, () => runArtifactRegisterLocked(paths, file, version));
}

function runArtifactRegisterLocked(
  paths: ProjectPaths,
  file?: string,
  version?: number,
): CommandResult {
  if (!file) return failure({ human: "usage: th artifact register <file> --version <n>" });
  if (version === undefined || !Number.isInteger(version) || version < 1) {
    return failure({ human: "usage: th artifact register <file> --version <n>" });
  }

  const abs = resolveWithinRoot(paths.root, file);
  if (abs === null) {
    return failure({ human: `Path outside project root: ${file}`, data: { error: "path_outside_root", file } });
  }
  if (!fs.existsSync(abs)) {
    return failure({ human: `File not found: ${file}`, data: { error: "file_not_found", file } });
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile() && !stat.isDirectory()) {
    return failure({ human: `Not a file or directory: ${file}`, data: { error: "not_a_file_or_dir", file } });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `Existing state.json is invalid; fix it before registering:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  let hash: string;
  try {
    hash = shortHashPath(abs);
  } catch (e) {
    if (e instanceof HashLimitError) {
      return failure({
        human: `Cannot register ${file}: ${e.message}`,
        data: { error: "artifact_too_large", file },
      });
    }
    throw e;
  }
  const relKey = toRelKey(paths.root, file);

  // P4-7 — validate the Summary block at register time to bound head-fallback bloat.
  // `th context pack` routes the artifact's `## Summary` block as the handoff currency;
  // when it is ABSENT the pack falls back to the file HEAD. For a markdown artifact
  // missing a Summary block we surface a non-blocking warning so the author adds a tight
  // Summary rather than letting the pack inject the document head. Never blocks
  // registration (registration is a mechanical hash record); directories have no single
  // Summary block and are exempt.
  let summaryWarning: string | null = null;
  if (stat.isFile() && /\.(md|markdown)$/i.test(relKey)) {
    try {
      const { summary } = extractSummary(fs.readFileSync(abs, "utf8"));
      if (summary === null) {
        summaryWarning = `no \`## Summary\` block — \`th context pack\` will fall back to the file head; add a Summary block to keep the handoff tight.`;
      }
    } catch {
      /* unreadable as text — leave unvalidated (best-effort). */
    }
  }

  const entry: ApprovedArtifact = { file: relKey, version, hash };
  const next = { ...r.state, approved_artifacts: [...r.state.approved_artifacts] };
  const idx = next.approved_artifacts.findIndex((a) => a.file === relKey);
  if (idx >= 0) next.approved_artifacts[idx] = entry;
  else next.approved_artifacts.push(entry);

  writeState(paths, next);
  structuredLog({ cmd: "artifact register", file: relKey, version, hash, summaryWarning: summaryWarning !== null });
  return success({
    data: { file: relKey, version, hash, summaryWarning },
    human: summaryWarning
      ? `registered ${relKey} v${version} (${hash})\n  ⚠ ${summaryWarning}`
      : `registered ${relKey} v${version} (${hash})`,
  });
}

/**
 * SG3 (audit P1) — the approved-artifact CLOBBER + version-monotonicity guard for the
 * GOVERNED WRITERS (`th research write`, `th inspector write`). Those verbs write the
 * file directly through the atomic chokepoint and THEN auto-register, so they BYPASS the
 * PreToolUse R-14 approved-artifact clobber guard (which only fires for Write/Edit/Bash
 * tool calls routed through the hook). Without this check a stage re-run silently
 * overwrote an approved doc AND reset its registered version to 1 (the audit reproduced
 * an approved v7 research document replaced and downgraded to v1). So before such a
 * writer overwrites a path it must consult THIS guard:
 *
 *   - target NOT yet registered          → first registration; version = requested ?? 1.
 *   - registered, no explicit version    → REFUSE `approved_artifact_exists` (re-authoring
 *     would silently clobber reviewed content; caller must pass an explicit higher version).
 *   - registered, requested ≤ registered → REFUSE `version_not_monotonic` (never downgrade
 *     an approved artifact).
 *   - registered, requested > registered → allow at the requested version (deliberate bump).
 *
 * Returns the effective version to register at, or a ready-to-return refusal result. The
 * caller checks this BEFORE writing, so a refused re-author never touches the file on disk.
 */
export function guardApprovedArtifactReauthor(
  approved: readonly ApprovedArtifact[],
  relKey: string,
  requestedVersion: number | undefined,
  cmd: string,
): { ok: true; version: number } | { ok: false; result: CommandResult } {
  const existing = approved.find((a) => a.file === relKey);
  if (!existing) {
    return { ok: true, version: requestedVersion ?? 1 };
  }
  if (requestedVersion === undefined) {
    return {
      ok: false,
      result: failure({
        human:
          `Refusing ${cmd}: ${relKey} is already a REGISTERED approved artifact (v${existing.version}). ` +
          `Re-authoring it would overwrite reviewed/human-edited content. To deliberately replace it, pass ` +
          `--version ${existing.version + 1} (a version bump).`,
        data: {
          error: "approved_artifact_exists",
          file: relKey,
          registeredVersion: existing.version,
          nextVersion: existing.version + 1,
        },
      }),
    };
  }
  if (requestedVersion <= existing.version) {
    return {
      ok: false,
      result: failure({
        human:
          `Refusing ${cmd}: ${relKey} is registered at v${existing.version}; --version must be GREATER than ` +
          `${existing.version} (a governed writer must not downgrade an approved artifact). ` +
          `Pass --version ${existing.version + 1} or higher.`,
        data: {
          error: "version_not_monotonic",
          file: relKey,
          registeredVersion: existing.version,
          requested: requestedVersion,
        },
      }),
    };
  }
  return { ok: true, version: requestedVersion };
}

/** `th artifact list` — list every recorded approved artifact. */
export function runArtifactList(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }
  const artifacts = r.state.approved_artifacts;
  const human = artifacts.length
    ? artifacts.map((a) => `${a.file}  v${a.version}  ${a.hash}`).join("\n")
    : "(none)";
  return success({ data: { artifacts }, human });
}

// ---------------------------------------------------------------------------
// `th artifact section` (SG3 P1-B / C-12) — bounded named-heading extraction
// ---------------------------------------------------------------------------

/**
 * Token estimator: ~4 chars per token (mirrors `context.ts` TOKENS_PER_CHAR and the
 * §9 pack budget heuristic). The single estimation point so the budget math here and
 * in `th context pack` / `th context read` agree.
 */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

export interface ArtifactSectionOptions {
  /** Artifact file to read (root-relative or absolute within root). */
  file?: string;
  /** Heading name to extract (the H1-H6 text, e.g. "External Dependencies"). */
  section?: string;
  /** Token budget for the returned body. When set (>0), the body is truncated to fit. */
  maxTokens?: number;
}

/**
 * `th artifact section --file <p> --section <h> [--max-tokens N]` (C-12) — extract the
 * BODY of a named heading from a markdown artifact under an optional token budget, with
 * a content-hash RECEIPT of the FULL extracted section. This closes the "no bounded
 * section read" gap: an agent can pull JUST `## External Dependencies` (or any heading)
 * without reading — or paying the token cost of — the whole document.
 *
 * Determinism: the section is the first heading whose text equals `--section`
 * (case-insensitive); its body runs to the next same-or-higher-level heading
 * (`extractSection`). When `--max-tokens` is set and the body exceeds it, the body is
 * truncated to the budget by KEEPING A LINE PREFIX (deterministic — never a random
 * slice), and `truncated:true` is reported. The receipt always hashes the FULL section
 * body (the evidence of what was extracted), regardless of truncation. Read-only.
 *
 * Follows Critical Pattern 1: named `runArtifactSection`, `paths` first, typed opts
 * second; returns `success()`/`failure()` (never throws / exits); one structuredLog.
 */
export function runArtifactSection(paths: ProjectPaths, opts: ArtifactSectionOptions = {}): CommandResult {
  if (!opts.file) {
    structuredLog({ cmd: "artifact section", error: "no_file" });
    return failure({ human: "usage: th artifact section --file <path> --section <heading> [--max-tokens N]", data: { error: "no_file" } });
  }
  if (!opts.section) {
    structuredLog({ cmd: "artifact section", error: "no_section" });
    return failure({ human: "usage: th artifact section --file <path> --section <heading> [--max-tokens N]", data: { error: "no_section" } });
  }

  const abs = resolveWithinRoot(paths.root, opts.file);
  if (abs === null) {
    structuredLog({ cmd: "artifact section", error: "path_outside_root", file: opts.file });
    return failure({ human: `Path outside project root: ${opts.file}`, data: { error: "path_outside_root", file: opts.file } });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    structuredLog({ cmd: "artifact section", error: "file_not_found", file: opts.file });
    return failure({ human: `File not found: ${opts.file}`, data: { error: "file_not_found", file: opts.file } });
  }

  const relKey = toRelKey(paths.root, opts.file);
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    structuredLog({ cmd: "artifact section", error: "read_failed", file: relKey });
    return failure({ human: `Could not read ${relKey}`, data: { error: "read_failed", file: relKey } });
  }

  const extracted = extractSection(content, opts.section);
  if (!extracted.found) {
    structuredLog({ cmd: "artifact section", error: "section_not_found", file: relKey, section: opts.section });
    return failure({
      human: `No \`${opts.section}\` heading in ${relKey}.`,
      data: { error: "section_not_found", file: relKey, section: opts.section },
    });
  }

  const fullBody = extracted.body;
  const fullTokens = estimateTokens(fullBody);

  // Token budget: when set (>0), truncate the body to fit by keeping a deterministic
  // LINE PREFIX. The receipt always hashes the FULL body (the evidence of what the
  // section is), so a downstream consumer can detect a later edit even if it only saw
  // the truncated head.
  const budget = typeof opts.maxTokens === "number" && opts.maxTokens > 0 ? opts.maxTokens : null;
  let bodyOut = fullBody;
  let truncated = false;
  if (budget !== null && fullTokens > budget) {
    const lines = fullBody.split("\n");
    const kept: string[] = [];
    let running = 0;
    for (const line of lines) {
      const cost = estimateTokens(line + "\n");
      if (running + cost > budget) break;
      kept.push(line);
      running += cost;
    }
    bodyOut = kept.join("\n");
    truncated = true;
  }

  const receipt: ReadReceipt = { file: relKey, hash: hashContent(fullBody), tokensConsumed: estimateTokens(bodyOut) };

  structuredLog({
    cmd: "artifact section",
    file: relKey,
    section: opts.section,
    fullTokens,
    returnedTokens: receipt.tokensConsumed,
    truncated,
  });

  const human = [
    extracted.heading ?? `## ${opts.section}`,
    "",
    bodyOut || "(empty section)",
    "",
    truncated
      ? `(truncated to --max-tokens=${budget}; full section ~${fullTokens} tokens, hash ${receipt.hash.slice(0, 12)})`
      : `(~${fullTokens} tokens, hash ${receipt.hash.slice(0, 12)})`,
  ].join("\n");

  return success({
    receipts: [receipt],
    data: {
      file: relKey,
      section: opts.section,
      heading: extracted.heading,
      body: bodyOut,
      fullTokens,
      returnedTokens: receipt.tokensConsumed,
      truncated,
      maxTokens: budget,
      receipts: [receipt],
    },
    human,
  });
}
