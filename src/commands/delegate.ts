import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { structuredLog } from "../core/log";
import { runContextPack } from "./context";
import {
  computeDelegation,
  validateCapsule,
  capsuleTemplate,
  CAPSULE_SECTIONS,
  DELEGATION_INTENTS,
  type DelegationIntent,
  type DelegationSignals,
} from "../core/delegation";
import { mintDelegationId } from "../core/delegation-scope";
import { loadManifest } from "../core/context-manifest";

/**
 * `th delegate` — the Context Preservation / Delegation Layer (advisory).
 *
 * The main context window is a scarce control-plane resource. This group helps the
 * Orchestrator decide WHEN to delegate high-context work to a child agent
 * (`plan`), ASSEMBLE a bounded handoff for it (`pack`), emit the strict return
 * format (`capsule`), and VALIDATE the capsule it returns (`check`). Every verb
 * COMPUTES or CHECKS; like `th route`/`th next` it never decides — the
 * Orchestrator still owns the call. Read-only: no `state.json` mutation.
 */

/** Parse/validate the `--intent` flag against the known set. */
function parseIntent(raw: string | undefined): { intent?: DelegationIntent; error?: string } {
  if (raw === undefined) return {};
  if ((DELEGATION_INTENTS as readonly string[]).includes(raw)) return { intent: raw as DelegationIntent };
  return { error: `unknown intent "${raw}" — expected one of: ${DELEGATION_INTENTS.join(", ")}` };
}

/* ------------------------------------------------------------------ *
 * th delegate plan — the delegate / keep-main recommendation oracle.  *
 * ------------------------------------------------------------------ */

export interface DelegatePlanOptions {
  intent?: string;
  files?: number;
  writes?: boolean;
  noisy?: boolean;
  /** Free-text label echoed into the output (not parsed — keeps the verb deterministic). */
  task?: string;
  /** Slice this task is scoped to — used to frame the suggested handoff. */
  slice?: string;
}

export function runDelegatePlan(opts: DelegatePlanOptions): CommandResult {
  const parsed = parseIntent(opts.intent);
  if (parsed.error) {
    return failure({ human: parsed.error, data: { error: "unknown_intent", intent: opts.intent } });
  }
  const signals: DelegationSignals = {
    intent: parsed.intent,
    files: opts.files,
    writes: opts.writes,
    noisy: opts.noisy,
  };
  const rec = computeDelegation(signals);

  // The suggested handoff references ONLY commands that exist today.
  const handoff: string[] = [];
  if (rec.recommendation === "delegate") {
    handoff.push(opts.slice ? `th context pack --slice ${opts.slice}` : "th context pack");
    handoff.push(
      `th delegate pack --agent ${rec.suggestedAgent}` +
        (opts.slice ? ` --slice ${opts.slice}` : "") +
        (opts.intent ? ` --intent ${opts.intent}` : ""),
    );
    handoff.push("write long-form detail under .twinharness/delegations/DEL-###/; return only the capsule");
  }

  structuredLog({
    cmd: "delegate plan",
    recommendation: rec.recommendation,
    intent: parsed.intent ?? null,
    files: opts.files ?? null,
    suggestedAgent: rec.suggestedAgent,
  });

  const lines: string[] = [`recommendation: ${rec.recommendation}`];
  if (opts.task) lines.push(`task: ${opts.task}`);
  lines.push("reasons:");
  for (const r of rec.reasons) lines.push(`- ${r}`);
  if (rec.suggestedAgent) lines.push(`suggested agent: ${rec.suggestedAgent}`);
  if (handoff.length > 0) {
    lines.push("suggested handoff:");
    for (const h of handoff) lines.push(`- ${h}`);
  }
  lines.push(`context pack recommended: ${rec.packRecommended ? "yes" : "no"}`);
  lines.push(`capsule required: ${rec.capsuleRequired ? "yes" : "no"}`);

  return success({
    data: {
      recommendation: rec.recommendation,
      reasons: rec.reasons,
      suggestedAgent: rec.suggestedAgent,
      suggestedHandoff: handoff,
      packRecommended: rec.packRecommended,
      capsuleRequired: rec.capsuleRequired,
      task: opts.task ?? null,
      slice: opts.slice ?? null,
    },
    human: lines.join("\n"),
  });
}

/* ------------------------------------------------------------------ *
 * th delegate pack — assemble a bounded child-agent handoff.          *
 * ------------------------------------------------------------------ */

