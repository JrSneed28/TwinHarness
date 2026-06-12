/**
 * `th context estimate` — prompt-surface token cost (Phase 3) — REQ-anchored.
 * Reads the real plugin prompt files; asserts structure, not exact sizes.
 */

import { describe, it, expect } from "vitest";
import { runContextEstimate } from "../src/commands/context";

interface FileEst { file: string; lines: number; tokens: number; flag: boolean }

describe("REQ-CONTEXT-001: prompt-surface estimate", () => {
  it("estimates every skill/agent/command prompt file with a positive token total", () => {
    const res = runContextEstimate();
    expect(res.ok).toBe(true);
    const data = res.data as { files: FileEst[]; totalTokens: number };
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.totalTokens).toBeGreaterThan(0);
    // The orchestrator skill is part of the surface.
    expect(data.files.some((f) => f.file.endsWith("skills/twinharness/SKILL.md"))).toBe(true);
    // Every entry has a positive line and token count.
    for (const f of data.files) {
      expect(f.lines).toBeGreaterThan(0);
      expect(f.tokens).toBeGreaterThan(0);
    }
  });
});
