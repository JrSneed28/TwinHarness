import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateGet, runStateSet, runStateVerify, runStateStatus } from "../src/commands/state";
import { runDriftAdd, runDriftResolve } from "../src/commands/drift";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function init(): TempProject {
  const t = makeTempProject();
  runInit(t.paths, {});
  return t;
}

describe("REQ-STATE-CMD-UNKNOWN-KEY: set rejects unknown top-level keys", () => {
  it("typo 'implementaton_allowed' → failure unknown_field", () => {
    tp = init();
    const res = runStateSet(tp.paths, "implementaton_allowed", "true");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_field");
    expect(res.data?.field).toBe("implementaton_allowed");
    // State must be unchanged.
    expect(readState(tp.paths).state?.implementation_allowed).toBe(false);
  });

  it("nested path with valid first segment is accepted", () => {
    tp = init();
    const res = runStateSet(tp.paths, "revise_loop_counts.design", "2");
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state?.revise_loop_counts.design).toBe(2);
  });

  it("nested path with invalid first segment is rejected", () => {
    tp = init();
    const res = runStateSet(tp.paths, "bogus_field.sub", "1");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_field");
  });
});

describe("REQ-STATE-CMD-PROTO: set refuses prototype-polluting key segments (S3)", () => {
  it.each([
    "revise_loop_counts.__proto__.polluted",
    "revise_loop_counts.constructor.x",
    "revise_loop_counts.prototype.y",
  ])("rejects %s with error unsafe_key", (key) => {
    tp = init();
    const res = runStateSet(tp.paths, key, "1");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unsafe_key");
    // No prototype was polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // State remains valid.
    expect(runStateVerify(tp.paths).ok).toBe(true);
  });
});

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

describe("REQ-STATE-CMD-MANAGED: state set refuses managed fields", () => {
  it("drift_open_blocking 0 → failure managed_field, counter unchanged", () => {
    tp = init();
    const before = readState(tp.paths).state?.drift_open_blocking;
    const res = runStateSet(tp.paths, "drift_open_blocking", "0");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("managed_field");
    expect(res.data?.field).toBe("drift_open_blocking");
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(before);
  });

  it("drift_open_blocking 5 → failure managed_field, counter unchanged", () => {
    tp = init();
    const before = readState(tp.paths).state?.drift_open_blocking;
    const res = runStateSet(tp.paths, "drift_open_blocking", "5");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("managed_field");
    expect(res.data?.field).toBe("drift_open_blocking");
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(before);
  });

  it("implementation_allowed (non-managed gate field) still succeeds", () => {
    tp = init();
    const res = runStateSet(tp.paths, "implementation_allowed", "true");
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state?.implementation_allowed).toBe(true);
  });

  it("th drift add / th drift resolve own the counter without interference", () => {
    tp = init();
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(0);

    // drift add --layer requirement increments the counter.
    const addRes = runDriftAdd(tp.paths, {
      layer: "requirement",
      ref: "SLICE-1 / TASK-001",
      discovery: "Managed-field guard test",
      action: "build paused",
    });
    expect(addRes.ok).toBe(true);
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);

    // drift resolve decrements the counter.
    const id = (addRes.data as { id: string }).id;
    const resolveRes = runDriftResolve(tp.paths, id);
    expect(resolveRes.ok).toBe(true);
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(0);
  });
});