export interface DelegatePackOptions {
  agent?: string;
  task?: string;
  intent?: string;
  slice?: string;
  /** P4-7 — frame the handoff's repo-relevant layer for a REQ-ID (agent-specific pack). */
  req?: string;
  /** P4-7 — frame the handoff's repo-relevant layer for a file path (failure/file pack). */
  file?: string;
  /**
   * SG3 P1-B (C-11) — the explicit read/write SCOPE the delegate is allowed to touch
   * (root-relative paths). When provided, the pack emits `allowedFiles[]` in its data and
   * the envelope. The CLI then ARMS this as a DURABLE scope
   * (`.twinharness/delegation-scope.json`, via `core/delegation-scope.ts`), because the
   * out-of-process PreToolUse write-gate (`runHookPretoolGate`) gets NO `allowed_files` on
   * its stdin — it READS the durable scope from disk and DENIES a child write outside it
   * (read-scoping, not write-policy). The scope is disarmed when the delegated subagent
   * stops. When absent the pack derives a sensible default from `--file` (that file) — a
   * `--slice` scope stays component-named (the gate's component-boundary path enforces it).
   */
  allowedFiles?: string[];
  /**
   * R-36 (F7) — an explicit per-delegation id to arm the scope under. Normally OMITTED:
   * `runDelegatePack` MINTS a fresh id so overlapping delegations get independent scope
   * files (no clobber). Supplied only by callers that already own an id (e.g. a re-pack
   * that must update the SAME delegation's scope rather than mint a new one).
   */
  delegationId?: string;
  /**
   * S4/D-03 — tier label for advisory stage manifest lookup
   * (`.twinharness/context-manifests/<tier>/<stage>.json`). When absent, no manifest
   * consultation is attempted and the output is identical to today's behaviour.
   */
  tier?: string;
  /**
   * S4/D-03 — stage label for advisory stage manifest lookup. Requires `tier`.
   * When absent, no manifest consultation is attempted.
   */
  stage?: string;
}

export function runDelegatePack(paths: ProjectPaths, opts: DelegatePackOptions): CommandResult {
  const parsed = parseIntent(opts.intent);
  if (parsed.error) {
    return failure({ human: parsed.error, data: { error: "unknown_intent", intent: opts.intent } });
  }

  // Reuse `th context pack` for slice framing + artifact Summary blocks when a
  // slice/REQ/file selector is given. Propagate its failure (no state / unknown
  // slice) so the caller fixes the precondition instead of getting a half-built
  // handoff. P4-7 — REQ- and file-specific packs give per-agent views (a Debugger
  // gets a failure/file pack; a Spec agent gets a REQ pack).
  let contextPack: string | null = null;
  if (opts.slice || opts.req || opts.file) {
    const pack = runContextPack(paths, { slice: opts.slice, req: opts.req, file: opts.file });
    if (!pack.ok) return pack;
    contextPack = pack.human ?? null;
  }

  // SG3 P1-B (C-11) — the explicit allowed-files scope. Use the supplied list; else
  // default to `--file` when given (the file pack's natural boundary). Normalized to
  // trimmed non-empty entries, deduped, deterministic order. This is the list the
  // write-gate enforces off its stdin payload.
  const allowedFiles = normalizeAllowedFiles(opts.allowedFiles, opts.file);

  // R-36 (F7) — mint a per-delegation id (unless the caller supplied one) so overlapping
  // delegations arm INDEPENDENT scope files. The id is returned in `data.delegationId` (the
  // CLI arms the scope under it) and surfaced in the envelope so the orchestrator can pass
  // it as the subagent's `delegation_id` (per-id enforcement + clear-own-id-only). It is
  // minted even when there is no scope, so the envelope always names the delegation.
  const delegationId = opts.delegationId ?? mintDelegationId();

  // S4/D-03 — advisory stage manifest consultation. When tier+stage are supplied the
  // manifest is loaded; if absent or malformed it is silently ignored (passthrough). The
  // manifest never changes the recommendation or the capsule requirement — it only annotates
  // the handoff with stage-specific section hints and a budget ceiling when a valid manifest
  // is present. When tier or stage is omitted, `manifestSections` and `manifestMaxBudget`
  // remain null and the envelope/data are identical to the pre-manifest behaviour.
  let manifestSections: string[] | null = null;
  let manifestMaxBudget: number | null = null;
  if (opts.tier && opts.stage) {
    try {
      const mr = loadManifest(paths, opts.tier, opts.stage);
      if (mr.found && mr.valid) {
        manifestSections = mr.manifest.sections.artifact.length > 0
          ? mr.manifest.sections.artifact
          : null;
        manifestMaxBudget = mr.manifest.max_budget > 0 ? mr.manifest.max_budget : null;
      }
      // When absent or malformed: advisory — silently ignore, no behaviour change.
    } catch {
      // Fail-safe (D-16): never let manifest loading break a delegate pack.
    }
  }

  const envelope: string[] = [
    "DELEGATED AGENT HANDOFF",
    `Agent: ${opts.agent ?? "(unspecified — set --agent)"}`,
    `Delegation id: ${delegationId}`,
    `Task: ${opts.task ?? "(describe the task)"}`,
    `Intent: ${parsed.intent ?? "(read|write|debug|review|artifact|repo-analysis)"}`,
    `Slice: ${opts.slice ?? "(none)"}`,
    ...(opts.req ? [`REQ: ${opts.req}`] : []),
    ...(opts.file ? [`File: ${opts.file}`] : []),
    `Allowed scope: ${
      opts.slice
        ? `the components of ${opts.slice}; do not edit outside them`
        : opts.file
          ? `${opts.file} and its direct neighbors; do not edit outside them`
          : opts.req
            ? `the files anchored to ${opts.req}; do not edit outside them`
            : "(state the file/dir/component boundary)"
    }`,
    ...(allowedFiles.length
      ? [`Allowed files (write-gate enforced): ${allowedFiles.join(", ")}`]
      : []),
    // S4/D-03 — advisory manifest hints (omitted when no valid manifest is present)
    ...(manifestMaxBudget !== null
      ? [`Context budget (manifest advisory): ${manifestMaxBudget} tokens`]
      : []),
    ...(manifestSections !== null
      ? [`Required sections (manifest advisory): ${manifestSections.join(", ")}`]
      : []),
    "",
    "Context pack:",
    contextPack ?? "(run `th context pack` for approved-artifact Summary blocks)",
    "",
    "Required behavior:",
    "- inspect deeply inside YOUR OWN context; do not return raw scratchwork",
    "- write durable artifacts under .twinharness/delegations/DEL-###/ when detail is long",
    "- return ONLY a Delegation Capsule (format below) to the main context",
    "",
    "Required Delegation Capsule format:",
    capsuleTemplate(),
  ];

  structuredLog({
    cmd: "delegate pack",
    agent: opts.agent ?? null,
    slice: opts.slice ?? null,
    intent: parsed.intent ?? null,
    hasContextPack: contextPack !== null,
    allowedFiles: allowedFiles.length,
    delegationId,
  });

  return success({
    data: {
      agent: opts.agent ?? null,
      task: opts.task ?? null,
      intent: parsed.intent ?? null,
      slice: opts.slice ?? null,
      capsuleSections: [...CAPSULE_SECTIONS],
      hasContextPack: contextPack !== null,
      // SG3 P1-B (C-11) — the explicit write-scope the gate enforces (always present).
      allowedFiles,
      // R-36 (F7) — the minted per-delegation id the CLI arms the scope under.
      delegationId,
      // S4/D-03 — advisory manifest fields; null when no valid manifest was found.
      manifestSections,
      manifestMaxBudget,
    },
    human: envelope.join("\n"),
  });
}

