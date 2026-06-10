/**
 * RepoContext (`repo-context`, REQ-003) — assemble the bounded initial
 * understanding of the target repo the AgentRun seeds its conversation with,
 * WITHOUT loading the whole repo into the prompt.
 *
 * What it gathers (all bounded — RULE: do not stream the entire repo):
 *  - a capped, top-down directory listing (FILE_LISTING_CAP entries),
 *  - a detected project type (from marker files, e.g. package.json → "node"),
 *  - a detected test command (from package.json `scripts.test`, OVERRIDABLE via
 *    Config — a config-supplied command wins over detection),
 *  - a small set of key files (capped — names only, never their full contents).
 *
 * READ-ONLY: it walks the read path (fs reads) and never mutates. No
 * `path-sandbox.checkWrite` is involved here (INV-002 — reads need no gate).
 *
 * The emitted `context-gathered` TranscriptEntry payload (IF-015) is exactly
 * `{ projectType, testCommand, fileCount }`; the bounded `files`/`keyFiles`
 * lists live on the in-process RepoContext for the loop to use but are NOT the
 * whole repo (the bound is asserted in tests — REQ-003).
 */
import fs from "node:fs";
import path from "node:path";

/** Hard caps so context never becomes "the whole repo" (REQ-003 bound). */
export const FILE_LISTING_CAP = 200;
export const KEY_FILE_CAP = 12;
/** Directories never descended into (noise / volume). */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".transcripts",
  ".next",
  "out",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
]);
/** Marker files whose presence both names a project type and elects a key file. */
const KEY_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "README.md",
  "README",
]);

/**
 * In-process repo context. The `context-gathered` payload is the first three
 * fields; `files`/`keyFiles` are the bounded working lists for the loop. They
 * are deliberately capped — never the entire repo (REQ-003).
 */
export interface RepoContext {
  projectType: string | null;
  testCommand: string | null;
  fileCount: number;
  /** Capped, repo-root-relative listing (≤ FILE_LISTING_CAP). */
  files: string[];
  /** Capped key-file names (≤ KEY_FILE_CAP) — names only, not contents. */
  keyFiles: string[];
  /** True iff the listing was truncated at the cap (more files exist on disk). */
  truncated: boolean;
}

export interface BuildRepoContextOptions {
  /**
   * Config-supplied test command override. When provided (non-empty), it wins
   * over detection (Assumptions / task file: overridable via config).
   */
  testCommandOverride?: string;
}

/** Detect the project type from marker files in the root. */
function detectProjectType(root: string): string | null {
  const has = (name: string): boolean => {
    try {
      return fs.statSync(path.join(root, name)).isFile();
    } catch {
      return false;
    }
  };
  if (has("package.json")) return "node";
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    return "python";
  }
  if (has("Cargo.toml")) return "rust";
  if (has("go.mod")) return "go";
  if (has("pom.xml") || has("build.gradle")) return "java";
  if (has("Gemfile")) return "ruby";
  return null;
}

/** Detect the test command from package.json `scripts.test` (Node projects). */
function detectTestCommand(root: string): string | null {
  const pkgPath = path.join(root, "package.json");
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch {
    return null;
  }
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const testScript = pkg.scripts?.test;
    if (typeof testScript === "string" && testScript.trim().length > 0) {
      // The completion signal (REQ-013, SLICE-5) runs the *script*, not its body.
      return "npm test";
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Walk the repo top-down, collecting a capped, root-relative file listing. The
 * walk stops emitting files once FILE_LISTING_CAP is reached (bounded — it never
 * collects the entire repo, REQ-003). Ignored directories are not descended.
 * Returns the listing plus whether it was truncated.
 */
function gatherFiles(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  // Breadth-first so shallow (more relevant) files are seen before deep ones.
  const queue: string[] = [root];
  while (queue.length > 0) {
    if (files.length >= FILE_LISTING_CAP) {
      truncated = true;
      break;
    }
    const dir = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Deterministic order: names sorted within each directory.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (files.length >= FILE_LISTING_CAP) {
          truncated = true;
          break;
        }
        files.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  }
  return { files, truncated };
}

/** Select key files from the bounded listing (names only, capped). */
function selectKeyFiles(files: string[]): string[] {
  const keyFiles: string[] = [];
  for (const rel of files) {
    if (keyFiles.length >= KEY_FILE_CAP) break;
    const base = path.basename(rel);
    // Top-level marker files are the most useful key files.
    if (KEY_FILE_NAMES.has(base) && !rel.includes(path.sep)) {
      keyFiles.push(rel);
    }
  }
  return keyFiles;
}

/**
 * Build the bounded RepoContext for `root`. READ-ONLY. The test command is the
 * Config override when supplied, else detected from package.json.
 */
export function buildRepoContext(
  root: string,
  opts: BuildRepoContextOptions = {},
): RepoContext {
  const { files, truncated } = gatherFiles(root);
  const projectType = detectProjectType(root);
  const override = opts.testCommandOverride?.trim();
  const testCommand =
    override && override.length > 0 ? override : detectTestCommand(root);
  const keyFiles = selectKeyFiles(files);

  return {
    projectType,
    testCommand,
    fileCount: files.length,
    files,
    keyFiles,
    truncated,
  };
}
