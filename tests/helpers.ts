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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-test-"));
  return {
    paths: resolveProjectPaths(root),
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
