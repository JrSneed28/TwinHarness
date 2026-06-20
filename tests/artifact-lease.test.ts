/**
 * Section-level artifact leases (Phase 4 Slice 6, REQ-PCO-041).
 *
 * Two agents may co-edit DIFFERENT sections of the same artifact concurrently,
 * but never the SAME section at once — the same collision-guard + state-lock
 * mechanism as the component leases in build-coordination, keyed by a
 * `<file>#<section>` section id and a holder. Mirrors build-coordination.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import {
  runArtifactClaim,
  runArtifactRelease,
  runArtifactLeases,
} from "../src/commands/artifact-lease";
import { activeSectionLeases, isSectionLeased } from "../src/core/leases";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-PCO-041: section-level artifact leases — different sections co-held, same section serialized", () => {
  it("two DIFFERENT sections of the same file can be co-held by different holders", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const a = runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" });
    const b = runArtifactClaim(tp.paths, { section: "docs/spec.md#api", holder: "agent-B" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const leases = activeSectionLeases(tp.paths);
    expect(leases).toEqual([
      { section: "docs/spec.md#intro", holder: "agent-A" },
      { section: "docs/spec.md#api", holder: "agent-B" },
    ]);
  });

  it("the SAME section cannot be double-claimed by a different holder (collision guard)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    expect(runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" }).ok).toBe(true);
    const conflict = runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-B" });
    expect(conflict.ok).toBe(false);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.data?.error).toBe("section_lease_conflict");
    expect(conflict.data?.holder).toBe("agent-A"); // reports the current owner

    // The original holder still owns it; no second lease was opened.
    expect(isSectionLeased(tp.paths, "docs/spec.md#intro")).toBe(true);
    expect(activeSectionLeases(tp.paths)).toEqual([{ section: "docs/spec.md#intro", holder: "agent-A" }]);
  });

  it("re-claim by the SAME holder is allowed (not a collision with itself)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    expect(runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" }).ok).toBe(true);
    expect(runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" }).ok).toBe(true);
    expect(activeSectionLeases(tp.paths)).toEqual([{ section: "docs/spec.md#intro", holder: "agent-A" }]);
  });

  it("release frees the section so another holder can claim it", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    expect(runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" }).ok).toBe(true);
    expect(runArtifactRelease(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" }).ok).toBe(true);
    expect(isSectionLeased(tp.paths, "docs/spec.md#intro")).toBe(false);
    expect(activeSectionLeases(tp.paths)).toEqual([]);

    // Now a different holder may claim the freed section.
    expect(runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-B" }).ok).toBe(true);
    expect(activeSectionLeases(tp.paths)).toEqual([{ section: "docs/spec.md#intro", holder: "agent-B" }]);
  });

  it("th artifact leases lists active section holders; empty when none", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    expect((runArtifactLeases(tp.paths).data?.leases as unknown[]).length).toBe(0);

    runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" });
    runArtifactClaim(tp.paths, { section: "src/app.ts#header", holder: "agent-B" });
    const res = runArtifactLeases(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.leases).toEqual([
      { section: "docs/spec.md#intro", holder: "agent-A" },
      { section: "src/app.ts#header", holder: "agent-B" },
    ]);
  });
});

describe("REQ-PCO-041: section id validation", () => {
  it("claim rejects a malformed section id (missing <file>#<section> shape)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const noHash = runArtifactClaim(tp.paths, { section: "docs/spec.md", holder: "agent-A" });
    expect(noHash.ok).toBe(false);
    expect(noHash.data?.error).toBe("invalid_section_id");

    const emptySection = runArtifactClaim(tp.paths, { section: "docs/spec.md#", holder: "agent-A" });
    expect(emptySection.ok).toBe(false);
    expect(emptySection.data?.error).toBe("invalid_section_id");

    const emptyFile = runArtifactClaim(tp.paths, { section: "#intro", holder: "agent-A" });
    expect(emptyFile.ok).toBe(false);
    expect(emptyFile.data?.error).toBe("invalid_section_id");
  });

  it("claim and release require both section and holder", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    expect(runArtifactClaim(tp.paths, { section: "docs/spec.md#intro" }).ok).toBe(false);
    expect(runArtifactClaim(tp.paths, { holder: "agent-A" }).ok).toBe(false);
    expect(runArtifactRelease(tp.paths, { section: "docs/spec.md#intro" }).ok).toBe(false);
  });
});

describe("R-11: the shared lease validator rejects an absolute / parent-escaping file part (parity with th_artifact_register)", () => {
  it("claim REJECTS an absolute file part with a path_escape error", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const abs = runArtifactClaim(tp.paths, { section: "/etc/passwd#x", holder: "agent-A" });
    expect(abs.ok).toBe(false);
    expect(abs.data?.error).toBe("path_escape");
    // No lease was opened for the rejected key.
    expect(isSectionLeased(tp.paths, "/etc/passwd#x")).toBe(false);
    expect(activeSectionLeases(tp.paths)).toEqual([]);
  });

  it("claim REJECTS a `..` segment in the file part (POSIX or Windows separator)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const posix = runArtifactClaim(tp.paths, { section: "../../secret#s", holder: "agent-A" });
    expect(posix.ok).toBe(false);
    expect(posix.data?.error).toBe("path_escape");

    const windows = runArtifactClaim(tp.paths, { section: "..\\..\\x#s", holder: "agent-A" });
    expect(windows.ok).toBe(false);
    expect(windows.data?.error).toBe("path_escape");

    expect(activeSectionLeases(tp.paths)).toEqual([]);
  });

  it("release ALSO rejects an absolute / `..` file part (the validator is shared)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    expect(runArtifactRelease(tp.paths, { section: "/etc/passwd#x", holder: "agent-A" }).data?.error).toBe("path_escape");
    expect(runArtifactRelease(tp.paths, { section: "..\\x#s", holder: "agent-A" }).data?.error).toBe("path_escape");
  });

  it("a legitimate in-repo section id (docs/x.md#s) still claims successfully", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const ok = runArtifactClaim(tp.paths, { section: "docs/x.md#s", holder: "agent-A" });
    expect(ok.ok).toBe(true);
    expect(activeSectionLeases(tp.paths)).toEqual([{ section: "docs/x.md#s", holder: "agent-A" }]);
  });
});

describe("R-22: the lease validator rejects CROSS-PLATFORM absolute file parts (host-native path.isAbsolute missed these on POSIX)", () => {
  it("claim REJECTS a Windows drive-absolute file part on ANY host (the R-11 gap)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    // On a POSIX host the OLD `path.isAbsolute("C:\\Windows\\x")` was false and the
    // `..`-split missed it too → it slipped through. The shared cross-platform
    // predicate now rejects it identically on POSIX and Windows.
    const drive = runArtifactClaim(tp.paths, { section: "C:\\Windows\\x#sec", holder: "agent-A" });
    expect(drive.ok).toBe(false);
    expect(drive.data?.error).toBe("path_escape");

    const driveFwd = runArtifactClaim(tp.paths, { section: "c:/Windows/x#sec", holder: "agent-A" });
    expect(driveFwd.ok).toBe(false);
    expect(driveFwd.data?.error).toBe("path_escape");

    expect(activeSectionLeases(tp.paths)).toEqual([]);
  });

  it("claim REJECTS a UNC file part on ANY host", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const unc = runArtifactClaim(tp.paths, { section: "\\\\server\\share#sec", holder: "agent-A" });
    expect(unc.ok).toBe(false);
    expect(unc.data?.error).toBe("path_escape");
    expect(activeSectionLeases(tp.paths)).toEqual([]);
  });
});

describe("REQ-PCO-041: commands return NOT_INIT on an uninitialized project", () => {
  it("claim returns not_initialized when state.json is absent", () => {
    tp = makeTempProject();
    const res = runArtifactClaim(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });

  it("release returns not_initialized when state.json is absent", () => {
    tp = makeTempProject();
    const res = runArtifactRelease(tp.paths, { section: "docs/spec.md#intro", holder: "agent-A" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });

  it("leases returns not_initialized when state.json is absent", () => {
    tp = makeTempProject();
    const res = runArtifactLeases(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});
