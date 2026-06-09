"use strict";
/**
 * The canonical artifact dependency order (spec §18 "Artifacts form a dependency
 * graph"). Cascade re-verification is diff-scoped: when an upstream artifact's
 * version changes, every artifact strictly *after* it in this order is marked
 * stale (`th stale --since <hash>`, §18). The order is the SDLC stage order from
 * the plan (requirements → scope → … → verification report).
 *
 * Pure data + a single lookup helper — no IO, no clock, no randomness.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARTIFACT_PIPELINE = void 0;
exports.downstreamOf = downstreamOf;
/**
 * Canonical pipeline order of artifact files, root-relative with forward slashes
 * (matching the `approved_artifacts.file` key shape, see commands/artifact.ts).
 * `docs/05-adrs` is the ADR directory; everything else is a single markdown file.
 */
exports.ARTIFACT_PIPELINE = [
    "docs/01-requirements.md",
    "docs/02-scope.md",
    "docs/03-domain-model.md",
    "docs/04-architecture.md",
    "docs/05-adrs",
    "docs/06-technical-design.md",
    "docs/07-contracts.md",
    "docs/08-test-strategy.md",
    "docs/08a-security-threat-model.md",
    "docs/08b-failure-edge-cases.md",
    "docs/09-implementation-plan.md",
    "docs/10-verification-report.md",
];
/**
 * Everything strictly downstream of `file` in {@link ARTIFACT_PIPELINE} — i.e.
 * the artifacts that depend (transitively) on it and must be re-verified when it
 * changes. Returns `[]` when `file` is not in the pipeline or is the last entry.
 */
function downstreamOf(file) {
    const idx = exports.ARTIFACT_PIPELINE.indexOf(file);
    if (idx < 0)
        return [];
    return exports.ARTIFACT_PIPELINE.slice(idx + 1);
}
