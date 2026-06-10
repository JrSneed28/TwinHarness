/**
 * SLICE-6 / TASK-013 — apply_patch tool: parse + ATOMIC multi-file apply/reject
 * (REQ-023; enforces RULE-013 / INV-007).
 *
 * Drives the REAL tool against temp-dir fixtures through the REAL PathSandbox +
 * ApprovalGate + diff-engine (parsePatch / applyHunks / generateDiff). The HEADLINE
 * property — ATOMICITY — is negative-tested rigorously: every failure mode (a
 * malformed patch, one failing hunk in a multi-hunk OR multi-file patch, an
 * out-of-root target) must leave ZERO files written. The "nothing written" property
 * is asserted by reading the disk back and confirming NOTHING changed.
 *
 * Patches are built from the SAME generateDiff the engine emits, so the parse/apply
 * round-trip is faithful. Symlink-escape uses an INJECTED scripted-realpath
 * SandboxPolicy (deterministic on Windows, no symlink privileges — the SLICE-3/4
 * approach). No network, no real subprocess.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPathSandbox, type SandboxPolicy } from "../src/path-sandbox.js";
import { createApprovalGate, type ConfirmFn } from "../src/approval-gate.js";
import {
  generateDiff,
  parsePatch,
  applyHunks,
  createDiffEngine,
} from "../src/diff-engine.js";
import { createApplyPatchTool, type ApplyPatchDeps } from "../src/tool-applypatch.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createReadTool } from "../src/tool-read.js";
import { isUserAbortError } from "../src/tool-errors.js";
import type { EditApprovalPolicy, ToolCall, ToolResult } from "../src/contracts.js";

const AUTO: EditApprovalPolicy = { editMode: "auto" };
const CONFIRM_EACH: EditApprovalPolicy = { editMode: "confirm-each" };

/** A confirm seam returning a fixed answer (for the gate's confirm-each path). */
function confirmWith(answer: "approve" | "deny" | "abort"): ConfirmFn {
  return async () => answer;
}

