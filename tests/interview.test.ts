import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import {
  runInterviewStart,
  runInterviewRecord,
  runInterviewStatus,
  DEFAULT_INTERVIEW_THRESHOLD,
} from "../src/commands/interview";

/**
 * Pure interview-handler round-trip. The interview tools are STORE-ONLY and
 * deterministic: they record agent-supplied scores/ambiguity verbatim and COMPUTE
 * nothing except `ready = ambiguity <= threshold`. These tests pin that contract.
 */

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("interview handlers — store-only round-trip (start/record/status)", () => {
  it("status on a fresh project reports not-started with the default threshold", () => {
    tp = makeTempProject();
    const res = runInterviewStatus(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.started).toBe(false);
    expect(res.data?.rounds).toBe(0);
    expect(res.data?.ambiguity).toBe(null);
    expect(res.data?.threshold).toBe(DEFAULT_INTERVIEW_THRESHOLD);
    expect(res.data?.ready).toBe(false);
  });

  it("start requires idea; without it returns missing_field", () => {
    tp = makeTempProject();
    const res = runInterviewStart(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("missing_field");
    expect(res.data?.field).toBe("idea");
  });

  it("start creates interview.json with the default threshold; record fails before start", () => {
    tp = makeTempProject();
    // record before start → not_started
    const early = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.1, constraints: 0.1, criteria: 0.1 },
      ambiguity: 0.1,
    });
    expect(early.ok).toBe(false);
    expect(early.data?.error).toBe("not_started");

    const start = runInterviewStart(tp.paths, { idea: "build a thing" });
    expect(start.ok).toBe(true);
    expect(start.data?.threshold).toBe(DEFAULT_INTERVIEW_THRESHOLD);
    expect(fs.existsSync(tp.paths.interviewFile)).toBe(true);
  });

  it("record appends rounds and ready flips true once ambiguity ≤ threshold", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x", threshold: 0.25 });

    const r1 = runInterviewRecord(tp.paths, {
      question: "goal?",
      answer: "ship it",
      scores: { goal: 0.6, constraints: 0.5, criteria: 0.4 },
      ambiguity: 0.6,
      entities: ["a", "b"],
    });
    expect(r1.ok).toBe(true);
    expect(r1.data?.rounds).toBe(1);
    expect(r1.data?.ready).toBe(false);

    const r2 = runInterviewRecord(tp.paths, {
      question: "constraints?",
      answer: "deterministic",
      scores: { goal: 0.2, constraints: 0.2, criteria: 0.2 },
      ambiguity: 0.2,
    });
    expect(r2.ok).toBe(true);
    expect(r2.data?.rounds).toBe(2);
    expect(r2.data?.ready).toBe(true);

    const status = runInterviewStatus(tp.paths);
    expect(status.data?.rounds).toBe(2);
    expect(status.data?.ambiguity).toBe(0.2);
    expect(status.data?.threshold).toBe(0.25);
    expect(status.data?.ready).toBe(true);
  });

  it("threshold override is honored: same ambiguity, different gate verdicts", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x", threshold: 0.1 });
    const r = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.15, constraints: 0.15, criteria: 0.15 },
      ambiguity: 0.15,
    });
    // 0.15 > 0.1 → NOT ready under the stricter override.
    expect(r.data?.ready).toBe(false);
    expect(runInterviewStatus(tp.paths).data?.threshold).toBe(0.1);
  });

  it("the status result COMPUTES nothing beyond ready (exact key-set)", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x" });
    runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.1, constraints: 0.1, criteria: 0.1 },
      ambiguity: 0.1,
    });
    const status = runInterviewStatus(tp.paths);
    // Only the stored values + the single computed `ready`; no derived scores/aggregates.
    expect(Object.keys(status.data ?? {}).sort()).toEqual(
      ["ambiguity", "ready", "rounds", "started", "threshold"].sort(),
    );
  });

  it("record validates shape: bad scores / ambiguity out of range / non-string entities are refused", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x" });

    const badScores = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.1, constraints: 0.1 }, // missing criteria
      ambiguity: 0.1,
    });
    expect(badScores.ok).toBe(false);
    expect(badScores.data?.error).toBe("invalid_scores");

    const badAmbiguity = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.1, constraints: 0.1, criteria: 0.1 },
      ambiguity: 1.5, // out of [0,1]
    });
    expect(badAmbiguity.ok).toBe(false);
    expect(badAmbiguity.data?.error).toBe("invalid_ambiguity");

    const badEntities = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.1, constraints: 0.1, criteria: 0.1 },
      ambiguity: 0.1,
      entities: [1, 2] as unknown as string[],
    });
    expect(badEntities.ok).toBe(false);
    expect(badEntities.data?.error).toBe("invalid_entities");
  });

  it("a corrupt interview.json is treated as not started", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x" });
    fs.writeFileSync(tp.paths.interviewFile, "{ not json", "utf8");
    const status = runInterviewStatus(tp.paths);
    expect(status.ok).toBe(true);
    expect(status.data?.started).toBe(false);
  });
});
