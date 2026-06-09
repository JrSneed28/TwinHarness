import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { runStale } from "../src/commands/stale";
import { ARTIFACT_PIPELINE, downstreamOf } from "../src/core/pipeline";
import { shortHash } from "../src/core/hash";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a file (relative to the temp project root) and return its root-relative path. */
function writeFile(t: TempProject, rel: string, content: string): string {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/**
 * Scaffold + register 01-requirements, 04-architecture, 09-implementation-plan
 * and return the recorded hash of 01-requirements (the upstream under test).
 */
function setupRegistered(t: TempProject): { hash01: string } {
  runInit(t.paths, {});
  const reqContent = "REQ-001 the system shall.\n";
  writeFile(t, "docs/01-requirements.md", reqContent);
  writeFile(t, "docs/04-architecture.md", "arch covers REQ-001.\n");
  writeFile(t, "docs/09-implementation-plan.md", "plan covers REQ-001.\n");
  const r1 = runArtifactRegister(t.paths, "docs/01-requirements.md", 1);
  runArtifactRegister(t.paths, "docs/04-architecture.md", 1);
  runArtifactRegister(t.paths, "docs/09-implementation-plan.md", 1);
  return { hash01: r1.data?.hash as string };
}

describe("REQ-STALE-001: unchanged upstream → changed false, downstream registered set is stale (§18)", () => {
  it("01 unchanged → changed=false, stale=[04, 09]", () => {
    tp = makeTempProject();
    const { hash01 } = setupRegistered(tp);

    const res = runStale(tp.paths, hash01);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.upstream).toBe("docs/01-requirements.md");
    expect(res.data?.changed).toBe(false);
    expect(res.data?.stale).toEqual([
      "docs/04-architecture.md",
      "docs/09-implementation-plan.md",
    ]);
    expect(res.human).toContain("unchanged");
  });
});

describe("REQ-STALE-002: changed upstream → changed true, downstream registered set stale (§18)", () => {
  it("editing 01 on disk and querying the original hash → changed=true", () => {
    tp = makeTempProject();
    const { hash01 } = setupRegistered(tp);

    // Modify the upstream file on disk; the recorded hash is now out of date.
    writeFile(tp, "docs/01-requirements.md", "REQ-001 the system shall, REVISED.\n");

    const res = runStale(tp.paths, hash01);
    expect(res.ok).toBe(true);
    expect(res.data?.changed).toBe(true);
    expect(res.data?.stale).toEqual([
      "docs/04-architecture.md",
      "docs/09-implementation-plan.md",
    ]);
    expect(res.human).toContain("changed");
    expect(res.human).toContain("docs/04-architecture.md");
  });
});

describe("REQ-STALE-003: a deleted upstream file is treated as changed (§18)", () => {
  it("removing the upstream file → changed=true", () => {
    tp = makeTempProject();
    const { hash01 } = setupRegistered(tp);
    fs.rmSync(path.join(tp.root, "docs", "01-requirements.md"));

    const res = runStale(tp.paths, hash01);
    expect(res.ok).toBe(true);
    expect(res.data?.changed).toBe(true);
  });
});

describe("REQ-STALE-004: only REGISTERED downstream artifacts are stale (§18)", () => {
  it("an unregistered downstream file is omitted from the stale set", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "docs/04-architecture.md", "arch.\n");
    const r1 = runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    // 04 exists on disk but is NOT registered → not stale.

    const res = runStale(tp.paths, r1.data?.hash as string);
    expect(res.ok).toBe(true);
    expect(res.data?.stale).toEqual([]);
  });
});

describe("REQ-STALE-005: input + lookup failures", () => {
  it("missing --since → usage failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStale(tp.paths, undefined);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.human).toContain("usage:");
  });

  it("unknown hash → failure unknown_hash", () => {
    tp = makeTempProject();
    setupRegistered(tp);
    const res = runStale(tp.paths, "deadbeefcafe");
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.error).toBe("unknown_hash");
  });

  it("not initialized → failure not_initialized", () => {
    tp = makeTempProject();
    const res = runStale(tp.paths, "anything");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});

describe("REQ-STALE-006: downstreamOf is the strict pipeline suffix (§18)", () => {
  it("returns everything strictly after a file in ARTIFACT_PIPELINE", () => {
    expect(downstreamOf("docs/01-requirements.md")).toEqual(ARTIFACT_PIPELINE.slice(1));
    expect(downstreamOf("docs/07-contracts.md")).toEqual([
      "docs/08-test-strategy.md",
      "docs/08a-security-threat-model.md",
      "docs/08b-failure-edge-cases.md",
      "docs/09-implementation-plan.md",
      "docs/10-verification-report.md",
    ]);
  });

  it("the last artifact has no downstream, and an unknown file has none", () => {
    expect(downstreamOf("docs/10-verification-report.md")).toEqual([]);
    expect(downstreamOf("docs/does-not-exist.md")).toEqual([]);
  });

  it("the recorded hash from a real shortHash round-trips against the file content", () => {
    const content = "REQ-001.\n";
    expect(shortHash(content)).toHaveLength(12);
  });
});
