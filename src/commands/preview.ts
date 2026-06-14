import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success } from "../core/output";
import { readState } from "../core/state-store";
import { engagedStages, type StageContract } from "../core/stages";

/**
 * `th preview` — a pre-run "what will this run actually do?" view.
 *
 * Given a tier it lays out the ordered ENGAGED stages for that tier (the subset
 * of STAGE_PIPELINE that tier runs), marking which carry a blocking human gate
 * and which Critic mode reviews each, plus a one-line summary
 * ("T2: N stages, M human gates, K Critic reviews"). It is the static mirror of
 * `th next`: `next` answers "what do I owe right now" from live state; `preview`
 * answers "what is the whole shape of this pipeline" before (or during) a run.
 *
 * Records and computes; never decides (plan §3). Read-only — it never mutates
 * state and never runs anything. Tier resolution:
 *   1. `--tier T<n>` if given,
 *   2. else `state.tier` if a run exists and is classified,
 *   3. else default to T2 (and note that it is the default) so the command is
 *      always useful even before tier classification.
 */

interface PreviewStage {
  stage: string;
  produces: string;
  criticMode: string;
  humanGate: boolean;
  summary: string;
}

function toPreviewStage(c: StageContract): PreviewStage {
  return { stage: c.stage, produces: c.produces, criticMode: c.criticMode, humanGate: c.humanGate, summary: c.summary };
}

export function runPreview(paths: ProjectPaths, opts: { tier?: string }): CommandResult {
  // Resolve tier: explicit flag → recorded state → T2 default.
  let tier = opts.tier?.trim() || undefined;
  let source: "flag" | "state" | "default";
  if (tier) {
    source = "flag";
  } else {
    const recorded = readState(paths).state?.tier ?? null;
    if (recorded) {
      tier = recorded;
      source = "state";
    } else {
      tier = "T2";
      source = "default";
    }
  }

  const stages = engagedStages(tier).map(toPreviewStage);
  const humanGates = stages.filter((s) => s.humanGate).length;
  const criticReviews = stages.filter((s) => s.criticMode.length > 0).length;
  const summary = `${tier}: ${stages.length} stages, ${humanGates} human gates, ${criticReviews} Critic reviews`;

  // T0 (or an unknown tier) engages nothing — say so plainly.
  if (stages.length === 0) {
    const note =
      tier === "T0"
        ? "Tier 0 bypasses the engaged pipeline — no stages, no gates, no Critic reviews."
        : `Tier "${tier}" engages no pipeline stages.`;
    const humanLines = [summary, note];
    if (source === "default") humanLines.push("(no tier resolved — defaulted to T2 then noted this tier engages nothing)");
    return success({
      data: { tier, tierSource: source, stages, humanGates, criticReviews, summary },
      human: humanLines.join("\n"),
    });
  }

  const rows = stages.map((s, i) => {
    const gate = s.humanGate ? "[gate]" : "      ";
    return `${String(i + 1).padStart(2)}. ${s.stage.padEnd(22)} ${gate} critic:${s.criticMode.padEnd(20)} ${s.produces || "(no artifact)"}`;
  });

  const header = [summary];
  if (source === "default") header.push("(no tier specified or recorded — showing the default T2 pipeline; pass --tier T<n> to change)");

  const human = [...header, "", ...rows].join("\n");

  return success({
    data: { tier, tierSource: source, stages, humanGates, criticReviews, summary },
    human,
  });
}
