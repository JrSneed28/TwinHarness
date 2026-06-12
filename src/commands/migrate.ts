import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import { CURRENT_SCHEMA_VERSION, type TwinHarnessState } from "../core/state-schema";
import { structuredLog } from "../core/log";

/**
 * `th migrate` — upgrade a `state.json` to the current schema version (Phase 4).
 *
 * Legacy files written before schema versioning have no `schema_version` field
 * and are treated as v1. Migration is forward-only: it stamps/upgrades the
 * version (applying any per-version field migrations) and refuses to touch a
 * file written by a NEWER `th` (which the current binary cannot safely downgrade).
 *
 * Idempotent: running it on an already-current file is a no-op.
 */

/**
 * Per-version migration steps. The key is the version being migrated FROM; each
 * step returns the state shape at the next version. Currently the only step is
 * the implicit legacy→v1 stamp (no field changes). Add steps here when the
 * schema changes (e.g. a `1: (s) => ({ ...s, new_field: default })`).
 */
const MIGRATIONS: Record<number, (s: TwinHarnessState) => TwinHarnessState> = {
  // 1: (s) => ({ ...s, /* v1 → v2 field changes */ }),
};

export function runMigrate(paths: ProjectPaths): CommandResult {
  return withStateLock(paths, () => runMigrateLocked(paths));
}

function runMigrateLocked(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) {
    return failure({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
  }
  if (!r.state) {
    return failure({
      human: "state.json does not validate; repair it before migrating.",
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const from = r.state.schema_version ?? 1; // absent ⇒ legacy v1

  if (from > CURRENT_SCHEMA_VERSION) {
    return failure({
      human: `state.json is schema v${from}, newer than this th (v${CURRENT_SCHEMA_VERSION}). Upgrade th; refusing to downgrade.`,
      data: { error: "schema_too_new", from, current: CURRENT_SCHEMA_VERSION },
    });
  }

  if (from === CURRENT_SCHEMA_VERSION && r.state.schema_version !== undefined) {
    return success({
      data: { migrated: false, from, to: CURRENT_SCHEMA_VERSION },
      human: `Already at schema v${CURRENT_SCHEMA_VERSION}; nothing to migrate.`,
    });
  }

  // Apply each migration step from `from` up to CURRENT, then stamp the version.
  let next: TwinHarnessState = { ...r.state };
  for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) next = step(next);
  }
  next = { ...next, schema_version: CURRENT_SCHEMA_VERSION };

  writeState(paths, next);
  structuredLog({ cmd: "migrate", from, to: CURRENT_SCHEMA_VERSION });
  return success({
    data: { migrated: true, from, to: CURRENT_SCHEMA_VERSION },
    human: `Migrated state.json from schema v${from} to v${CURRENT_SCHEMA_VERSION}.`,
  });
}
