/**
 * #15 — the shared §16 owner-violation predicate `classifyOwnership` that both
 * Phase-B write gates (Bash-strict + file_path) now route through. The end-to-end
 * gate batteries (hook-gate / pretool-gate / write-gate-strict) prove the
 * deny/ask/allow decisions are unchanged; this golden table pins the predicate
 * directly so the extracted owners→verdict classification can't silently drift.
 *
 * Component tokens contain "/" so they are path-like without touching the disk
 * (isPathLikeComponent short-circuits on "/"); `root` is therefore irrelevant here.
 */

import { describe, it, expect } from "vitest";
import { classifyOwnership } from "../src/commands/hook";

const ROOT = "/proj";
const sl = (id: string, status: string, components: string[]) => ({ id, status, components });

describe("#15: classifyOwnership golden table (unowned / in-progress / violation)", () => {
  it("a path no slice owns → { kind: 'unowned' } (allow)", () => {
    expect(classifyOwnership("src/other.ts", [sl("SLICE-1", "pending", ["src/api"])], ROOT)).toEqual({
      kind: "unowned",
    });
  });

  it("no slices at all → unowned", () => {
    expect(classifyOwnership("src/api/x.ts", [], ROOT)).toEqual({ kind: "unowned" });
  });

  it("owned by an in-progress slice → { kind: 'in-progress' } (allow)", () => {
    expect(classifyOwnership("src/api/x.ts", [sl("SLICE-1", "in-progress", ["src/api"])], ROOT)).toEqual({
      kind: "in-progress",
    });
  });

  it("owned ONLY by a non-in-progress slice → violation with ownerSummary", () => {
    expect(classifyOwnership("src/api/x.ts", [sl("SLICE-1", "pending", ["src/api"])], ROOT)).toEqual({
      kind: "violation",
      ownerSummary: "SLICE-1 (pending)",
    });
  });

  it("an EXACT component match (path === token) is owned", () => {
    expect(classifyOwnership("src/api", [sl("SLICE-1", "done", ["src/api"])], ROOT)).toEqual({
      kind: "violation",
      ownerSummary: "SLICE-1 (done)",
    });
  });

  it("mixed owners with at least one in-progress → in-progress (allow), NOT a violation", () => {
    const slices = [sl("SLICE-1", "pending", ["src/api"]), sl("SLICE-2", "in-progress", ["src/api"])];
    expect(classifyOwnership("src/api/x.ts", slices, ROOT)).toEqual({ kind: "in-progress" });
  });

  it("multiple non-in-progress owners → violation lists all as 'id (status)' joined", () => {
    const slices = [sl("SLICE-1", "pending", ["src/api"]), sl("SLICE-2", "done", ["src/api"])];
    expect(classifyOwnership("src/api/x.ts", slices, ROOT)).toEqual({
      kind: "violation",
      ownerSummary: "SLICE-1 (pending), SLICE-2 (done)",
    });
  });

  it("a non-path-like (no-slash, nonexistent) component does NOT own → unowned", () => {
    // "api" has no "/" and /proj/api does not exist → not path-like → not an owner.
    expect(classifyOwnership("src/api/x.ts", [sl("SLICE-1", "pending", ["api"])], ROOT)).toEqual({
      kind: "unowned",
    });
  });
});