/**
 * SG3 P1-B (C-11) — normalize the allowed-files scope: trim, drop empties, dedupe,
 * deterministic insertion order. Falls back to `[fallbackFile]` when no explicit list
 * was supplied but a `--file` pack target was (the file pack's natural boundary). The
 * paths are kept verbatim (root-relative, as the operator wrote them); the write-gate
 * resolves + compares them against the tool's target, so no resolution happens here.
 */
function normalizeAllowedFiles(list: string[] | undefined, fallbackFile: string | undefined): string[] {
  const raw = list && list.length > 0 ? list : fallbackFile ? [fallbackFile] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of raw) {
    const t = f.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * th delegate capsule — print the blank capsule skeleton.            *
 * ------------------------------------------------------------------ */

export function runDelegateCapsule(): CommandResult {
  structuredLog({ cmd: "delegate capsule" });
  return success({
    data: { sections: [...CAPSULE_SECTIONS], template: capsuleTemplate() },
    human: capsuleTemplate(),
  });
}

/* ------------------------------------------------------------------ *
 * th delegate check — validate a returned capsule's required sections.*
 * ------------------------------------------------------------------ */

export interface DelegateCheckOptions {
  /** Path to a capsule file (root-relative or absolute within root). */
  file?: string;
  /** Inline capsule text — used in preference to `file` when provided (MCP). */
  text?: string;
}

export function runDelegateCheck(paths: ProjectPaths, opts: DelegateCheckOptions): CommandResult {
  let text = opts.text;
  if (text === undefined) {
    if (!opts.file) {
      return failure({
        human: "th delegate check requires --capsule <path> (or inline text via MCP).",
        data: { error: "no_capsule" },
      });
    }
    const abs = resolveWithinRoot(paths.root, opts.file);
    if (abs === null) {
      return failure({
        human: `Capsule path outside project root: ${opts.file}`,
        data: { error: "path_outside_root", file: opts.file },
      });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return failure({
        human: `Capsule file not found: ${opts.file}`,
        data: { error: "capsule_not_found", file: opts.file },
      });
    }
    text = fs.readFileSync(abs, "utf8");
  }

  const v = validateCapsule(text);
  structuredLog({ cmd: "delegate check", ok: v.ok, missing: v.missing.length });

  if (v.ok) {
    return success({
      data: { ok: true, present: v.present, missing: [] },
      human: `Capsule OK — all ${v.present.length} required sections present.`,
    });
  }
  return failure({
    data: { ok: false, present: v.present, missing: v.missing },
    human: `Capsule INVALID — missing ${v.missing.length} required section(s):\n${v.missing
      .map((m) => `  - ${m}`)
      .join("\n")}`,
  });
}
