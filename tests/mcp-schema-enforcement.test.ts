/**
 * MCP runtime schema enforcement + gate-owned setter refusal (F-7, H-1/H-2).
 *
 * H-1: validateToolArgs enforces each tool's CLOSED, typed inputSchema before
 * dispatch — extra / wrong-typed / missing-required args are rejected. Tested via
 * the exported pure function (the SDK CallTool handler is not publicly invocable).
 * H-2: the th_state_set adapter refuses GATE_OWNED keys over MCP even though the
 * CLI keeps them settable.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { validateToolArgs, TOOL_DEFS } from "../src/mcp-server";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

const defFor = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

describe("F-7/H-1: validateToolArgs enforces the closed, typed inputSchema", () => {
  it("rejects an extra (additional) property", () => {
    const r = validateToolArgs("th_state_set", { key: "tier", value: "T1", bogus: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong-typed property (th_drift_add layer must be a string)", () => {
    const r = validateToolArgs("th_drift_add", { layer: 5 });
    expect(r.ok).toBe(false);
  });

  it("rejects a value outside an enum (th_drift_add layer)", () => {
    const r = validateToolArgs("th_drift_add", { layer: "nonsense" });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing required property", () => {
    const r = validateToolArgs("th_state_set", { key: "tier" }); // value missing
    expect(r.ok).toBe(false);
  });

  it("accepts a valid call", () => {
    expect(validateToolArgs("th_state_get", { path: "tier" }).ok).toBe(true);
    expect(validateToolArgs("th_drift_add", { layer: "requirement", ref: "SLICE-1" }).ok).toBe(true);
  });

  it("locks down additionalProperties on a zero-property schema (th_next)", () => {
    expect(validateToolArgs("th_next", {}).ok).toBe(true);
    expect(validateToolArgs("th_next", { x: 1 }).ok).toBe(false);
  });

  it("reports an unknown tool", () => {
    expect(validateToolArgs("th_does_not_exist", {}).ok).toBe(false);
  });
});

describe("F-7/H-2: th_state_set refuses GATE_OWNED fields over MCP", () => {
  it.each([
    "implementation_allowed",
    "tier",
    "current_stage",
    "write_gate",
    "blast_radius_flags",
    // R-04 / DR-02 — the four gate-defining config fields are refused over MCP too.
    "delivery_mode",
    "has_ui",
    "interview_required",
    "interview_cutoff",
  ])(
    "refuses gate-owned field %j via the MCP adapter even though the CLI allows it",
    (field) => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      const value =
        field === "implementation_allowed" ? "true"
        : field === "tier" ? "T1"
        : field === "current_stage" ? "requirements"
        : field === "blast_radius_flags" ? "[]"
        : field === "delivery_mode" ? "no-code"
        : field === "has_ui" ? "false"
        : field === "interview_required" ? "false"
        : field === "interview_cutoff" ? "0.1"
        : "deny";
      const res = defFor("th_state_set").run(tp.paths, { key: field, value });
      expect(res.ok).toBe(false);
      expect(res.data?.error).toBe("gate_owned_field");
    },
  );

  it("still allows a non-gate, non-managed field via MCP (regression)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // complexity_rationale is a free-form string field — neither gate-owned nor a
    // managed counter — so the MCP raw setter still accepts it.
    const res = defFor("th_state_set").run(tp.paths, { key: "complexity_rationale", value: "just a note" });
    expect(res.ok).toBe(true);
  });

  it("still refuses the managed drift counter via MCP (regression guard #2)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_state_set").run(tp.paths, { key: "drift_open_blocking", value: "5" });
    expect(res.ok).toBe(false);
  });
});
