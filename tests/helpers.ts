import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";

export interface TempProject {
  paths: ProjectPaths;
  root: string;
  cleanup: () => void;
}

/** Create an isolated temp project dir so tests never touch the repo root. */
export function makeTempProject(): TempProject {
  const literalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "th-test-"));
  const paths = resolveProjectPaths(literalRoot);
  return {
    paths,
    // Expose the CANONICAL root (paths.root), NOT the raw mkdtemp path. R-13 makes
    // resolveProjectPaths realpath the selected root (macOS /var→/private/var, a
    // Windows 8.3 short name like RUNNER~1→runneradmin, a symlinked $TMPDIR), so on
    // CI the raw mkdtemp path differs from paths.root. Tests routinely thread `root`
    // as a project root while deriving targets from `paths.*`; if the two disagree,
    // a containment check (resolveWithinRoot / the write-gate) lexically rejects an
    // otherwise in-root path. Returning the canonical root keeps the fixture
    // internally consistent — exactly how production derives everything from one
    // resolveProjectPaths() call. Cleanup uses the literal path (same dir on disk).
    root: paths.root,
    cleanup: () => fs.rmSync(literalRoot, { recursive: true, force: true }),
  };
}
