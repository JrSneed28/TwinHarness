import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { loadBriefFromFile } from "../core/brief";
import { computeRoute } from "../core/routing";
import { appendTelemetry } from "../core/telemetry";
import { structuredLog } from "../core/log";

/**
 * `th route` — advisory model/effort routing (spec §2). Computes the recommended
 * {model, effort} for an agent spawn from the agent, its mode, the tier, and the
 * blast-radius flags. The mapping lives in `core/routing.ts`; this command sources
 * the inputs (tier + blast flags from state by default; `--tier` / `--brief`
 * override) and records the decision to local telemetry. Like `th tier classify`,
 * it COMPUTES — the Orchestrator still APPLIES the override at spawn (§3).
 */

export interface RouteOptions {
  agent?: string;
  mode?: string;
  tier?: string;
  brief?: string;
  componentBlast?: boolean;
  summarization?: boolean;
}

export function runRoute(paths: ProjectPaths, opts: RouteOptions): CommandResult {
  let tier: string | null = opts.tier ?? null;
  let blastFlags: string[] = [];
  let mode = opts.mode;

  // Default tier / blast flags / mode from the live run when present (advisory:
  // routing works even before a run exists — it just falls back to defaults).
  const r = readState(paths);
  if (r.state) {
    if (!opts.tier) tier = r.state.tier;
    blastFlags = [...r.state.blast_radius_flags];
    if (!mode) mode = r.state.current_stage;
  }

  // `--brief` overrides blast flags (e.g. at tier time, before state records them).
  if (opts.brief) {
    const briefFile = resolveWithinRoot(paths.root, opts.brief);
    if (briefFile === null) {
      return failure({
        human: `Brief path outside project root: ${opts.brief}`,
        data: { error: "path_outside_root", file: opts.brief },
      });
    }
    const loaded = loadBriefFromFile(briefFile);
    if (!loaded.ok || !loaded.brief) {
      return failure({
        human: `Could not load brief "${opts.brief}".`,
        data: { error: "invalid_brief", issues: loaded.issues },
      });
    }
    blastFlags = [...loaded.brief.blast_radius_flags];
  }

  const decision = computeRoute({
    agent: opts.agent,
    mode,
    tier,
    blastFlags,
    componentBlast: opts.componentBlast,
    summarization: opts.summarization,
  });

  appendTelemetry(paths, {
    ts: new Date().toISOString(),
    event: "route",
    agent: opts.agent ?? null,
    mode: mode ?? null,
    tier,
    blastFlags,
    model: decision.model,
    effort: decision.effort,
  });
  structuredLog({ cmd: "route", agent: opts.agent, mode, model: decision.model, effort: decision.effort });

  return success({
    data: { model: decision.model, effort: decision.effort, rationale: decision.rationale },
    human: `${decision.model} / ${decision.effort} — ${decision.rationale}`,
  });
}
