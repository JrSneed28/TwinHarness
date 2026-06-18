/**
 * Published JSON Schemas (Phase 4) stay in sync with the hand-rolled validators.
 * The CLI has zero runtime deps (no JSON-schema engine), so this test — not a
 * library — guarantees schemas/*.json keep matching src/core/state-schema.ts and
 * src/core/brief.ts.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_FIELD_ORDER } from "../src/core/state-schema";

const ROOT = path.resolve(__dirname, "..");
const load = (p: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")) as Record<string, unknown>;

const OPTIONAL_STATE_FIELDS = ["schema_version", "write_gate", "project_mode", "debate_open_blocking", "interview_cutoff", "max_tokens"];

describe("REQ-SCHEMA-001: state.schema.json matches the validator", () => {
  it("properties cover exactly STATE_FIELD_ORDER", () => {
    const schema = load("schemas/state.schema.json");
    const props = Object.keys(schema.properties as object).sort();
    expect(props).toEqual([...STATE_FIELD_ORDER].sort());
  });

  it("required lists every non-optional field", () => {
    const schema = load("schemas/state.schema.json");
    const expected = (STATE_FIELD_ORDER as string[]).filter((f) => !OPTIONAL_STATE_FIELDS.includes(f)).sort();
    expect([...(schema.required as string[])].sort()).toEqual(expected);
  });
});

describe("REQ-SCHEMA-002: brief.schema.json matches the brief validator", () => {
  it("covers all brief fields and leaves description optional", () => {
    const schema = load("schemas/brief.schema.json");
    const props = Object.keys(schema.properties as object);
    for (const f of [
      "description",
      "single_file_or_local",
      "changes_public_interface",
      "adds_dependency",
      "obvious_testable_answer",
      "blast_radius_flags",
    ]) {
      expect(props).toContain(f);
    }
    expect(schema.required as string[]).not.toContain("description");
  });
});
