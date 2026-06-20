/**
 * R-22: `isAbsoluteOrEscaping` is a pure, cross-platform predicate for an absolute
 * or parent-escaping path KEY (the `<file>` part of an artifact-lease section id and
 * the `th_artifact_register` MCP pre-check).
 *
 * These assertions are host-INDEPENDENT: the drive / UNC / `..` branches are regex +
 * string ops, not host-native `path.isAbsolute`. So the Windows-absolute and UNC cases
 * below are the regression guard that fails on the exact platform the OLD host-native
 * `path.isAbsolute(file) || ...includes("..")` check missed — a POSIX host (CI), where
 * `path.isAbsolute("C:\\Windows\\x")` is `false`.
 */
import { describe, it, expect } from "vitest";
import { isAbsoluteOrEscaping } from "../src/core/paths";

describe("R-22: isAbsoluteOrEscaping — cross-platform absolute/escape detection", () => {
  it.each<[string, boolean]>([
    ["/etc/passwd", true], // POSIX absolute
    ["C:\\Windows\\System32", true], // Windows drive-absolute — host-native isAbsolute misses this on POSIX
    ["c:/Windows/x", true], // drive-absolute, lowercase + forward slash
    ["\\\\server\\share", true], // UNC
    ["../secret", true], // parent escape
    ["a/../../b", true], // mid-path parent escape
    ["..\\..\\x", true], // backslash-separated parent escape
    ["docs/04-architecture.md", false], // normal in-root relative key
    ["docs\\notes.md", false], // a lone backslash is an odd-but-contained key, not an ESCAPE
    ["intro", false],
    ["", false],
  ])("isAbsoluteOrEscaping(%j) === %s", (input, expected) => {
    expect(isAbsoluteOrEscaping(input)).toBe(expected);
  });
});
