/**
 * Shared run-health computations — the single core behind `th doctor` (the
 * run-health audit), `th next` (the next-action oracle), and the slice/coverage
 * views. Keeping these in one place means the audit and the oracle can never
 * disagree about whether an artifact has drifted, a slice is unfinished, or a
 * revise loop has hit its cap.
 *
 * All functions are read-only and clock-free: they record and compute over
 * durable state + on-disk anchors. They never decide which stage runs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import type { TwinHarnessState } from "./state-schema";
import { shortHashPath } from "./hash";

/** Default Agent↔Critic revise-loop cap (spec §18). Mirrors commands/revise.ts. */
export const DEFAULT_REVISE_CAP = 3;

export interface ArtifactIntegrity {
  file: string;
  /** ok = on-disk hash matches the recorded hash; changed = drifted; missing = gone. */
  status: "ok" | "changed" | "missing";
}

/**
 * Compare each approved artifact's recorded hash against its current on-disk
 * hash (file or directory). Surfaces governed docs that were edited without
 * re-registration (silent drift) — the same comparison `th stale` does for one
 * artifact, applied to all.
 */
export function artifactIntegrity(paths: ProjectPaths, state: TwinHarnessState): ArtifactIntegrity[] {
  return state.approved_artifacts.map((a) => {
    const abs = path.resolve(paths.root, a.file);
    if (!fs.existsSync(abs)) return { file: a.file, status: "missing" as const };
    try {
      return { file: a.file, status: shortHashPath(abs) === a.hash ? "ok" : "changed" };
    } catch {
      return { file: a.file, status: "missing" as const };
    }
  });
}

export interface SliceProgress {
  total: number;
  done: number;
  blocked: number;
  inProgress: number;
  pending: number;
  /** True when every slice is in a terminal state (done|blocked) — the §final-verify floor. */
  allSettled: boolean;
}

export function sliceProgress(state: TwinHarnessState): SliceProgress {
  const by = (status: string): number => state.slices.filter((s) => s.status === status).length;
  const done = by("done");
  const blocked = by("blocked");
  const inProgress = by("in-progress");
  const pending = by("pending");
  return {
    total: state.slices.length,
    done,
    blocked,
    inProgress,
    pending,
    allSettled: state.slices.length > 0 && inProgress === 0 && pending === 0,
  };
}

export interface ReviseEscalation {
  mode: string;
  count: number;
  cap: number;
}

/** Revise modes whose count has reached the cap (escalate-to-human per §18). */
export function reviseEscalations(state: TwinHarnessState, cap = DEFAULT_REVISE_CAP): ReviseEscalation[] {
  return Object.entries(state.revise_loop_counts)
    .filter(([, count]) => count >= cap)
    .map(([mode, count]) => ({ mode, count, cap }));
}
