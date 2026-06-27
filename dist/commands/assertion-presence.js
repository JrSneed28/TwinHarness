"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAssertionPresenceRecord = runAssertionPresenceRecord;
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const assertion_presence_1 = require("../core/assertion-presence");
/**
 * `th assertion-presence record [--identity <who>]` — mint an in-process assertion-presence
 * receipt from the current tests directory. Serialized under the state lock so the chain append
 * is atomic (mirrors `th driver record` / `th approve`).
 */
function runAssertionPresenceRecord(paths, opts = {}) {
    return (0, state_store_1.withStateLock)(paths, () => runAssertionPresenceRecordLocked(paths, opts));
}
function runAssertionPresenceRecordLocked(paths, opts) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: "state.json is invalid; fix it before recording an assertion-presence receipt.",
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const sealed = (0, assertion_presence_1.appendAssertionPresenceReceipt)(paths, {
        producerIdentity: opts.producerIdentity ?? "cli:th assertion-presence record",
    });
    const rel = path.relative(paths.root, (0, assertion_presence_1.assertionPresenceReceiptsPath)(paths)).split(path.sep).join("/");
    const reqs = sealed.ground.length;
    const assertionFree = sealed.ground.filter((g) => g.assertionFree).length;
    // Audit trail (mirrors the driver/realization writers): an assertion-presence receipt grounds
    // the BSC-2 assertion rung. Key the chain digest as `assertionPresenceRecordHash` so it never
    // collides with the ledger entry's OWN recordHash/prevHash seal fields.
    (0, ledger_1.appendLedger)(paths, {
        event: "assertion-presence-record",
        reqs,
        assertionPresenceRecordHash: sealed.recordHash,
    });
    (0, log_1.structuredLog)({ cmd: "assertion-presence record", reqs, assertionPresenceRecordHash: sealed.recordHash });
    return (0, output_1.success)({
        data: {
            file: rel,
            reqs,
            assertionFree,
            recordHash: sealed.recordHash,
        },
        human: `Recorded an in-process assertion-presence receipt at ${rel} ` +
            `(REQ-IDs measured: ${reqs}; assertion-free: ${assertionFree}). ` +
            `NOTE: this measures assertion PRESENCE / non-triviality, NOT efficacy — it records whether ` +
            `each REQ's recognized test files carry a non-trivial assertion, not whether the suite catches ` +
            `regressions. It is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it, so its status ` +
            `is \`valid\` NEVER \`valid-grounded\`; the only efficacy/independence grade is the external ` +
            `mutation-kill receipt (2b).`,
        receipts: [{ file: rel, hash: sealed.recordHash }],
    });
}
