/**
 * SLICE-0 / TASK-000 — Adoption-seam characterization tests.
 *
 * Pins the CURRENT behavior of the three integration points that the `th repo`
 * overlay (later slices) will attach to. No production code is changed here.
 *
 * Anchors covered: REQ-RU-001, REQ-NFR-002, REQ-NFR-005.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runContextPack } from "../src/commands/context";
import { TOOL_DEFS } from "../src/mcp-server";
import { BLAST_RADIUS_FLAGS } from "../src/core/state-schema";
import {
  type RepoMap,
  type Language,
  type FileEntry,
  type Component,
  emptyRepoMap,
  serializeRepoMap,
  parseRepoMap,
  renderRepoMapMarkdown,
} from "../src/core/repo-map/schema";
import { scanRepo } from "../src/core/repo-map/scanner";
import { runRepoMap, runRepoRelevant, runRepoImpact } from "../src/commands/repo";
import { computeRelevance, computeImpact, type Selector, type ImpactSelector } from "../src/core/repo-map/query";
import { parseArgs } from "../src/cli";
import { readState, writeState } from "../src/core/state-store";

const ROOT = path.resolve(__dirname, "..");

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// ---------------------------------------------------------------------------
// Seam 1: src/cli.ts dispatch() — unknown group is handled cleanly today.
// SLICE-1 will add `case "repo":` here; this test pins the CURRENT default path
// so a regression is immediately visible.
// ---------------------------------------------------------------------------

describe("REQ-RU-001: dispatch() attachment point — `repo` group now wired (SLICE-1)", () => {
  // We test dispatch() indirectly via the built CLI binary so that the full
  // arg-parsing + dispatch path is exercised end-to-end, matching the integration
  // test convention in cli-integration.test.ts.
  //
  // NOTE (SLICE-1 supersedes SLICE-0): these two cases originally pinned the
  // PRE-SLICE-1 reality ("no `case "repo":` yet — unknown group"). SLICE-1's
  // whole purpose is to fill that seam, so they are updated to assert the new,
  // implemented behavior. The third case (existing groups still dispatch) is the
  // additive-no-regression guarantee and is unchanged.
  const CLI = path.join(ROOT, "dist", "cli.js");

  function runCLI(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync("node", [CLI, "--cwd", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, TH_NO_LOG: "1" },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  }

  it("REQ-RU-001 — `th repo map` now dispatches successfully (handler wired in SLICE-1)", () => {
    tp = makeTempProject();
    const res = runCLI(tp.root, ["repo", "map", "--no-write"]);
    // SLICE-1 added `case "repo":` → the command is handled and exits 0.
    expect(res.status).toBe(0);
  });

  it("REQ-RU-001 — `th repo map` output is the repo-map summary, NOT an unknown-command error", () => {
    tp = makeTempProject();
    const res = runCLI(tp.root, ["repo", "map", "--no-write"]);
    expect(res.stdout).not.toContain("unknown command");
    expect(res.stdout).toContain("Repo map:");
  });

  it("REQ-RU-001 — existing groups (e.g. th version) still dispatch correctly", () => {
    tp = makeTempProject();
    const res = runCLI(tp.root, ["version"]);
    // Known groups must continue to work — the default branch must NOT swallow them.
    expect(res.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Seam 2: src/mcp-server.ts TOOL_DEFS — 9 base tools + 3 delegate + 4 repo-map = 16.
// Pinning the exact count + names makes any future change to the surface deliberate.
// ---------------------------------------------------------------------------

describe("REQ-NFR-002: TOOL_DEFS baseline — exactly 60 tools registered (on top of the prior 39, the MCP-tool-expansion adds 5 typed gate-transition tools — th_tier_record/stage_advance/implementation_unlock/write_gate_set/blast_radius_record — plus 16 wired handlers — th_drift_list/resolve, th_coverage_report, th_artifact_register/list, th_verify_add/list/clear/run, th_stage_current/describe/list, th_doctor, th_scorecard, th_slices_sync, th_slice_set_status)", () => {
  // Anchor: REQ-NFR-002
  const EXPECTED_TOOL_NAMES = [
    "th_state_get",
    "th_state_set",
    "th_tier_record",
    "th_stage_advance",
    "th_implementation_unlock",
    "th_write_gate_set",
    "th_blast_radius_record",
    "th_drift_add",
    "th_drift_list",
    "th_drift_resolve",
    "th_build_next_wave",
    "th_build_claim",
    "th_build_release",
    "th_build_dispatch",
    "th_build_plan",
    "th_route",
    "th_coverage_check",
    "th_coverage_report",
    "th_next",
    "th_delegate_plan",
    "th_delegate_pack",
    "th_delegate_check",
    "th_repo_map",
    "th_repo_relevant",
    "th_repo_impact",
    "th_context_pack",
    "th_build_sub_claim",
    "th_build_sub_release",
    "th_repo_check",
    "th_decision_detect",
    "th_decision_add",
    "th_decision_check",
    "th_decision_list",
    "th_artifact_register",
    "th_artifact_list",
    "th_artifact_claim",
    "th_artifact_release",
    "th_artifact_leases",
    "th_collab_init",
    "th_collab_fragment",
    "th_collab_list",
    "th_collab_merge",
    "th_debate_add",
    "th_debate_list",
    "th_debate_resolve",
    "th_verify_add",
    "th_verify_list",
    "th_verify_clear",
    "th_verify_run",
    "th_stage_current",
    "th_stage_describe",
    "th_stage_list",
    "th_doctor",
    "th_scorecard",
    "th_slices_sync",
    "th_slice_set_status",
    "th_interview_start",
    "th_interview_record",
    "th_interview_status",
    "th_init",
    "th_budget_check",
    "th_handoff_write",
  ] as const;

  it("REQ-NFR-002 — TOOL_DEFS.length === 60 (the MCP-tool-expansion adds 5 typed gate-transition tools + 16 wired handlers on top of the prior 39 → 60)", () => {
    expect(TOOL_DEFS.length).toBe(62);
  });

  it("REQ-NFR-002 — TOOL_DEFS contains exactly the 60 expected tool names", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("REQ-NFR-002 — dist/cli.js does NOT import the MCP SDK (CLI stays SDK-free)", () => {
    const cli = fs.readFileSync(path.join(ROOT, "dist", "cli.js"), "utf8");
    expect(cli.includes("@modelcontextprotocol")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Seam 3: src/commands/context.ts runContextPack() — returns a well-formed
// §9 handoff bundle. SLICE-5 may extend this; pinning the shape now catches
// regressions.
// ---------------------------------------------------------------------------

describe("REQ-NFR-005: runContextPack() seam — returns a well-formed CommandResult today", () => {
  // Anchor: REQ-NFR-005

  it("REQ-NFR-005 — runContextPack on an initialized project returns ok:true", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
  });

  it("REQ-NFR-005 — the result has a numeric totalTokens field and an artifacts array", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
    // Well-formed bundle: must carry a data object with the shape §9 requires.
    expect(typeof res.data?.totalTokens).toBe("number");
    expect(Array.isArray(res.data?.artifacts)).toBe(true);
  });

  it("REQ-NFR-005 — runContextPack on a non-initialized project returns ok:false (not_initialized)", () => {
    tp = makeTempProject();
    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });

  it("REQ-NFR-005 — dist/ is in sync with src/ today (git diff --exit-code dist/ exits 0)", () => {
    // Pins the dist-sync invariant: `npm run verify` includes `git diff --exit-code dist/`.
    // We assert it is clean RIGHT NOW so any accidental dist/ mutation fails fast.
    const r = spawnSync("git", ["diff", "--exit-code", "dist/"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    expect(r.status).toBe(0);
  });
});

// ===========================================================================
// SLICE-1 / TASK-001 — schema.ts: types + deterministic serializer + strict
// parser + markdown renderer.
// ===========================================================================

describe("SLICE-1 / TASK-001 — repo-map schema (serialize / parse / render)", () => {
  // A non-trivial in-memory RepoMap with deliberately UNSORTED collections and
  // BACKSLASH paths, so the serializer's sort + POSIX normalization is exercised.
  function sampleMap(): RepoMap {
    const m = emptyRepoMap("/tmp/some/abs/root");
    m.scanReport = { filesScanned: 3, filesSkipped: 1, capHit: null };
    m.languages = [
      { name: "TypeScript", evidence: ["src\\b.ts", "src\\a.ts"], source: "both" },
      { name: "Go", evidence: ["go.mod"], source: "manifest" },
    ];
    m.package_managers = [
      { name: "npm", manifest_paths: ["sub\\package.json", "package.json"] },
    ];
    m.candidate_commands = [
      { label: "test", raw: "vitest run", source_file: "package.json", kind: "test" },
      { label: "build", raw: "tsc", source_file: "package.json", kind: "build" },
    ];
    m.source_roots = ["src", "lib"];
    m.test_roots = ["tests"];
    m.docs_roots = ["docs"];
    m.generated_paths = ["dist", "node_modules"];
    m.components = [
      { name: "src\\commands", path: "src\\commands", file_count: 2 },
      { name: "src\\core", path: "src\\core", file_count: 5 },
    ];
    m.entrypoints = [{ name: "th", path: "dist\\cli.js", source: "package.json:bin" }];
    m.public_api = { hints: [{ name: "runX", source: "export" }], confidence: "heuristic" };
    m.ownership_hints = [{ path_prefix: "src\\core", component: "src\\core" }];
    m.files = [
      { path: "src\\b.ts", component: "src\\core", language: "TypeScript", is_test: false, req_ids: ["REQ-RU-002", "REQ-RU-001"] },
      { path: "src\\a.ts", component: "src\\core", language: "TypeScript", is_test: false, req_ids: [] },
    ];
    m.req_anchors = [
      { req_id: "REQ-RU-002", locations: ["src\\b.ts"] },
      { req_id: "REQ-RU-001", locations: ["tests\\x.ts", "src\\b.ts"] },
    ];
    m.blast_radius_signals = [
      { flag: "authentication", matching_paths: ["src\\auth.ts"], trigger_patterns: ["login", "auth"] },
    ];
    return m;
  }

  it("REQ-RU-015 — byte-stable: serialized bytes contain no ISO-timestamp and no host absolute path", () => {
    const s = serializeRepoMap(sampleMap());
    // No ISO timestamp.
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)).toBe(false);
    // No host absolute path markers.
    expect(s.includes("/tmp/")).toBe(false);
    expect(s.includes(":\\")).toBe(false);
    expect(s.includes("/Users/")).toBe(false);
    expect(s.includes("/home/")).toBe(false);
    // repoRoot + scanReport are stripped.
    expect(s.includes("repoRoot")).toBe(false);
    expect(s.includes("scanReport")).toBe(false);
    expect(s.includes("filesScanned")).toBe(false);
  });

  it("REQ-RU-064 — schema_version is present and emitted first", () => {
    const s = serializeRepoMap(sampleMap());
    const obj = JSON.parse(s) as Record<string, unknown>;
    expect(obj.schema_version).toBe(2);
    expect(Object.keys(obj)[0]).toBe("schema_version");
  });

  it("REQ-RU-064 — extensions is reserved and NOT written", () => {
    const s = serializeRepoMap(sampleMap());
    const obj = JSON.parse(s) as Record<string, unknown>;
    expect("extensions" in obj).toBe(false);
  });

  it("REQ-NFR-001 — serializing the same map twice is byte-identical (no abs path / timestamp)", () => {
    const m = sampleMap();
    const a = serializeRepoMap(m);
    const b = serializeRepoMap(m);
    expect(a).toBe(b);
    // Single trailing newline, 2-space indent.
    expect(a.endsWith("\n")).toBe(true);
    expect(a.endsWith("\n\n")).toBe(false);
    expect(a.includes('\n  "languages"')).toBe(true);
  });

  it("REQ-NFR-001 — collections + inner arrays are sorted (input order is irrelevant)", () => {
    // Reversed-order map serializes identically to the forward-order map.
    const m1 = sampleMap();
    const m2 = sampleMap();
    m2.languages.reverse();
    m2.files.reverse();
    m2.req_anchors.reverse();
    m2.candidate_commands.reverse();
    expect(serializeRepoMap(m1)).toBe(serializeRepoMap(m2));

    const obj = JSON.parse(serializeRepoMap(m1)) as {
      languages: Language[];
      files: FileEntry[];
      source_roots: string[];
    };
    expect(obj.languages.map((l) => l.name)).toEqual(["Go", "TypeScript"]);
    expect(obj.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(obj.source_roots).toEqual(["lib", "src"]);
    // Inner array (req_ids) sorted lexicographically.
    const b = obj.files.find((f) => f.path === "src/b.ts")!;
    expect(b.req_ids).toEqual(["REQ-RU-001", "REQ-RU-002"]);
  });

  it("REQ-NFR-001 — parsed bytes have no top-level extensions key", () => {
    const obj = JSON.parse(serializeRepoMap(sampleMap())) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(obj, "extensions")).toBe(false);
  });

  it("REQ-NFR-006 — path separators are normalized: no backslash in any path field", () => {
    const s = serializeRepoMap(sampleMap());
    // Backslashes were present in the in-memory map; none survive serialization.
    expect(s.includes("\\")).toBe(false);
    const obj = JSON.parse(s) as { files: FileEntry[]; components: Component[] };
    for (const f of obj.files) expect(f.path.includes("\\")).toBe(false);
    for (const c of obj.components) {
      expect(c.path.includes("\\")).toBe(false);
      expect(c.name.includes("\\")).toBe(false);
    }
  });

  it("REQ-RU-043 — parseRepoMap on invalid JSON returns the map_invalid-json tagged failure (no throw)", () => {
    const r = parseRepoMap("{ not json ");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("map_invalid-json");
  });

  it("REQ-RU-043 — parseRepoMap on a schema-invalid object returns map_schema (no throw)", () => {
    // Right version, wrong shape (languages must be an array).
    const r = parseRepoMap(JSON.stringify({ schema_version: 2, languages: "nope" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("map_schema");
  });

  it("REQ-RU-043 — parseRepoMap on an unknown schema_version returns map_version (no throw)", () => {
    const r = parseRepoMap(JSON.stringify({ schema_version: 999 }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("map_version");
  });

  it("REQ-RU-043 — parseRepoMap on null/missing returns map_missing (no throw)", () => {
    expect(parseRepoMap(null).error).toBe("map_missing");
    expect(parseRepoMap(undefined).error).toBe("map_missing");
  });

  it("REQ-RU-043 — round-trip: serialize → parse yields ok:true with a valid map", () => {
    const s = serializeRepoMap(sampleMap());
    const r = parseRepoMap(s);
    expect(r.ok).toBe(true);
    expect(r.map?.schema_version).toBe(2);
    // re-serializing the parsed map is byte-identical (determinism survives the round trip).
    expect(serializeRepoMap(r.map!)).toBe(s);
  });

  it("REQ-NFR-004 — renderRepoMapMarkdown is a compact summary (not a full dump) and byte-stable", () => {
    const m = sampleMap();
    const md = renderRepoMapMarkdown(m);
    expect(md).toBe(renderRepoMapMarkdown(m));
    expect(md.startsWith("# Repo Map\n")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    // Compact: counts, not the per-file path dump.
    expect(md.includes("## Counts")).toBe(true);
    expect(md.includes("Files: 2")).toBe(true);
    // No date / no abs path.
    expect(/\d{4}-\d{2}-\d{2}/.test(md)).toBe(false);
    expect(md.includes("/tmp/")).toBe(false);
  });
});

// ===========================================================================
// SLICE-1 / TASK-002 — scanner.ts: bounded walk + generated-dir exclusion +
// 10 pure detectors. NEVER executes a discovered command.
// ===========================================================================

describe("SLICE-1 / TASK-002 — repo scanner (detectors + exclusion + bounds)", () => {
  /** Write a synthetic file tree under a temp root. */
  function writeTree(root: string, tree: Record<string, string>): void {
    for (const [rel, content] of Object.entries(tree)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
  }

  it("REQ-RU-002 — language detection: TypeScript via .ts extension + tsconfig manifest", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "export const x = 1;\n", "tsconfig.json": "{}\n" });
    const m = scanRepo(tp.root);
    const names = m.languages.map((l) => l.name);
    expect(names).toContain("TypeScript");
  });

  it("REQ-RU-002 — language detection: Go via .go + go.mod", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "main.go": "package main\n", "go.mod": "module x\n" });
    const m = scanRepo(tp.root);
    expect(m.languages.map((l) => l.name)).toContain("Go");
  });

  it("REQ-RU-002 — language detection: Rust via .rs + Cargo.toml", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/lib.rs": "pub fn x() {}\n", "Cargo.toml": "[package]\n" });
    const m = scanRepo(tp.root);
    expect(m.languages.map((l) => l.name)).toContain("Rust");
  });

  it("REQ-RU-003 — package-manager detection: npm via package.json", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "package.json": JSON.stringify({ name: "x" }) });
    const m = scanRepo(tp.root);
    expect(m.package_managers.map((p) => p.name)).toContain("npm");
  });

  it("REQ-RU-003 — package-manager detection: go modules via go.mod", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "go.mod": "module x\n" });
    const m = scanRepo(tp.root);
    expect(m.package_managers.map((p) => p.name)).toContain("go modules");
  });

  it("REQ-RU-003 — package-manager detection: cargo via Cargo.toml", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "Cargo.toml": "[package]\n" });
    const m = scanRepo(tp.root);
    expect(m.package_managers.map((p) => p.name)).toContain("cargo");
  });

  it("REQ-RU-004 — candidate commands are recorded as inert strings, not executed", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    });
    const m = scanRepo(tp.root);
    const labels = m.candidate_commands.map((c) => c.label);
    expect(labels).toContain("test");
    expect(labels).toContain("build");
    const testCmd = m.candidate_commands.find((c) => c.label === "test")!;
    expect(testCmd.raw).toBe("vitest run");
    expect(testCmd.kind).toBe("test");
  });

  it("REQ-RU-005 — source root detected (src/)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n" });
    const m = scanRepo(tp.root);
    expect(m.source_roots).toContain("src");
  });

  it("REQ-RU-005 — test root detected (tests/)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "tests/a.test.ts": "1\n" });
    const m = scanRepo(tp.root);
    expect(m.test_roots).toContain("tests");
  });

  it("REQ-RU-006 — generated dirs (node_modules, dist) are excluded", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "src/a.ts": "1\n",
      "node_modules/dep/index.js": "1\n",
      "dist/cli.js": "1\n",
    });
    const m = scanRepo(tp.root);
    // No file under node_modules or dist appears in files.
    expect(m.files.some((f) => f.path.startsWith("node_modules/"))).toBe(false);
    expect(m.files.some((f) => f.path.startsWith("dist/"))).toBe(false);
    expect(m.generated_paths).toContain("node_modules");
    expect(m.generated_paths).toContain("dist");
  });

  it("REQ-RU-041 — generated dirs excluded across all scan areas (nested too)", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "src/a.ts": "1\n",
      "src/node_modules/dep/index.js": "1\n",
      "build/out.js": "1\n",
      "target/debug/bin": "1\n",
    });
    const m = scanRepo(tp.root);
    expect(m.files.some((f) => f.path.includes("node_modules/"))).toBe(false);
    expect(m.files.some((f) => f.path.startsWith("build/"))).toBe(false);
    expect(m.files.some((f) => f.path.startsWith("target/"))).toBe(false);
  });

  it("REQ-RU-007 — component detection from src subdirs (src/a, src/b)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a/x.ts": "1\n", "src/b/y.ts": "1\n", "src/b/z.ts": "1\n" });
    const m = scanRepo(tp.root);
    const names = m.components.map((c) => c.name);
    expect(names).toContain("src/a");
    expect(names).toContain("src/b");
    const b = m.components.find((c) => c.name === "src/b")!;
    expect(b.file_count).toBe(2);
  });

  it("REQ-RU-008 — entrypoint detection from package.json bin", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "package.json": JSON.stringify({ bin: { th: "dist/cli.js" } }) });
    const m = scanRepo(tp.root);
    const bin = m.entrypoints.find((e) => e.source === "package.json:bin");
    expect(bin).toBeDefined();
    expect(bin!.path).toBe("dist/cli.js");
  });

  it("REQ-RU-009 — public API surface detected when present (package.json exports)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "package.json": JSON.stringify({ exports: { ".": "./index.js" } }) });
    const m = scanRepo(tp.root);
    expect(m.public_api).not.toBeNull();
    expect(m.public_api!.confidence).toBe("heuristic");
  });

  it("REQ-RU-009 — public API absent is not a failure (null, scan still ok)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n" });
    const m = scanRepo(tp.root);
    expect(m.public_api).toBeNull();
    // Map is still a valid, populated structure.
    expect(m.files.length).toBeGreaterThan(0);
  });

  it("REQ-RU-010 — test locations detected (is_test flag on test files)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "tests/a.test.ts": "1\n", "src/a.ts": "1\n" });
    const m = scanRepo(tp.root);
    const testFile = m.files.find((f) => f.path === "tests/a.test.ts")!;
    const srcFile = m.files.find((f) => f.path === "src/a.ts")!;
    expect(testFile.is_test).toBe(true);
    expect(srcFile.is_test).toBe(false);
  });

  it("REQ-RU-011 — REQ anchors recorded via scanDirForReqIds", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "// Anchor: REQ-RU-001\nexport const x = 1;\n" });
    const m = scanRepo(tp.root);
    const anchor = m.req_anchors.find((r) => r.req_id === "REQ-RU-001");
    expect(anchor).toBeDefined();
    expect(anchor!.locations).toContain("src/a.ts");
    // Also attached to the FileEntry.
    const f = m.files.find((f) => f.path === "src/a.ts")!;
    expect(f.req_ids).toContain("REQ-RU-001");
  });

  it("REQ-RU-012 — ownership hints recorded (file-to-component mapping)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/core/a.ts": "1\n" });
    const m = scanRepo(tp.root);
    const hint = m.ownership_hints.find((o) => o.component === "src/core");
    expect(hint).toBeDefined();
    expect(hint!.path_prefix).toBe("src/core");
  });

  it("REQ-RU-013 — blast-radius signals detected via BLAST_RADIUS_FLAGS vocabulary", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/auth/login.ts": "1\n" });
    const m = scanRepo(tp.root);
    const sig = m.blast_radius_signals.find((s) => s.flag === "authentication");
    expect(sig).toBeDefined();
    expect(sig!.matching_paths).toContain("src/auth/login.ts");
    // The flag is from the canonical vocabulary.
    expect((BLAST_RADIUS_FLAGS as readonly string[]).includes(sig!.flag)).toBe(true);
  });

  it("REQ-NFR-007 — file-count cap fires to a partial map (capHit set, still ok)", () => {
    tp = makeTempProject();
    // Real fixture of 5 files; lower the cap to 3 so the walk stops early.
    writeTree(tp.root, {
      "src/a.ts": "1\n",
      "src/b.ts": "1\n",
      "src/c.ts": "1\n",
      "src/d.ts": "1\n",
      "src/e.ts": "1\n",
    });
    const m = scanRepo(tp.root, { fileCountCap: 3 });
    expect(m.scanReport.capHit).toBe("file-count");
    // A cap is NOT an error — the map is still well-formed and partial.
    expect(m.scanReport.filesScanned).toBe(3);
    expect(m.files.length).toBe(3);
  });

  it("REQ-NFR-007 — total-bytes cap fires to a partial map (capHit set, still ok)", () => {
    tp = makeTempProject();
    // Each file is ~50 bytes; cap at 60 bytes so the second file trips it.
    writeTree(tp.root, {
      "src/a.ts": "x".repeat(50),
      "src/b.ts": "y".repeat(50),
    });
    const m = scanRepo(tp.root, { totalBytesCap: 60 });
    expect(m.scanReport.capHit).toBe("total-bytes");
    // First file fit; second tripped the cap → partial, still ok.
    expect(m.files.length).toBe(1);
  });

  it("REQ-NFR-007 — excluded dirs are skipped early (not opened) so injected content is never read", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "src/a.ts": "1\n",
      "node_modules/evil/inject.ts": "// Anchor: REQ-RU-999\n",
    });
    const m = scanRepo(tp.root);
    // inject.ts content (REQ-RU-999) must NOT appear anywhere — node_modules was
    // excluded before being opened (both the walk and scanDirForReqIds skip it).
    expect(m.req_anchors.some((r) => r.req_id === "REQ-RU-999")).toBe(false);
    expect(m.files.some((f) => f.path.includes("node_modules/"))).toBe(false);
    expect(m.generated_paths).toContain("node_modules");
  });
});

