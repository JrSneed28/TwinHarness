/**
 * SLICE-8 / TASK-017 — Reporter: human stream + final summary + `--json` + secret
 * redaction (REQ-017, REQ-019, REQ-024, REQ-018).
 *
 * Anchored to:
 *  - REQ-017 — the CLI streams human-readable progress (plan/step, each tool call +
 *    outcome, diffs, test results) IN ORDER.
 *  - REQ-019 — on completion a final summary reports outcome, files changed (+diffs),
 *    tests, iterations used, tokens, runId.
 *  - REQ-024 — `--json` emits a parseable, schema-stable RunSummary (IF-016) with
 *    status/exitCode/stopCondition + schemaVersion.
 *  - REQ-018 — the API key appears in NEITHER the transcript JSONL NOR the `--json`
 *    stdout (the redaction test greps both for a sentinel key and asserts absence).
 *
 * The reporter renders the SAME classified RunSummary two ways (compute once) and the
 * exitCode/status/stopCondition are REUSED from the SLICE-7 classification, never
 * recomputed here. stdout is captured via an injected writer. No network, no real
 * subprocess.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReporter, type ReporterWriter } from "../src/reporter.js";
import { createBudgetController } from "../src/budget-stop.js";
import { createAgentRun } from "../src/agent-run.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createReadTool } from "../src/tool-read.js";
import { createPathSandbox } from "../src/path-sandbox.js";
import { createTranscriptWriter } from "../src/transcript.js";
import { buildRepoContext } from "../src/repo-context.js";
import { SCHEMA_VERSION } from "../src/contracts.js";
import type { LlmResponse, RunSummary } from "../src/contracts.js";
import { createStubLlmClient } from "./stubs.js";

/** A capturing stdout sink: records every write so a test can assert order/content. */
function captureWriter(): ReporterWriter & { text: () => string; chunks: string[] } {
  const chunks: string[] = [];
  return {
    write: (t: string) => {
      chunks.push(t);
    },
    chunks,
    text: () => chunks.join(""),
  };
}

/**
 * Build a RunSummary FROM the SLICE-7 classification (the reporter must reuse, not
 * recompute, status/exitCode/stopCondition). This mirrors how the composition root
 * assembles the summary: classify once, then fill the run facts.
 */
function summaryFromClassification(opts: {
  signal: Parameters<ReturnType<typeof createBudgetController>["classify"]>[0];
  filesChanged?: RunSummary["filesChanged"];
  testsResult?: RunSummary["testsResult"];
  iterationsUsed?: number;
  tokensUsed?: number;
  estimated?: boolean;
  runId?: string;
}): RunSummary {
  const classified = createBudgetController().classify(opts.signal);
  return {
    status: classified.status,
    stopCondition: classified.stopCondition,
    exitCode: classified.exitCode, // 0 IFF succeeded — reused from SLICE-7 (INV-006)
    filesChanged: opts.filesChanged ?? [],
    testsResult: opts.testsResult ?? { ran: false, passed: 0, failed: 0 },
    iterationsUsed: opts.iterationsUsed ?? 0,
    tokensUsed: opts.tokensUsed ?? 0,
    estimated: opts.estimated,
    runId: opts.runId ?? "run-rep",
    schemaVersion: SCHEMA_VERSION,
  };
}

