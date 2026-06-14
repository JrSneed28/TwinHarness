import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { hashDir, HashLimitError, MAX_HASH_FILE_BYTES } from "../src/core/hash";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { makeTempProject, type TempProject } from "./helpers";

/**
 * Guardrails so a misdirected `th artifact register <huge-dir>` fails fast
 * instead of walking millions of files / reading gigabytes into memory and
 * hanging the CLI. Caps are injectable so we exercise them without huge fixtures.
 */

let tp: TempProject;
afterEach(() => tp?.cleanup());

function writeFiles(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
}

describe("hashDir guardrails", () => {
  it("hashes a normal small directory deterministically (under the caps)", () => {
    tp = makeTempProject();
    const dir = path.join(tp.root, "adrs");
    writeFiles(dir, { "ADR-001.md": "a", "ADR-002.md": "b" });
    expect(hashDir(dir)).toBe(hashDir(dir)); // stable
  });

  it("throws when the file count exceeds the cap", () => {
    tp = makeTempProject();
    const dir = path.join(tp.root, "many");
    writeFiles(dir, { "a.md": "1", "b.md": "2", "c.md": "3" });
    expect(() => hashDir(dir, { maxFiles: 2, maxTotalBytes: 1e9, maxFileBytes: 1e9 })).toThrow(
      HashLimitError,
    );
    expect(() => hashDir(dir, { maxFiles: 2, maxTotalBytes: 1e9, maxFileBytes: 1e9 })).toThrow(
      /more than 2 files/,
    );
  });

  it("throws when a single file exceeds the per-file cap", () => {
    tp = makeTempProject();
    const dir = path.join(tp.root, "big");
    writeFiles(dir, { "huge.md": "0123456789AB" }); // 12 bytes
    expect(() => hashDir(dir, { maxFiles: 1e9, maxTotalBytes: 1e9, maxFileBytes: 10 })).toThrow(
      /huge\.md.*exceeds 10 bytes/,
    );
  });

  it("throws when the total byte budget is exceeded", () => {
    tp = makeTempProject();
    const dir = path.join(tp.root, "total");
    writeFiles(dir, { "a.md": "12345", "b.md": "67890" }); // 10 bytes total
    expect(() => hashDir(dir, { maxFiles: 1e9, maxTotalBytes: 8, maxFileBytes: 1e9 })).toThrow(
      /exceeds 8 bytes total/,
    );
  });

  it("th artifact register fails cleanly on an over-cap file instead of hanging", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const dir = path.join(tp.root, "docs", "oversized");
    fs.mkdirSync(dir, { recursive: true });
    // One file just over the default per-file cap.
    fs.writeFileSync(path.join(dir, "blob.md"), Buffer.alloc(MAX_HASH_FILE_BYTES + 1, "x"));
    const r = runArtifactRegister(tp.paths, "docs/oversized", 1);
    expect(r.ok).toBe(false);
    expect((r.data as any)?.error).toBe("artifact_too_large");
  });
});
