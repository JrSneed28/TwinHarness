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

describe("R-18 — parseLcovContained TOLERATES malformed / truncated / garbage input (never throws)", () => {
  // lcov is UNTRUSTED repo content (RULE-004). The parser is correct but was
  // previously untested against malformed input (lane08 F-04). It must degrade
  // gracefully on garbage — skip what it cannot use, never throw — so a corrupt or
  // partial coverage report cannot crash a scan.
  it("returns [] for empty / whitespace-only / non-lcov text", () => {
    expect(parseLcovContained("", ROOT, "", undefined)).toEqual([]);
    expect(parseLcovContained("   \n\t\n  ", ROOT, "", undefined)).toEqual([]);
    expect(parseLcovContained("this is not lcov at all\nrandom words\n", ROOT, "", undefined)).toEqual([]);
  });

  it("skips an SF: line with an EMPTY path and records none", () => {
    const lcov = ["SF:", "DA:1,1", "end_of_record", "SF:   ", "end_of_record"].join("\n");
    expect(() => parseLcovContained(lcov, ROOT, "", undefined)).not.toThrow();
    expect(parseLcovContained(lcov, ROOT, "", undefined)).toEqual([]);
  });

  it("tolerates a TRUNCATED record (SF: with no end_of_record) and still extracts the valid path", () => {
    const lcov = ["SF:src/a.ts", "DA:1,1", "DA:2,"].join("\n"); // truncated mid-record, partial DA line
    let out: string[] = [];
    expect(() => {
      out = parseLcovContained(lcov, ROOT, "", undefined);
    }).not.toThrow();
    expect(out).toContain("src/a.ts");
  });

  it("tolerates garbage interleaved with valid SF: records (skips garbage, keeps valid)", () => {
    const lcov = [
      "garbage line 1",
      "SF:src/a.ts",
      "!!! not a directive @@@",
      "end_of_record",
      "SF", // missing colon — not an SF: directive
      "SFsrc/b.ts", // missing colon — not matched
      "SF:src/c.ts",
      "end_of_record",
    ].join("\n");
    let out: string[] = [];
    expect(() => {
      out = parseLcovContained(lcov, ROOT, "", undefined);
    }).not.toThrow();
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/c.ts");
    expect(out).not.toContain("src/b.ts"); // the malformed `SFsrc/b.ts` was not parsed
  });

  it("handles CRLF line endings and trailing whitespace on SF: lines", () => {
    const lcov = "SF:src/a.ts  \r\nDA:1,1\r\nend_of_record\r\n";
    expect(parseLcovContained(lcov, ROOT, "", undefined)).toContain("src/a.ts");
  });
});
