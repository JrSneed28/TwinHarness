import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  runInterviewStart,
  runInterviewRecord,
  runInterviewStatus,
  DEFAULT_INTERVIEW_CUTOFF,
} from "../src/commands/interview";

/**
 * Pure interview-handler round-trip. The interview tools are STORE-ONLY and
 * deterministic: they record agent-supplied scores/confidence verbatim and COMPUTE
 * nothing except `ready = confidence >= cutoff`. These tests pin that contract plus
 * the lazy on-read upgrade of a legacy `{ threshold, ambiguity }` interview.json.
 */

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("interview handlers — store-only round-trip (start/record/status)", () => {
  it("status on a fresh project reports not-started with the default cutoff", () => {
    tp = makeTempProject();
    const res = runInterviewStatus(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.started).toBe(false);
    expect(res.data?.rounds).toBe(0);
    expect(res.data?.confidence).toBe(null);
    expect(res.data?.cutoff).toBe(DEFAULT_INTERVIEW_CUTOFF);
    expect(res.data?.ready).toBe(false);
  });

  it("the default cutoff is 0.8", () => {
    expect(DEFAULT_INTERVIEW_CUTOFF).toBe(0.8);
  });

  it("start requires idea; without it returns missing_field", () => {
    tp = makeTempProject();
    const res = runInterviewStart(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("missing_field");
    expect(res.data?.field).toBe("idea");
  });

  it("start creates interview.json with the default cutoff; record fails before start", () => {
    tp = makeTempProject();
    // record before start → not_started
    const early = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.9, constraints: 0.9, criteria: 0.9 },
      confidence: 0.9,
    });
    expect(early.ok).toBe(false);
    expect(early.data?.error).toBe("not_started");

    const start = runInterviewStart(tp.paths, { idea: "build a thing" });
    expect(start.ok).toBe(true);
    expect(start.data?.cutoff).toBe(DEFAULT_INTERVIEW_CUTOFF);
    expect(fs.existsSync(tp.paths.interviewFile)).toBe(true);
  });

  it("record appends rounds and ready flips true once confidence ≥ cutoff", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x", cutoff: 0.75 });

    const r1 = runInterviewRecord(tp.paths, {
      question: "goal?",
      answer: "ship it",
      scores: { goal: 0.4, constraints: 0.5, criteria: 0.6 },
      confidence: 0.4,
      entities: ["a", "b"],
    });
    expect(r1.ok).toBe(true);
    expect(r1.data?.rounds).toBe(1);
    expect(r1.data?.ready).toBe(false);

    const r2 = runInterviewRecord(tp.paths, {
      question: "constraints?",
      answer: "deterministic",
      scores: { goal: 0.8, constraints: 0.8, criteria: 0.8 },
      confidence: 0.8,
    });
    expect(r2.ok).toBe(true);
    expect(r2.data?.rounds).toBe(2);
    expect(r2.data?.ready).toBe(true);

    const status = runInterviewStatus(tp.paths);
    expect(status.data?.rounds).toBe(2);
    expect(status.data?.confidence).toBe(0.8);
    expect(status.data?.cutoff).toBe(0.75);
    expect(status.data?.ready).toBe(true);
  });

  it("cutoff override is honored: same confidence, different gate verdicts", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x", cutoff: 0.9 });
    const r = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.85, constraints: 0.85, criteria: 0.85 },
      confidence: 0.85,
    });
    // 0.85 < 0.9 → NOT ready under the stricter override.
    expect(r.data?.ready).toBe(false);
    expect(runInterviewStatus(tp.paths).data?.cutoff).toBe(0.9);
  });

  it("the status result COMPUTES nothing beyond ready (exact key-set)", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x" });
    runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.9, constraints: 0.9, criteria: 0.9 },
      confidence: 0.9,
    });
    const status = runInterviewStatus(tp.paths);
    // Only the stored values + the single computed `ready`; no derived scores/aggregates.
    expect(Object.keys(status.data ?? {}).sort()).toEqual(
      ["confidence", "cutoff", "ready", "rounds", "started"].sort(),
    );
  });

  it("record validates shape: bad scores / confidence out of range / non-string entities are refused", () => {
    tp = makeTempProject();
    runInterviewStart(tp.paths, { idea: "x" });

    const badScores = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.9, constraints: 0.9 }, // missing criteria
      confidence: 0.9,
    });
    expect(badScores.ok).toBe(false);
    expect(badScores.data?.error).toBe("invalid_scores");

    const badConfidence = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.9, constraints: 0.9, criteria: 0.9 },
      confidence: 1.5, // out of [0,1]
    });
    expect(badConfidence.ok).toBe(false);
    expect(badConfidence.data?.error).toBe("invalid_confidence");

    const badEntities = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.9, constraints: 0.9, criteria: 0.9 },
      confidence: 0.9,
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

