/**
 * context-normalize-fingerprint.test.ts — T4 (S3/D-14) unit tests.
 *
 * Coverage:
 *   AC-8:  identical failures across runs ⇒ stable fingerprint
 *          strips listed volatiles deterministically
 *          raw content retained (cold-stored, retrievable)
 *   Functional: normalize strips timestamps / UUIDs / ports / IPs /
 *               ANSI / temp-paths / durations / hex addresses.
 *               deduplicateStackFrames collapses repeated frames.
 *               deltaNormalized diffs over normalized forms.
 *               buildFingerprint cold-stores raw and returns stable hash.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  normalize,
  deduplicateStackFrames,
  buildFingerprint,
  hashNormalized,
  deltaNormalized,
} from "../src/core/context-normalize";
import { coldStoreGet } from "../src/core/context-page";
import type { ProjectPaths } from "../src/core/paths";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePaths(tmpDir: string): ProjectPaths {
  return {
    projectRoot: tmpDir,
    stateDir: path.join(tmpDir, ".twinharness"),
    statePath: path.join(tmpDir, ".twinharness", "state.json"),
    distDir: path.join(tmpDir, "dist"),
  } as ProjectPaths;
}

let tmpDir: string;
let paths: ProjectPaths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-norm-test-"));
  paths = makePaths(tmpDir);
});

// ---------------------------------------------------------------------------
// normalize: ANSI escape sequences
// ---------------------------------------------------------------------------

describe("normalize: ANSI escape sequences", () => {
  it("strips CSI colour sequences", () => {
    const raw = "\x1b[32mGREEN\x1b[0m text";
    expect(normalize(raw)).toBe("GREEN text");
  });

  it("strips bold / underline codes", () => {
    expect(normalize("\x1b[1mBOLD\x1b[22m")).toBe("BOLD");
  });

  it("is idempotent on already-clean text", () => {
    const clean = "plain text with no escapes";
    expect(normalize(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// normalize: timestamps
// ---------------------------------------------------------------------------

describe("normalize: timestamps", () => {
  it("replaces ISO 8601 datetime with <timestamp>", () => {
    const s = normalize("started at 2024-01-15T09:32:11.456Z done");
    expect(s).toContain("<timestamp>");
    expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("replaces ISO datetime with +HH:MM timezone", () => {
    const s = normalize("event 2023-06-01T00:00:00+05:30 end");
    expect(s).toContain("<timestamp>");
  });

  it("replaces space-separated datetime", () => {
    const s = normalize("logged 2024-03-10 14:22:33 complete");
    expect(s).toContain("<timestamp>");
  });

  it("replaces 13-digit epoch ms", () => {
    const s = normalize("ts=1700000000000 ok");
    expect(s).toContain("<epoch-ms>");
    expect(s).not.toContain("1700000000000");
  });

  it("replaces 10-digit epoch s", () => {
    const s = normalize("created=1700000000 done");
    expect(s).toContain("<epoch-s>");
    expect(s).not.toContain("1700000000 ");
  });

  it("F6: leaves a non-epoch 10-digit integer (account id) untouched", () => {
    // Leading digit 9 is outside the plausible Unix-second range (~2001-2033),
    // so an account/order id like 9876543210 must NOT collapse to <epoch-s>.
    const s = normalize("account=9876543210 done");
    expect(s).toContain("9876543210");
    expect(s).not.toContain("<epoch-s>");
  });

  it("F6: two distinct 10-digit account ids hash differently", () => {
    const a = normalize("account=9876543210");
    const b = normalize("account=9000000001");
    expect(a).not.toBe(b);
  });

  it("F6: still normalizes a genuine 2-prefixed epoch second", () => {
    const s = normalize("created=2000000000 done");
    expect(s).toContain("<epoch-s>");
    expect(s).not.toContain("2000000000");
  });

  it("two different timestamps normalize to same placeholder", () => {
    const a = normalize("at 2024-01-01T00:00:00Z");
    const b = normalize("at 2025-12-31T23:59:59Z");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// normalize: durations
// ---------------------------------------------------------------------------

describe("normalize: duration literals", () => {
  it("replaces millisecond literals", () => {
    expect(normalize("elapsed: 123ms")).toContain("<duration>");
  });

  it("replaces fractional seconds", () => {
    expect(normalize("took 4.5s")).toContain("<duration>");
  });

  it("replaces nanoseconds", () => {
    expect(normalize("latency 500ns")).toContain("<duration>");
  });

  it("replaces combined 2m3s form", () => {
    expect(normalize("runtime 2m3s")).toContain("<duration>");
  });

  it("replaces combined 1h2m3s form", () => {
    expect(normalize("duration 1h2m3s")).toContain("<duration>");
  });

  it("F6: preserves plural-integer prose like '100s of items'", () => {
    const s = normalize("processed 100s of items");
    expect(s).toBe("processed 100s of items");
    expect(s).not.toContain("<duration>");
  });

  it("F6: two distinct plural-integer phrases hash differently", () => {
    const a = normalize("100s of items");
    const b = normalize("200s of items");
    expect(a).not.toBe(b);
  });

  it("F6: still normalizes genuine fractional-second durations", () => {
    expect(normalize("took 1.5s")).toContain("<duration>");
    expect(normalize("took 1.5s")).not.toContain("1.5s");
  });
});

// ---------------------------------------------------------------------------
// normalize: temp paths
// ---------------------------------------------------------------------------

describe("normalize: temp-path tokens", () => {
  it("replaces POSIX /tmp/… paths", () => {
    const s = normalize("wrote to /tmp/abc123/output.json done");
    expect(s).toContain("<tmp-path>");
    expect(s).not.toContain("/tmp/abc123");
  });

  it("replaces /var/folders/… paths (macOS)", () => {
    const s = normalize("cache at /var/folders/xy/abc123/T/file.bin");
    expect(s).toContain("<tmp-path>");
  });

  it("replaces Windows C:\\Temp\\… paths", () => {
    const s = normalize("temp file at C:\\Temp\\run-xyz\\output.log");
    expect(s).toContain("<tmp-path>");
  });

  it("two different temp paths normalize to same placeholder", () => {
    const a = normalize("file /tmp/run-a/x.json ok");
    const b = normalize("file /tmp/run-b/x.json ok");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// normalize: UUIDs
// ---------------------------------------------------------------------------

describe("normalize: UUIDs", () => {
  it("replaces lowercase UUID", () => {
    const s = normalize("id=550e8400-e29b-41d4-a716-446655440000 ok");
    expect(s).toContain("<uuid>");
    expect(s).not.toMatch(/[0-9a-f]{8}-/);
  });

  it("replaces uppercase UUID", () => {
    const s = normalize("req=550E8400-E29B-41D4-A716-446655440000 ok");
    expect(s).toContain("<uuid>");
  });

  it("two different UUIDs normalize identically", () => {
    const a = normalize("a=550e8400-e29b-41d4-a716-000000000001");
    const b = normalize("a=550e8400-e29b-41d4-a716-000000000002");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// normalize: IP addresses
// ---------------------------------------------------------------------------

describe("normalize: IP addresses", () => {
  it("replaces IPv4 address", () => {
    const s = normalize("server 192.168.1.100 up");
    expect(s).toContain("<ip>");
    expect(s).not.toContain("192.168.1.100");
  });

  it("two different IPs normalize identically", () => {
    const a = normalize("host 10.0.0.1 ok");
    const b = normalize("host 10.0.0.2 ok");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// normalize: ports
// ---------------------------------------------------------------------------

describe("normalize: port patterns", () => {
  it("replaces :PORT in host:port form", () => {
    const s = normalize("listening on localhost:3000");
    expect(s).toContain(":<port>");
    expect(s).not.toContain(":3000");
  });

  it("replaces bare :PORT token", () => {
    const s = normalize("bound :8080 ready");
    expect(s).toContain(":<port>");
  });

  it("two different ports normalize identically", () => {
    const a = normalize("server :3000 ready");
    const b = normalize("server :4000 ready");
    expect(a).toBe(b);
  });

  it("F6: does NOT treat a stack-trace location 'file.ts:1234' as a port", () => {
    const s = normalize("    at run (server.ts:1234)");
    expect(s).toContain("server.ts:1234");
    expect(s).not.toContain(":<port>");
  });

  it("F6: two distinct stack-trace locations hash differently", () => {
    const a = normalize("    at run (server.ts:1234)");
    const b = normalize("    at run (server.ts:5678)");
    expect(a).not.toBe(b);
    expect(hashNormalized(a)).not.toBe(hashNormalized(b));
  });

  it("F6: does NOT collapse the ':line:col' suffix of a source location", () => {
    // `:4567` here is followed by `:5` (a column), i.e. a `:line:col` form.
    const s = normalize("    at main (index.ts:4567:5)");
    expect(s).toContain(":4567:5");
    expect(s).not.toContain(":<port>");
  });

  it("F6: still normalizes a genuine host:port reference", () => {
    const s = normalize("connecting to localhost:5432");
    expect(s).toContain(":<port>");
    expect(s).not.toContain(":5432");
  });

  it("F6: still normalizes an <ip>:port reference", () => {
    // IPv4 is replaced with <ip> first, then the port suffix normalizes.
    const s = normalize("listening 192.168.0.10:8080");
    expect(s).toContain("<ip>:<port>");
  });
});

// ---------------------------------------------------------------------------
// normalize: hex addresses
// ---------------------------------------------------------------------------

describe("normalize: hex memory addresses", () => {
  it("replaces 0x… address", () => {
    const s = normalize("at Object.<anonymous> (0x7fff1234abcd)");
    expect(s).toContain("<addr>");
    expect(s).not.toContain("0x7fff1234abcd");
  });

  it("two different addresses normalize identically", () => {
    const a = normalize("ptr 0xdeadbeef");
    const b = normalize("ptr 0xcafebabe");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// normalize: determinism
// ---------------------------------------------------------------------------

describe("normalize: determinism", () => {
  it("same input always produces same output", () => {
    const raw = "test run at 2024-01-01T00:00:00Z, id=550e8400-e29b-41d4-a716-446655440000, :8080";
    expect(normalize(raw)).toBe(normalize(raw));
  });

  it("is idempotent (normalize(normalize(x)) == normalize(x))", () => {
    const raw = "started 2024-01-01T00:00:00Z uuid=550e8400-e29b-41d4-a716-000000000001";
    expect(normalize(normalize(raw))).toBe(normalize(raw));
  });
});

// ---------------------------------------------------------------------------
// deduplicateStackFrames
// ---------------------------------------------------------------------------

describe("deduplicateStackFrames", () => {
  it("collapses consecutive identical Node.js frames", () => {
    const trace = [
      "Error: something",
      "    at Object.run (runner.ts:10:5)",
      "    at Object.run (runner.ts:10:5)",
      "    at Object.run (runner.ts:10:5)",
      "    at main (index.ts:1:1)",
    ].join("\n");
    const result = deduplicateStackFrames(trace);
    expect(result).toContain("<2 repeated>");
    // The original frame appears once, not three times
    const frameCount = (result.match(/at Object\.run/g) ?? []).length;
    expect(frameCount).toBe(1);
  });

  it("does not collapse different consecutive frames", () => {
    const trace = [
      "Error",
      "    at alpha (a.ts:1:1)",
      "    at beta (b.ts:2:2)",
    ].join("\n");
    const result = deduplicateStackFrames(trace);
    expect(result).toContain("at alpha");
    expect(result).toContain("at beta");
    expect(result).not.toContain("<");
  });

  it("is a no-op on content with no stack frames", () => {
    const plain = "some test output\nno frames here\ndone";
    expect(deduplicateStackFrames(plain)).toBe(plain);
  });

  it("collapses Python-style repeated frames", () => {
    const trace = [
      "Traceback:",
      '  File "runner.py", line 42, in run',
      '  File "runner.py", line 42, in run',
      "ValueError: bad input",
    ].join("\n");
    const result = deduplicateStackFrames(trace);
    expect(result).toContain("<1 repeated>");
  });
});

// ---------------------------------------------------------------------------
// AC-8: stable fingerprint (identical failures across runs)
// ---------------------------------------------------------------------------

describe("AC-8: stable fingerprint across runs", () => {
  it("hashNormalized is stable for identical logical content", () => {
    const run1 = "FAIL: test at 2024-01-01T00:00:00Z in /tmp/run-1/file.ts uuid=550e8400-e29b-41d4-a716-000000000001";
    const run2 = "FAIL: test at 2024-12-31T23:59:59Z in /tmp/run-2/file.ts uuid=aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    expect(hashNormalized(run1)).toBe(hashNormalized(run2));
  });

  it("hashNormalized differs for genuinely different failure messages", () => {
    const errA = "Error: cannot find module 'foo'";
    const errB = "Error: cannot find module 'bar'";
    expect(hashNormalized(errA)).not.toBe(hashNormalized(errB));
  });

  it("buildFingerprint: normalized is stable across runs", () => {
    const run1 = "Test failed at 2024-01-01T12:00:00Z (duration: 500ms) id=550e8400-e29b-41d4-a716-000000000001";
    const run2 = "Test failed at 2024-06-15T08:30:00Z (duration: 123ms) id=aaaabbbb-0000-1111-2222-333333333333";
    const fp1 = buildFingerprint(run1, paths, false);
    const fp2 = buildFingerprint(run2, paths, false);
    expect(fp1.normalized).toBe(fp2.normalized);
  });
});

// ---------------------------------------------------------------------------
// AC-8: raw retained (cold-stored)
// ---------------------------------------------------------------------------

describe("AC-8: raw content retained in cold store", () => {
  it("buildFingerprint cold-stores raw content and returns non-null raw_objref", () => {
    const raw = "raw test output with timestamp 2024-01-01T00:00:00Z";
    const fp = buildFingerprint(raw, paths, false);
    expect(fp.raw_objref).not.toBeNull();
  });

  it("raw content can be retrieved from cold store via raw_objref", () => {
    const raw = "original failure: Error: connection refused at 127.0.0.1:5432";
    const fp = buildFingerprint(raw, paths, false);
    const retrieved = coldStoreGet(paths, fp.raw_objref!);
    expect(retrieved).toBe(raw);
  });

  it("raw_objref differs when raw content differs", () => {
    const fp1 = buildFingerprint("content alpha", paths, false);
    const fp2 = buildFingerprint("content beta", paths, false);
    expect(fp1.raw_objref).not.toBe(fp2.raw_objref);
  });

  it("sensitive content: raw_objref returned but no bytes written", () => {
    const raw = "secret content: API_KEY=supersecret12345";
    const fp = buildFingerprint(raw, paths, /* sensitive */ true);
    // raw_objref is the hash (returned by coldStorePut for sensitive)
    expect(fp.raw_objref).not.toBeNull();
    // But the object should NOT be in the cold store (sensitive flag)
    const retrieved = coldStoreGet(paths, fp.raw_objref!);
    expect(retrieved).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deltaNormalized
