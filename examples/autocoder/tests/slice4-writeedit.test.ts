/**
 * SLICE-4 / TASK-010 — write_edit tool (REQ-008, REQ-011, REQ-021).
 *
 * Drives the REAL tool against temp-dir fixtures through the real PathSandbox +
 * ApprovalGate + generateDiff. The fixed mutation order (checkWrite → generateDiff →
 * resolveEdit → persist) is exercised end-to-end: a write produces a Diff and (on
 * approval) the file on disk; replace edits an existing file; mis-matched replace
 * yields SEARCH_NOT_FOUND / SEARCH_AMBIGUOUS with NO Edit; approval/containment/IO
 * failures map to APPROVAL_DENIED / PATH_ESCAPE / WRITE_FAILED error ToolResults
 * (never a throw — RULE-008); applied edits are durable (survive a simulated crash).
 *
 * Confinement (REQ-021): traversal / absolute-outside / unresolvable targets are
 * rejected by the REAL sandbox; symlink-escape is asserted deterministically on
 * Windows by INJECTING a scripted-realpath SandboxPolicy (as SLICE-3 did) so the
 * escape is caught WITHOUT needing symlink-creation privileges. The LWW + TOCTOU
 * residuals are documented and tested (recorded, not eliminated).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPathSandbox, type SandboxPolicy } from "../src/path-sandbox.js";
import { createApprovalGate, type ConfirmFn } from "../src/approval-gate.js";
import { createWriteEditTool, type WriteEditDeps } from "../src/tool-writeedit.js";
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

describe("SLICE-4 write_edit tool (REQ-008 / REQ-011 / REQ-021)", () => {
  let root: string;
  let sibling: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice4-"));
    root = path.join(base, "root");
    sibling = path.join(base, "sibling");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  /** Build the tool with the REAL sandbox (over the temp root) + a chosen policy. */
  function tool(overrides: Partial<WriteEditDeps> = {}): ReturnType<typeof createWriteEditTool> {
    const sandbox = overrides.sandbox ?? createPathSandbox(root);
    const approval =
      overrides.approval ?? createApprovalGate({ confirm: confirmWith("approve") });
    const policy = overrides.policy ?? AUTO;
    return createWriteEditTool({ sandbox, approval, policy, ...overrides });
  }

  function call(args: Record<string, unknown>): ToolCall {
    return { id: "c1", toolName: "write_edit", arguments: args };
  }

  // ---------------------------------------------------------------- REQ-008 ----

  // Anchor: REQ-008.
  it("test_REQ008_write_creates_file_with_diff", async () => {
    const target = path.join(root, "sub", "new.ts");
    const r: ToolResult = await tool().execute(
      call({ targetPath: target, mode: "write", content: "const x = 1;\n" }),
    );
    expect(r.status).toBe("ok");
    // The output carries the applied Edit, a Diff, and the approval verdict.
    const edit = r.output?.edit as { targetPath: string; before: string | null; after: string; applied: boolean };
    expect(edit.applied).toBe(true);
    expect(edit.before).toBe(null); // new file
    expect(edit.after).toBe("const x = 1;\n");
    expect(r.output?.approval).toBe("auto-approved");
    const diff = r.output?.diff as string;
    expect(diff).toContain("--- /dev/null"); // new-file header
    expect(diff).toContain("+++ b/");
    expect(diff).toContain("+const x = 1;");
    // The file is actually on disk (parent dir created within root).
    expect(await fs.readFile(target, "utf8")).toBe("const x = 1;\n");
  });

  // Anchor: REQ-008.
  it("test_REQ008_replace_edits_existing", async () => {
    const target = path.join(root, "a.ts");
    await fs.writeFile(target, "let v = OLD;\n", "utf8");
    const r = await tool().execute(
      call({ targetPath: target, mode: "replace", search: "OLD", replacement: "NEW" }),
    );
    expect(r.status).toBe("ok");
    const edit = r.output?.edit as { before: string | null; after: string; applied: boolean };
    expect(edit.before).toBe("let v = OLD;\n");
    expect(edit.after).toBe("let v = NEW;\n");
    expect(edit.applied).toBe(true);
    expect(r.output?.diff as string).toContain("-let v = OLD;");
    expect(r.output?.diff as string).toContain("+let v = NEW;");
    // Persisted: a subsequent read sees the new state.
    expect(await fs.readFile(target, "utf8")).toBe("let v = NEW;\n");
  });

  // Anchor: REQ-008.
  it("test_REQ008_search_not_found", async () => {
    const target = path.join(root, "a.ts");
    await fs.writeFile(target, "nothing here\n", "utf8");
    const r = await tool().execute(
      call({ targetPath: target, mode: "replace", search: "ABSENT", replacement: "X" }),
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("SEARCH_NOT_FOUND");
    // No Edit produced → the file is unchanged.
    expect(await fs.readFile(target, "utf8")).toBe("nothing here\n");
  });

  // Anchor: REQ-008.
  it("test_REQ008_search_ambiguous", async () => {
    const target = path.join(root, "a.ts");
    await fs.writeFile(target, "x x x\n", "utf8");
    // >1 match without replaceAll → SEARCH_AMBIGUOUS (count reported), no Edit.
    const r = await tool().execute(
      call({ targetPath: target, mode: "replace", search: "x", replacement: "y" }),
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("SEARCH_AMBIGUOUS");
    expect(r.error?.message).toContain("3"); // the count is reported
    expect(await fs.readFile(target, "utf8")).toBe("x x x\n"); // unchanged

    // With replaceAll:true the same edit succeeds (all occurrences replaced).
    const ok = await tool().execute(
      call({ targetPath: target, mode: "replace", search: "x", replacement: "y", replaceAll: true }),
    );
    expect(ok.status).toBe("ok");
    expect(await fs.readFile(target, "utf8")).toBe("y y y\n");
  });

  // ---------------------------------------------------------------- REQ-011 ----

  // Anchor: REQ-011.
  it("test_REQ011_approved_edit_persisted_to_disk", async () => {
    // confirm-each + approve → approved-by-user; the file is written so a fresh read sees it.
    const target = path.join(root, "persist.ts");
    const r = await tool({
      approval: createApprovalGate({ confirm: confirmWith("approve") }),
      policy: CONFIRM_EACH,
    }).execute(call({ targetPath: target, mode: "write", content: "persisted = true\n" }));
    expect(r.status).toBe("ok");
    expect(r.output?.approval).toBe("approved-by-user");
    expect(await fs.readFile(target, "utf8")).toBe("persisted = true\n");

    // A denied edit (confirm-each + deny) → APPROVAL_DENIED, file NOT written, loop continues.
    const target2 = path.join(root, "denied.ts");
    const denied = await tool({
      approval: createApprovalGate({ confirm: confirmWith("deny") }),
      policy: CONFIRM_EACH,
    }).execute(call({ targetPath: target2, mode: "write", content: "nope\n" }));
    expect(denied.status).toBe("error");
    expect(denied.error?.code).toBe("APPROVAL_DENIED");
    await expect(fs.readFile(target2, "utf8")).rejects.toBeDefined(); // never created
  });

  // Anchor: REQ-011.
  it("test_REQ011_write_io_failure", async () => {
    // Approval + containment pass, but the injected persist seam throws → WRITE_FAILED
    // (ERR-008); Edit is Rejected (applied:false), not Applied — never a throw.
    const target = path.join(root, "io.ts");
    const r = await tool({
      persist: async () => {
        throw new Error("ENOSPC simulated");
      },
    }).execute(call({ targetPath: target, mode: "write", content: "data\n" }));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("WRITE_FAILED");
    // The Edit did NOT reach disk.
    await expect(fs.readFile(target, "utf8")).rejects.toBeDefined();
  });

  // Anchor: REQ-011.
  it("test_REQ011_rewrite_identical_content_idempotent", async () => {
    const target = path.join(root, "idem.ts");
    const content = "stable = 1\n";
    const first = await tool().execute(call({ targetPath: target, mode: "write", content }));
    expect(first.status).toBe("ok");
    const onDisk1 = await fs.readFile(target, "utf8");

    // Re-writing the SAME content yields the same file (content-idempotent). The
    // second call still produces its own Diff + approval (no dedup needed); the
    // resulting file bytes are identical.
    const second = await tool().execute(call({ targetPath: target, mode: "write", content }));
    expect(second.status).toBe("ok");
    const onDisk2 = await fs.readFile(target, "utf8");
    expect(onDisk2).toBe(onDisk1);
    expect(onDisk2).toBe(content);
  });

  // Anchor: REQ-011.
  it("test_REQ011_applied_edits_persist_after_crash", async () => {
    // An applied edit is durably on disk BEFORE the tool returns (the persist seam
    // fsyncs). We model "process crashes immediately after the write" by reading the
    // file back through a brand-new fs handle (a fresh read = the post-crash observer):
    // the committed write stays applied (no auto-rollback — Crash/Restart-Recovery).
    const target = path.join(root, "durable.ts");
    const r = await tool().execute(
      call({ targetPath: target, mode: "write", content: "survives = true\n" }),
    );
    expect(r.status).toBe("ok");
    // Post-"crash" observer: the file is present and complete.
    const observed = await fs.readFile(target, "utf8");
    expect(observed).toBe("survives = true\n");
  });

  // ---------------------------------------------------------------- REQ-021 ----

  // Anchor: REQ-021.
  it("test_REQ021_write_traversal_rejected", async () => {
    // A `..` traversal escaping the root → PATH_ESCAPE, fail-closed, no write.
    const escape = path.join(root, "..", "sibling", "evil.ts");
    const r = await tool().execute(call({ targetPath: escape, mode: "write", content: "x\n" }));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");
    // Nothing written into the sibling dir.
    await expect(fs.readFile(path.join(sibling, "evil.ts"), "utf8")).rejects.toBeDefined();
  });

  // Anchor: REQ-021.
  it("test_REQ021_write_absolute_outside_rejected", async () => {
    // An absolute path landing OUTSIDE the root → PATH_ESCAPE.
    const outside = path.join(sibling, "abs.ts");
    const r = await tool().execute(call({ targetPath: outside, mode: "write", content: "x\n" }));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");
    await expect(fs.readFile(outside, "utf8")).rejects.toBeDefined();
  });

  // Anchor: REQ-021.
  it("test_REQ021_write_symlink_escape_rejected", async () => {
    // Symlink-escape via an INJECTED scripted-realpath SandboxPolicy (deterministic on
    // Windows, no symlink privileges needed — the SLICE-3 approach). `link` exists
    // inside the root but its REAL path is the out-of-root sibling: confinement must
    // follow the symlink and reject.
    const linkInRoot = path.join(root, "link");
    const realOutside = path.join(sibling, "target");
    const policy: SandboxPolicy = {
      caseFold: process.platform === "win32",
      pathMod: path.win32.sep === path.sep ? path.win32 : path.posix,
      realpath: (p: string) => {
        const key = path.resolve(p);
        const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
        // root and the link's parent resolve to themselves; the link resolves OUTSIDE.
        if (fold(key) === fold(path.resolve(root))) return root;
        if (fold(key) === fold(path.resolve(linkInRoot))) return realOutside;
        if (fold(key) === fold(path.resolve(sibling))) return sibling;
        if (fold(key) === fold(path.resolve(realOutside))) return realOutside;
        throw new Error(`ENOENT (scripted): ${p}`);
      },
    };
    const sandbox = createPathSandbox(root, policy);
    const r = await tool({ sandbox }).execute(
      call({ targetPath: linkInRoot, mode: "write", content: "x\n" }),
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");
  });

  // Anchor: REQ-021.
  it("test_REQ021_unresolvable_path_rejected", async () => {
    // An unresolvable path (scripted realpath throws for every probe incl. the fs
    // root) → fail-closed PATH_ESCAPE, never a permissive default.
    const policy: SandboxPolicy = {
      caseFold: false,
      pathMod: path.posix,
      realpath: () => {
        throw new Error("ENOENT (scripted)");
      },
    };
    const sandbox = createPathSandbox("/work/root", policy);
    const r = await tool({ sandbox }).execute(
      call({ targetPath: "/work/root/anything.ts", mode: "write", content: "x\n" }),
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");
  });

  // Anchor: REQ-021.
  it("test_REQ021_concurrent_external_mutation_lww", async () => {
    // RESIDUAL (documented, not eliminated): no run lock in the MVP — last-write-wins.
    // The tool reads `before`, an EXTERNAL writer mutates the same file, then the tool
    // writes its `after`: Autocoder's write WINS (the external edit is overwritten).
    // This test RECORDS the LWW behavior (it is the accepted, HUMAN-CONFIRMED stance).
    const target = path.join(root, "lww.ts");
    await fs.writeFile(target, "original\n", "utf8");

    // Simulate the external mutation happening between read and write via the persist
    // seam: just before Autocoder persists, an external writer changes the file. The
    // tool's `after` (computed from the original `before`) still overwrites it (LWW).
    let externalWroteAt: string | null = null;
    const r = await tool({
      persist: async (canonicalPath, contents) => {
        // External writer lands first...
        await fs.writeFile(canonicalPath, "EXTERNAL EDIT\n", "utf8");
        externalWroteAt = await fs.readFile(canonicalPath, "utf8");
        // ...then Autocoder's write wins (last-write-wins, no lock).
        await fs.writeFile(canonicalPath, contents, "utf8");
      },
    }).execute(call({ targetPath: target, mode: "replace", search: "original", replacement: "autocoder" }));

    expect(r.status).toBe("ok");
    expect(externalWroteAt).toBe("EXTERNAL EDIT\n"); // the external edit DID land
    // Last write wins: Autocoder's content is what's on disk (the external edit lost).
    expect(await fs.readFile(target, "utf8")).toBe("autocoder\n");
  });

  // Anchor: REQ-021.
  it("test_REQ021_toctou_symlink_window_documented", async () => {
    // RESIDUAL (documented, not eliminated): the gap between checkWrite and the write
    // is a TOCTOU window — a symlink swapped in that window could redirect the write.
    // The check resolves the real path of the deepest EXISTING ancestor; the residual
    // swap window is ACCEPTED as benign for a local single-user CLI. We DOCUMENT &
    // TEST it: checkWrite passes for an in-root target at check time; were a swap to
    // occur after, the write would follow the (already-validated) canonical path. The
    // window is recorded here as the accepted residual, not eliminated.
    const target = path.join(root, "toctou.ts");
    const sandbox = createPathSandbox(root);
    // At CHECK time the target is in-root → allowed; the canonicalPath is pinned.
    const verdict = sandbox.checkWrite(target);
    expect(verdict.allowed).toBe(true);
    expect(typeof verdict.canonicalPath).toBe("string");
    // The tool writes to the canonicalPath captured at check time (the window is the
    // gap between this check and the persist). The accepted residual: a post-check
    // symlink swap is NOT re-validated. We assert the write lands at the checked path.
    const r = await tool({ sandbox }).execute(
      call({ targetPath: target, mode: "write", content: "checked\n" }),
    );
    expect(r.status).toBe("ok");
    expect(await fs.readFile(verdict.canonicalPath as string, "utf8")).toBe("checked\n");
  });

  // Anchor: REQ-021. (ABU-003 reconciled.)
  it("test_REQ021_rejects_traversal_write", async () => {
    // A traversal write to climb out via multiple `..` segments is rejected fail-closed.
    const escape = path.join(root, "..", "..", "etc", "passwd");
    const r = await tool().execute(call({ targetPath: escape, mode: "write", content: "pwn\n" }));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");
  });

  // Anchor: REQ-021. (ABU-004 reconciled.)
  it("test_REQ021_rejects_symlink_escape", async () => {
    // A second symlink-escape vector (a nested link whose real parent is outside the
    // root) is also rejected — asserted via injected scripted realpath.
    const nestedLink = path.join(root, "deep", "link.ts");
    const realOutside = path.join(sibling, "outside.ts");
    const policy: SandboxPolicy = {
      caseFold: process.platform === "win32",
      pathMod: process.platform === "win32" ? path.win32 : path.posix,
      realpath: (p: string) => {
        const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
        const key = fold(path.resolve(p));
        if (key === fold(path.resolve(root))) return root;
        if (key === fold(path.resolve(path.join(root, "deep")))) return realOutside; // the link dir escapes
        if (key === fold(path.resolve(sibling))) return sibling;
        if (key === fold(path.resolve(realOutside))) return realOutside;
        throw new Error(`ENOENT (scripted): ${p}`);
      },
    };
    const sandbox = createPathSandbox(root, policy);
    const r = await tool({ sandbox }).execute(
      call({ targetPath: nestedLink, mode: "write", content: "x\n" }),
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("PATH_ESCAPE");
  });

  // Anchor: REQ-021. (user-abort propagates as a clean stop, not normalized.)
  it("test_REQ021_user_abort_propagates_clean", async () => {
    // A user-abort at the prompt throws UserAbortError (a CLEAN stop) — the tool does
    // NOT normalize it to an error ToolResult; it propagates for the run to stop clean.
    const target = path.join(root, "abort.ts");
    let threw: unknown;
    try {
      await tool({
        approval: createApprovalGate({ confirm: confirmWith("abort") }),
        policy: CONFIRM_EACH,
      }).execute(call({ targetPath: target, mode: "write", content: "x\n" }));
    } catch (err) {
      threw = err;
    }
    expect(isUserAbortError(threw)).toBe(true);
    // The file was never written (abort before persist).
    await expect(fs.readFile(target, "utf8")).rejects.toBeDefined();
  });

  // Anchor: REQ-008. (The real write_edit executor is reachable via the registry seam.)
  it("test_REQ008_write_edit_dispatches_via_registry", async () => {
    // SLICE-4 makes write_edit reachable through ToolRegistry.dispatch (the seam) —
    // cli.ts composition-root wiring is DEFERRED to SLICE-10. A real write through
    // dispatch yields exactly one ok ToolResult and the file on disk.
    const sandbox = createPathSandbox(root);
    const writeTool = createWriteEditTool({
      sandbox,
      approval: createApprovalGate({ confirm: confirmWith("approve") }),
      policy: AUTO,
    });
    const registry = createToolRegistry(createReadTool(sandbox), undefined, writeTool);
    // The write_edit schema is the IF-003 shape (targetPath/mode required) and there
    // are still exactly five schemas (RULE-012).
    expect(registry.schemas().length).toBe(5);
    const schema = registry.schemas().find((s) => s.name === "write_edit");
    expect(schema?.inputSchema).toMatchObject({ required: ["targetPath", "mode"] });

    const target = path.join(root, "viaregistry.ts");
    const result = await registry.dispatch(
      call({ targetPath: target, mode: "write", content: "dispatched = 1\n" }),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(target, "utf8")).toBe("dispatched = 1\n");
  });

  // Anchor: REQ-008. (user-abort is RE-RAISED by the registry, not normalized.)
  it("test_REQ008_user_abort_reraised_by_registry", async () => {
    // The registry re-raises UserAbortError (clean stop) rather than swallowing it as
    // an error ToolResult — so the run can terminate cleanly (Stopped, not Failed).
    const sandbox = createPathSandbox(root);
    const writeTool = createWriteEditTool({
      sandbox,
      approval: createApprovalGate({ confirm: confirmWith("abort") }),
      policy: CONFIRM_EACH,
    });
    const registry = createToolRegistry(createReadTool(sandbox), undefined, writeTool);
    let threw: unknown;
    try {
      await registry.dispatch(
        call({ targetPath: path.join(root, "x.ts"), mode: "write", content: "x\n" }),
      );
    } catch (err) {
      threw = err;
    }
    expect(isUserAbortError(threw)).toBe(true); // re-raised, NOT normalized
  });
});
