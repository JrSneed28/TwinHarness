/**
 * resolveWithinRoot symlink/junction containment (H-5).
 *
 * A lexical containment check is fooled by a symlink or NTFS junction inside the
 * root that points outside it. NTFS junctions are NOT symlinks, so the fix
 * realpaths the root and the resolved path and re-checks containment. The
 * junction case is the proven Windows vector and MUST run on windows-latest CI.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWithinRoot } from "../src/core/paths";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("resolveWithinRoot — symlink/junction escape (H-5)", () => {
  it("rejects a path that escapes the root via a junction (win) / symlink (posix)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-realpath-"));
    const root = path.join(tmp, "project");
    const secretDir = path.join(tmp, "secret"); // sibling OUTSIDE the root
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "secret.txt"), "TOP SECRET", "utf8");

    // A junction does NOT require elevation on Windows (the proven vector).
    const link = path.join(root, "escape");
    fs.symlinkSync(secretDir, link, process.platform === "win32" ? "junction" : "dir");

    // Lexically `escape/secret.txt` looks contained; realpath re-containment must reject it.
    expect(resolveWithinRoot(root, "escape/secret.txt")).toBeNull();
    expect(resolveWithinRoot(root, path.join("escape", "secret.txt"))).toBeNull();
    // The escape link directory itself also resolves outside the root.
    expect(resolveWithinRoot(root, "escape")).toBeNull();
  });

  it("still resolves a legitimate in-root path", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-realpath-ok-"));
    const root = path.join(tmp, "project");
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "a.md"), "hi", "utf8");

    const resolved = resolveWithinRoot(root, "docs/a.md");
    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith(path.resolve(root))).toBe(true);
  });

  it("resolves a not-yet-created in-root path (tolerates a non-existent tail)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-realpath-new-"));
    const root = path.join(tmp, "project");
    fs.mkdirSync(root, { recursive: true });

    expect(resolveWithinRoot(root, "docs/new/file.md")).not.toBeNull();
  });

  it("rejects a plain ../ lexical escape (regression: lexical check preserved)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-realpath-lex-"));
    const root = path.join(tmp, "project");
    fs.mkdirSync(root, { recursive: true });
    expect(resolveWithinRoot(root, "../outside.txt")).toBeNull();
  });
});
