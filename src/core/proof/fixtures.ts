/**
 * Stress fixtures (plan Step 3) — generate a large synthetic repo tree on disk so
 * the scanner-load proof ({@link runScannerLoad} in `stress.ts`) walks a REAL tree
 * rather than a mock. The tree is generated into an OS temp dir (NOT committed) and
 * the caller owns its lifecycle (delete with `fs.rmSync(root,{recursive,force})`).
 *
 * The shape mirrors a conventional Node project (a root `package.json` + a `src/`
 * tree of small modules carrying REQ-ID anchors) so `scanRepo` exercises its real
 * language/manifest/component/anchor detectors — never a degenerate flat directory.
 *
 * Pure of any SUT mocking: this only writes plain files; the scanner reads them as
 * untrusted repo content exactly as it would a developer's project.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Generate a large repo tree of ~`n` source files under a fresh OS temp root and
 * return that absolute root. Files are spread across `~sqrt(n)` component dirs so
 * the scanner records realistic components/ownership, and each file carries a
 * unique REQ-ID anchor so anchor extraction does real work. The caller MUST delete
 * the returned root when done (it is intentionally NOT auto-cleaned, so a scanner
 * proof can re-walk it across measured iterations).
 */
export function makeLargeRepo(n: number): string {
  const fileCount = Math.max(1, Math.floor(n));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-fixture-"));

  // A real root manifest so the scanner detects language + package-manager + a
  // candidate command (exercises the manifest detectors, not just extensions).
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      { name: "th-proof-large-fixture", version: "0.0.0", scripts: { build: "tsc", test: "vitest run" } },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const srcRoot = path.join(root, "src");
  fs.mkdirSync(srcRoot, { recursive: true });

  // Spread files across ~sqrt(n) component directories so each top-level dir under
  // `src/` becomes a detected component with a plausible file count.
  const dirCount = Math.max(1, Math.ceil(Math.sqrt(fileCount)));
  let written = 0;
  for (let d = 0; d < dirCount && written < fileCount; d++) {
    const dir = path.join(srcRoot, `mod${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; written < fileCount && f < Math.ceil(fileCount / dirCount); f++, written++) {
      // Each file: a small module with a unique REQ-ID anchor + enough body to give
      // the scanner real bytes to account (still well under MAX_READ_BYTES).
      const reqId = `REQ-FIX-${String(written).padStart(5, "0")}`;
      const body =
        `// ${reqId} — generated stress fixture module ${written}\n` +
        `export function fn${written}(x: number): number {\n` +
        `  // anchor ${reqId}\n` +
        `  return x * ${written + 1} + ${d};\n` +
        `}\n`;
      fs.writeFileSync(path.join(dir, `file${f}.ts`), body, "utf8");
    }
  }

  return root;
}