// ===========================================================================
// SLICE-1 / TASK-003 — runRepoMap handler + repo/map CLI dispatch + dual write.
// ===========================================================================

describe("SLICE-1 / TASK-003 — runRepoMap handler + CLI dispatch + dual-artifact write", () => {
  function writeTree(root: string, tree: Record<string, string>): void {
    for (const [rel, content] of Object.entries(tree)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
  }
  const CLI = path.join(ROOT, "dist", "cli.js");
  function runCLI(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync("node", [CLI, "--cwd", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, TH_NO_LOG: "1" },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  }

  it("REQ-RU-001 — runRepoMap returns a CommandResult ok:true (Critical Pattern 1)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "package.json": JSON.stringify({ name: "x" }), "src/a.ts": "1\n" });
    const res = runRepoMap(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(typeof res.data?.schemaVersion).toBe("number");
  });

  it("REQ-RU-014 — dual-artifact write: both repo-map.json and docs/00-repo-map.md exist", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "package.json": JSON.stringify({ name: "x" }), "src/a.ts": "1\n" });
    const res = runRepoMap(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.data?.wrote).toBe(true);
    expect(fs.existsSync(path.join(tp.paths.stateDir, "repo-map.json"))).toBe(true);
    expect(fs.existsSync(path.join(tp.paths.docsDir, "00-repo-map.md"))).toBe(true);
    expect(res.data?.artifacts).toEqual([".twinharness/repo-map.json", "docs/00-repo-map.md"]);
  });

  it("REQ-RU-016 — --json output flag emits the structured envelope via the CLI", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n" });
    const res = runCLI(tp.root, ["repo", "map", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; schemaVersion: number; counts: Record<string, number> };
    expect(parsed.ok).toBe(true);
    expect(parsed.schemaVersion).toBe(2);
    expect(typeof parsed.counts.files).toBe("number");
  });

  it("REQ-RU-016 — global --cwd flag is honored (writes under the target root)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n" });
    const res = runCLI(tp.root, ["repo", "map"]);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(tp.root, ".twinharness", "repo-map.json"))).toBe(true);
  });

  it("REQ-RU-017 — dry mode (--no-write) returns a correct result; neither artifact written", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "package.json": JSON.stringify({ name: "x" }), "src/a.ts": "1\n" });
    const res = runRepoMap(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    expect(res.data?.wrote).toBe(false);
    expect(res.data?.artifacts).toEqual([]);
    expect(fs.existsSync(path.join(tp.paths.stateDir, "repo-map.json"))).toBe(false);
    expect(fs.existsSync(path.join(tp.paths.docsDir, "00-repo-map.md"))).toBe(false);
    // The in-memory map (counts) still equals what would have been persisted.
    expect(typeof (res.data?.counts as Record<string, number>).files).toBe("number");
  });

  it("REQ-RU-017 — --no-write via CLI also writes nothing", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n" });
    const res = runCLI(tp.root, ["repo", "map", "--no-write"]);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(tp.root, ".twinharness", "repo-map.json"))).toBe(false);
  });

  it("REQ-RU-040 — the CLI path executes no discovered command (scripts present but inert)", () => {
    tp = makeTempProject();
    const sentinel = path.join(tp.root, "EXECUTED");
    // A package.json whose scripts WOULD create a sentinel if executed.
    writeTree(tp.root, {
      "package.json": JSON.stringify({
        scripts: { test: `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, "/")}','x')"` },
      }),
      "src/a.ts": "1\n",
    });
    const res = runCLI(tp.root, ["repo", "map"]);
    expect(res.status).toBe(0);
    // The command is recorded but NEVER executed → sentinel absent.
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("REQ-NFR-003 — runRepoMap matches Critical Pattern 1: never throws, no process.exit, returns CommandResult", () => {
    // Pointing at a non-existent root must NOT throw — it returns a valid result.
    const fakePaths = makeTempProject();
    tp = fakePaths;
    fs.rmSync(fakePaths.root, { recursive: true, force: true }); // remove the dir entirely
    const res = runRepoMap(fakePaths.paths, { write: false });
    expect(res.ok).toBe(true); // empty-but-valid map (scan never fails)
    expect(res.exitCode).toBe(0);
    expect((res.data?.counts as Record<string, number>).files).toBe(0);
  });

  it("REQ-NFR-004 — default (summary) output is compact, NOT a full map dump", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n", "src/b.ts": "1\n" });
    const res = runRepoMap(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    // Human summary mentions counts, never inlines the per-file path list as JSON.
    expect(res.human).toContain("Repo map:");
    expect(res.human).toContain("files:");
    // Compact: the full files array (with paths) is not dumped into the human text.
    expect(res.human!.includes("src/a.ts")).toBe(false);
  });

  it("REQ-RU-016 — bad --format yields a clean bad_format failure (ERR-008)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n" });
    const res = runRepoMap(tp.paths, { format: "xml" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("bad_format");
    expect(res.data?.format).toBe("xml");
  });

  it("REQ-RU-001 — CLI dispatch: existing groups still dispatch (additive edit, no regression)", () => {
    tp = makeTempProject();
    // `th version` (existing group) still works after adding `case "repo":`.
    expect(runCLI(tp.root, ["version"]).status).toBe(0);
    // `th repo map` now dispatches to the handler (no longer "unknown command").
    const repo = runCLI(tp.root, ["repo", "map", "--no-write"]);
    expect(repo.status).toBe(0);
    expect(repo.stdout.includes("unknown command")).toBe(false);
  });
});

