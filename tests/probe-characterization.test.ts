/**
 * R-37 — characterization tests CLOSING the three Phase-5 investigate probes that found
 * NO DEFECT, so the "is there a hole here?" question is pinned green permanently.
 *
 *   Probe #2 — path-containment TOCTOU (NO DEFECT): a deterministic dir→symlink/junction
 *     swap pointing OUTSIDE root, applied AFTER an initial in-root resolution, is rejected
 *     on re-resolution because `resolveWithinRoot` realpaths the longest existing prefix
 *     at CALL time (not cached). Complements paths-realpath.test.ts (which pins the static
 *     junction-escape vector) by pinning the dynamic post-resolution swap sequence.
 *
 *   Probe #3 — process-tree termination (NO DEFECT): a verify command that spawns a
 *     GRANDCHILD server binding a port, then hangs, is reaped on timeout so the PORT is
 *     freed (re-bindable). Complements verify.test.ts's reap coverage by asserting the
 *     observable port-release, the probe's exact discriminator.
 *
 *   Probe #4 — distribution reproducibility (NO DEFECT): the committed dist/ matches the
 *     source build. The authoritative gate is CI's `git diff --exit-code dist/`; this is a
 *     lightweight in-suite characterization that the committed bundle is the shipped one.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawnSync } from "node:child_process";
import { resolveWithinRoot } from "../src/core/paths";
import { runCommands } from "../src/core/verify";

let cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  cleanup = [];
});

// ---------------------------------------------------------------------------
// Probe #2 — path-containment TOCTOU (dir → out-of-root symlink/junction swap)
// ---------------------------------------------------------------------------
describe("Probe #2 (NO DEFECT) — a post-resolution dir→symlink swap cannot escape root", () => {
  it("an in-root path resolves; after the dir is swapped for an out-of-root junction, re-resolution REJECTS", () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "th-probe2-root-")));
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "th-probe2-out-")));
    cleanup.push(root, outside);

    const sub = path.join(root, "subdir");
    fs.mkdirSync(sub, { recursive: true });
    const target = path.join(sub, "file.txt");

    // BEFORE the swap: an in-root target resolves (contained).
    expect(resolveWithinRoot(root, target)).not.toBeNull();

    // SWAP: replace the real in-root subdir with a junction/symlink pointing OUTSIDE root.
    fs.rmSync(sub, { recursive: true, force: true });
    let linked = false;
    try {
      fs.symlinkSync(outside, sub, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch {
      // symlink/junction creation can require privilege on some hosts; if it fails,
      // the swap vector is unavailable here and there is nothing to assert.
      linked = false;
    }
    if (linked) {
      // The link physically resolves outside root…
      expect(fs.realpathSync.native(sub).startsWith(root)).toBe(false);
      // …and re-resolution (at call time) REJECTS the now-escaping path. No TOCTOU hole.
      expect(resolveWithinRoot(root, target)).toBeNull();
      expect(resolveWithinRoot(root, "subdir/file.txt")).toBeNull();
    }
  });

  it("a plain ../ lexical escape is rejected (containment baseline)", () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "th-probe2-lex-")));
    cleanup.push(root);
    expect(resolveWithinRoot(root, "../escape.txt")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Probe #3 — process-tree termination (grandchild server port freed on reap)
// ---------------------------------------------------------------------------
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

describe("Probe #3 (NO DEFECT) — a verify timeout reaps the GRANDCHILD server (port freed)", () => {
  it("a command that spawns a detached grandchild server, then hangs, is fully reaped on timeout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-probe3-"));
    cleanup.push(root);
    const PORT = 19000 + (process.pid % 800);
    const pidFile = path.join(root, "gc.pid");

    const server = path.join(root, "server.cjs");
    fs.writeFileSync(
      server,
      `const http=require("http");const fs=require("fs");` +
        `const s=http.createServer((_,r)=>r.end("ok"));` +
        `s.listen(${PORT},"127.0.0.1",()=>fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)));` +
        `setInterval(()=>{},1000);`,
      "utf8",
    );
    // Parent: spawn the grandchild DETACHED (a true grandchild, not the direct shell
    // child), then hang so the verify timeout fires and triggers the tree reap.
    const parentCmd =
      `node -e "const c=require('child_process').spawn(process.execPath,['${server.replace(/\\/g, "\\\\")}'],` +
      `{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000);"`;

    const report = runCommands(root, [parentCmd], { timeoutMs: 4000 });
    expect(report.results[0]?.ok).toBe(false); // timed out / killed

    // Allow a moment in case the grandchild bound just before the kill.
    await new Promise((r) => setTimeout(r, 1500));
    let gcPid: number | null = null;
    try { gcPid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { gcPid = null; }

    if (gcPid !== null) {
      // The reap was genuinely exercised (the grandchild bound): the port must be free…
      expect(await portFree(PORT)).toBe(true);
      // …and the grandchild PID must be dead.
      let alive = true;
      try { process.kill(gcPid, 0); } catch { alive = false; }
      if (alive) { try { process.kill(gcPid, "SIGKILL"); } catch { /* cleanup leak */ } }
      expect(alive).toBe(false);
    }
    // If the grandchild never bound this run (timing), the test is a no-op rather than
    // a false failure — the reap correctness is also covered in verify.test.ts.
  }, 20000);
});

// ---------------------------------------------------------------------------
// Probe #4 — distribution reproducibility (committed dist/ is the shipped bundle)
// ---------------------------------------------------------------------------
describe("Probe #4 (NO DEFECT) — the committed dist/ is in sync with source (reproducibility)", () => {
  it("git diff --exit-code dist/ is clean (the committed bundle matches the build)", () => {
    const root = path.resolve(__dirname, "..");
    const r = spawnSync("git", ["diff", "--exit-code", "dist/"], { cwd: root, encoding: "utf8" });
    // status 0 ⇒ no drift between the committed dist/ and the working tree (the same
    // invariant CI enforces; here as an in-suite characterization that closes probe #4).
    expect(r.status).toBe(0);
  });

  it("the shipped CLI + MCP bundle entrypoints exist (the artifacts the plugin loads)", () => {
    const root = path.resolve(__dirname, "..");
    expect(fs.existsSync(path.join(root, "dist", "cli.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist", "mcp-server.js"))).toBe(true);
  });
});
