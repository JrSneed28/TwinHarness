/**
 * AC#2 — atomic-io crash-durability (STEP 1).
 *
 * Three deliverables, all DETERMINISTIC on the Windows-first host (no untestable
 * SIGKILL-in-rename-window power-loss proof; see the ralplan AC#2 branch-(a) rationale):
 *
 *  (a) fsync ORDERING via the injectable {@link FsyncShim}: the temp fd is fsync'd
 *      BEFORE the rename and the containing directory AFTER it; a temp-fd (content)
 *      fsync error PROPAGATES; the dir fsync propagates everything EXCEPT the
 *      genuinely-not-applicable win32 dir-handle codes, which are swallowed only on
 *      win32. node:fs is NOT mocked — the seam is an injected shim.
 *  (b) deterministic rename-window proof: an injected rename that throws AFTER the
 *      temp is written+fsynced leaves state.json absent-or-full-old (never zero/torn)
 *      and no temp file behind.
 *  (c) torn-but-present characterization (no hook.ts change): a truncated/invalid
 *      state.json makes the default write-gate ALLOW-with-warning, while a
 *      `write_gate:"strict"` opt-in (readable from the raw bytes) DENIES — locking the
 *      invariant that strict is the fail-CLOSED opt-in and the default never silently
 *      fails open on a torn-but-present state.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  atomicWriteFile,
  StateWriteContendedError,
  type FsyncShim,
} from "../src/core/atomic-io";
import { WriteSurfaceError } from "../src/core/paths";
import { runHookPretoolGate } from "../src/commands/hook";
import { makeTempProject, type TempProject } from "./helpers";

let tp: TempProject | undefined;
afterEach(() => {
  if (tp) tp.cleanup();
  tp = undefined;
});

/** A governed target under a temp project's state dir (so the AC#1 guard passes). */
function governedTarget(p: TempProject, name = "state.json"): string {
  return path.join(p.paths.stateDir, name);
}

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/**
 * A recording fsync shim that drives the real open/close (so the file/dir actually
 * exist) but records the order of fsync targets and can be told to throw on the Nth
 * fsync. `fsyncFd` is keyed by the path we opened, recorded in `calls`.
 */
function recordingShim(opts: {
  throwOnFile?: NodeJS.ErrnoException;
  throwOnDir?: NodeJS.ErrnoException;
} = {}): { shim: FsyncShim; calls: string[] } {
  const calls: string[] = [];
  const fdToKind = new Map<number, "file" | "dir">();
  const shim: FsyncShim = {
    openSync: (p, flags) => {
      const fd = fs.openSync(p, flags);
      // 'r+' is the temp-file (content) open; 'r' is the directory open.
      fdToKind.set(fd, flags === "r+" ? "file" : "dir");
      return fd;
    },
    fsyncFd: (fd) => {
      const kind = fdToKind.get(fd) ?? "file";
      calls.push(kind);
      if (kind === "file" && opts.throwOnFile) throw opts.throwOnFile;
      if (kind === "dir" && opts.throwOnDir) throw opts.throwOnDir;
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => fs.closeSync(fd),
  };
  return { shim, calls };
}

describe("atomicWriteFile — fsync durability ordering (AC#2 a)", () => {
  it("fsyncs the temp fd BEFORE the rename and the directory AFTER (ordering proof)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    const f = governedTarget(tp);
    const order: string[] = [];
    const { shim, calls } = recordingShim();
    const trackingRename = (from: string, to: string) => {
      order.push("rename");
      fs.renameSync(from, to);
    };
    // Wrap the shim's fsyncFd to also append to `order` interleaved with rename.
    const orderedShim: FsyncShim = {
      openSync: shim.openSync,
      fsyncFd: (fd) => {
        order.push("fsync");
        shim.fsyncFd(fd);
      },
      closeSync: shim.closeSync,
    };
    atomicWriteFile(f, "payload", { root: tp.root, rename: trackingRename, fsync: orderedShim });

    // Content fsync must precede the rename; a dir fsync must follow it.
    expect(order[0]).toBe("fsync"); // temp fd content fsync first
    expect(order[1]).toBe("rename"); // then the durable swap
    expect(order[2]).toBe("fsync"); // then the directory fsync
    expect(calls).toEqual(["file", "dir"]);
    expect(fs.readFileSync(f, "utf8")).toBe("payload");
  });

  it("PROPAGATES a temp-fd (content) fsync error and leaves no temp file", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    const f = governedTarget(tp);
    const { shim } = recordingShim({ throwOnFile: errno("ENOSPC") });
    expect(() => atomicWriteFile(f, "data", { root: tp.root, fsync: shim })).toThrow(/ENOSPC/);
    // The target was never created (we failed before rename) and no temp leaks.
    expect(fs.existsSync(f)).toBe(false);
    const leftovers = fs.readdirSync(tp.paths.stateDir).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("PROPAGATES a genuine (non-N/A) directory fsync error", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    const f = governedTarget(tp);
    // EIO is NOT in the win32 N/A swallow set — it must propagate on every platform.
    const { shim } = recordingShim({ throwOnDir: errno("EIO") });
    expect(() => atomicWriteFile(f, "data", { root: tp.root, fsync: shim })).toThrow(/EIO/);
    // The rename already happened (dir fsync is after) → the data is durably present.
    expect(fs.readFileSync(f, "utf8")).toBe("data");
  });

  it("swallows ONLY the genuinely-N/A win32 dir-handle codes (and ONLY on win32)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    const f = governedTarget(tp);
    const naCode = "EISDIR"; // a representative win32 dir-fsync N/A code
    const { shim } = recordingShim({ throwOnDir: errno(naCode) });
    const run = () => atomicWriteFile(f, "data", { root: tp.root, fsync: shim });
    if (process.platform === "win32") {
      // win32: the N/A dir-handle code is swallowed → the write succeeds.
      expect(run).not.toThrow();
      expect(fs.readFileSync(f, "utf8")).toBe("data");
    } else {
      // POSIX: the same code is a real failure and PROPAGATES (no blanket swallow).
      expect(run).toThrow(new RegExp(naCode));
    }
  });
});

