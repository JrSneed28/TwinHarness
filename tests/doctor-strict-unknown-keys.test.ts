/**
 * FIX TEST — Finding #15 (strict unknown-key validation) + Finding #10 (doctor
 * surfaces the configured verify commands).
 *
 * #15: `validateState` emits a non-fatal WARNING for any unknown top-level key
 * (forward-compat / typo signal). `th doctor` keeps that as a WARNING in normal
 * mode but, under `--strict`, escalates an unknown key to a hard FAIL unless the
 * key is in `DOCTOR_STRICT_KEY_ALLOWLIST` — catching typos like `teir`.
 *
 * #10: `th doctor` additively surfaces the verify commands `th verify run` would
 * execute, so an operator / security review can audit exactly what runs.
 */

import * as fs from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDoctor } from "../src/commands/doctor";
import { runVerifyAdd } from "../src/commands/verify";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a raw state.json (bypassing serializeState, which would drop unknown keys). */
function injectRawStateKey(stateFile: string, extra: Record<string, unknown>): void {
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(stateFile, JSON.stringify({ ...parsed, ...extra }, null, 2) + "\n", "utf8");
}

describe("Finding #15 — th doctor --strict fails on unknown top-level keys", () => {
  it("--strict FAILS on an injected `teir` typo key", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    injectRawStateKey(tp.paths.stateFile, { teir: "T2" });

    const res = runDoctor(tp.paths, { strict: true });
    expect(res.ok).toBe(false);
    expect(res.human).toContain("state keys");
    expect(res.human).toContain("teir");
  });

  it("normal (non-strict) mode keeps the unknown key as a WARNING, not a failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    injectRawStateKey(tp.paths.stateFile, { teir: "T2" });

    const res = runDoctor(tp.paths, {});
    expect(res.ok).toBe(true); // warning only — does not fail the process
    expect(res.human).toContain("teir");
    expect(res.human).toContain("th doctor --strict");
  });

  it("--strict PASSES when only known top-level keys are present", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runDoctor(tp.paths, { strict: true });
    // No unknown keys → no "state keys" failure (node/state checks all pass).
    expect(res.ok).toBe(true);
    expect(res.human).not.toContain("unknown top-level key");
  });
});

describe("Finding #10 — th doctor surfaces the configured verify commands", () => {
  it("lists the commands `th verify run` would execute", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, "npm test");
    runVerifyAdd(tp.paths, "npm run lint");

    const res = runDoctor(tp.paths, {});
    expect(res.human).toContain("verify commands");
    expect(res.human).toContain("npm test");
    expect(res.human).toContain("npm run lint");
  });

  it("reports 'none configured' when no verify commands are set", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runDoctor(tp.paths, {});
    expect(res.human).toContain("verify commands");
    expect(res.human).toContain("none configured");
  });
});
