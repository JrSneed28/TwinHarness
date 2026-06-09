import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateGet, runStateSet, runStateVerify, runStateStatus } from "../src/commands/state";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function init(): TempProject {
  const t = makeTempProject();
  runInit(t.paths, {});
  return t;
}

describe("REQ-STATE-CMD: state get/set/verify/status", () => {
  it("get returns a dotted value", () => {
    tp = init();
    const res = runStateGet(tp.paths, "current_stage");
    expect(res.ok).toBe(true);
    expect(res.data?.value).toBe("init");
  });

  it("set persists valid JSON-parsed values", () => {
    tp = init();
    expect(runStateSet(tp.paths, "tier", "T2").ok).toBe(true);
    expect(readState(tp.paths).state?.tier).toBe("T2");
    expect(runStateSet(tp.paths, "implementation_allowed", "true").ok).toBe(true);
    expect(readState(tp.paths).state?.implementation_allowed).toBe(true);
  });

  it("set refuses an invalid value and leaves state unchanged", () => {
    tp = init();
    const res = runStateSet(tp.paths, "tier", "T9");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("would_be_invalid");
    expect(readState(tp.paths).state?.tier).toBeNull();
  });

  it("set supports nested revise_loop_counts", () => {
    tp = init();
    expect(runStateSet(tp.paths, "revise_loop_counts.architecture", "1").ok).toBe(true);
    expect(readState(tp.paths).state?.revise_loop_counts.architecture).toBe(1);
  });

  it("verify passes on a fresh init and fails on an uninitialized project", () => {
    tp = init();
    expect(runStateVerify(tp.paths).ok).toBe(true);
    const empty = makeTempProject();
    expect(runStateVerify(empty.paths).ok).toBe(false);
    empty.cleanup();
  });

  it("get on an uninitialized project reports not_initialized", () => {
    const empty = makeTempProject();
    const res = runStateGet(empty.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
    empty.cleanup();
  });

  it("status renders without throwing", () => {
    tp = init();
    expect(runStateStatus(tp.paths).ok).toBe(true);
  });
});
