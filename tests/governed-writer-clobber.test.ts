/**
 * SG3 (audit P1) — the governed writers (`th research write`, `th inspector write`) must
 * not SILENTLY overwrite or DOWNGRADE an already-registered approved artifact.
 *
 * These verbs write the file directly and THEN auto-register, so they bypass the
 * PreToolUse R-14 approved-artifact clobber guard. Without the in-handler guard
 * (`guardApprovedArtifactReauthor`), a stage re-run replaced an approved doc and reset
 * its registered version to 1 (the audit reproduced an approved v7 → v1 downgrade).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";
import { runResearchWrite } from "../src/commands/research";
import { runInspectorWrite, INSPECTOR_ANALYSIS_FILE } from "../src/commands/inspector";
import { runArtifactRegister } from "../src/commands/artifact";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function registeredVersion(t: TempProject, file: string): number | undefined {
  return readState(t.paths).state!.approved_artifacts.find((a) => a.file === file)?.version;
}

describe("th research write — clobber + version-monotonicity guard", () => {
  it("first write registers v1; a bare re-author is REFUSED (approved_artifact_exists)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const first = runResearchWrite(tp.paths, { topic: "auth-options", markdown: "# v1\n" });
    expect(first.ok).toBe(true);
    expect(first.data!.version).toBe(1);

    // A second write WITHOUT an explicit version bump must refuse — not silently clobber.
    const reauth = runResearchWrite(tp.paths, { topic: "auth-options", markdown: "# overwrite\n" });
    expect(reauth.ok).toBe(false);
    expect(reauth.data!.error).toBe("approved_artifact_exists");
    // The on-disk file is UNCHANGED (refused before writing).
    expect(fs.readFileSync(path.join(tp.root, "docs/00-research/auth-options.md"), "utf8")).toBe("# v1\n");
  });

  it("re-author at a HIGHER version is allowed and never downgrades", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runResearchWrite(tp.paths, { topic: "auth-options", markdown: "# v1\n" });

    // Simulate an approved doc that reached v7 (e.g. registered by hand after review).
    runArtifactRegister(tp.paths, "docs/00-research/auth-options.md", 7);
    expect(registeredVersion(tp, "docs/00-research/auth-options.md")).toBe(7);

    // A DOWNGRADE (or same version) is refused (version_not_monotonic) — the audit bug.
    const downgrade = runResearchWrite(tp.paths, { topic: "auth-options", markdown: "# nope\n", version: 1 });
    expect(downgrade.ok).toBe(false);
    expect(downgrade.data!.error).toBe("version_not_monotonic");
    expect(registeredVersion(tp, "docs/00-research/auth-options.md")).toBe(7); // still v7

    // A deliberate bump to v8 succeeds.
    const bump = runResearchWrite(tp.paths, { topic: "auth-options", markdown: "# v8\n", version: 8 });
    expect(bump.ok).toBe(true);
    expect(bump.data!.version).toBe(8);
    expect(registeredVersion(tp, "docs/00-research/auth-options.md")).toBe(8);
  });
});

describe("th inspector write — clobber + version-monotonicity guard", () => {
  it("first write registers v1; a bare re-author is REFUSED and the file is untouched", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const first = runInspectorWrite(tp.paths, { content: "# analysis v1\n" });
    expect(first.ok).toBe(true);
    expect(first.data!.version).toBe(1);

    const reauth = runInspectorWrite(tp.paths, { content: "# overwrite\n" });
    expect(reauth.ok).toBe(false);
    expect(reauth.data!.error).toBe("approved_artifact_exists");
    expect(fs.readFileSync(path.join(tp.root, INSPECTOR_ANALYSIS_FILE), "utf8")).toBe("# analysis v1\n");
  });

  it("does NOT downgrade an approved v5 to v1 (refused either way)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runInspectorWrite(tp.paths, { content: "# analysis v1\n" });
    runArtifactRegister(tp.paths, INSPECTOR_ANALYSIS_FILE, 5);

    // Default (no --version ⇒ would be v1) refuses as a bare re-author of an approved doc.
    const bare = runInspectorWrite(tp.paths, { content: "# overwrite\n" });
    expect(bare.ok).toBe(false);
    expect(bare.data!.error).toBe("approved_artifact_exists");
    expect(registeredVersion(tp, INSPECTOR_ANALYSIS_FILE)).toBe(5);

    // An EXPLICIT downgrade (--version 1 ≤ 5) is refused as non-monotonic — the audit bug.
    const downgrade = runInspectorWrite(tp.paths, { content: "# overwrite\n", version: 1 });
    expect(downgrade.ok).toBe(false);
    expect(downgrade.data!.error).toBe("version_not_monotonic");
    expect(registeredVersion(tp, INSPECTOR_ANALYSIS_FILE)).toBe(5);

    const bump = runInspectorWrite(tp.paths, { content: "# analysis v6\n", version: 6 });
    expect(bump.ok).toBe(true);
    expect(registeredVersion(tp, INSPECTOR_ANALYSIS_FILE)).toBe(6);
  });
});
