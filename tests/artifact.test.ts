import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister, runArtifactList } from "../src/commands/artifact";
import { shortHash } from "../src/core/hash";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a file (relative to the temp project root) and return its root-relative path. */
function writeFile(t: TempProject, rel: string, content: string): string {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

describe("REQ-ARTIFACT-001: register records a content-hashed, versioned artifact (§12/§18)", () => {
  it("registers a file → approved_artifacts has {file, version:1, hash} with the file's shortHash", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const content = "# Requirements\n\nThe system shall…\n";
    const rel = writeFile(tp, "docs/01-requirements.md", content);

    const res = runArtifactRegister(tp.paths, rel, 1);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.file).toBe("docs/01-requirements.md");
    expect(res.data?.version).toBe(1);
    expect(res.data?.hash).toBe(shortHash(content));

    const r = readState(tp.paths);
    expect(r.state?.approved_artifacts).toEqual([
      { file: "docs/01-requirements.md", version: 1, hash: shortHash(content) },
    ]);
  });
});

describe("REQ-ARTIFACT-002: re-registering the same file REPLACES (version bump, no duplicate)", () => {
  it("registers v1 then v2 of the same file → exactly one entry at version 2", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const rel = writeFile(tp, "docs/01-requirements.md", "v1 content\n");
    runArtifactRegister(tp.paths, rel, 1);

    // Update the content and bump the version.
    const newContent = "v2 content\n";
    writeFile(tp, "docs/01-requirements.md", newContent);
    const res = runArtifactRegister(tp.paths, rel, 2);
    expect(res.ok).toBe(true);

    const r = readState(tp.paths);
    expect(r.state?.approved_artifacts).toHaveLength(1);
    expect(r.state?.approved_artifacts[0]).toEqual({
      file: "docs/01-requirements.md",
      version: 2,
      hash: shortHash(newContent),
    });
  });
});

describe("REQ-ARTIFACT-003: distinct files produce distinct entries", () => {
  it("registering two different files yields two entries", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const a = writeFile(tp, "docs/01-requirements.md", "reqs\n");
    const b = writeFile(tp, "docs/02-design.md", "design\n");
    runArtifactRegister(tp.paths, a, 1);
    runArtifactRegister(tp.paths, b, 1);

    const r = readState(tp.paths);
    expect(r.state?.approved_artifacts).toHaveLength(2);
    expect(r.state?.approved_artifacts.map((x) => x.file).sort()).toEqual([
      "docs/01-requirements.md",
      "docs/02-design.md",
    ]);
  });
});

describe("REQ-ARTIFACT-004: input failures", () => {
  it("missing file → failure with error file_not_found", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runArtifactRegister(tp.paths, "docs/does-not-exist.md", 1);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.error).toBe("file_not_found");
  });

  it("missing/invalid version → failure (usage)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const rel = writeFile(tp, "docs/01-requirements.md", "x\n");
    expect(runArtifactRegister(tp.paths, rel, undefined).ok).toBe(false);
    expect(runArtifactRegister(tp.paths, rel, 0).ok).toBe(false);
    expect(runArtifactRegister(tp.paths, rel, -1).ok).toBe(false);
    expect(runArtifactRegister(tp.paths, rel, 1.5).ok).toBe(false);
  });

  it("missing file argument → failure (usage)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runArtifactRegister(tp.paths, undefined, 1).ok).toBe(false);
  });
});

describe("REQ-ARTIFACT-005: list reports recorded entries", () => {
  it("list returns the registered artifacts", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const content = "reqs\n";
    const rel = writeFile(tp, "docs/01-requirements.md", content);
    runArtifactRegister(tp.paths, rel, 3);

    const res = runArtifactList(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.artifacts).toEqual([
      { file: "docs/01-requirements.md", version: 3, hash: shortHash(content) },
    ]);
    expect(res.human).toContain("docs/01-requirements.md");
    expect(res.human).toContain("v3");
  });

  it("list on an empty registry → human is (none)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runArtifactList(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.artifacts).toEqual([]);
    expect(res.human).toBe("(none)");
  });
});

describe("REQ-ARTIFACT-006: not_initialized on an empty project", () => {
  it("register before init → failure not_initialized", () => {
    tp = makeTempProject();
    const rel = writeFile(tp, "docs/01-requirements.md", "x\n");
    const res = runArtifactRegister(tp.paths, rel, 1);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });

  it("list before init → failure not_initialized", () => {
    tp = makeTempProject();
    const res = runArtifactList(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});
