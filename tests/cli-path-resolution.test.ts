import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runTierClassify, runTierVetoCheck, VETO_EXIT_CODE } from "../src/commands/tier";
import { runArtifactRegister } from "../src/commands/artifact";
import { runStateGet } from "../src/commands/state";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-TIER-PATHRES-001: tier resolves the brief path against the project root (--cwd)", () => {
  it("classify finds a brief written into the project root via a relative path", () => {
    tp = makeTempProject();
    fs.writeFileSync(
      path.join(tp.paths.root, "brief.json"),
      JSON.stringify({
        single_file_or_local: true,
        changes_public_interface: false,
        adds_dependency: false,
        obvious_testable_answer: true,
        blast_radius_flags: [],
      }),
      "utf8",
    );
    const res = runTierClassify(tp.paths, "brief.json");
    expect(res.ok).toBe(true);
    expect(res.data?.tier0_eligible).toBe(true);
  });

  it("veto-check finds a relative auth brief under the root and blocks (exit 3)", () => {
    tp = makeTempProject();
    fs.writeFileSync(
      path.join(tp.paths.root, "auth.json"),
      JSON.stringify({
        single_file_or_local: true,
        changes_public_interface: false,
        adds_dependency: false,
        obvious_testable_answer: true,
        blast_radius_flags: ["authentication"],
      }),
      "utf8",
    );
    const res = runTierVetoCheck(tp.paths, "auth.json");
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(VETO_EXIT_CODE);
    expect(res.data?.blocked).toBe(true);
  });
});

describe("REQ-STATE-GET-ARRAY-001: state get supports numeric array-index paths", () => {
  it("reads approved_artifacts.0.hash after a registration", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.mkdirSync(tp.paths.docsDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.docsDir, "01-requirements.md"), "# Reqs\nREQ-001\n", "utf8");
    const reg = runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    expect(reg.ok).toBe(true);
    const got = runStateGet(tp.paths, "approved_artifacts.0.hash");
    expect(got.ok).toBe(true);
    expect(got.data?.value).toBe(reg.data?.hash);
  });

  it("returns path_not_found for an out-of-range index", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const got = runStateGet(tp.paths, "approved_artifacts.5.hash");
    expect(got.ok).toBe(false);
    expect(got.data?.error).toBe("path_not_found");
  });
});
