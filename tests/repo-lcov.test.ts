/**
 * P2-6b — lcov ingestion treated as UNTRUSTED, path-CONTAINED content.
 *
 * The lcov file is repo content (RULE-004): never executed, every SF: path resolved
 * through the same repo-containment check the scanner uses. A path escaping the repo
 * root (`..`, absolute, drive) is REJECTED — lcov can never grant a coverage edge to
 * an out-of-repo path.
 *
 * Anchors: REQ-NFR-003 (read-only, no escape), REQ-RU-092 (containment).
 */

import { describe, it, expect } from "vitest";
import { parseLcovContained, containLcovPath } from "../src/core/repo-map/lcov";

const ROOT = "/home/user/project";

describe("P2-6b — lcov path containment", () => {
  it("contains a relative SF path to a repo-relative POSIX path", () => {
    expect(containLcovPath(ROOT, "", "src/a.ts")).toBe("src/a.ts");
    expect(containLcovPath(ROOT, "coverage", "../src/a.ts")).toBe("src/a.ts");
  });

  it("REJECTS a path that escapes the repo root (../ traversal)", () => {
    expect(containLcovPath(ROOT, "", "../../etc/passwd")).toBeNull();
    expect(containLcovPath(ROOT, "coverage", "../../../../etc/passwd")).toBeNull();
  });

  it("REJECTS an absolute path outside the repo root", () => {
    expect(containLcovPath(ROOT, "", "/etc/passwd")).toBeNull();
    expect(containLcovPath(ROOT, "", "/home/user/other/x.ts")).toBeNull();
  });

  it("ACCEPTS an absolute path that falls under the repo root", () => {
    expect(containLcovPath(ROOT, "", "/home/user/project/src/a.ts")).toBe("src/a.ts");
  });
});

describe("P2-6b — parseLcovContained drops escaping paths and honors knownFiles", () => {
  const lcov = [
    "TN:",
    "SF:src/a.ts",
    "DA:1,1",
    "end_of_record",
    "SF:../../../etc/passwd", // escaping — must be dropped
    "end_of_record",
    "SF:src/deleted.ts", // not in knownFiles — must be dropped when knownFiles given
    "end_of_record",
  ].join("\n");

  it("returns only contained, in-repo source paths", () => {
    const paths = parseLcovContained(lcov, ROOT, "", undefined);
    expect(paths).toContain("src/a.ts");
    expect(paths.some((p) => p.includes("etc/passwd") || p.includes(".."))).toBe(false);
  });

  it("further restricts to known scanned files when provided", () => {
    const known = new Set(["src/a.ts"]);
    const paths = parseLcovContained(lcov, ROOT, "", known);
    expect(paths).toEqual(["src/a.ts"]);
    expect(paths).not.toContain("src/deleted.ts");
  });
});
