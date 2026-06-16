/**
 * REQ-CONTRACT-001: Prompt↔CLI contract test — pins F1 (invalid slice status).
 *
 * Scans the doc/prompt files that instruct agents on `th slice set-status` usage
 * and asserts every concrete status token is one of the valid SLICE_STATUSES.
 * This ensures `complete` (invalid) can never re-appear undetected.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SLICE_STATUSES } from "../src/core/state-schema";

const REPO_ROOT = path.resolve(__dirname, "..");

/** Files that MUST exist; a missing file is a test failure. */
const REQUIRED_FILES: string[] = [
  "skills/twinharness/SKILL.md",
  "agents/orchestrator.md",
  "agents/builder.md",
  // commands/
  "commands/th-run.md",
  "commands/th-status.md",
  "commands/th-drift.md",
  "commands/th-escalate.md",
];

/** Files that are genuinely optional — skipped when absent. */
const OPTIONAL_FILES: string[] = [
  "USAGE.md",
];

/** Files to scan for `th slice set-status` invocations. */
const FILES_TO_SCAN: string[] = [...REQUIRED_FILES, ...OPTIONAL_FILES];

/** Regex matching `set-status <SLICE-ID> <token>` — captures the status token. */
const SET_STATUS_RE = /set-status\s+\S+\s+(\S+)/g;

/**
 * Strip trailing punctuation (backticks, periods, commas, etc.) that can appear
 * when the command is embedded in inline code spans, table cells, or prose.
 * E.g. `th slice set-status <ID> in-progress` → token captured as "in-progress`"
 * without stripping. We want only the bare token.
 */
function stripTrailingPunct(token: string): string {
  return token.replace(/[`.,;:'")\]]+$/, "");
}

/** Placeholder tokens that are not literal status values. */
function isPlaceholder(token: string): boolean {
  return token.startsWith("<") || token === "<status>";
}

const VALID_STATUSES = new Set<string>(SLICE_STATUSES);

const REQUIRED_SET = new Set(REQUIRED_FILES);

describe("REQ-CONTRACT-001: th slice set-status tokens must be valid slice statuses", () => {
  for (const rel of FILES_TO_SCAN) {
    const abs = path.join(REPO_ROOT, rel);
    const isRequired = REQUIRED_SET.has(rel);
    it(`${rel}: all set-status tokens are valid (${SLICE_STATUSES.join(" | ")})`, () => {
      const exists = fs.existsSync(abs);
      if (!exists) {
        if (isRequired) {
          // Required docs must exist; a missing one is a real failure.
          expect(exists, `Required file "${rel}" is missing from the repo.`).toBe(true);
        }
        // Optional file absent — nothing to check.
        return;
      }
      const content = fs.readFileSync(abs, "utf8");
      const matches = [...content.matchAll(SET_STATUS_RE)];

      for (const m of matches) {
        const token = stripTrailingPunct(m[1]);
        if (isPlaceholder(token)) continue;
        expect(
          VALID_STATUSES.has(token),
          `File "${rel}" contains "set-status … ${token}" but "${token}" is not a valid status. ` +
            `Valid statuses: ${SLICE_STATUSES.join(", ")}`,
        ).toBe(true);
      }
    });
  }
});
