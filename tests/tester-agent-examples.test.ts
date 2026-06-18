/*
 * Finding #8 — Regression test: tester.md prompt example now uses correct MCP schema fields.
 *
 * The Tester agent prompt (agents/tester.md ~line 158) previously showed:
 *
 *   mcp__plugin_twinharness_th__th_collab_fragment  { content: "<finding summary>" }
 *
 * The real th_collab_fragment inputSchema (src/mcp-server.ts:959-982) has NO `content`
 * property (additionalProperties:false — any call with `content` would fail validation).
 * Its required fields are: stage, round, name. Optional: text, force.
 *
 * The example has been corrected to:
 *   th_collab_fragment { stage: "qa", round: "tester", name: "QA-001.md", text: "<finding summary>" }
 *
 * Also note: tester.md ~line 144 already documents the correct guidance that the Tester
 * should prefer th_drift_add (via `th drift add`) for QA failures — that guidance is correct
 * and is pinned here as well.
 *
 * THIS TEST ASSERTS THE CORRECTED STATE — content: absent, stage/round/name present.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const testerMd = read("agents/tester.md");
const mcpServer = read("src/mcp-server.ts");

// ---------------------------------------------------------------------------
// Locate the th_collab_fragment tool definition block in mcp-server.ts
// We extract from the name declaration up to (but not including) the next tool.
// ---------------------------------------------------------------------------
const collabFragmentBlockMatch = /name:\s*["']th_collab_fragment["'][\s\S]*?additionalProperties:\s*false,?\s*\}/
  .exec(mcpServer);

const collabFragmentBlock = collabFragmentBlockMatch ? collabFragmentBlockMatch[0] : "";

describe("Finding #8: tester.md th_collab_fragment example vs real MCP schema", () => {

  // -------------------------------------------------------------------------
  // Section 1 — Confirm agents/tester.md contains the drifted example.
  // -------------------------------------------------------------------------

  it("tester.md mentions th_collab_fragment", () => {
    expect(testerMd).toContain("th_collab_fragment");
  });

  it('tester.md example uses the correct schema fields (stage/round/name/text), not the old "content:" field', () => {
    // Locate the th_collab_fragment example block in the prompt.
    // The example appears between "th_collab_fragment" and the closing brace.
    const exampleIdx = testerMd.indexOf("th_collab_fragment");
    expect(exampleIdx).toBeGreaterThan(-1);

    // Extract a window of ~200 chars around the example to check the field name.
    const window = testerMd.slice(exampleIdx, exampleIdx + 200);

    // CORRECTED STATE: the example must NOT use `content:` (not a valid schema field).
    expect(window).not.toContain("content:");
  });

  it('tester.md example uses the correct fields (stage/round/name/text) in proximity to th_collab_fragment', () => {
    const exampleIdx = testerMd.indexOf("th_collab_fragment");
    const window = testerMd.slice(exampleIdx, exampleIdx + 200);

    // All required real fields must appear in the corrected example window.
    expect(window).toMatch(/\bstage\s*:/);
    expect(window).toMatch(/\bround\s*:/);
    expect(window).toMatch(/\bname\s*:/);
  });

  // -------------------------------------------------------------------------
  // Section 2 — Real MCP schema assertions.
  // -------------------------------------------------------------------------

  it("src/mcp-server.ts defines th_collab_fragment", () => {
    expect(mcpServer).toContain("th_collab_fragment");
  });

  it('real th_collab_fragment schema has required: ["stage", "round", "name"]', () => {
    expect(collabFragmentBlock).toBeTruthy();
    expect(collabFragmentBlock).toContain('"stage"');
    expect(collabFragmentBlock).toContain('"round"');
    expect(collabFragmentBlock).toContain('"name"');
  });

  it("real th_collab_fragment schema exposes stage, round, name, text, force properties", () => {
    expect(collabFragmentBlock).toMatch(/\bstage\b/);
    expect(collabFragmentBlock).toMatch(/\bround\b/);
    expect(collabFragmentBlock).toMatch(/\bname\b/);
    expect(collabFragmentBlock).toMatch(/\btext\b/);
    expect(collabFragmentBlock).toMatch(/\bforce\b/);
  });

  it("real th_collab_fragment schema has NO content property (mismatch with tester.md example)", () => {
    // This is the core mismatch: the prompt example calls `content:` but the schema
    // does not expose a `content` property. Any call using `content` would fail
    // schema validation (additionalProperties: false).
    expect(collabFragmentBlock).not.toMatch(/\bcontent\b/);
  });

  it('real th_collab_fragment schema lists required as ["stage", "round", "name"]', () => {
    // The exact required array must include all three and not include "content".
    expect(collabFragmentBlock).toContain('required: ["stage", "round", "name"]');
  });

  // -------------------------------------------------------------------------
  // Section 3 — Confirm th_drift_add guidance already exists (correct).
  // -------------------------------------------------------------------------

  it("tester.md already documents th drift add preference for QA failures (~line 144)", () => {
    // The drift-preference guidance is correct and present; only the collab_fragment
    // example is wrong. This assertion confirms the correct section exists.
    expect(testerMd).toMatch(/th drift add/);
  });
});