describe("interview.json LAZY on-read upgrade (legacy {threshold, ambiguity} → {cutoff, confidence})", () => {
  it("upgrades a legacy interview.json on read: cutoff 0.8, confidence inverts, NOT dropped as not-started", () => {
    tp = makeTempProject();
    // A legacy on-disk document in the OLD shape (threshold 0.2, ambiguity 0.3 → confidence 0.7).
    const legacy = {
      idea: "legacy idea",
      threshold: 0.2,
      rounds: [
        {
          question: "goal?",
          answer: "ship",
          scores: { goal: 0.3, constraints: 0.3, criteria: 0.3 },
          ambiguity: 0.3,
          entities: ["x"],
        },
      ],
      ambiguity: 0.3,
      status: "in-progress",
    };
    fs.mkdirSync(path.dirname(tp.paths.interviewFile), { recursive: true });
    fs.writeFileSync(tp.paths.interviewFile, JSON.stringify(legacy, null, 2) + "\n", "utf8");

    const status = runInterviewStatus(tp.paths);
    // NOT dropped as "not started" — the legacy shape survives validation + upgrades.
    expect(status.ok).toBe(true);
    expect(status.data?.started).toBe(true);
    expect(status.data?.rounds).toBe(1);
    // Default mapping: threshold 0.2 → cutoff 0.8; latest ambiguity 0.3 → confidence 0.7.
    expect(status.data?.cutoff).toBeCloseTo(0.8, 10);
    expect(status.data?.confidence).toBeCloseTo(0.7, 10);
    // confidence 0.7 < cutoff 0.8 → not ready.
    expect(status.data?.ready).toBe(false);

    // The file was rewritten in the NEW shape, and a one-time .bak snapshot was made.
    const onDisk = JSON.parse(fs.readFileSync(tp.paths.interviewFile, "utf8")) as Record<string, unknown>;
    expect(onDisk.cutoff).toBeCloseTo(0.8, 10);
    expect(onDisk.confidence).toBeCloseTo(0.7, 10);
    expect(onDisk).not.toHaveProperty("threshold");
    expect(onDisk).not.toHaveProperty("ambiguity");
    // The recorded round's ambiguity inverted to confidence (0.3 → 0.7).
    const rounds = onDisk.rounds as Array<Record<string, unknown>>;
    expect(rounds[0]?.confidence).toBeCloseTo(0.7, 10);
    expect(rounds[0]).not.toHaveProperty("ambiguity");

    expect(fs.existsSync(tp.paths.interviewFile + ".bak")).toBe(true);
    const bak = JSON.parse(fs.readFileSync(tp.paths.interviewFile + ".bak", "utf8")) as Record<string, unknown>;
    expect(bak.threshold).toBe(0.2);
    expect(bak.ambiguity).toBe(0.3);
  });

  it("after upgrade, a subsequent record appends in the new shape and gates on confidence", () => {
    tp = makeTempProject();
    const legacy = {
      idea: "legacy",
      threshold: 0.2, // → cutoff 0.8
      rounds: [],
      ambiguity: null,
      status: "in-progress",
    };
    fs.mkdirSync(path.dirname(tp.paths.interviewFile), { recursive: true });
    fs.writeFileSync(tp.paths.interviewFile, JSON.stringify(legacy, null, 2) + "\n", "utf8");

    // First read (via record) upgrades, then appends a high-confidence round → ready.
    const rec = runInterviewRecord(tp.paths, {
      question: "q",
      answer: "a",
      scores: { goal: 0.9, constraints: 0.9, criteria: 0.9 },
      confidence: 0.9,
    });
    expect(rec.ok).toBe(true);
    expect(rec.data?.cutoff).toBeCloseTo(0.8, 10);
    expect(rec.data?.ready).toBe(true);
  });
});