describe("SLICE-8 Reporter human stream + --json summary + redaction (REQ-017/019/024/018)", () => {
  // Anchor: REQ-017.
  it("test_REQ017_streams_plan_toolcalls_diffs_results", () => {
    // The reporter streams the plan/step, each tool call + its outcome, diffs, and
    // test results — and the ORDER is the contract (not colors/width).
    const cap = captureWriter();
    const reporter = createReporter({ out: cap });

    reporter.streamPlan("read the readme, then run tests");
    reporter.streamToolCall("read_file", { path: "/repo/README.md" });
    reporter.streamToolResult("ok", "42 lines");
    reporter.streamDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n");
    reporter.streamToolCall("run_command", { command: "npm test" });
    reporter.streamToolResult("ok");
    reporter.streamTestResult("npm test", 12, 0);

    const text = cap.text();
    // Each event is present.
    expect(text).toContain("plan: read the readme");
    expect(text).toContain("tool read_file");
    expect(text).toContain("tool run_command");
    expect(text).toContain("+new"); // the diff body streamed
    expect(text).toContain("12 passed, 0 failed");

    // ORDER: plan → first tool call → its result → diff → second tool call → test
    // result. Assert by ascending index of each marker (the ordering contract).
    const idx = (needle: string) => text.indexOf(needle);
    expect(idx("plan:")).toBeLessThan(idx("tool read_file"));
    expect(idx("tool read_file")).toBeLessThan(idx("← ok 42 lines"));
    expect(idx("← ok 42 lines")).toBeLessThan(idx("+new"));
    expect(idx("+new")).toBeLessThan(idx("tool run_command"));
    expect(idx("tool run_command")).toBeLessThan(idx("12 passed, 0 failed"));
  });

  // Anchor: REQ-019.
  it("test_REQ019_summary_reports_outcome_files_tests_iters_tokens", () => {
    // The final summary reports status, filesChanged (+diffs), testsResult,
    // iterationsUsed, tokensUsed, runId — the human form, rendered from the SAME
    // classified object.
    const cap = captureWriter();
    const reporter = createReporter({ out: cap });
    const summary = summaryFromClassification({
      signal: { kind: "task-success" },
      filesChanged: [
        { targetPath: "src/app.ts", diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@\n+added\n" },
      ],
      testsResult: { ran: true, passed: 9, failed: 1 },
      iterationsUsed: 3,
      tokensUsed: 1234,
      runId: "run-summary",
    });

    const returned = reporter.renderSummary(summary);
    // renderSummary renders the SAME object it was given (compute once, render twice).
    expect(returned).toBe(summary);

    const text = cap.text();
    expect(text).toContain("status:        succeeded (exit 0)");
    expect(text).toContain("src/app.ts");
    expect(text).toContain("+added"); // the file's diff is shown
    expect(text).toContain("9 passed, 1 failed");
    expect(text).toContain("iterations:    3");
    expect(text).toContain("tokens:        1234");
    expect(text).toContain("runId:         run-summary");

    // A stopped run with no files / no tests renders the empty/none forms too.
    const cap2 = captureWriter();
    const r2 = createReporter({ out: cap2 });
    r2.renderSummary(
      summaryFromClassification({
        signal: { kind: "model-give-up" },
        tokensUsed: 50,
        estimated: true,
        runId: "run-stop",
      }),
    );
    const t2 = cap2.text();
    expect(t2).toContain("status:        stopped (exit 1)");
    expect(t2).toContain("filesChanged:  (none)");
    expect(t2).toContain("tests:         (not run)");
    expect(t2).toContain("tokens:        50 (estimated)");
  });

  // Anchor: REQ-024.
  it("test_REQ024_json_summary_schema_stable_and_parseable", () => {
    // With --json, the final summary is a PARSEABLE JSON object carrying every IF-016
    // field + schemaVersion. The human form is still emitted; the JSON is its own line.
    const cap = captureWriter();
    const reporter = createReporter({ out: cap, json: true });
    const summary = summaryFromClassification({
      signal: { kind: "task-success" },
      filesChanged: [{ targetPath: "a.ts", diff: "diff-text" }],
      testsResult: { ran: true, passed: 5, failed: 0 },
      iterationsUsed: 2,
      tokensUsed: 999,
      runId: "run-json",
    });
    reporter.renderSummary(summary);

    // The LAST non-empty line of stdout is the JSON object (CI parses it).
    const jsonLine = cap
      .text()
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .pop();
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine as string) as RunSummary;

    // Every required IF-016 field is present and correctly typed (schema-stable).
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.status).toBe("succeeded");
    expect(parsed.stopCondition).toBe("task-success");
    expect(parsed.exitCode).toBe(0);
    expect(Array.isArray(parsed.filesChanged)).toBe(true);
    expect(parsed.filesChanged[0]?.targetPath).toBe("a.ts");
    expect(parsed.filesChanged[0]?.diff).toBe("diff-text");
    expect(parsed.testsResult).toEqual({ ran: true, passed: 5, failed: 0 });
    expect(parsed.iterationsUsed).toBe(2);
    expect(parsed.tokensUsed).toBe(999);
    expect(parsed.runId).toBe("run-json");

    // Without --json, NO JSON object is emitted (human-only).
    const capNo = captureWriter();
    createReporter({ out: capNo, json: false }).renderSummary(summary);
    const hasJson = capNo
      .text()
      .split("\n")
      .some((l) => l.trim().startsWith("{"));
    expect(hasJson).toBe(false);
  });

  // Anchor: REQ-024.
  it("test_REQ024_json_exitcode_status_stopcondition_present", () => {
    // CI may rely on status/exitCode/stopCondition PERMANENTLY (IF-016 stability). For
    // every classified terminal, the --json object carries all three with exitCode==0
    // IFF status==succeeded (INV-006, reused from SLICE-7 — not recomputed here).
    const signals = [
      { kind: "task-success" as const, status: "succeeded", stop: "task-success", exit0: true },
      { kind: "model-give-up" as const, status: "stopped", stop: "model-give-up", exit0: false },
      { kind: "user-abort" as const, status: "stopped", stop: "user-abort", exit0: false },
      { kind: "unrecoverable-error" as const, status: "failed", stop: "unrecoverable-error", exit0: false },
    ];
    for (const sig of signals) {
      const cap = captureWriter();
      const reporter = createReporter({ out: cap, json: true });
      reporter.renderSummary(summaryFromClassification({ signal: { kind: sig.kind } }));
      const jsonLine = cap
        .text()
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .pop();
      const parsed = JSON.parse(jsonLine as string) as RunSummary;
      expect(parsed.status).toBe(sig.status);
      expect(parsed.stopCondition).toBe(sig.stop);
      if (sig.exit0) {
        expect(parsed.exitCode).toBe(0);
      } else {
        expect(parsed.exitCode).not.toBe(0);
      }
      // The exit-code invariant holds for every terminal (INV-006).
      expect(parsed.exitCode === 0).toBe(parsed.status === "succeeded");
    }
  });
});