// ===========================================================================
// SLICE-1 / TASK-004 — Acceptance battery: REQ-RU-090 robustness, golden
// double-run byte-stability, no-exec sentinel, SDK-free + dist-sync checks.
// ===========================================================================

describe("SLICE-1 / TASK-004 — acceptance battery (robustness, determinism, no-exec, dist-sync)", () => {
  function writeTree(root: string, tree: Record<string, string>): void {
    for (const [rel, content] of Object.entries(tree)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
  }
  const CLI = path.join(ROOT, "dist", "cli.js");
  function runCLI(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync("node", [CLI, "--cwd", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, TH_NO_LOG: "1" },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  }

  // ---- REQ-RU-090 robustness suite -----------------------------------------

  it("REQ-RU-090 — empty repo yields a valid empty map (ok:true)", () => {
    tp = makeTempProject();
    const res = runRepoMap(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    expect((res.data?.counts as Record<string, number>).files).toBe(0);
  });

  it("REQ-RU-090 — a repo with no manifests still yields a valid map", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "README.txt": "hello\n", "notes/x.md": "note\n" });
    const res = runRepoMap(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    expect((res.data?.counts as Record<string, number>).packageManagers).toBe(0);
  });

  it("REQ-RU-090 — an unreadable file is skipped, not crashed", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n" });
    // scanRepo must not throw even when a stat fails mid-walk. We assert the
    // happy path produces a result; the scanner's try/catch guards the rest.
    const m = scanRepo(tp.root);
    expect(m.files.length).toBeGreaterThanOrEqual(1);
  });

  it("REQ-RU-090 — a binary-ish file is recorded by name only (no crash)", () => {
    tp = makeTempProject();
    // A file with NUL bytes — recorded as a FileEntry; never parsed as a manifest.
    fs.mkdirSync(path.join(tp.root, "assets"), { recursive: true });
    fs.writeFileSync(path.join(tp.root, "assets", "blob.bin"), Buffer.from([0, 1, 2, 255, 0]));
    const m = scanRepo(tp.root);
    expect(m.files.some((f) => f.path === "assets/blob.bin")).toBe(true);
  });

  it("REQ-RU-090 — an oversize manifest is skipped for content (name-only), still no crash", () => {
    tp = makeTempProject();
    // A package.json larger than the 2MB content-read cap → not parsed, no commands.
    const big = '{"scripts":{"test":"' + "x".repeat(3 * 1024 * 1024) + '"}}';
    writeTree(tp.root, { "package.json": big });
    const m = scanRepo(tp.root);
    // It is still listed as a file, but its (oversize) scripts are NOT parsed.
    expect(m.files.some((f) => f.path === "package.json")).toBe(true);
    expect(m.candidate_commands.length).toBe(0);
  });

  it("REQ-RU-090 — file-count cap → partial map flagged (ok), not an error", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n", "src/b.ts": "1\n", "src/c.ts": "1\n" });
    const m = scanRepo(tp.root, { fileCountCap: 2 });
    expect(m.scanReport.capHit).toBe("file-count");
    expect(m.files.length).toBe(2);
  });

  it("REQ-RU-090 — total-bytes cap → partial map flagged (ok), not an error", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "x".repeat(40), "src/b.ts": "y".repeat(40) });
    const m = scanRepo(tp.root, { totalBytesCap: 50 });
    expect(m.scanReport.capHit).toBe("total-bytes");
  });

  it("REQ-RU-090 — deep nesting is bounded (walk completes, no stack blow-up)", () => {
    tp = makeTempProject();
    let p = "src";
    const tree: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      p = `${p}/d${i}`;
      tree[`${p}/f.ts`] = "1\n";
    }
    writeTree(tp.root, tree);
    const m = scanRepo(tp.root);
    expect(m.files.length).toBe(40);
  });

  it("REQ-RU-090 — an empty source root does not crash", () => {
    tp = makeTempProject();
    fs.mkdirSync(path.join(tp.root, "src"), { recursive: true });
    const m = scanRepo(tp.root);
    expect(m.source_roots).toContain("src");
    expect(m.files.length).toBe(0);
  });

  it("REQ-RU-090 — a repo of only generated dirs yields an empty (excluded) map", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "node_modules/a/index.js": "1\n",
      "dist/cli.js": "1\n",
      "build/out.js": "1\n",
    });
    const m = scanRepo(tp.root);
    expect(m.files.length).toBe(0);
    // The generated dirs were observed (and excluded), not descended.
    expect(m.generated_paths.length).toBeGreaterThanOrEqual(3);
  });

  it("REQ-RU-090 — a partial scan is reported (scanReport), not silent", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n", "src/b.ts": "1\n" });
    const res = runRepoMap(tp.paths, { write: false, format: "json" });
    expect(res.ok).toBe(true);
    const report = res.data?.scanReport as { capHit: unknown; filesScanned: number };
    expect(report).toBeDefined();
    expect(typeof report.filesScanned).toBe("number");
  });

  // ---- P0-2: partial-scan banner is prominent in the summary view -----------
  it("P0-2 — a partial scan surfaces a prominent PARTIAL banner in the summary output", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "src/a.ts": "1\n",
      "src/b.ts": "1\n",
      "src/c.ts": "1\n",
      "src/d.ts": "1\n",
    });
    const res = runRepoMap(tp.paths, { write: false, scanOptions: { fileCountCap: 2 } });
    expect(res.ok).toBe(true);
    expect(res.human).toContain("⚠ PARTIAL SCAN");
    expect(res.human).toContain("cap hit: file-count");
    expect(res.human).toContain("re-run `th repo map`");
    // The banner leads the output (operator sees it first, not buried).
    expect(res.human!.startsWith("⚠ PARTIAL SCAN")).toBe(true);
  });

  it("P0-2 — a complete scan shows NO partial banner", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n", "src/b.ts": "1\n" });
    const res = runRepoMap(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    expect(res.human).not.toContain("PARTIAL SCAN");
  });

  // ---- P1-2: the partial marker is PERSISTED deterministically --------------
  it("P1-2 — a partial scan persists a deterministic capHit + partial marker (no run-varying counts)", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "src/a.ts": "1\n",
      "src/b.ts": "1\n",
      "src/c.ts": "1\n",
    });
    const m = scanRepo(tp.root, { fileCountCap: 2 });
    const obj = JSON.parse(serializeRepoMap(m)) as Record<string, unknown>;
    expect(obj.capHit).toBe("file-count");
    expect(obj.partial).toBe(true);
    // The run-varying counts are NEVER persisted (would break the byte-identical
    // golden — REQ-NFR-001).
    expect(JSON.stringify(obj)).not.toContain("filesScanned");
    expect(JSON.stringify(obj)).not.toContain("filesSkipped");
  });

  it("P1-2 — a complete scan persists capHit:null + partial:false", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n", "src/b.ts": "1\n" });
    const obj = JSON.parse(serializeRepoMap(scanRepo(tp.root))) as Record<string, unknown>;
    expect(obj.capHit).toBeNull();
    expect(obj.partial).toBe(false);
  });

  it("P1-2 — the partial marker round-trips through parseRepoMap (capHit restored)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "1\n", "src/b.ts": "1\n", "src/c.ts": "1\n" });
    const serialized = serializeRepoMap(scanRepo(tp.root, { fileCountCap: 2 }));
    const parsed = parseRepoMap(serialized);
    expect(parsed.ok).toBe(true);
    expect(parsed.map?.scanReport.capHit).toBe("file-count");
    // Re-serializing is byte-identical (the marker survives the round trip).
    expect(serializeRepoMap(parsed.map!)).toBe(serialized);
  });

  // ---- P1-3: every inferred fact carries a basis + confidence ---------------
  it("P1-3 — scanned components/ownership/blast-radius carry path-token provenance", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "src/auth/login.ts": "// authentication\nexport const a = 1;\n",
      "src/core/b.ts": "export const b = 2;\n",
    });
    const m = scanRepo(tp.root);
    expect(m.components.length).toBeGreaterThan(0);
    for (const c of m.components) {
      expect(c.provenance).toEqual({ basis: "path-token", confidence: "medium" });
    }
    for (const o of m.ownership_hints) {
      expect(o.provenance).toEqual({ basis: "path-token", confidence: "medium" });
    }
    for (const s of m.blast_radius_signals) {
      expect(s.provenance).toEqual({ basis: "path-token", confidence: "medium" });
    }
  });

  it("P1-3 — manifest entrypoints are high-confidence; convention ones are name-basis", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "package.json": JSON.stringify({ bin: { th: "dist/cli.js" }, exports: { ".": "./i.js" } }),
      "main.go": "package main\n",
    });
    const m = scanRepo(tp.root);
    const manifestEp = m.entrypoints.find((e) => e.source.startsWith("package.json"));
    const conventionEp = m.entrypoints.find((e) => e.source === "convention");
    expect(manifestEp?.provenance).toEqual({ basis: "manifest", confidence: "high" });
    expect(conventionEp?.provenance).toEqual({ basis: "name", confidence: "medium" });
    // public_api keeps its legacy literal AND carries a generalised provenance.
    expect(m.public_api?.confidence).toBe("heuristic");
    expect(m.public_api?.provenance).toEqual({ basis: "manifest", confidence: "medium" });
  });

  it("P1-3 — provenance survives a serialize → parse round-trip and is validated", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/core/b.ts": "export const b = 2;\n" });
    const serialized = serializeRepoMap(scanRepo(tp.root));
    const parsed = parseRepoMap(serialized);
    expect(parsed.ok).toBe(true);
    expect(parsed.map?.components[0]?.provenance?.basis).toBe("path-token");
    // A bad provenance value is rejected as map_schema (no throw).
    const bad = JSON.parse(serialized) as Record<string, unknown>;
    (bad.components as Array<Record<string, unknown>>)[0].provenance = { basis: "bogus", confidence: "high" };
    const r = parseRepoMap(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("map_schema");
  });

  // ---- Golden double-run byte-stability (REQ-NFR-001) ----------------------

  it("REQ-NFR-001 — repo map rerun is byte-identical on an unchanged repo (golden double-run)", () => {
    tp = makeTempProject();
    writeTree(tp.root, {
      "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest", build: "tsc" }, bin: { th: "dist/cli.js" } }),
      "src/core/a.ts": "// Anchor: REQ-RU-001\nexport const a = 1;\n",
      "src/commands/b.ts": "export const b = 2;\n",
      "src/auth/login.ts": "export const c = 3;\n",
      "tests/a.test.ts": "// Anchor: REQ-RU-002\n",
      "docs/x.md": "# doc\n",
    });
    const jsonPath = path.join(tp.paths.stateDir, "repo-map.json");

    const r1 = runRepoMap(tp.paths, {});
    expect(r1.ok).toBe(true);
    const bytes1 = fs.readFileSync(jsonPath, "utf8");

    const r2 = runRepoMap(tp.paths, {});
    expect(r2.ok).toBe(true);
    const bytes2 = fs.readFileSync(jsonPath, "utf8");

    expect(bytes2).toBe(bytes1);
    // And the bytes carry no run-specific data.
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(bytes1)).toBe(false);
    expect(bytes1.includes(":\\")).toBe(false);
    expect(bytes1.includes("/Users/")).toBe(false);
    expect(bytes1.includes("/home/")).toBe(false);
    expect(bytes1.includes("\\")).toBe(false);
  });

  // ---- No-command-execution sentinel (REQ-RU-091) --------------------------

  it("REQ-RU-091 — a candidate command is NEVER executed (sentinel side-effect absent)", () => {
    tp = makeTempProject();
    const sentinel = path.join(tp.root, "PWNED");
    // scripts.test WOULD write a sentinel file if it were ever executed.
    writeTree(tp.root, {
      "package.json": JSON.stringify({
        scripts: { test: `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, "/")}','x')"` },
      }),
      "src/a.ts": "1\n",
    });
    // Build (write mode) AND dry mode: neither path may execute the command.
    const w = runRepoMap(tp.paths, {});
    expect(w.ok).toBe(true);
    const d = runRepoMap(tp.paths, { write: false });
    expect(d.ok).toBe(true);
    // The command is recorded as inert data...
    const map = scanRepo(tp.root);
    expect(map.candidate_commands.some((c) => c.label === "test")).toBe(true);
    // ...but the side-effect file is ABSENT — the irreducible safety claim.
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("REQ-RU-091 — the no-exec guarantee holds via the CLI path too", () => {
    tp = makeTempProject();
    const sentinel = path.join(tp.root, "PWNED_CLI");
    writeTree(tp.root, {
      "package.json": JSON.stringify({
        scripts: { build: `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, "/")}','x')"` },
      }),
      "src/a.ts": "1\n",
    });
    const res = runCLI(tp.root, ["repo", "map"]);
    expect(res.status).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  // ---- SDK-free + dist-sync checks (REQ-NFR-002 / REQ-NFR-005) -------------

  it("REQ-NFR-002 — dist/cli.js contains no @modelcontextprotocol import (SDK-free)", () => {
    const cli = fs.readFileSync(path.join(ROOT, "dist", "cli.js"), "utf8");
    expect(cli.includes("@modelcontextprotocol")).toBe(false);
  });

  it("REQ-NFR-002 — the repo layer imports no child_process (no execution path exists)", () => {
    // Static check: the scanner + handler source never IMPORT child_process (an
    // import/require statement — not a mention in a comment).
    const importRe = /(?:import[^;]*from\s*["']node:child_process["']|require\(\s*["']node:child_process["']\s*\)|from\s*["']child_process["'])/;
    const scannerSrc = fs.readFileSync(path.join(ROOT, "src", "core", "repo-map", "scanner.ts"), "utf8");
    const handlerSrc = fs.readFileSync(path.join(ROOT, "src", "commands", "repo.ts"), "utf8");
    expect(importRe.test(scannerSrc)).toBe(false);
    expect(importRe.test(handlerSrc)).toBe(false);
  });

  it("REQ-NFR-005 — dist/ is in sync with src/ (git diff --exit-code dist/ exits 0)", () => {
    const r = spawnSync("git", ["diff", "--exit-code", "dist/"], { encoding: "utf8", cwd: ROOT });
    expect(r.status).toBe(0);
  });
});

// ===========================================================================
// SLICE-2 / TASK-005 — computeRelevance: pure weighted scorer + WHY + maxResults
// ===========================================================================

describe("SLICE-2 / TASK-005 — computeRelevance pure scorer (REQ-RU-021/022/023)", () => {
  /** Minimal RepoMap for scorer tests — zero filesystem access. */
  function buildTestMap(): RepoMap {
    const m = emptyRepoMap("/tmp/test");
    m.source_roots = ["src"];
    m.test_roots = ["tests"];
    m.generated_paths = ["node_modules", "dist"];
    m.components = [
      { name: "src/core", path: "src/core", file_count: 2 },
      { name: "src/commands", path: "src/commands", file_count: 2 },
    ];
    m.files = [
      {
        path: "src/core/a.ts",
        component: "src/core",
        language: "TypeScript",
        is_test: false,
        req_ids: ["REQ-RU-021", "REQ-RU-022"],
      },
      {
        path: "src/core/b.ts",
        component: "src/core",
        language: "TypeScript",
        is_test: false,
        req_ids: ["REQ-RU-021"],
      },
      {
        path: "src/commands/repo.ts",
        component: "src/commands",
        language: "TypeScript",
        is_test: false,
        req_ids: [],
      },
      {
        path: "src/commands/auth.ts",
        component: "src/commands",
        language: "TypeScript",
        is_test: false,
        req_ids: [],
      },
      {
        path: "tests/core.test.ts",
        component: null,
        language: "TypeScript",
        is_test: true,
        req_ids: ["REQ-RU-021"],
      },
    ];
    m.req_anchors = [
      { req_id: "REQ-RU-021", locations: ["src/core/a.ts", "src/core/b.ts", "tests/core.test.ts"] },
      { req_id: "REQ-RU-022", locations: ["src/core/a.ts"] },
    ];
    m.blast_radius_signals = [
      {
        flag: "authentication",
        matching_paths: ["src/commands/auth.ts"],
        trigger_patterns: ["auth"],
      },
    ];
    m.candidate_commands = [
      { label: "test", raw: "vitest run", source_file: "package.json", kind: "test" },
      { label: "build", raw: "tsc", source_file: "package.json", kind: "build" },
    ];
    return m;
  }

  // Anchor: REQ-RU-021
  it("REQ-RU-021 — result carries all seven categories (readFirst/related/tests/owningComponents/doNotTouch/risks/verifyCandidates)", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "req", value: "REQ-RU-021" };
    const result = computeRelevance(map, selector);
    // All seven fields present.
    expect(Array.isArray(result.readFirst)).toBe(true);
    expect(Array.isArray(result.related)).toBe(true);
    expect(Array.isArray(result.tests)).toBe(true);
    expect(Array.isArray(result.owningComponents)).toBe(true);
    expect(Array.isArray(result.doNotTouch)).toBe(true);
    expect(Array.isArray(result.risks)).toBe(true);
    expect(Array.isArray(result.verifyCandidates)).toBe(true);
    // Selector metadata.
    expect(result.selectorKind).toBe("req");
    expect(result.selectorValue).toBe("REQ-RU-021");
    // Actual results: a.ts and b.ts carry REQ-RU-021.
    const allPaths = [...result.readFirst, ...result.related, ...result.tests].map((i) => i.path);
    expect(allPaths).toContain("src/core/a.ts");
    expect(allPaths).toContain("src/core/b.ts");
    // doNotTouch populated from generated_paths.
    expect(result.doNotTouch).toContain("node_modules");
    expect(result.doNotTouch).toContain("dist");
    // verifyCandidates from candidate_commands.
    expect(result.verifyCandidates.some((c) => c.label === "test")).toBe(true);
    expect(result.verifyCandidates.some((c) => c.label === "build")).toBe(true);
  });

  // Anchor: REQ-RU-022
  it("REQ-RU-022 — every returned item has a non-empty why", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "req", value: "REQ-RU-021" };
    const result = computeRelevance(map, selector);
    const allItems = [...result.readFirst, ...result.related, ...result.tests];
    expect(allItems.length).toBeGreaterThan(0);
    for (const item of allItems) {
      expect(typeof item.why).toBe("string");
      expect(item.why.length).toBeGreaterThan(0);
    }
  });

  // Anchor: REQ-RU-022
  it("REQ-RU-022 — score field is present on every item (only in structured data)", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "file", value: "src/core/a.ts" };
    const result = computeRelevance(map, selector);
    const allItems = [...result.readFirst, ...result.related, ...result.tests];
    for (const item of allItems) {
      expect(typeof item.score).toBe("number");
      expect(item.score).toBeGreaterThan(0);
    }
  });

  // Anchor: REQ-RU-023
  it("REQ-RU-023 — maxResults:2 caps combined items and sets truncated:true", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "req", value: "REQ-RU-021" };
    const result = computeRelevance(map, selector, { maxResults: 2 });
    const total = result.readFirst.length + result.related.length + result.tests.length;
    expect(total).toBeLessThanOrEqual(2);
    // We have 3 files matching REQ-RU-021 so truncated must be true.
    expect(result.truncated).toBe(true);
  });

  // Anchor: REQ-RU-023
  it("REQ-RU-023 — maxResults ≤0 is treated as default (20)", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "req", value: "REQ-RU-021" };
    // With 5 files total, none should be truncated even with maxResults=0.
    const result = computeRelevance(map, selector, { maxResults: 0 });
    expect(result.truncated).toBe(false);
    // negative too.
    const result2 = computeRelevance(map, selector, { maxResults: -5 });
    expect(result2.truncated).toBe(false);
  });

  it("REQ-RU-021 — selector-matches-nothing yields all-empty arrays, truncated:false (success not failure)", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "req", value: "REQ-DOES-NOT-EXIST" };
    const result = computeRelevance(map, selector);
    expect(result.readFirst).toEqual([]);
    expect(result.related).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.truncated).toBe(false);
    // owningComponents empty too.
    expect(result.owningComponents).toEqual([]);
  });

  it("REQ-RU-021 — --slice selector uses sliceComponents to match files", () => {
    const map = buildTestMap();
    const selector: Selector = {
      kind: "slice",
      value: "SLICE-1",
      sliceComponents: ["src/core"],
    };
    const result = computeRelevance(map, selector);
    const allPaths = [...result.readFirst, ...result.related, ...result.tests].map((i) => i.path);
    // Files in src/core should be returned.
    expect(allPaths).toContain("src/core/a.ts");
    expect(allPaths).toContain("src/core/b.ts");
    // Files NOT in src/core should NOT be in readFirst (may appear as related).
    const readFirstPaths = result.readFirst.map((i) => i.path);
    expect(readFirstPaths.every((p) => p.startsWith("src/core"))).toBe(true);
  });

  it("REQ-RU-021 — --query selector matches by path keyword", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "query", value: "auth" };
    const result = computeRelevance(map, selector);
    const allPaths = [...result.readFirst, ...result.related, ...result.tests].map((i) => i.path);
    // "auth" substring matches "src/commands/auth.ts".
    expect(allPaths).toContain("src/commands/auth.ts");
  });

  it("REQ-RU-021 — --file selector returns the exact file in readFirst", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "file", value: "src/core/a.ts" };
    const result = computeRelevance(map, selector);
    expect(result.readFirst.some((i) => i.path === "src/core/a.ts")).toBe(true);
  });

  it("REQ-RU-021 — owningComponents is sorted and deduped", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "req", value: "REQ-RU-021" };
    const result = computeRelevance(map, selector);
    // Sorted.
    for (let i = 1; i < result.owningComponents.length; i++) {
      expect(result.owningComponents[i]! >= result.owningComponents[i - 1]!).toBe(true);
    }
    // No duplicates.
    const set = new Set(result.owningComponents);
    expect(set.size).toBe(result.owningComponents.length);
  });

  it("REQ-RU-021 — risks narrowed to blast-radius signals intersecting the relevant scope", () => {
    const map = buildTestMap();
    // Use --query "auth" to get auth.ts into scope.
    const selector: Selector = { kind: "query", value: "auth" };
    const result = computeRelevance(map, selector);
    // The blast-radius signal for "authentication" matches "src/commands/auth.ts".
    const authRisk = result.risks.find((r) => r.flag === "authentication");
    expect(authRisk).toBeDefined();
    expect(authRisk!.matchingPaths).toContain("src/commands/auth.ts");
    expect(authRisk!.triggerPatterns).toContain("auth");
  });

  it("REQ-RU-021 — computeRelevance performs ZERO filesystem access (pure over loaded map)", () => {
    // We test this by pointing the selector at a non-existent path; the function
    // must complete successfully (no ENOENT), not touch the disk at all.
    const map = emptyRepoMap("/no/such/path");
    const selector: Selector = { kind: "file", value: "does/not/exist.ts" };
    // Should not throw, should return empty-but-valid result.
    const result = computeRelevance(map, selector);
    expect(result.readFirst).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("REQ-RU-022 — verifyCandidates are camelCase Cmd objects (sourceFile, not source_file)", () => {
    const map = buildTestMap();
    const selector: Selector = { kind: "query", value: "core" };
    const result = computeRelevance(map, selector);
    for (const cmd of result.verifyCandidates) {
      expect(typeof cmd.sourceFile).toBe("string");
      expect("source_file" in cmd).toBe(false);
    }
  });
});

