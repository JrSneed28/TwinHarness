"use strict";
/**
 * `th repo check` exit-code constants (IF-001 / REQ-203). Extracted to core so the
 * pure freshness module and the command layer share ONE definition (ARCH-002),
 * without the core depending on the command layer (which would be a cycle).
 *
 * The command module (`src/commands/repo.ts`) re-exports these under their
 * original names so existing importers (`src/commands/next.ts`, the repo-check
 * tests) keep working unchanged.
 *
 *   0  fresh           — handled inline (exit 0)
 *   4  stale           — REPO_STALE_EXIT
 *   5  no-map          — REPO_NO_MAP_EXIT
 *   1  parse-failure   — handled inline (exit 1)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPO_NO_MAP_EXIT = exports.REPO_STALE_EXIT = void 0;
/** Working tree drifted from the persisted map (added/removed/modified, or no_hashes). */
exports.REPO_STALE_EXIT = 4;
/** repo-map.json is absent. */
exports.REPO_NO_MAP_EXIT = 5;