describe("SLICE-8 secret redaction — apiKey in neither transcript nor --json (REQ-018)", () => {
  let root: string;
  let transcriptDir: string;
  let fixtureFile: string;
  /** A distinctive sentinel API key the test greps for everywhere. */
  const SENTINEL_KEY = "sk-ant-SENTINEL-DO-NOT-LEAK-0123456789";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice8-redact-"));
    transcriptDir = path.join(root, ".transcripts");
    fixtureFile = path.join(root, "README.md");
    await fs.writeFile(fixtureFile, "# fixture\nline two\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Anchor: REQ-018.
  it("test_REQ018_apikey_never_serialized", async () => {
    // Drive a real run with the sentinel API key in scope, then GREP both the
    // transcript JSONL and the captured --json stdout for the key string and assert
    // ABSENCE (ABU-009). The transcript never receives the key (emitters never put it
    // in a payload); the reporter additionally REDACTS it from stdout as defense in
    // depth — even a diff/output line that happened to carry the key is scrubbed.
    const runId = "run-redact";
    const script: LlmResponse[] = [
      {
        toolCalls: [{ id: "c1", toolName: "read_file", arguments: { path: fixtureFile } }],
        finalAnswer: null,
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2, estimated: false },
      },
      { toolCalls: null, finalAnswer: "done", stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 1, estimated: false } },
    ];
    const llm = createStubLlmClient(script);
    const sandbox = createPathSandbox(root);
    const registry = createToolRegistry(createReadTool(sandbox));
    const transcript = createTranscriptWriter({ dir: transcriptDir });
    const cap = captureWriter();
    // The reporter is configured with the sentinel as the secret to redact (REQ-018).
    const reporter = createReporter({ out: cap, json: true, secrets: [SENTINEL_KEY] });
    const context = buildRepoContext(root);
    const budget = createBudgetController({ maxIterations: 25, tokenBudget: 1_000_000 });

    const agentRun = createAgentRun({
      runId,
      task: "read the readme",
      root,
      modelId: "stub-model",
      context,
      llm,
      registry,
      transcript,
      reporter,
      budget,
    });
    const outcome = await agentRun.run();

    // Build + render the final summary (reusing the SLICE-7 classification). A
    // MALICIOUS payload deliberately tries to leak the key through a diff line — the
    // reporter must scrub it.
    const summary: RunSummary = {
      status: outcome.status,
      stopCondition: "task-success",
      exitCode: outcome.exitCode, // reused — not recomputed
      filesChanged: [
        { targetPath: "leak.ts", diff: `+ const k = "${SENTINEL_KEY}";\n` },
      ],
      testsResult: { ran: false, passed: 0, failed: 0 },
      iterationsUsed: 1,
      tokensUsed: 12,
      runId,
      schemaVersion: SCHEMA_VERSION,
    };
    // Also try to leak via the human stream directly.
    reporter.streamToolResult("ok", `key=${SENTINEL_KEY}`);
    reporter.renderSummary(summary);

    // GREP 1: the transcript JSONL file content never contains the sentinel key.
    const transcriptRaw = await fs.readFile(
      path.join(transcriptDir, `${runId}.jsonl`),
      "utf8",
    );
    expect(transcriptRaw.includes(SENTINEL_KEY)).toBe(false);

    // GREP 2: the captured --json (+human) stdout never contains the sentinel key —
    // even the malicious diff line and the malicious stream note were redacted.
    const stdout = cap.text();
    expect(stdout.includes(SENTINEL_KEY)).toBe(false);
    // The redaction placeholder IS present where the key would have been (proof the
    // line was emitted-and-scrubbed, not merely dropped).
    expect(stdout).toContain("[REDACTED]");

    // The --json line still PARSES (redaction did not corrupt the JSON structure).
    const jsonLine = stdout
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .pop();
    const parsed = JSON.parse(jsonLine as string) as RunSummary;
    expect(parsed.runId).toBe(runId);
    expect(parsed.status).toBe("succeeded");
    expect(JSON.stringify(parsed).includes(SENTINEL_KEY)).toBe(false);
  });
});
