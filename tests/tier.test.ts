import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runTierClassify, runTierVetoCheck, VETO_EXIT_CODE } from "../src/commands/tier";
import { loadBriefFromFile } from "../src/core/brief";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a brief.json into the temp project and return its absolute path. */
function writeBrief(t: TempProject, brief: Record<string, unknown>): string {
  const file = path.join(t.root, "brief.json");
  fs.writeFileSync(file, JSON.stringify(brief), "utf8");
  return file;
}

const TRIVIAL = {
  description: "add a log line",
  single_file_or_local: true,
  changes_public_interface: false,
  adds_dependency: false,
  obvious_testable_answer: true,
  blast_radius_flags: [],
};

const AUTH = {
  description: "tweak the login check",
  single_file_or_local: true,
  changes_public_interface: false,
  adds_dependency: false,
  obvious_testable_answer: true,
  blast_radius_flags: ["authentication"],
};

const NORMAL = {
  description: "extend the public API",
  single_file_or_local: false,
  changes_public_interface: true,
  adds_dependency: false,
  obvious_testable_answer: true,
  blast_radius_flags: [],
};

describe("REQ-TIER-001: classify is advisory (§5)", () => {
  it("trivial brief (all-5 true, no flags) → tier0_eligible, advisory T0", () => {
    tp = makeTempProject();
    const res = runTierClassify(tp.paths, writeBrief(tp, TRIVIAL));
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.tier0_eligible).toBe(true);
    expect(res.data?.blocked_by_veto).toBe(false);
    expect(res.data?.advisory).toBe("T0");
  });

  it("auth brief → tier0_eligible false, blocked_by_veto true (advisory never hard-fails)", () => {
    tp = makeTempProject();
    const res = runTierClassify(tp.paths, writeBrief(tp, AUTH));
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.tier0_eligible).toBe(false);
    expect(res.data?.blocked_by_veto).toBe(true);
    expect(res.data?.advisory).toBe("≥T1");
    expect(res.data?.blast_radius_flags).toEqual(["authentication"]);
  });

  it("normal brief (public interface, no flags) → tier0_eligible false, blocked_by_veto false", () => {
    tp = makeTempProject();
    const res = runTierClassify(tp.paths, writeBrief(tp, NORMAL));
    expect(res.ok).toBe(true);
    expect(res.data?.tier0_eligible).toBe(false);
    expect(res.data?.blocked_by_veto).toBe(false);
    expect(res.data?.advisory).toBe("≥T1");
    expect((res.data?.reasons as string[]).length).toBeGreaterThan(0);
  });
});

describe("REQ-VETO-001: veto-check is a mechanical exit-code gate (§5)", () => {
  it("auth brief → ok false, exit 3, data.blocked true", () => {
    tp = makeTempProject();
    const res = runTierVetoCheck(tp.paths, writeBrief(tp, AUTH));
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(VETO_EXIT_CODE);
    expect(res.exitCode).toBe(3);
    expect(res.data?.blocked).toBe(true);
    expect(res.data?.flags).toEqual(["authentication"]);
  });

  it("clean brief → ok true, exit 0, blocked false", () => {
    tp = makeTempProject();
    const res = runTierVetoCheck(tp.paths, writeBrief(tp, TRIVIAL));
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.blocked).toBe(false);
    expect(res.data?.flags).toEqual([]);
  });
});

describe("REQ-TIER-SEC-001: path traversal outside project root is rejected", () => {
  it("classify: brief path escaping root → failure with error path_outside_root", () => {
    tp = makeTempProject();
    const res = runTierClassify(tp.paths, "../../etc/hostname");
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.error).toBe("path_outside_root");
  });

  it("veto-check: brief path escaping root → failure with error path_outside_root", () => {
    tp = makeTempProject();
    const res = runTierVetoCheck(tp.paths, "../../etc/hostname");
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.error).toBe("path_outside_root");
  });
});

describe("REQ-BRIEF-001: brief loading + validation", () => {
  it("missing file returns issues", () => {
    tp = makeTempProject();
    const r = loadBriefFromFile(path.join(tp.root, "does-not-exist.json"));
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.brief).toBeUndefined();
  });

  it("malformed JSON returns issues", () => {
    tp = makeTempProject();
    const file = path.join(tp.root, "bad.json");
    fs.writeFileSync(file, "{ not valid json", "utf8");
    const r = loadBriefFromFile(file);
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("rejects an unknown blast-radius flag", () => {
    tp = makeTempProject();
    const file = writeBrief(tp, { ...TRIVIAL, blast_radius_flags: ["bogus"] });
    const r = loadBriefFromFile(file);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path.startsWith("blast_radius_flags"))).toBe(true);
  });

  it("classify/veto-check report a brief-load failure when the file is missing", () => {
    tp = makeTempProject();
    const missing = path.join(tp.root, "nope.json");
    const c = runTierClassify(tp.paths, missing);
    expect(c.ok).toBe(false);
    expect(c.data?.error).toBe("invalid_brief");
    const v = runTierVetoCheck(tp.paths, missing);
    expect(v.ok).toBe(false);
    expect(v.data?.error).toBe("invalid_brief");
  });
});
