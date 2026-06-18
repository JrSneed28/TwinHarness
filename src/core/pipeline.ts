/**
 * The canonical artifact dependency order (spec §18 "Artifacts form a dependency
 * graph"). Cascade re-verification is diff-scoped: when an upstream artifact's
 * version changes, every artifact strictly *after* it in this order is marked
 * stale (`th stale --since <hash>`, §18). The order is the SDLC stage order from
 * the plan (requirements → scope → … → verification report).
 *
 * Pure data + a single lookup helper — no IO, no clock, no randomness.
 */

/**
 * Canonical pipeline order of artifact files, root-relative with forward slashes
 * (matching the `approved_artifacts.file` key shape, see commands/artifact.ts).
 * `docs/00-research` (the conditional Researcher's output) is the most-upstream
 * artifact — it feeds the design stages, so a change to it cascades to everything.
 * `docs/04b-ui-design.md` (conditional UI-Design) sits just after architecture.
 * `docs/00-research` and `docs/05-adrs` are directories; the rest are single files.
 */
export const ARTIFACT_PIPELINE: string[] = [
  "docs/00-research",
  "docs/01-requirements.md",
  "docs/02-scope.md",
  "docs/03-domain-model.md",
  "docs/04-architecture.md",
  "docs/04a-ux-design.md",
  "docs/04b-ui-design.md",
  "docs/05-adrs",
  "docs/06-technical-design.md",
  "docs/07-contracts.md",
  "docs/08a-security-threat-model.md",
  "docs/08b-failure-edge-cases.md",
  "docs/08-test-strategy.md",
  "docs/09-implementation-plan.md",
  "docs/10-verification-report.md",
];

/**
 * Everything strictly downstream of `file` in {@link ARTIFACT_PIPELINE} — i.e.
 * the artifacts that depend (transitively) on it and must be re-verified when it
 * changes. Returns `[]` when `file` is not in the pipeline or is the last entry.
 */
export function downstreamOf(file: string): string[] {
  const idx = ARTIFACT_PIPELINE.indexOf(file);
  if (idx < 0) return [];
  return ARTIFACT_PIPELINE.slice(idx + 1);
}
