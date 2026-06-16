import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-030 — Phase 3 parallelism-optimizer wiring (AGENT/PROMPT content).
 *
 * The optimizer is a prompt-level handshake between the Critic (in a new
 * `parallelism` mode) and the Vertical-Slice agent, mediated by the
 * `th build plan --advise` advisory. These are content truths in the agent /
 * skill prompts, so they are asserted by code, not by eyeballing. (The
 * deterministic `th build advise` core is covered by sibling source tests.)
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("REQ-PCO-030: parallelism-optimizer prompt wiring", () => {
  it("REQ-PCO-030: critic.md documents a `parallelism` mode referencing th build advise", () => {
    const critic = read("agents/critic.md");
    expect(critic).toContain("parallelism");
    // The mode must point producers at the advisory command.
    expect(critic).toContain("th build plan --advise");
  });

  it("REQ-PCO-030: critic.md ties the parallelism mode to REQ-PCO-030", () => {
    const critic = read("agents/critic.md");
    expect(critic).toContain("REQ-PCO-030");
  });

  it("REQ-PCO-030: vertical-slice.md documents the optimizer handshake", () => {
    const slice = read("agents/vertical-slice.md");
    // Consumes the Critic(parallelism) suggestions...
    expect(slice).toContain("parallelism");
    // ...plus the th build advise advisory.
    expect(slice).toContain("th build plan --advise");
    // ...and frames it as an explicit handshake/reconciliation.
    expect(slice.toLowerCase()).toContain("optimizer handshake");
  });

  it("REQ-PCO-030: vertical-slice.md keeps the optimizer subordinate to the hard gates", () => {
    const slice = read("agents/vertical-slice.md");
    expect(slice).toContain("th coverage check");
  });

  it("REQ-PCO-030: pipeline-stages.md documents the Stage 9 parallelism-optimizer loop", () => {
    const pipeline = read("skills/twinharness/reference/pipeline-stages-part3.md");
    expect(pipeline).toContain("REQ-PCO-030");
    expect(pipeline.toLowerCase()).toContain("parallelism");
    expect(pipeline).toContain("th build plan --advise");
  });
});