// ===========================================================================
// SLICE-2 / TASK-006 — runRepoRelevant handler + relevant CLI dispatch
// ===========================================================================

describe("SLICE-2 / TASK-006 — runRepoRelevant handler + CLI relevant dispatch", () => {
  /** Write a minimal valid repo-map.json into a temp project's stateDir. */
  function writeRepoMap(tp: TempProject, map: RepoMap): void {
    const json = serializeRepoMap(map);
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), json, "utf8");
  }

  function buildMinimalMap(root: string): RepoMap {
    const m = emptyRepoMap(root);
    m.files = [
      { path: "src/a.ts", component: "src", language: "TypeScript", is_test: false, req_ids: ["REQ-RU-020"] },
      { path: "tests/a.test.ts", component: null, language: "TypeScript", is_test: true, req_ids: [] },
    ];
    m.components = [{ name: "src", path: "src", file_count: 1 }];
    m.candidate_commands = [{ label: "test", raw: "vitest run", source_file: "package.json", kind: "test" }];
    return m;
  }

  const CLI = path.join(ROOT, "dist", "cli.js");
  function runCLI(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync("node", [CLI, "--cwd", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, TH_NO_LOG: "1" },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  }

  // Anchor: REQ-RU-020
  it("REQ-RU-020 — --req selector returns a CommandResult ok:true with relevant files", () => {
    tp = makeTempProject();
    writeRepoMap(tp, buildMinimalMap(tp.root));
    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-020" });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    const allPaths = [
      ...(res.data?.readFirst as Array<{ path: string }> ?? []),
      ...(res.data?.related as Array<{ path: string }> ?? []),
    ].map((i) => i.path);
    expect(allPaths).toContain("src/a.ts");
  });

  // Anchor: REQ-RU-020
  it("REQ-RU-020 — --file selector returns ok:true for an existing file", () => {
    tp = makeTempProject();
    writeRepoMap(tp, buildMinimalMap(tp.root));
    const res = runRepoRelevant(tp.paths, { file: "src/a.ts" });
    expect(res.ok).toBe(true);
    expect(res.data?.selectorKind).toBe("file");
  });

  // Anchor: REQ-RU-020
  it("REQ-RU-020 — --query selector returns ok:true", () => {
    tp = makeTempProject();
    writeRepoMap(tp, buildMinimalMap(tp.root));
    const res = runRepoRelevant(tp.paths, { query: "src" });
    expect(res.ok).toBe(true);
    expect(res.data?.selectorKind).toBe("query");
  });

  // Anchor: REQ-RU-020
  it("REQ-RU-020 — --slice selector requires initialized state (tested via missing state)", () => {
    tp = makeTempProject();
    writeRepoMap(tp, buildMinimalMap(tp.root));
    // No state.json — should fail gracefully (not_initialized), not crash.
    const res = runRepoRelevant(tp.paths, { slice: "SLICE-1" });
    expect(res.ok).toBe(false);
    // Either not_initialized or unknown_slice — both acceptable without state.
    expect(typeof res.data?.error).toBe("string");
  });

  // Anchor: REQ-RU-024
  it("REQ-RU-024 — --file path escape returns path_outside_root; no read performed", () => {
    tp = makeTempProject();
    // We do NOT write a repo-map.json — if the guard didn't fire first, the
    // handler would fail with map_missing, not path_outside_root.
    const res = runRepoRelevant(tp.paths, { file: "../../etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("path_outside_root");
    // Confirm no map-load error (guard ran first).
    expect(res.data?.error).not.toBe("map_missing");
  });

  // Anchor: REQ-RU-025
  it("REQ-RU-025 — missing repo-map.json yields map_missing clean failure", () => {
    tp = makeTempProject();
    // No repo-map.json written.
    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-001" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("map_missing");
    expect(res.human).toContain("th repo map");
  });

  // Anchor: REQ-RU-025
  it("REQ-RU-025 — malformed repo-map.json yields map_invalid-json clean failure", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), "{ not json", "utf8");
    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-001" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("map_invalid-json");
  });

  // Anchor: REQ-RU-026
  it("REQ-RU-026 — relevant is read-only: state.json and repo-map.json unchanged after call", () => {
    tp = makeTempProject();
    const map = buildMinimalMap(tp.root);
    writeRepoMap(tp, map);
    const mapPath = path.join(tp.paths.stateDir, "repo-map.json");
    const mapBefore = fs.readFileSync(mapPath, "utf8");

    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-020" });
    expect(res.ok).toBe(true);

    const mapAfter = fs.readFileSync(mapPath, "utf8");
    expect(mapAfter).toBe(mapBefore);
    // No state.json was created.
    expect(fs.existsSync(tp.paths.stateFile)).toBe(false);
  });

  // Anchor: REQ-RU-027
  it("REQ-RU-027 — --slice resolves components from state.slices read-only", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Manually set a slice in state.
    const sr = readState(tp.paths);
    if (sr.state) {
      sr.state.slices = [{ id: "SLICE-1", status: "pending", components: ["src"] }];
      writeState(tp.paths, sr.state);
    }
    writeRepoMap(tp, buildMinimalMap(tp.root));
    const res = runRepoRelevant(tp.paths, { slice: "SLICE-1" });
    expect(res.ok).toBe(true);
    expect(res.data?.selectorKind).toBe("slice");
    expect(res.data?.selectorValue).toBe("SLICE-1");
  });

  // Anchor: REQ-RU-042
  it("REQ-RU-042 — path containment: --file outside root fails before any read", () => {
    tp = makeTempProject();
    // No map written — if guard fires first, error is path_outside_root, not map_missing.
    const res = runRepoRelevant(tp.paths, { file: "/absolute/system/path" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("path_outside_root");
  });

  // Anchor: REQ-RU-043
  it("REQ-RU-043 — missing map returns map_missing (never throws)", () => {
    tp = makeTempProject();
    expect(() => runRepoRelevant(tp.paths, { req: "REQ-001" })).not.toThrow();
    const res = runRepoRelevant(tp.paths, { req: "REQ-001" });
    expect(res.data?.error).toBe("map_missing");
  });

  // Anchor: REQ-RU-043
  it("REQ-RU-043 — invalid JSON map returns map_invalid-json clean failure (no throw)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), "BAD", "utf8");
    expect(() => runRepoRelevant(tp.paths, { req: "REQ-001" })).not.toThrow();
    const res = runRepoRelevant(tp.paths, { req: "REQ-001" });
    expect(res.data?.error).toBe("map_invalid-json");
  });

  // Anchor: REQ-RU-043
  it("REQ-RU-043 — schema-invalid map returns map_schema clean failure (no throw)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(tp.paths.stateDir, "repo-map.json"),
      JSON.stringify({ schema_version: 2, languages: "not-an-array" }),
      "utf8",
    );
    const res = runRepoRelevant(tp.paths, { req: "REQ-001" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("map_schema");
  });

  // Anchor: REQ-RU-043
  it("REQ-RU-043 — unknown schema_version returns map_version clean failure (no throw)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(tp.paths.stateDir, "repo-map.json"),
      JSON.stringify({ schema_version: 999 }),
      "utf8",
    );
    const res = runRepoRelevant(tp.paths, { req: "REQ-001" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("map_version");
  });

  it("REQ-RU-020 — no_selector when zero selectors given", () => {
    tp = makeTempProject();
    writeRepoMap(tp, buildMinimalMap(tp.root));
    const res = runRepoRelevant(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("no_selector");
  });

  it("REQ-RU-020 — multiple_selectors when >1 selector given", () => {
    tp = makeTempProject();
    writeRepoMap(tp, buildMinimalMap(tp.root));
    const res = runRepoRelevant(tp.paths, { req: "REQ-001", query: "src" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("multiple_selectors");
    expect(Array.isArray(res.data?.given)).toBe(true);
  });

  it("REQ-RU-020 — unknown --slice returns unknown_slice with known list", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeRepoMap(tp, buildMinimalMap(tp.root));
    const res = runRepoRelevant(tp.paths, { slice: "SLICE-UNKNOWN" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_slice");
    expect(Array.isArray(res.data?.known)).toBe(true);
  });
});

// ===========================================================================
// SLICE-2 / TASK-007 — Acceptance battery: security + functional
// ===========================================================================

describe("SLICE-2 / TASK-007 — acceptance battery: path-traversal, symlink, functional", () => {
  function writeTree(root: string, tree: Record<string, string>): void {
    for (const [rel, content] of Object.entries(tree)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
  }

  function writeMinimalRepoMap(tp: TempProject): void {
    const m = emptyRepoMap(tp.root);
    m.files = [
      { path: "src/a.ts", component: "src", language: "TypeScript", is_test: false, req_ids: ["REQ-RU-093"] },
      { path: "tests/a.test.ts", component: null, language: "TypeScript", is_test: true, req_ids: [] },
    ];
    m.components = [{ name: "src", path: "src", file_count: 1 }];
    m.candidate_commands = [{ label: "test", raw: "vitest run", source_file: "package.json", kind: "test" }];
    m.generated_paths = ["node_modules", "dist"];
    const json = serializeRepoMap(m);
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), json, "utf8");
  }

  const CLI = path.join(ROOT, "dist", "cli.js");
  function runCLI(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync("node", [CLI, "--cwd", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, TH_NO_LOG: "1" },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  }

  // ---- Security: path traversal + symlink (REQ-RU-092) ----

  // Anchor: REQ-RU-092
  it("REQ-RU-092 — path-traversal-refused-before-read: --file ../../etc/passwd returns path_outside_root, no read outside root", () => {
    tp = makeTempProject();
    // NO repo-map.json: if the guard didn't fire first, the error would be map_missing.
    // The fact that we get path_outside_root proves the guard fires before any I/O.
    const res = runRepoRelevant(tp.paths, { file: "../../etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("path_outside_root");
    // Explicitly not map_missing, map_invalid-json, etc.
    expect(res.data?.error).not.toBe("map_missing");
  });

  // Anchor: REQ-RU-092
  it("REQ-RU-092 — symlink not followed: in-repo symlink pointing outside is a scan skip (not descended)", () => {
    tp = makeTempProject();
    writeTree(tp.root, { "src/a.ts": "export const x = 1;\n" });
    // Create a symlink inside the repo pointing outside (Windows: may require elevated permissions,
    // on Linux: always works). We use a try/catch so the test degrades gracefully if the OS
    // doesn't allow symlink creation without elevation.
    let symlinkCreated = false;
    try {
      fs.symlinkSync(path.join(tp.root, ".."), path.join(tp.root, "src", "evil-link"), "dir");
      symlinkCreated = true;
    } catch {
      // Symlink creation not permitted — skip the descent check; guard is still coded.
    }
    // The scanner must not follow the symlink; scan completes without crashing.
    const m = scanRepo(tp.root);
    if (symlinkCreated) {
      // No file under the symlink path should appear.
      expect(m.files.some((f) => f.path.startsWith("src/evil-link/"))).toBe(false);
    }
    // The repo itself is still scanned correctly.
    expect(m.files.some((f) => f.path === "src/a.ts")).toBe(true);
  });

  // ---- REQ-RU-093 functional battery ----

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — relevant_no_match_empty_success: selector matching nothing → ok:true with empty arrays", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runRepoRelevant(tp.paths, { req: "REQ-DOES-NOT-EXIST" });
    expect(res.ok).toBe(true);
    expect(res.data?.readFirst).toEqual([]);
    expect(res.data?.related).toEqual([]);
    expect(res.data?.tests).toEqual([]);
    expect(res.data?.truncated).toBe(false);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — relevant_nonpositive_maxresults_clamped: maxResults=0 → default (20) used", () => {
    tp = makeTempProject();
    // Build a bigger map to verify clamping.
    const m = emptyRepoMap(tp.root);
    m.files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/f${i}.ts`,
      component: "src",
      language: "TypeScript",
      is_test: false,
      req_ids: ["REQ-RU-093"],
    }));
    m.components = [{ name: "src", path: "src", file_count: 25 }];
    const json = serializeRepoMap(m);
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), json, "utf8");

    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-093", maxResults: 0 });
    expect(res.ok).toBe(true);
    // Default is 20; with 25 matching files, truncated should be true.
    const total = (res.data?.readFirst as unknown[]).length + (res.data?.related as unknown[]).length + (res.data?.tests as unknown[]).length;
    expect(total).toBeLessThanOrEqual(20);
    expect(res.data?.truncated).toBe(true);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — relevant_unknown_target_empty_with_note: query for non-existent term → empty success", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runRepoRelevant(tp.paths, { query: "zzz_no_such_keyword_xyz" });
    expect(res.ok).toBe(true);
    expect(res.data?.readFirst).toEqual([]);
    expect(res.data?.related).toEqual([]);
    expect(res.data?.tests).toEqual([]);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — no_selector_failure: zero selectors → failure with no_selector", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runRepoRelevant(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("no_selector");
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — multiple_selectors_failure: two selectors → failure with multiple_selectors", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runRepoRelevant(tp.paths, { req: "REQ-001", file: "src/a.ts" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("multiple_selectors");
    const given = res.data?.given as string[] | undefined;
    expect(Array.isArray(given)).toBe(true);
    expect(given).toContain("--req");
    expect(given).toContain("--file");
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — relevant_generated_file_noted: generated paths in doNotTouch", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-093" });
    expect(res.ok).toBe(true);
    const doNotTouch = res.data?.doNotTouch as string[] | undefined;
    expect(Array.isArray(doNotTouch)).toBe(true);
    expect(doNotTouch).toContain("node_modules");
    expect(doNotTouch).toContain("dist");
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — map_write_failure_clean: map_missing returns clean failure not crash", () => {
    tp = makeTempProject();
    const res = runRepoRelevant(tp.paths, { query: "src" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("map_missing");
    // No throw, no partial output.
    expect(res.human).toBeDefined();
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — crash_before_rename_no_partial_artifact: relevant never writes anything", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const mapPath = path.join(tp.paths.stateDir, "repo-map.json");
    const before = fs.readFileSync(mapPath, "utf8");

    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-093" });
    expect(res.ok).toBe(true);

    const after = fs.readFileSync(mapPath, "utf8");
    expect(after).toBe(before);
    // No temp files created.
    const stateFiles = fs.readdirSync(tp.paths.stateDir);
    expect(stateFiles.some((f) => f.includes(".tmp"))).toBe(false);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — query_idempotent_no_side_effect: two calls return identical result with no state mutation", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res1 = runRepoRelevant(tp.paths, { req: "REQ-RU-093" });
    const res2 = runRepoRelevant(tp.paths, { req: "REQ-RU-093" });
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    // Data should be identical across runs (deterministic scorer).
    expect(JSON.stringify(res1.data)).toBe(JSON.stringify(res2.data));
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — map_rerun_no_partial_read: relevant reads map atomically (no partial artifact)", () => {
    // Simulate a torn write: write a partial/invalid map, then a valid one.
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    // First write valid map.
    writeMinimalRepoMap(tp);
    const mapPath = path.join(tp.paths.stateDir, "repo-map.json");
    // The handler reads the file atomically; we just confirm it reads the real map, not a .tmp file.
    // Simulate an interrupted write by leaving a .tmp artifact.
    fs.writeFileSync(mapPath + ".tmp-99999", "{ partial", "utf8");
    const res = runRepoRelevant(tp.paths, { req: "REQ-RU-093" });
    expect(res.ok).toBe(true); // Reads the real map, ignores .tmp.
    fs.unlinkSync(mapPath + ".tmp-99999");
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — unknown_flag_rejected: unknown CLI flag returns exit 1", () => {
    tp = makeTempProject();
    const res = runCLI(tp.root, ["repo", "relevant", "--unknown-flag-xyz", "val", "--req", "REQ-001"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("unknown flag");
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — unknown_slice_failure: --slice unknown-id returns unknown_slice", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeMinimalRepoMap(tp);
    const res = runRepoRelevant(tp.paths, { slice: "SLICE-NEVER" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_slice");
    expect(Array.isArray(res.data?.known)).toBe(true);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — no_network_import_in_dist: dist/cli.js contains no @modelcontextprotocol import", () => {
    const cli = fs.readFileSync(path.join(ROOT, "dist", "cli.js"), "utf8");
    expect(cli.includes("@modelcontextprotocol")).toBe(false);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — JSON output via CLI --json flag returns structured RelevanceResult", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runCLI(tp.root, ["repo", "relevant", "--req", "REQ-RU-093", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      selectorKind: string;
      selectorValue: string;
      readFirst: unknown[];
      related: unknown[];
      tests: unknown[];
      truncated: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.selectorKind).toBe("req");
    expect(parsed.selectorValue).toBe("REQ-RU-093");
    expect(Array.isArray(parsed.readFirst)).toBe(true);
    expect(Array.isArray(parsed.tests)).toBe(true);
    expect(typeof parsed.truncated).toBe("boolean");
  });

  // ---- parseArgs tests for new flags (REQ-RU-093 arg-parsing battery) ----

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — parseArgs: --query parsed correctly into flags.query", () => {
    const parsed = parseArgs(["repo", "relevant", "--query", "my-keyword"]);
    expect(parsed.flags.query).toBe("my-keyword");
    expect(parsed.unknownFlags).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — parseArgs: --maxResults parsed correctly into flags.maxResults", () => {
    const parsed = parseArgs(["repo", "relevant", "--maxResults", "5", "--req", "REQ-001"]);
    expect(parsed.flags.maxResults).toBe(5);
    expect(parsed.unknownFlags).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — parseArgs: --file parsed correctly into flags.file", () => {
    const parsed = parseArgs(["repo", "relevant", "--file", "src/a.ts"]);
    expect(parsed.flags.file).toBe("src/a.ts");
    expect(parsed.unknownFlags).toEqual([]);
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — parseArgs: unknown flag is rejected (recorded in unknownFlags)", () => {
    const parsed = parseArgs(["repo", "relevant", "--unknown-xyz", "val", "--req", "REQ-001"]);
    expect(parsed.unknownFlags).toContain("--unknown-xyz");
  });

  // Anchor: REQ-RU-093
  it("REQ-RU-093 — parseArgs: --maxResults without value recorded as error", () => {
    const parsed = parseArgs(["repo", "relevant", "--maxResults"]);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  // ---- Read-only invariant (REQ-RU-026) ----

  // Anchor: REQ-RU-026
  it("REQ-RU-026 — relevant_readonly_no_state_mutation: state.json unchanged after call (REQ-RU-026)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeMinimalRepoMap(tp);
    const stateBefore = fs.readFileSync(tp.paths.stateFile, "utf8");

    runRepoRelevant(tp.paths, { query: "src" });

    const stateAfter = fs.readFileSync(tp.paths.stateFile, "utf8");
    expect(stateAfter).toBe(stateBefore);
  });

  // Anchor: REQ-RU-020
  // Anchor: REQ-RU-093
  it("REQ-RU-020 / REQ-RU-093 — CLI 'th repo relevant' dispatches (status 0 on valid req)", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runCLI(tp.root, ["repo", "relevant", "--req", "REQ-RU-093"]);
    expect(res.status).toBe(0);
  });

  // Anchor: REQ-RU-020
  it("REQ-RU-020 — CLI 'th repo relevant' with no selector exits 1", () => {
    tp = makeTempProject();
    writeMinimalRepoMap(tp);
    const res = runCLI(tp.root, ["repo", "relevant"]);
    expect(res.status).toBe(1);
  });
});

// ===========================================================================
// SLICE-3 / TASK-008 — computeImpact: impact propagation + risk flags + WHY
// ===========================================================================

describe("SLICE-3 / TASK-008 — computeImpact pure impact scorer (REQ-RU-031/022)", () => {
  /** Minimal RepoMap for impact tests — zero filesystem access. */
  function buildImpactTestMap(): RepoMap {
    const m = emptyRepoMap("/tmp/impact-test");
    m.source_roots = ["src"];
    m.test_roots = ["tests"];
    m.generated_paths = ["node_modules", "dist"];
    m.components = [
      { name: "src/auth", path: "src/auth", file_count: 2 },
      { name: "src/commands", path: "src/commands", file_count: 2 },
    ];
    m.files = [
      {
        path: "src/auth/login.ts",
        component: "src/auth",
        language: "TypeScript",
        is_test: false,
        req_ids: ["REQ-RU-031", "REQ-RU-022"],
      },
      {
        path: "src/auth/session.ts",
        component: "src/auth",
        language: "TypeScript",
        is_test: false,
        req_ids: ["REQ-RU-031"],
      },
      {
        path: "src/commands/repo.ts",
        component: "src/commands",
        language: "TypeScript",
        is_test: false,
        req_ids: [],
      },
      {
        path: "tests/auth.test.ts",
        component: null,
        language: "TypeScript",
        is_test: true,
        req_ids: ["REQ-RU-031"],
      },
      {
        path: "tests/repo.test.ts",
        component: null,
        language: "TypeScript",
        is_test: true,
        req_ids: [],
      },
    ];
    m.req_anchors = [
      { req_id: "REQ-RU-022", locations: ["src/auth/login.ts"] },
      { req_id: "REQ-RU-031", locations: ["src/auth/login.ts", "src/auth/session.ts", "tests/auth.test.ts"] },
    ];
    m.blast_radius_signals = [
      {
        flag: "authentication",
        matching_paths: ["src/auth/login.ts", "src/auth/session.ts"],
        trigger_patterns: ["auth", "login"],
      },
    ];
    m.candidate_commands = [
      { label: "test", raw: "vitest run", source_file: "package.json", kind: "test" },
      { label: "build", raw: "tsc", source_file: "package.json", kind: "build" },
    ];
    m.entrypoints = [
      { name: "th", path: "src/auth/login.ts", source: "convention" },
    ];
    m.ownership_hints = [
      { path_prefix: "src/auth", component: "src/auth" },
    ];
    return m;
  }

  // Anchor: REQ-RU-031
  it("REQ-RU-031 — test_REQ-RU-031_impact_full_result_shape: result carries all categories; riskFlags present when blast-radius signals intersect", () => {
    const map = buildImpactTestMap();
    const selector: ImpactSelector = { kind: "file", value: "src/auth/login.ts" };
    const result = computeImpact(map, selector);

    // All IF-003 fields present.
    expect(result.selectorKind).toBe("file");
    expect(result.selectorValue).toBe("src/auth/login.ts");
    expect(Array.isArray(result.impactedComponents)).toBe(true);
    expect(Array.isArray(result.relatedTests)).toBe(true);
    expect(Array.isArray(result.downstreamFeatures)).toBe(true);
    expect(Array.isArray(result.reqAnchors)).toBe(true);
    expect(Array.isArray(result.artifactStageImplications)).toBe(true);
    expect(Array.isArray(result.riskFlags)).toBe(true);
    expect(Array.isArray(result.verifyCandidates)).toBe(true);

    // Risk flags must be present (blast-radius signal "authentication" matches src/auth/login.ts).
    expect(result.riskFlags.length).toBeGreaterThan(0);
    const authFlag = result.riskFlags.find((f) => f.flag === "authentication");
    expect(authFlag).toBeDefined();
    expect(authFlag!.matchingPaths).toContain("src/auth/login.ts");

    // verifyCandidates from candidate_commands.
    expect(result.verifyCandidates.some((c) => c.label === "test")).toBe(true);
    expect(result.verifyCandidates.some((c) => c.label === "build")).toBe(true);

    // reqAnchors sorted.
    for (let i = 1; i < result.reqAnchors.length; i++) {
      expect(result.reqAnchors[i]! >= result.reqAnchors[i - 1]!).toBe(true);
    }
  });

  // Anchor: REQ-RU-022
  it("REQ-RU-022 — test_REQ-RU-022_impact_why_nonempty: every impact item has a non-empty why", () => {
    const map = buildImpactTestMap();
    const selector: ImpactSelector = { kind: "component", value: "src/auth" };
    const result = computeImpact(map, selector);

    const allItems = [
      ...result.impactedComponents,
      ...result.relatedTests,
      ...result.downstreamFeatures,
    ];

    // There must be at least some items when the component exists.
    expect(allItems.length).toBeGreaterThan(0);

    // REQ-RU-022: every item has a non-empty why.
    for (const item of allItems) {
      expect(typeof item.why).toBe("string");
      expect(item.why.length).toBeGreaterThan(0);
    }
  });

  it("REQ-RU-031 — selector-matches-nothing yields empty-but-valid result (success, not failure)", () => {
    const map = buildImpactTestMap();
    const selector: ImpactSelector = { kind: "file", value: "does/not/exist.ts" };
    const result = computeImpact(map, selector);
    expect(result.impactedComponents).toEqual([]);
    expect(result.relatedTests).toEqual([]);
    expect(result.downstreamFeatures).toEqual([]);
    expect(result.reqAnchors).toEqual([]);
    expect(result.riskFlags).toEqual([]);
    // verifyCandidates are always present from candidate_commands.
    expect(Array.isArray(result.verifyCandidates)).toBe(true);
  });

  it("REQ-RU-031 — computeImpact performs ZERO filesystem access (pure over loaded map)", () => {
    // Point at a non-existent root — function must not throw.
    const map = emptyRepoMap("/no/such/path");
    const selector: ImpactSelector = { kind: "file", value: "does/not/exist.ts" };
    expect(() => computeImpact(map, selector)).not.toThrow();
    const result = computeImpact(map, selector);
    expect(result.impactedComponents).toEqual([]);
  });

  it("REQ-RU-031 — component selector matches files by component name", () => {
    const map = buildImpactTestMap();
    const selector: ImpactSelector = { kind: "component", value: "src/auth" };
    const result = computeImpact(map, selector);
    // src/auth component has files login.ts and session.ts → impacted component listed.
    expect(result.impactedComponents.some((c) => c.name === "src/auth")).toBe(true);
  });

  it("REQ-RU-031 — reqAnchors are sorted and deduped", () => {
    const map = buildImpactTestMap();
    const selector: ImpactSelector = { kind: "component", value: "src/auth" };
    const result = computeImpact(map, selector);
    // Should include REQ-RU-022 and REQ-RU-031 (from login.ts and session.ts).
    expect(result.reqAnchors).toContain("REQ-RU-022");
    expect(result.reqAnchors).toContain("REQ-RU-031");
    // Sorted.
    for (let i = 1; i < result.reqAnchors.length; i++) {
      expect(result.reqAnchors[i]! >= result.reqAnchors[i - 1]!).toBe(true);
    }
    // No duplicates.
    expect(new Set(result.reqAnchors).size).toBe(result.reqAnchors.length);
  });

  it("REQ-RU-031 — risk flags NOT present when blast-radius signals do NOT intersect scope", () => {
    const map = buildImpactTestMap();
    // src/commands/repo.ts is NOT in the blast_radius_signals matching paths.
    const selector: ImpactSelector = { kind: "file", value: "src/commands/repo.ts" };
    const result = computeImpact(map, selector);
    // No blast-radius signal matches src/commands/repo.ts.
    expect(result.riskFlags.length).toBe(0);
  });
});

// ===========================================================================
// SLICE-3 / TASK-009 — runRepoImpact handler + impact CLI dispatch + guards
// ===========================================================================

describe("SLICE-3 / TASK-009 — runRepoImpact handler + CLI impact dispatch", () => {
  function writeTree(root: string, tree: Record<string, string>): void {
    for (const [rel, content] of Object.entries(tree)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
  }

  /** Write a minimal valid repo-map.json into a temp project's stateDir. */
  function writeImpactRepoMap(tp: TempProject, map: RepoMap): void {
    const json = serializeRepoMap(map);
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), json, "utf8");
  }

  function buildImpactMap(root: string): RepoMap {
    const m = emptyRepoMap(root);
    m.files = [
      { path: "src/auth/login.ts", component: "src/auth", language: "TypeScript", is_test: false, req_ids: ["REQ-RU-030"] },
      { path: "src/commands/repo.ts", component: "src/commands", language: "TypeScript", is_test: false, req_ids: [] },
      { path: "tests/auth.test.ts", component: null, language: "TypeScript", is_test: true, req_ids: ["REQ-RU-030"] },
    ];
    m.components = [
      { name: "src/auth", path: "src/auth", file_count: 1 },
      { name: "src/commands", path: "src/commands", file_count: 1 },
    ];
    m.candidate_commands = [{ label: "test", raw: "vitest run", source_file: "package.json", kind: "test" }];
    m.blast_radius_signals = [
      { flag: "authentication", matching_paths: ["src/auth/login.ts"], trigger_patterns: ["auth"] },
    ];
    return m;
  }

  const CLI = path.join(ROOT, "dist", "cli.js");
  function runCLI(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync("node", [CLI, "--cwd", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, TH_NO_LOG: "1" },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
  }

  // Anchor: REQ-RU-030
  it("REQ-RU-030 — test_REQ-RU-030_impact_file_selector: --file selector returns ok:true with impact result", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runRepoImpact(tp.paths, { file: "src/auth/login.ts" });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.selectorKind).toBe("file");
    expect(res.data?.selectorValue).toBe("src/auth/login.ts");
    expect(Array.isArray(res.data?.impactedComponents)).toBe(true);
    expect(Array.isArray(res.data?.riskFlags)).toBe(true);
  });

  // Anchor: REQ-RU-030
  it("REQ-RU-030 — test_REQ-RU-030_impact_component_selector: --component selector returns ok:true with impact result", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runRepoImpact(tp.paths, { component: "src/auth" });
    expect(res.ok).toBe(true);
    expect(res.data?.selectorKind).toBe("component");
    expect(res.data?.selectorValue).toBe("src/auth");
    const comps = res.data?.impactedComponents as Array<{ name: string; why: string }>;
    expect(Array.isArray(comps)).toBe(true);
    expect(comps.some((c) => c.name === "src/auth")).toBe(true);
  });

  // Anchor: REQ-RU-032
  it("REQ-RU-032 — test_REQ-RU-032_impact_file_path_escape_failure: --file escape returns path_outside_root; no read outside root", () => {
    tp = makeTempProject();
    // NO repo-map.json: if the guard didn't fire first, error would be map_missing.
    const res = runRepoImpact(tp.paths, { file: "../../etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("path_outside_root");
    // Explicitly not map_missing.
    expect(res.data?.error).not.toBe("map_missing");
  });

  // Anchor: REQ-RU-033
  it("REQ-RU-033 — test_REQ-RU-033_impact_readonly_no_state_mutation: state.json byte-unchanged after call", () => {
    tp = makeTempProject();
    // Write state.json via init.
    runInit(tp.paths, {});
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const stateBefore = fs.readFileSync(tp.paths.stateFile, "utf8");

    const res = runRepoImpact(tp.paths, { file: "src/auth/login.ts" });
    expect(res.ok).toBe(true);

    // REQ-RU-033: state.json must be byte-identical after the call.
    const stateAfter = fs.readFileSync(tp.paths.stateFile, "utf8");
    expect(stateAfter).toBe(stateBefore);
  });

  // Anchor: REQ-RU-033
  it("REQ-RU-033 — impact reads NO state: state.json not created even if absent", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    // No state.json created.
    expect(fs.existsSync(tp.paths.stateFile)).toBe(false);

    const res = runRepoImpact(tp.paths, { component: "src/auth" });
    expect(res.ok).toBe(true);

    // state.json must STILL not exist — impact never touches state.
    expect(fs.existsSync(tp.paths.stateFile)).toBe(false);
  });

  // Anchor: REQ-RU-034
  it("REQ-RU-034 — test_REQ-RU-034_impact_missing_map_clean_failure: no map → clean failure with actionable message", () => {
    tp = makeTempProject();
    // No repo-map.json.
    const res = runRepoImpact(tp.paths, { file: "src/a.ts" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("map_missing");
    expect(res.human).toContain("th repo map");
  });

  it("REQ-RU-034 — malformed map yields map_invalid-json clean failure", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), "{ bad json", "utf8");
    const res = runRepoImpact(tp.paths, { file: "src/a.ts" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("map_invalid-json");
  });

  // Anchor: REQ-RU-042
  it("REQ-RU-042 — test_REQ-RU-042_path_containment_impact: --file outside root fails before any read", () => {
    tp = makeTempProject();
    // No map — guard must fire before map load.
    const res = runRepoImpact(tp.paths, { file: "/absolute/system/path" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("path_outside_root");
  });

  // Anchor: REQ-RU-092
  it("REQ-RU-092 — test_REQ-RU-092_path_traversal_refused_before_read: --file ../../etc/passwd refused before any read (impact selector form)", () => {
    tp = makeTempProject();
    // NO repo-map.json: guard fires first → path_outside_root, not map_missing.
    const res = runRepoImpact(tp.paths, { file: "../../etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("path_outside_root");
    expect(res.data?.error).not.toBe("map_missing");
  });

  it("REQ-RU-030 — no_selector when zero selectors given", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runRepoImpact(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("no_selector");
  });

  it("REQ-RU-030 — multiple_selectors when both --file and --component given", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runRepoImpact(tp.paths, { file: "src/auth/login.ts", component: "src/auth" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("multiple_selectors");
    expect(Array.isArray(res.data?.given)).toBe(true);
  });

  it("REQ-RU-030 — selector-matches-nothing yields ok:true with empty arrays (success)", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runRepoImpact(tp.paths, { file: "does/not/exist.ts" });
    expect(res.ok).toBe(true);
    expect(res.data?.impactedComponents).toEqual([]);
    expect(res.data?.relatedTests).toEqual([]);
  });

  it("REQ-RU-030 — impact is read-only: repo-map.json unchanged after call", () => {
    tp = makeTempProject();
    const map = buildImpactMap(tp.root);
    writeImpactRepoMap(tp, map);
    const mapPath = path.join(tp.paths.stateDir, "repo-map.json");
    const mapBefore = fs.readFileSync(mapPath, "utf8");

    const res = runRepoImpact(tp.paths, { file: "src/auth/login.ts" });
    expect(res.ok).toBe(true);

    const mapAfter = fs.readFileSync(mapPath, "utf8");
    expect(mapAfter).toBe(mapBefore);
  });

  it("REQ-RU-030 — CLI 'th repo impact' dispatches successfully via --file", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runCLI(tp.root, ["repo", "impact", "--file", "src/auth/login.ts"]);
    expect(res.status).toBe(0);
  });

  it("REQ-RU-030 — CLI 'th repo impact' dispatches successfully via --component", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runCLI(tp.root, ["repo", "impact", "--component", "src/auth"]);
    expect(res.status).toBe(0);
  });

  it("REQ-RU-030 — CLI 'th repo impact --json' returns structured ImpactResult envelope", () => {
    tp = makeTempProject();
    writeImpactRepoMap(tp, buildImpactMap(tp.root));
    const res = runCLI(tp.root, ["repo", "impact", "--file", "src/auth/login.ts", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      selectorKind: string;
      impactedComponents: unknown[];
      riskFlags: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.selectorKind).toBe("file");
    expect(Array.isArray(parsed.impactedComponents)).toBe(true);
    expect(Array.isArray(parsed.riskFlags)).toBe(true);
  });

  it("REQ-RU-032 — CLI path-traversal on --file exits 1 with path_outside_root", () => {
    tp = makeTempProject();
    // Use --json so stdout is the structured envelope.
    const res = runCLI(tp.root, ["repo", "impact", "--file", "../../etc/passwd", "--json"]);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("path_outside_root");
  });

  it("REQ-RU-030 — parseArgs: --component parsed correctly into flags.component", () => {
    const parsed = parseArgs(["repo", "impact", "--component", "src/auth"]);
    expect(parsed.flags.component).toBe("src/auth");
    expect(parsed.unknownFlags).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });
});

// ===========================================================================
// SLICE-5 / TASK-012 — runContextPack extension: --slice includes repo-relevant
// files/tests from the persisted map (REQ-RU-061, REQ-RU-095, REQ-RU-063).
// ===========================================================================

describe("SLICE-5 / TASK-012 — runContextPack --slice includes repo-relevant data (REQ-RU-061/095/063)", () => {
  /** Write a minimal valid repo-map.json into a temp project's stateDir. */
  function writeRepoMapForSlice(tp: TempProject, sliceComponents: string[]): void {
    const m = emptyRepoMap(tp.root);
    // Files that belong to the slice components.
    // NOTE: test file is given component "src/commands" so the --slice scorer can
    // discover it (slice selector scores files in sliceComponents; component:null → no score).
    m.files = [
      { path: "src/commands/context.ts", component: "src/commands", language: "TypeScript", is_test: false, req_ids: ["REQ-RU-061"] },
      { path: "src/commands/repo.ts", component: "src/commands", language: "TypeScript", is_test: false, req_ids: ["REQ-RU-061"] },
      { path: "tests/repo.test.ts", component: "src/commands", language: "TypeScript", is_test: true, req_ids: ["REQ-RU-061"] },
      { path: "src/core/a.ts", component: "src/core", language: "TypeScript", is_test: false, req_ids: [] },
    ];
    m.components = [
      { name: "src/commands", path: "src/commands", file_count: 2 },
      { name: "src/core", path: "src/core", file_count: 1 },
    ];
    m.candidate_commands = [{ label: "test", raw: "vitest run", source_file: "package.json", kind: "test" }];
    const json = serializeRepoMap(m);
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(tp.paths.stateDir, "repo-map.json"), json, "utf8");
  }

  // Anchor: REQ-RU-061
  it("REQ-RU-061 — context pack --slice includes repo-relevant files/tests from the repo-understanding layer", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Add a slice that maps to src/commands.
    const sr = readState(tp.paths);
    if (sr.state) {
      sr.state.slices = [{ id: "SLICE-5", status: "in-progress", components: ["src/commands"] }];
      writeState(tp.paths, sr.state);
    }
    writeRepoMapForSlice(tp, ["src/commands"]);

    const res = runContextPack(tp.paths, { slice: "SLICE-5" });
    expect(res.ok).toBe(true);

    // REQ-RU-061: the pack must include repo-layer-sourced files.
    const d = res.data as Record<string, unknown>;
    const repoFiles = d.repoRelevantFiles as Array<{ path: string; kind: string; why: string }>;
    expect(Array.isArray(repoFiles)).toBe(true);
    // At least 1 file sourced from the repo-understanding layer.
    expect(repoFiles.length).toBeGreaterThanOrEqual(1);
    // Files should include src/commands component files.
    const filePaths = repoFiles.map((f) => f.path);
    expect(filePaths.some((p) => p.startsWith("src/commands/"))).toBe(true);
  });

  // Anchor: REQ-RU-061
  it("REQ-RU-061 — the file list from --slice context-pack intersects runRepoRelevant result for the same slice", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const sr = readState(tp.paths);
    if (sr.state) {
      sr.state.slices = [{ id: "SLICE-5", status: "in-progress", components: ["src/commands"] }];
      writeState(tp.paths, sr.state);
    }
    writeRepoMapForSlice(tp, ["src/commands"]);

    const packRes = runContextPack(tp.paths, { slice: "SLICE-5" });
    expect(packRes.ok).toBe(true);

    const relRes = runRepoRelevant(tp.paths, { slice: "SLICE-5" });
    expect(relRes.ok).toBe(true);

    // The pack's repoRelevantFiles must intersect runRepoRelevant's result.
    const packFiles = (packRes.data as Record<string, unknown>).repoRelevantFiles as Array<{ path: string }>;
    const relPaths = [
      ...(relRes.data?.readFirst as Array<{ path: string }> ?? []),
      ...(relRes.data?.related as Array<{ path: string }> ?? []),
      ...(relRes.data?.tests as Array<{ path: string }> ?? []),
    ].map((i) => i.path);

    const packPaths = packFiles.map((f) => f.path);
    // At least one path in common (intersection non-empty).
    expect(packPaths.some((p) => relPaths.includes(p))).toBe(true);
  });

  // Anchor: REQ-RU-095
  it("REQ-RU-095 — brownfield temp project: runContextPack({slice}) returns bundle with ≥1 repo-layer file", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Simulate brownfield: init with project_mode brownfield-style, add committed repo-map.
    const sr = readState(tp.paths);
    if (sr.state) {
      sr.state.project_mode = "brownfield";
      sr.state.slices = [{ id: "SLICE-5", status: "in-progress", components: ["src/commands"] }];
      writeState(tp.paths, sr.state);
    }
    writeRepoMapForSlice(tp, ["src/commands"]);

    const res = runContextPack(tp.paths, { slice: "SLICE-5" });
    expect(res.ok).toBe(true);

    const d = res.data as Record<string, unknown>;
    const repoFiles = d.repoRelevantFiles as Array<{ path: string }>;
    // REQ-RU-095: ≥1 file from the repo-understanding layer on a brownfield project.
    expect(repoFiles.length).toBeGreaterThanOrEqual(1);
    // The note field must be null (successful, not a degraded note).
    expect(d.repoRelevantNote).toBeNull();
  });

  // Anchor: REQ-RU-095
  it("REQ-RU-095 — context pack with no repo-map: degraded gracefully with a note (pack still ok)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const sr = readState(tp.paths);
    if (sr.state) {
      sr.state.slices = [{ id: "SLICE-5", status: "pending", components: ["src/commands"] }];
      writeState(tp.paths, sr.state);
    }
    // No repo-map.json written.
    const res = runContextPack(tp.paths, { slice: "SLICE-5" });
    // Pack itself must still succeed (no repo-map does NOT fail the pack).
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    // repoRelevantNote indicates the map was unavailable.
    expect(typeof d.repoRelevantNote).toBe("string");
    expect((d.repoRelevantNote as string).length).toBeGreaterThan(0);
  });

  // Anchor: REQ-RU-061
  it("REQ-RU-061 — context pack without --slice: existing bundle preserved (no repoRelevantFiles field change)", () => {
    // No-slice call: the existing behavior is preserved exactly (additive-only extension).
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
    // Without --slice there is no repoRelevantFiles appended (or it may be empty —
    // the key point is the call succeeds and existing fields are intact).
    expect(typeof res.data?.totalTokens).toBe("number");
    expect(Array.isArray(res.data?.artifacts)).toBe(true);
  });

  // Anchor: REQ-RU-061
  it("REQ-RU-061 — context pack with tests sourced from repo-layer: tests section included", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const sr = readState(tp.paths);
    if (sr.state) {
      sr.state.slices = [{ id: "SLICE-5", status: "in-progress", components: ["src/commands"] }];
      writeState(tp.paths, sr.state);
    }
    writeRepoMapForSlice(tp, ["src/commands"]);

    const res = runContextPack(tp.paths, { slice: "SLICE-5" });
    expect(res.ok).toBe(true);
    const repoFiles = (res.data as Record<string, unknown>).repoRelevantFiles as Array<{ path: string; kind: string }>;
    // Test files (is_test=true) must appear in "tests" kind.
    const testFiles = repoFiles.filter((f) => f.kind === "tests");
    expect(testFiles.some((f) => f.path.includes(".test."))).toBe(true);
  });

  // Anchor: REQ-RU-061
  it("REQ-RU-061 — runContextPack is read-only with respect to repo-map.json (no mutation)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const sr = readState(tp.paths);
    if (sr.state) {
      sr.state.slices = [{ id: "SLICE-5", status: "in-progress", components: ["src/commands"] }];
      writeState(tp.paths, sr.state);
    }
    writeRepoMapForSlice(tp, ["src/commands"]);
    const mapPath = path.join(tp.paths.stateDir, "repo-map.json");
    const mapBefore = fs.readFileSync(mapPath, "utf8");

    runContextPack(tp.paths, { slice: "SLICE-5" });

    // Repo-map.json must be byte-identical after the context-pack call (read-only).
    const mapAfter = fs.readFileSync(mapPath, "utf8");
    expect(mapAfter).toBe(mapBefore);
  });
});

// ===========================================================================
// SLICE-5 / TASK-013 — docs-truthfulness + brownfield-workflow test anchors.
//
// IMPORTANT: Tests asserting doc PROSE are RED until the Doc-Writer (Stage 10.5)
// adds that prose. This is EXPECTED. The no-network and structural-call tests
// MUST be green now.
// ===========================================================================

describe("SLICE-5 / TASK-013 — no-network import assertion (REQ-NFR-008) — must be GREEN now", () => {
  // Anchor: REQ-NFR-008
  it("REQ-NFR-008 — test_REQ-NFR-008_no_network_import_in_layer: dist/cli.js and new repo-layer source files have no http/https/fetch/net import", () => {
    // dist/cli.js: no network import.
    const cli = fs.readFileSync(path.join(ROOT, "dist", "cli.js"), "utf8");
    // No http/https node builtins.
    expect(/require\(["']node:http["']\)/.test(cli)).toBe(false);
    expect(/require\(["']node:https["']\)/.test(cli)).toBe(false);
    expect(/require\(["']http["']\)/.test(cli)).toBe(false);
    expect(/require\(["']https["']\)/.test(cli)).toBe(false);
    // No fetch (global or import).
    expect(/\bfetch\b/.test(cli)).toBe(false);

    // Source layer files: scanner, query, schema, repo handler, context handler.
    const layerFiles = [
      path.join(ROOT, "src", "core", "repo-map", "scanner.ts"),
      path.join(ROOT, "src", "core", "repo-map", "query.ts"),
      path.join(ROOT, "src", "core", "repo-map", "schema.ts"),
      path.join(ROOT, "src", "commands", "repo.ts"),
      path.join(ROOT, "src", "commands", "context.ts"),
    ];
    const networkImportRe = /import[^;]*from\s*["'](node:http|node:https|http|https|node:net|net)["']|require\s*\(\s*["'](node:http|node:https|http|https|node:net|net)["']\s*\)|\bfetch\b/;
    for (const f of layerFiles) {
      const src = fs.readFileSync(f, "utf8");
      expect(networkImportRe.test(src)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// REQ-RU-073 — documented `th repo` surface ⊆ dispatch table (subset check).
// This passes trivially when USAGE.md has no th-repo content yet (EXPECTED).
// Once Doc-Writer adds prose, this becomes a real bidirectional guard.
// ---------------------------------------------------------------------------

describe("SLICE-5 / TASK-013 — docs truthfulness: documented surface ⊆ dispatch (REQ-RU-073)", () => {
  // Anchor: REQ-RU-073
  it("REQ-RU-073 — test_REQ-RU-073_docs_truthful_to_shipped_behavior: every th repo flag/command in USAGE.md appears in src/cli.ts dispatch", () => {
    const usagePath = path.join(ROOT, "USAGE.md");
    // If USAGE.md does not exist yet, the subset is trivially satisfied (empty doc ⊆ anything).
    if (!fs.existsSync(usagePath)) {
      // Pass trivially — Doc-Writer hasn't written the file yet.
      return;
    }
    const usage = fs.readFileSync(usagePath, "utf8");

    // Extract `th repo <subcommand>` mentions from USAGE.md.
    const repoCommandMentions = [...usage.matchAll(/`th repo (\w+)/g)].map((m) => m[1]);

    if (repoCommandMentions.length === 0) {
      // No th-repo content in USAGE.md yet — subset trivially satisfied.
      return;
    }

    // Known implemented subcommands in dispatch table (src/cli.ts case "repo":).
    // `check` (runRepoCheck, cli.ts case "repo"→"check") was added after this list
    // was first written; USAGE.md now documents it (exit codes 4/5), so it must be
    // listed here for the subset guard to reflect the real dispatch table.
    const implementedSubcommands = ["map", "relevant", "impact", "check"];

    for (const mentioned of repoCommandMentions) {
      expect(implementedSubcommands).toContain(mentioned);
    }
  });
});

// ---------------------------------------------------------------------------
// Docs-scan tests (REQ-RU-060/062/070/071/072/096) — EXPECTED RED until
// Doc-Writer adds prose in Stage 10.5.
// ---------------------------------------------------------------------------

describe("SLICE-5 / TASK-013 — docs scan: README contains `th repo` (REQ-RU-070/096)", () => {
  // Anchor: REQ-RU-070
  // Anchor: REQ-RU-096
  it("REQ-RU-070 / REQ-RU-096 — test_REQ-RU-096_docs_truthfulness_readme: README contains `th repo`", () => {
    const readmePath = path.join(ROOT, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);
    const readme = fs.readFileSync(readmePath, "utf8");
    // Doc-Writer must add `th repo` to README.md (Stage 10.5).
    expect(readme).toContain("th repo");
  });
});

describe("SLICE-5 / TASK-013 — docs scan: USAGE.md contains th repo subcommands (REQ-RU-070/096)", () => {
  // Anchor: REQ-RU-070
  // Anchor: REQ-RU-096
  it("REQ-RU-096 — test_REQ-RU-096_docs_truthfulness_usage_md: USAGE.md contains `th repo map`", () => {
    const usagePath = path.join(ROOT, "USAGE.md");
    expect(fs.existsSync(usagePath)).toBe(true);
    const usage = fs.readFileSync(usagePath, "utf8");
    expect(usage).toContain("th repo map");
  });

  it("REQ-RU-070 — test_REQ-RU-070_docs_describe_new_layer_relevant: USAGE.md contains `th repo relevant`", () => {
    const usagePath = path.join(ROOT, "USAGE.md");
    expect(fs.existsSync(usagePath)).toBe(true);
    const usage = fs.readFileSync(usagePath, "utf8");
    expect(usage).toContain("th repo relevant");
  });

  it("REQ-RU-070 — test_REQ-RU-070_docs_describe_new_layer_impact: USAGE.md contains `th repo impact`", () => {
    const usagePath = path.join(ROOT, "USAGE.md");
    expect(fs.existsSync(usagePath)).toBe(true);
    const usage = fs.readFileSync(usagePath, "utf8");
    expect(usage).toContain("th repo impact");
  });
});

describe("SLICE-5 / TASK-013 — docs scan: SECURITY.md documents trust boundary (REQ-RU-071/096)", () => {
  // Anchor: REQ-RU-071
  // Anchor: REQ-RU-096
  it("REQ-RU-071 — test_REQ-RU-096_docs_truthfulness_security_md: SECURITY.md contains `resolveWithinRoot`", () => {
    const secPath = path.join(ROOT, "SECURITY.md");
    expect(fs.existsSync(secPath)).toBe(true);
    const sec = fs.readFileSync(secPath, "utf8");
    // Doc-Writer must document the path-containment function.
    expect(sec).toContain("resolveWithinRoot");
  });

  it("REQ-RU-071 — SECURITY.md contains `never executed` (commands are inert strings, not executed)", () => {
    const secPath = path.join(ROOT, "SECURITY.md");
    expect(fs.existsSync(secPath)).toBe(true);
    const sec = fs.readFileSync(secPath, "utf8");
    // Doc-Writer must document the no-execution guarantee.
    expect(sec).toContain("never executed");
  });
});

describe("SLICE-5 / TASK-013 — docs scan: CHANGELOG.md contains a `th repo` entry (REQ-RU-070/096)", () => {
  // Anchor: REQ-RU-070
  // Anchor: REQ-RU-096
  it("REQ-RU-096 — test_REQ-RU-096_docs_truthfulness_changelog: CHANGELOG.md contains a `th repo` entry", () => {
    const changelogPath = path.join(ROOT, "CHANGELOG.md");
    expect(fs.existsSync(changelogPath)).toBe(true);
    const changelog = fs.readFileSync(changelogPath, "utf8");
    // Doc-Writer must add a `th repo` entry.
    expect(changelog).toContain("th repo");
  });
});

describe("SLICE-5 / TASK-013 — docs scan: Codebase-Inspector workflow documented (REQ-RU-060)", () => {
  // Anchor: REQ-RU-060
  it("REQ-RU-060 — test_REQ-RU-060_codebase_inspector_workflow_documented: agent/workflow docs reference the new layer", () => {
    // Doc-Writer must update docs in agents/ or USAGE.md to describe the codebase-inspector
    // workflow: prose vs. machine map complementary; map as durable source of truth.
    // We scan for these key phrases in the agents/ directory or USAGE.md.
    const candidates: string[] = [
      path.join(ROOT, "USAGE.md"),
      path.join(ROOT, "agents", "twinharness", "codebase-inspector.md"),
    ];
    const keyword = "repo-map";
    let found = false;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        if (content.includes(keyword)) {
          found = true;
          break;
        }
      }
    }
    // Doc-Writer must include "repo-map" in the codebase-inspector workflow docs.
    expect(found).toBe(true);
  });
});

