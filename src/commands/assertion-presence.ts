/**
 * `th assertion-presence record` (Axis-B slice-6 / BSC-2 2a) — mint the in-process
 * assertion-PRESENCE receipt the production-reality assertion rung reads.
 *
 * Before this verb, the completion gate counted a REQ as "tested" when its anchor appeared
 * in a RECOGNIZED test file, even if that file carried NO non-trivial assertion — an empty
 * `it()`, a smoke test that only constructs a value, a tautology like `expect(true).toBe(true)`
 * cleared the bar (BSC-2). This is the missing in-process SENSOR writer: per REQ-ID it records
 * whether the recognized test files anchoring it carry a non-trivial (cannot-be-tautological)
 * assertion, hash-chained into `<stateDir>/assertion-presence-receipts.jsonl`, under
 * `withStateLock` (exactly like `th driver record` / `th approve`).
 *
 * MEASURES PRESENCE, NOT EFFICACY: the sensor records whether an assertion that *can fail* is
 * PRESENT and non-trivial — it does NOT and cannot prove the suite actually CATCHES regressions.
 * The genuine efficacy/independence grade is the EXTERNAL mutation-kill receipt (2b), produced by
 * a controlled runner that proves the suite KILLS injected faults.
 *
 * ZERO TRUST WEIGHT (consensus): this is the IN-PROCESS producer — the agent can mint it, so the
 * record is ATTRIBUTION-ONLY. Its in-process pass status is `valid` NEVER `valid-grounded`; the
 * independently-grounded property arrives only with the external Ed25519-signed mutation-kill
 * producer (2b) at a write-surface TwinHarness cannot reach. The record LOOKS authoritative
 * (hash-chained, snapshot-bound) but is NOT an independence anchor.
 *
 * SENSOR-at-mint: the ground is computed FRESH by the Lane-A sensor (the only thing recordable);
 * the core sensor + store live in `src/core/assertion-presence.ts`; this is its governed CLI
 * writer (mirroring the driver/realization producer split).
 */

import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { withStateLock, readState } from "../core/state-store";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { NOT_INIT } from "../core/guards";
import {
  appendAssertionPresenceReceipt,
  assertionPresenceReceiptsPath,
} from "../core/assertion-presence";

export interface AssertionPresenceRecordOptions {
  /** Self-asserted producer identity (attribution-only, zero in-process trust weight). */
  producerIdentity?: string;
}

/**
 * `th assertion-presence record [--identity <who>]` — mint an in-process assertion-presence
 * receipt from the current tests directory. Serialized under the state lock so the chain append
 * is atomic (mirrors `th driver record` / `th approve`).
 */
export function runAssertionPresenceRecord(
  paths: ProjectPaths,
  opts: AssertionPresenceRecordOptions = {},
): CommandResult {
  return withStateLock(paths, () => runAssertionPresenceRecordLocked(paths, opts));
}

function runAssertionPresenceRecordLocked(
  paths: ProjectPaths,
  opts: AssertionPresenceRecordOptions,
): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: "state.json is invalid; fix it before recording an assertion-presence receipt.",
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const sealed = appendAssertionPresenceReceipt(paths, {
    producerIdentity: opts.producerIdentity ?? "cli:th assertion-presence record",
  });

  const rel = path.relative(paths.root, assertionPresenceReceiptsPath(paths)).split(path.sep).join("/");
  const reqs = sealed.ground.length;
  const assertionFree = sealed.ground.filter((g) => g.assertionFree).length;

  // Audit trail (mirrors the driver/realization writers): an assertion-presence receipt grounds
  // the BSC-2 assertion rung. Key the chain digest as `assertionPresenceRecordHash` so it never
  // collides with the ledger entry's OWN recordHash/prevHash seal fields.
  appendLedger(paths, {
    event: "assertion-presence-record",
    reqs,
    assertionPresenceRecordHash: sealed.recordHash,
  });
  structuredLog({ cmd: "assertion-presence record", reqs, assertionPresenceRecordHash: sealed.recordHash });

  return success({
    data: {
      file: rel,
      reqs,
      assertionFree,
      recordHash: sealed.recordHash,
    },
    human:
      `Recorded an in-process assertion-presence receipt at ${rel} ` +
      `(REQ-IDs measured: ${reqs}; assertion-free: ${assertionFree}). ` +
      `NOTE: this measures assertion PRESENCE / non-triviality, NOT efficacy — it records whether ` +
      `each REQ's recognized test files carry a non-trivial assertion, not whether the suite catches ` +
      `regressions. It is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it, so its status ` +
      `is \`valid\` NEVER \`valid-grounded\`; the only efficacy/independence grade is the external ` +
      `mutation-kill receipt (2b).`,
    receipts: [{ file: rel, hash: sealed.recordHash }],
  });
}
