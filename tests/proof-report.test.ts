/**
 * Dual-format report (plan Step 9 / §11 / AC #4 / AC #8).
 *
 * {@link emitReport} must write `report.json` (parses), `report.jsonl` (one object
 * per line), and `report.md` (a section per component card + run summary + coverage
 * matrix + a diagnostic per failure) under `<outputRoot>/<ts>/`, and copy them to
 * `<outputRoot>/latest/`. The renderers are tested over a hand-built report that
 * carries a failing card (so a diagnostic must surface).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emitReport, renderMarkdown, toJsonl } from "../src/core/proof/report";
import { PROOF_COMPONENTS } from "../src/core/proof/types";
import type { CoverageMatrix, ProofReport, ReportCard } from "../src/core/proof/types";

let outRoot: string | undefined;
afterEach(() => {
  if (outRoot) fs.rmSync(outRoot, { recursive: true, force: true });
  outRoot = undefined;
});

function card(component: ReportCard["component"], verdict: ReportCard["verdict"]): ReportCard {
  const pass = verdict !== "fail";
  return {
    component,
    verdict,
    assertions: [{ name: `${component}_invariant`, component, expected: true, actual: pass, pass }],
    stats: { sample: 1 },
    diagnostics: pass
      ? []
      : [{ component, location: `${component}#failed`, severity: "error", hint: `fix the ${component} invariant` }],
  };
}

const MATRIX: CoverageMatrix = {
  subsystems: { count: 2, touched: ["state-store", "schedule"], untouched: [] },
  mcpTools: { count: 2, touched: ["th_route"], untouched: ["th_next"] },
  gates: { count: 1, touched: ["stop"], untouched: [] },
  complete: false,
};

/** A report carrying all nine cards, one of which (stress) FAILS → a diagnostic. */
function buildReport(): ProofReport {
  const cards: ReportCard[] = PROOF_COMPONENTS.map((c) => card(c, c === "stress" ? "fail" : "pass"));
  return {
    summary: {
      id: "proof-2026-06-17T12-00-00-000Z",
      startedAt: "2026-06-17T12:00:00.000Z",
      finishedAt: "2026-06-17T12:00:05.000Z",
      verdict: "fail",
      briefIds: ["tiny-cli-greenfield"],
      componentsRun: [...PROOF_COMPONENTS],
      scenarios: [],
      stats: { selfTest: false },
      tokenCost: null,
    },
    cards,
    matrix: MATRIX,
    regressions: [
      { metric: "scanner-walk", baseline: 10, current: 11, deltaPct: 10, gating: true, regressed: false },
    ],
    diagnostics: cards.flatMap((c) => c.diagnostics),
  };
}

describe("toJsonl — one independently-parseable object per line", () => {
  it("emits summary + each card + matrix + each regression + each diagnostic", () => {
    const report = buildReport();
    const lines = toJsonl(report).trim().split("\n");
    // 1 summary + 9 cards + 1 matrix + 1 regression + 1 diagnostic = 13.
    expect(lines.length).toBe(1 + report.cards.length + 1 + report.regressions.length + report.diagnostics.length);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds[0]).toBe("summary");
    expect(kinds.filter((k) => k === "card").length).toBe(report.cards.length);
    expect(kinds).toContain("matrix");
    expect(kinds).toContain("regression");
    expect(kinds).toContain("diagnostic");
  });
});

describe("renderMarkdown — a section per component card + summary + matrix + diagnostics", () => {
  it("renders a heading per component and the supporting sections", () => {
    const md = renderMarkdown(buildReport());
    for (const component of PROOF_COMPONENTS) {
      expect(md).toContain(component); // a section heading exists for each card
    }
    expect(md).toContain("# TwinHarness Operational Proof Report");
    expect(md).toContain("## Coverage matrix");
    expect(md).toContain("## Diagnostics");
    expect(md).toContain("fix the stress invariant"); // the failing card's diagnostic surfaces
    expect(md).toContain("INCOMPLETE"); // matrix.complete === false is reported
  });
});

describe("emitReport — dual-format artifacts under <ts>/ and a latest/ copy (AC #4)", () => {
  it("writes report.json (parses), report.jsonl (one-per-line), report.md and copies to latest/", () => {
    outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-report-"));
    const report = buildReport();
    const emitted = emitReport(report, { outputRoot: outRoot });

    // Timestamped dir + all three artifacts exist.
    expect(fs.existsSync(emitted.jsonPath)).toBe(true);
    expect(fs.existsSync(emitted.jsonlPath)).toBe(true);
    expect(fs.existsSync(emitted.mdPath)).toBe(true);
    expect(path.dirname(emitted.jsonPath)).toBe(emitted.dir);

    // report.json round-trips.
    const parsed = JSON.parse(fs.readFileSync(emitted.jsonPath, "utf8")) as ProofReport;
    expect(parsed.summary.verdict).toBe("fail");
    expect(parsed.cards.length).toBe(PROOF_COMPONENTS.length);

    // report.jsonl is one object per line.
    const jsonlLines = fs.readFileSync(emitted.jsonlPath, "utf8").trim().split("\n");
    for (const line of jsonlLines) expect(() => JSON.parse(line)).not.toThrow();

    // latest/ copy was written with the same three files.
    const latest = path.join(outRoot, "latest");
    expect(fs.existsSync(path.join(latest, "report.json"))).toBe(true);
    expect(fs.existsSync(path.join(latest, "report.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(latest, "report.md"))).toBe(true);
    // The latest copy matches the timestamped copy.
    expect(fs.readFileSync(path.join(latest, "report.json"), "utf8")).toBe(fs.readFileSync(emitted.jsonPath, "utf8"));
  });
});