// ---------------------------------------------------------------------------

describe("deltaNormalized", () => {
  it("volatile-only differences between two versions do not produce delta hunks", () => {
    // Same logical content but different timestamps / UUIDs
    const base =
      "Test passed\nDuration: 250ms\nRun id: 550e8400-e29b-41d4-a716-000000000001\nAt: 2024-01-01T00:00:00Z\n" +
      "Line 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10";
    const current =
      "Test passed\nDuration: 310ms\nRun id: aaaabbbb-1111-2222-3333-444444444444\nAt: 2024-06-15T12:30:00Z\n" +
      "Line 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10";
    const result = deltaNormalized(base, current);
    // After normalization, the two contents should be identical → 0 hunks
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(patch.hunks).toHaveLength(0);
  });

  it("real content differences are captured in the delta", () => {
    const base =
      "Test passed at 2024-01-01T00:00:00Z\n" +
      "Line 2\nLine 3\nLine 4\nLine 5\n" +
      "Result: OK";
    const current =
      "Test passed at 2024-06-01T00:00:00Z\n" +
      "Line 2\nLine 3\nLine 4\nLine 5\n" +
      "Result: FAIL";  // changed
    const result = deltaNormalized(base, current);
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(patch.hunks.length).toBeGreaterThan(0);
  });

  it("passes opts through to computeDelta (sensitive ⇒ FULL)", () => {
    const result = deltaNormalized("base content", "current content", { sensitive: true });
    expect(result).toMatchObject({ fallback: "FULL", reason: "sensitive" });
  });
});
