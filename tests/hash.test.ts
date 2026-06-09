import { describe, it, expect } from "vitest";
import { hashContent, shortHash } from "../src/core/hash";

describe("REQ-HASH-001: content hashing is deterministic and clock-free", () => {
  it("returns the same digest for the same content across calls", () => {
    expect(hashContent("hello world")).toBe(hashContent("hello world"));
  });

  it("normalizes CRLF and LF to the same digest (cross-platform stability)", () => {
    expect(hashContent("line1\r\nline2")).toBe(hashContent("line1\nline2"));
  });

  it("produces different digests for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  it("shortHash is the 12-char prefix of the full hash", () => {
    const content = "REQ-001 anchor";
    expect(shortHash(content)).toBe(hashContent(content).slice(0, 12));
    expect(shortHash(content)).toHaveLength(12);
  });
});
