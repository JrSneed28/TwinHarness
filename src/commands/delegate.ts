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
}

export function runDelegatePack(paths: ProjectPaths, opts: DelegatePackOptions): CommandResult {
  const parsed = parseIntent(opts.intent);
  if (parsed.error) {
    return failure({ human: parsed.error, data: { error: "unknown_intent", intent: opts.intent } });
  }

  // Reuse `th context pack` for slice framing + artifact Summary blocks when a
  // slice is given. Propagate its failure (no state / unknown slice) so the
  // caller fixes the precondition instead of getting a half-built handoff.
  let contextPack: string | null = null;
  if (opts.slice) {
    const pack = runContextPack(paths, { slice: opts.slice });
    if (!pack.ok) return pack;
    contextPack = pack.human ?? null;
  }

  const envelope: string[] = [
    "DELEGATED AGENT HANDOFF",
    `Agent: ${opts.agent ?? "(unspecified — set --agent)"}`,
    `Task: ${opts.task ?? "(describe the task)"}`,
    `Intent: ${parsed.intent ?? "(read|write|debug|review|artifact|repo-analysis)"}`,
    `Slice: ${opts.slice ?? "(none)"}`,
    `Allowed scope: ${
      opts.slice ? `the components of ${opts.slice}; do not edit outside them` : "(state the file/dir/component boundary)"
    }`,
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
  });

  return success({
    data: {
      agent: opts.agent ?? null,
      task: opts.task ?? null,
      intent: parsed.intent ?? null,
      slice: opts.slice ?? null,
      capsuleSections: [...CAPSULE_SECTIONS],
      hasContextPack: contextPack !== null,
    },
    human: envelope.join("\n"),
  });
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