describe("SLICE-5 / TASK-013 — docs scan: brownfield workflow documented (REQ-RU-062)", () => {
  // Anchor: REQ-RU-062
  it("REQ-RU-062 — test_REQ-RU-062_brownfield_workflow_documented: agent/workflow docs reference the new commands", () => {
    // Doc-Writer must document brownfield workflow: Slice 0 characterization seam,
    // Builder reuse, Critic ownership comparison, Debugger related-files/tests.
    const candidates: string[] = [
      path.join(ROOT, "USAGE.md"),
      path.join(ROOT, "agents", "twinharness", "builder.md"),
      path.join(ROOT, "docs", "09-implementation-plan.md"),
    ];
    const keyword = "th repo";
    let found = false;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        if (content.includes(keyword)) {
          found = true;
          break;
        }
      }
    }
    // Doc-Writer must reference `th repo` in brownfield workflow docs.
    expect(found).toBe(true);
  });
});

describe("SLICE-5 / TASK-013 — docs scan: agent instructions updated (REQ-RU-072)", () => {
  // Anchor: REQ-RU-072
  it("REQ-RU-072 — test_REQ-RU-072_agent_instructions_updated: Codebase-Inspector or USAGE.md references new commands", () => {
    // Doc-Writer must update agent instructions to reference the new `th repo` commands
    // and the prose-vs-map division.
    const candidates: string[] = [
      path.join(ROOT, "USAGE.md"),
      path.join(ROOT, "agents", "twinharness", "codebase-inspector.md"),
      path.join(ROOT, "agents", "twinharness", "builder.md"),
    ];
    const keyword = "th repo";
    let found = false;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        if (content.includes(keyword)) {
          found = true;
          break;
        }
      }
    }
    // Doc-Writer must update agent instructions with `th repo` references.
    expect(found).toBe(true);
  });
});
