/**
 * atomic-io: retrying atomic writer + retrying reader (C-2 / M-3).
 *
 * The retry path is exercised by INJECTING a fake `rename`/`read` that throws a
 * transient error N times then succeeds (node:fs properties are non-configurable,
 * so the seam is an injected op rather than a module mock), and by exhausting the
 * budget to assert the typed contention error (and that no temp file is left
 * behind). A non-transient error must NOT be retried.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, readFileWithRetry, StateWriteContendedError } from "../src/core/atomic-io";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("atomicWriteFile", () => {
  it("writes content atomically, creating parent dirs (happy path)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-aio-"));
    const f = path.join(tmp, "deep", "nested", "a.json");
    atomicWriteFile(f, "hello");
    expect(fs.readFileSync(f, "utf8")).toBe("hello");
  });

  it("retries the rename on transient EPERM, then succeeds", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-aio-"));
    const f = path.join(tmp, "a.json");
    let calls = 0;
    const flakyRename = (from: string, to: string) => {
      calls++;
      if (calls <= 3) throw errno("EPERM");
      fs.renameSync(from, to);
    };

    atomicWriteFile(f, "data", flakyRename);
    expect(calls).toBeGreaterThan(3);
    expect(fs.readFileSync(f, "utf8")).toBe("data");
  });

  it("throws StateWriteContendedError after the budget is exhausted and leaves no temp file", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-aio-"));
    const f = path.join(tmp, "a.json");
    const alwaysEPERM = () => {
      throw errno("EPERM");
    };

    expect(() => atomicWriteFile(f, "data", alwaysEPERM)).toThrow(StateWriteContendedError);
    const leftovers = fs.readdirSync(tmp).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("rethrows a non-transient error immediately without retrying", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-aio-"));
    const f = path.join(tmp, "a.json");
    let calls = 0;
    const enospc = () => {
      calls++;
      throw errno("ENOSPC");
    };

    expect(() => atomicWriteFile(f, "data", enospc)).toThrow(/ENOSPC/);
    expect(calls).toBe(1); // a genuine error is not retried
    const leftovers = fs.readdirSync(tmp).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("readFileWithRetry", () => {
  it("returns content on the happy path", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-aio-"));
    const f = path.join(tmp, "a.json");
    fs.writeFileSync(f, "payload", "utf8");
    expect(readFileWithRetry(f)).toBe("payload");
  });

  it("retries once on a transient read error, then succeeds", () => {
    let calls = 0;
    const flakyRead = (_p: string) => {
      calls++;
      if (calls === 1) throw errno("EBUSY");
      return "payload";
    };

    expect(readFileWithRetry("ignored", flakyRead)).toBe("payload");
    expect(calls).toBe(2);
  });

  it("does not retry a genuine ENOENT", () => {
    let calls = 0;
    const enoent = (_p: string) => {
      calls++;
      throw errno("ENOENT");
    };
    expect(() => readFileWithRetry("missing", enoent)).toThrow();
    expect(calls).toBe(1);
  });
});