describe("SLICE-6 apply_patch tool (REQ-023 — atomic multi-file)", () => {
  let root: string;
  let sibling: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice6-"));
    root = path.join(base, "root");
    sibling = path.join(base, "sibling");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  /** Build the tool with the REAL sandbox over the temp root + a chosen policy. */
  function tool(overrides: Partial<ApplyPatchDeps> = {}): ReturnType<typeof createApplyPatchTool> {
    const sandbox = overrides.sandbox ?? createPathSandbox(root);
    const approval =
      overrides.approval ?? createApprovalGate({ confirm: confirmWith("approve") });
    const policy = overrides.policy ?? AUTO;
    return createApplyPatchTool({ sandbox, approval, policy, ...overrides });
  }

  function call(patch: string): ToolCall {
    return { id: "c1", toolName: "apply_patch", arguments: { patch } };
  }

  /** A single-file patch built by the engine for a known before/after target. */
  function patchFor(targetPath: string, before: string | null, after: string): string {
    return generateDiff(before, after, targetPath);
  }

  // ------------------------------------------------------------ happy path ----

  // Anchor: REQ-023.
  it("test_REQ023_applies_multifile_patch", async () => {
    // Two existing files, each modified by one hunk. A clean multi-file patch applies
    // ALL hunks and the files on disk reflect EVERY change, with a per-file diff.
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");
    await fs.writeFile(aPath, "alpha\nbeta\ngamma\n", "utf8");
    await fs.writeFile(bPath, "one\ntwo\nthree\n", "utf8");

    const patchA = patchFor(aPath, "alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
    const patchB = patchFor(bPath, "one\ntwo\nthree\n", "one\ntwo\nTHREE\n");
    const combined = patchA + patchB;

    const r: ToolResult = await tool().execute(call(combined));
    expect(r.status).toBe("ok");
    expect(r.output?.filesChanged).toBe(2);
    expect(r.output?.approval).toBe("auto-approved");
    const diffs = r.output?.diffs as string[];
    expect(diffs.length).toBe(2); // a Diff per applied Edit (RULE-002)
    const edits = r.output?.edits as { targetPath: string; applied: boolean }[];
    expect(edits.every((e) => e.applied)).toBe(true);

    // The DISK reflects every change.
    expect(await fs.readFile(aPath, "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(await fs.readFile(bPath, "utf8")).toBe("one\ntwo\nTHREE\n");
  });

  // ---------------------------------------------------------- malformed ----

  // Anchor: REQ-023.
  it("test_REQ023_patch_malformed", async () => {
    // Unparseable patch text (no headers, no @@) → PATCH_MALFORMED (ERR-011), zero
    // writes. The engine reports a discriminable failure that the tool maps.
    const r = await tool().execute(call("this is not a patch at all\njust prose\n"));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATCH_MALFORMED");

    // A `@@` hunk before any file header is also malformed (engine-level).
    const stray = "@@ -1,1 +1,1 @@\n-x\n+y\n";
    expect(parsePatch(stray).ok).toBe(false);
    const r2 = await tool().execute(call(stray));
    expect(r2.status).toBe("error");
    expect(r2.error?.code).toBe("PATCH_MALFORMED");
  });

  // -------------------------------------------------- one-hunk atomic reject ----

  // Anchor: REQ-023.
  it("test_REQ023_patch_one_hunk_fails_atomic", async () => {
    // A two-file patch where the SECOND file's hunk does NOT match the on-disk content
    // (the patch was built against stale context). The WHOLE patch is rejected with
    // PATCH_NOT_APPLICABLE and ZERO files are written — asserted by reading BOTH files
    // back and confirming NEITHER changed.
    const aPath = path.join(root, "a.ts");
    const bPath = path.join(root, "b.ts");
    await fs.writeFile(aPath, "alpha\nbeta\ngamma\n", "utf8");
    // b.ts on disk has DIFFERENT content than the patch's context expects.
    await fs.writeFile(bPath, "totally\ndifferent\ncontent\n", "utf8");

    const patchA = patchFor(aPath, "alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
    // This hunk's context ("one/two/three") does not match what's on disk.
    const patchB = patchFor(bPath, "one\ntwo\nthree\n", "one\ntwo\nTHREE\n");

    const r = await tool().execute(call(patchA + patchB));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATCH_NOT_APPLICABLE");

    // ZERO files written: even the FIRST file (whose hunk WAS applicable) is untouched,
    // because the dry-run-all barrier rejects before ANY write.
    expect(await fs.readFile(aPath, "utf8")).toBe("alpha\nbeta\ngamma\n");
    expect(await fs.readFile(bPath, "utf8")).toBe("totally\ndifferent\ncontent\n");
  });

  // ------------------------------------------------------ target escape ----

  // Anchor: REQ-023.
  it("test_REQ023_patch_target_escape_rejected", async () => {
    // A two-file patch where one target resolves OUTSIDE the root (`..` traversal) →
    // the WHOLE patch is rejected with PATH_ESCAPE and nothing is written — including
    // the in-root file. (RULE-001 fail-closed before any write.)
    const inRoot = path.join(root, "good.ts");
    await fs.writeFile(inRoot, "keep\nme\n", "utf8");
    const escape = path.join(root, "..", "sibling", "evil.ts");

    const patchGood = patchFor(inRoot, "keep\nme\n", "KEEP\nme\n");
    const patchEvil = patchFor(escape, null, "pwned\n");

    const r = await tool().execute(call(patchGood + patchEvil));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");

    // The in-root file is UNCHANGED and the out-of-root target was NEVER created.
    expect(await fs.readFile(inRoot, "utf8")).toBe("keep\nme\n");
    await expect(fs.readFile(path.join(sibling, "evil.ts"), "utf8")).rejects.toBeDefined();
  });

  // Anchor: REQ-023. (symlink-escape via injected scripted realpath — no privileges.)
  it("test_REQ023_patch_symlink_target_escape_rejected", async () => {
    // A target that LIVES in-root but whose REAL path is the out-of-root sibling: the
    // sandbox must follow the link and reject the whole patch.
    const linkInRoot = path.join(root, "link.ts");
    const realOutside = path.join(sibling, "target.ts");
    const policy: SandboxPolicy = {
      caseFold: process.platform === "win32",
      pathMod: process.platform === "win32" ? path.win32 : path.posix,
      realpath: (p: string) => {
        const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
        const key = fold(path.resolve(p));
        if (key === fold(path.resolve(root))) return root;
        if (key === fold(path.resolve(linkInRoot))) return realOutside;
        if (key === fold(path.resolve(sibling))) return sibling;
        if (key === fold(path.resolve(realOutside))) return realOutside;
        throw new Error(`ENOENT (scripted): ${p}`);
      },
    };
    const sandbox = createPathSandbox(root, policy);
    const r = await tool({ sandbox }).execute(call(patchFor(linkInRoot, null, "x\n")));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");
  });

  // ---------------------------------------------------------- re-apply ----

  // Anchor: REQ-023.
  it("test_REQ023_reapply_patch_rejected", async () => {
    // Apply a patch once (succeeds), then re-apply the SAME patch: the second apply is
    // rejected because the `-`/context lines no longer match the (already mutated) file.
    const target = path.join(root, "c.ts");
    await fs.writeFile(target, "one\ntwo\nthree\n", "utf8");
    const patch = patchFor(target, "one\ntwo\nthree\n", "one\nTWO\nthree\n");

    const first = await tool().execute(call(patch));
    expect(first.status).toBe("ok");
    expect(await fs.readFile(target, "utf8")).toBe("one\nTWO\nthree\n");

    // Re-applying the identical patch: context no longer matches → rejected, and the
    // file is left exactly as the FIRST apply left it (no further mutation).
    const second = await tool().execute(call(patch));
    expect(second.status).toBe("error");
    expect(second.error?.code).toBe("PATCH_NOT_APPLICABLE");
    expect(await fs.readFile(target, "utf8")).toBe("one\nTWO\nthree\n");
  });

  // ------------------------------------------ multi-hunk partial atomic ----

  // Anchor: REQ-023.
  it("test_REQ023_multihunk_partial_atomic", async () => {
    // A SINGLE-FILE, MULTI-HUNK patch where the second hunk fails to match. The whole
    // patch is rejected; the file is NOT written (the first applicable hunk is also
    // discarded). Asserted by reading the file back unchanged.
    const target = path.join(root, "multi.ts");
    // A file long enough that two separate, non-adjacent change regions form two hunks.
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    await fs.writeFile(target, lines, "utf8");

    // Build a valid two-hunk patch (change line2 and line19), then CORRUPT the second
    // hunk's context so it no longer matches on disk — forcing a partial failure.
    const after = lines
      .replace("line2\n", "LINE2\n")
      .replace("line19\n", "LINE19\n");
    const validTwoHunk = patchFor(target, lines, after);
    expect(validTwoHunk.split("@@").length - 1).toBeGreaterThanOrEqual(4); // ≥2 hunks (2 markers each)

    // Corrupt a context line in the patch's SECOND hunk so applyHunks reports it bad.
    const corrupted = validTwoHunk.replace(" line18", " NOPE18");

    const r = await tool().execute(call(corrupted));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATCH_NOT_APPLICABLE");
    // ZERO writes: the (otherwise-applicable) first hunk did NOT land either.
    expect(await fs.readFile(target, "utf8")).toBe(lines);
  });

  // ------------------------------------------ multi-file partial atomic ----

  // Anchor: REQ-023.
  it("test_REQ023_multifile_partial_atomic", async () => {
    // THREE files; the LAST file's hunk fails. Reading ALL THREE back asserts that NONE
    // were written — the atomicity barrier rejects the whole patch before any write.
    const f1 = path.join(root, "f1.ts");
    const f2 = path.join(root, "f2.ts");
    const f3 = path.join(root, "f3.ts");
    await fs.writeFile(f1, "a\nb\nc\n", "utf8");
    await fs.writeFile(f2, "d\ne\nf\n", "utf8");
    await fs.writeFile(f3, "g\nh\ni\n", "utf8");

    const p1 = patchFor(f1, "a\nb\nc\n", "a\nB\nc\n");
    const p2 = patchFor(f2, "d\ne\nf\n", "d\nE\nf\n");
    // p3's context expects different content than what's on disk → fails.
    const p3 = patchFor(f3, "x\ny\nz\n", "x\nY\nz\n");

    const r = await tool().execute(call(p1 + p2 + p3));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATCH_NOT_APPLICABLE");

    // ALL THREE files unchanged on disk (zero writes).
    expect(await fs.readFile(f1, "utf8")).toBe("a\nb\nc\n");
    expect(await fs.readFile(f2, "utf8")).toBe("d\ne\nf\n");
    expect(await fs.readFile(f3, "utf8")).toBe("g\nh\ni\n");
  });

  // --------------------------------------- dry-run leaves no drift ----

  // Anchor: REQ-023.
  it("test_REQ023_dryrun_apply_no_internal_drift", async () => {
    // applyHunks is a PURE dry-run: it must NOT mutate its inputs or disk. We call it
    // directly, assert it does not change the source string identity/content, and that
    // a FAILED dry-run on a multi-file patch (one bad hunk) writes NOTHING to disk.
    const before = "p\nq\nr\n";
    const parsed = parsePatch(patchFor("x.ts", before, "p\nQ\nr\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    const hunks = parsed.patch.files[0]!.hunks;

    // The dry-run returns a FRESH result and leaves `before` byte-identical.
    const beforeSnapshot = before;
    const dry1 = applyHunks(before, hunks);
    expect(dry1.applicable).toBe(true);
    expect(dry1.result).toBe("p\nQ\nr\n");
    expect(before).toBe(beforeSnapshot); // input not mutated

    // Re-running the SAME dry-run yields the SAME result (no internal-state drift).
    const dry2 = applyHunks(before, hunks);
    expect(dry2.result).toBe(dry1.result);

    // A failing-hunk patch across two files: the tool's dry-run barrier writes NOTHING.
    const okFile = path.join(root, "ok.ts");
    const badFile = path.join(root, "bad.ts");
    await fs.writeFile(okFile, "p\nq\nr\n", "utf8");
    await fs.writeFile(badFile, "real\non\ndisk\n", "utf8");
    const combined =
      patchFor(okFile, "p\nq\nr\n", "p\nQ\nr\n") +
      patchFor(badFile, "expected\nnot\nmatching\n", "expected\nNOT\nmatching\n");
    const r = await tool().execute(call(combined));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATCH_NOT_APPLICABLE");
    // No disk drift from the dry-run: both files are exactly as they were.
    expect(await fs.readFile(okFile, "utf8")).toBe("p\nq\nr\n");
    expect(await fs.readFile(badFile, "utf8")).toBe("real\non\ndisk\n");
  });

  // ----------------------------------------------- approval + IO mapping ----

  // Anchor: REQ-023. (confirm-each + deny → APPROVAL_DENIED, nothing written.)
  it("test_REQ023_patch_denied_writes_nothing", async () => {
    const target = path.join(root, "deny.ts");
    await fs.writeFile(target, "keep\n", "utf8");
    const patch = patchFor(target, "keep\n", "KEEP\n");
    const r = await tool({
      approval: createApprovalGate({ confirm: confirmWith("deny") }),
      policy: CONFIRM_EACH,
    }).execute(call(patch));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("APPROVAL_DENIED");
    expect(await fs.readFile(target, "utf8")).toBe("keep\n"); // untouched
  });

  // Anchor: REQ-023. (a disk failure mid-apply → WRITE_FAILED, never a throw.)
  it("test_REQ023_patch_write_failed", async () => {
    const target = path.join(root, "io.ts");
    await fs.writeFile(target, "x\n", "utf8");
    const patch = patchFor(target, "x\n", "X\n");
    const r = await tool({
      persist: async () => {
        throw new Error("ENOSPC simulated");
      },
    }).execute(call(patch));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("WRITE_FAILED");
  });

  // Anchor: REQ-023. (user-abort at the patch prompt propagates as a CLEAN stop.)
  it("test_REQ023_patch_user_abort_propagates_clean", async () => {
    const target = path.join(root, "abort.ts");
    await fs.writeFile(target, "y\n", "utf8");
    const patch = patchFor(target, "y\n", "Y\n");
    let threw: unknown;
    try {
      await tool({
        approval: createApprovalGate({ confirm: confirmWith("abort") }),
        policy: CONFIRM_EACH,
      }).execute(call(patch));
    } catch (err) {
      threw = err;
    }
    expect(isUserAbortError(threw)).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("y\n"); // never written
  });

  // ----------------------------------------------------- registry seam ----

  // Anchor: REQ-023. (the real apply_patch executor is reachable via the registry.)
  it("test_REQ023_apply_patch_dispatches_via_registry", async () => {
    // SLICE-6 makes apply_patch reachable through ToolRegistry.dispatch (the seam) —
    // cli.ts composition-root wiring is DEFERRED to SLICE-10. There are STILL exactly
    // five schemas (RULE-012), and a real patch through dispatch lands on disk.
    const sandbox = createPathSandbox(root);
    const patchTool = createApplyPatchTool({
      sandbox,
      approval: createApprovalGate({ confirm: confirmWith("approve") }),
      policy: AUTO,
    });
    const registry = createToolRegistry(
      createReadTool(sandbox),
      undefined,
      undefined,
      undefined,
      patchTool,
    );
    expect(registry.schemas().length).toBe(5);
    const schema = registry.schemas().find((s) => s.name === "apply_patch");
    expect(schema?.inputSchema).toMatchObject({ required: ["patch"] });

    const target = path.join(root, "viaregistry.ts");
    await fs.writeFile(target, "old\n", "utf8");
    const result = await registry.dispatch(call(patchFor(target, "old\n", "new\n")));
    expect(result.status).toBe("ok");
    expect(await fs.readFile(target, "utf8")).toBe("new\n");
  });

  // Anchor: REQ-023. (new-file creation via a /dev/null patch.)
  it("test_REQ023_patch_creates_new_file", async () => {
    // A new-file patch (before === null → `--- /dev/null`) creates the file in-root.
    const target = path.join(root, "created", "fresh.ts");
    const patch = patchFor(target, null, "const created = true;\n");
    const r = await tool().execute(call(patch));
    expect(r.status).toBe("ok");
    expect(r.output?.filesChanged).toBe(1);
    const edits = r.output?.edits as { before: string | null; applied: boolean }[];
    expect(edits[0]!.before).toBe(null); // new file
    expect(await fs.readFile(target, "utf8")).toBe("const created = true;\n");
  });

  // Anchor: REQ-023. (the engine wrapper exposes the read side.)
  it("test_REQ023_diff_engine_exposes_parse_and_apply", () => {
    const engine = createDiffEngine();
    const p = engine.parsePatch(generateDiff("a\n", "b\n", "z.ts"));
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("unreachable");
    const applied = engine.applyHunks("a\n", p.patch.files[0]!.hunks);
    expect(applied.applicable).toBe(true);
    expect(applied.result).toBe("b\n");
  });
});