describe("atomicWriteFile — deterministic rename-window proof (AC#2 b)", () => {
  it("a rename that throws AFTER temp is written+fsynced leaves state.json absent-or-full-old, no temp leak", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    const f = governedTarget(tp);

    // Case 1: no prior file. A genuine (non-transient) rename failure in the window
    // must leave the target ABSENT (never a zero-byte/torn file) and clean the temp.
    const enospcRename = () => {
      throw errno("ENOSPC");
    };
    expect(() => atomicWriteFile(f, '{"new":true}', { root: tp.root, rename: enospcRename })).toThrow(/ENOSPC/);
    expect(fs.existsSync(f)).toBe(false); // absent — never a torn zero file
    expect(fs.readdirSync(tp.paths.stateDir).filter((n) => n.includes(".tmp-"))).toEqual([]);

    // Case 2: a FULL OLD file exists. The same failed rename must leave the OLD
    // content fully intact (the temp+rename never touched it) — never half-written.
    const old = '{"old":true,"intact":1}';
    fs.writeFileSync(f, old, "utf8");
    expect(() => atomicWriteFile(f, '{"new":true}', { root: tp.root, rename: enospcRename })).toThrow(/ENOSPC/);
    expect(fs.readFileSync(f, "utf8")).toBe(old); // full-old, never torn
    expect(fs.readdirSync(tp.paths.stateDir).filter((n) => n.includes(".tmp-"))).toEqual([]);

    // Sustained transient contention exhausts the retry budget the same way: typed
    // error, old content intact, no temp leak.
    const alwaysEPERM = () => {
      throw errno("EPERM");
    };
    expect(() => atomicWriteFile(f, '{"new":true}', { root: tp.root, rename: alwaysEPERM })).toThrow(StateWriteContendedError);
    expect(fs.readFileSync(f, "utf8")).toBe(old);
    expect(fs.readdirSync(tp.paths.stateDir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("write-gate torn-but-present characterization (AC#2 c — no hook.ts change)", () => {
  it("a truncated/invalid state.json → default write-gate ALLOWS with a warning (fail-open)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    // A torn (truncated) state.json: invalid JSON, no readable write_gate opt-in.
    fs.writeFileSync(tp.paths.stateFile, '{"current_stage":"init","slices', "utf8");

    const res = runHookPretoolGate(
      tp.paths,
      { tool_name: "Write", tool_input: { file_path: "src/impl.ts" }, cwd: tp.root },
      {}, // empty env — no TH_DISABLE_WRITE_GATE
    );
    const out = JSON.parse(res.stdout) as { systemMessage?: string; hookSpecificOutput?: unknown };
    // Default fail-open: a systemMessage warning, NOT a deny decision.
    expect(out.systemMessage).toMatch(/standing down|invalid/i);
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("a parseable-but-invalid state.json carrying write_gate:\"strict\" → DENIES (fail-closed opt-in)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    // Parses as an object (so rawWriteGateIsStrict can read the opt-in) but FAILS
    // schema validation (missing required fields / wrong types) → state absent but
    // raw write_gate:"strict" present → fail-closed DENY.
    fs.writeFileSync(
      tp.paths.stateFile,
      JSON.stringify({ write_gate: "strict", current_stage: 123 /* invalid type */ }),
      "utf8",
    );

    const res = runHookPretoolGate(
      tp.paths,
      { tool_name: "Write", tool_input: { file_path: "src/impl.ts" }, cwd: tp.root },
      {},
    );
    const out = JSON.parse(res.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("atomicWriteFile — AC#1 guard fires at this chokepoint (runtime positive control)", () => {
  it("throws WriteSurfaceError when a threaded-root write targets a non-governed in-root path", () => {
    tp = makeTempProject();
    // A path INSIDE the root but OUTSIDE the governed allowlist (src/ is slice-owned).
    const outside = path.join(tp.root, "src", "owned.ts");
    expect(() => atomicWriteFile(outside, "x", { root: tp.root })).toThrow(WriteSurfaceError);
    // And it never created the file or a temp.
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("allows a governed write and skips the guard entirely when no root is threaded", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    const governed = governedTarget(tp, "telemetry.json");
    expect(() => atomicWriteFile(governed, "{}", { root: tp.root })).not.toThrow();
    // No-root call: the guard is skipped (back-compat for callers that contain paths
    // by other means), so a non-governed temp path is permitted.
    const anywhere = path.join(os.tmpdir(), `th-noroot-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      expect(() => atomicWriteFile(anywhere, "ok")).not.toThrow();
      expect(fs.readFileSync(anywhere, "utf8")).toBe("ok");
    } finally {
      fs.rmSync(anywhere, { force: true });
    }
  });
});
