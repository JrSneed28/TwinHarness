"use strict";
/**
 * Component 6 (Failure-injection / negative proof) — plan Step 6. Each enumerated
 * fault is injected into a real, isolated temp project and the spine is asserted to
 * fail SAFELY: a structured rejection (never an uncaught crash) and the correct
 * gate-block. The faults exercise the REAL validators / lock / integrity / wave /
 * gate functions — no SUT mocking.
 *
 * Faults (plan Step 6):
 *   - corrupt-state          → `validateState`/`readState` reject; stop-gate blocks
 *   - stale-lock             → `withStateLock` steals a >STALE_MS lock and runs fn
 *   - artifact-hash-mismatch → `artifactIntegrity` reports `changed`
 *   - dangling-cyclic-deps   → `validateDeps` reports dangling+cycles; `computeWave` stalls
 *   - open-drift-debate      → stop-gate blocks on open blocking drift/debate
 *   - unapproved-decision    → `gatingObligations` blocks; stop-gate blocks
 *
 * Every injector is wrapped so a thrown error becomes a FAILED {@link FaultResult}
 * (`observed:"threw: …"`, `pass:false`) rather than propagating — a fault proof must
 * itself never crash the suite.
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
exports.ALL_FAULTS = void 0;
exports.injectAndAssert = injectAndAssert;
exports.runAllFaults = runAllFaults;
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
const state_store_1 = require("../state-store");
const health_1 = require("../health");
const wave_1 = require("../wave");
const decisions_1 = require("../decisions");
const hash_1 = require("../hash");
const init_1 = require("../../commands/init");
const hook_1 = require("../../commands/hook");
/** Every enumerated fault, in proof order. */
exports.ALL_FAULTS = [
    "corrupt-state",
    "stale-lock",
    "artifact-hash-mismatch",
    "dangling-cyclic-deps",
    "open-drift-debate",
    "unapproved-decision",
];
/** Run `fn` against a fresh, initialized, isolated temp project; always cleans up. */
function withTempProject(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-fault-"));
    const paths = (0, paths_1.resolveProjectPaths)(root);
    (0, init_1.runInit)(paths, {});
    try {
        return fn(paths);
    }
    finally {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        }
        catch {
            /* best-effort cleanup */
        }
    }
}
// --- individual injectors ---------------------------------------------------
/** Corrupt/invalid state.json → structured rejection (not a crash) + stop-gate block. */
function injectCorruptState() {
    return withTempProject((paths) => {
        // Schema-invalid (bad tier + empty current_stage) — must reject, never throw.
        fs.writeFileSync(paths.stateFile, JSON.stringify({ tier: "T9", current_stage: "" }), "utf8");
        const r = (0, state_store_1.readState)(paths);
        const rejected = r.exists && r.state === undefined && (r.issues?.length ?? 0) > 0;
        const gate = (0, hook_1.evaluateStopGate)(paths);
        return {
            fault: "corrupt-state",
            expected: "validateState rejects with issues (no crash) and the stop-gate blocks",
            observed: `rejected=${rejected} (issues=${r.issues?.length ?? 0}), stopGate.block=${gate.block}`,
            pass: rejected && gate.block,
            gateBlocked: gate.block ? "stop-gate" : undefined,
        };
    });
}
/** Stale lock (older than STALE_MS) → `withStateLock` steals it and runs fn. */
function injectStaleLock() {
    return withTempProject((paths) => {
        const lockDir = path.join(paths.stateDir, ".state.lock");
        fs.mkdirSync(lockDir, { recursive: true });
        const old = Date.now() - (state_store_1.STALE_MS + 60_000);
        fs.utimesSync(lockDir, new Date(old), new Date(old));
        let ran = false;
        const out = (0, state_store_1.withStateLock)(paths, () => {
            ran = true;
            return 42;
        });
        const released = !fs.existsSync(lockDir);
        return {
            fault: "stale-lock",
            expected: "withStateLock steals the stale lock, runs fn, and releases (no deadlock)",
            observed: `ran=${ran}, returned=${out}, released=${released}`,
            pass: ran && out === 42 && released,
        };
    });
}
/** Approved artifact edited after registration → `artifactIntegrity` = `changed`. */
function injectArtifactHashMismatch() {
    return withTempProject((paths) => {
        const rel = "docs/governed.md";
        const abs = path.join(paths.root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, "approved content v1\n", "utf8");
        // Register the CURRENT hash, then mutate the file → silent drift.
        const r = (0, state_store_1.readState)(paths);
        const state = r.state;
        state.approved_artifacts = [{ file: rel, version: 1, hash: (0, hash_1.shortHashPath)(abs) }];
        (0, state_store_1.writeState)(paths, state);
        fs.appendFileSync(abs, "sneaky unregistered edit\n", "utf8");
        const integ = (0, health_1.artifactIntegrity)(paths, (0, state_store_1.readState)(paths).state);
        const entry = integ.find((i) => i.file === rel);
        return {
            fault: "artifact-hash-mismatch",
            expected: "artifactIntegrity flags the edited governed artifact as 'changed'",
            observed: `status=${entry?.status ?? "absent"}`,
            pass: entry?.status === "changed",
        };
    });
}
/** Dangling reference + a 2-cycle → `validateDeps` reports both; `computeWave` stalls. */
function injectDanglingCyclicDeps() {
    const slices = [
        { id: "SLICE-A", status: "pending", components: ["c1"], depends_on: ["SLICE-MISSING"] },
        { id: "SLICE-B", status: "pending", components: ["c2"], depends_on: ["SLICE-C"] },
        { id: "SLICE-C", status: "pending", components: ["c3"], depends_on: ["SLICE-B"] },
    ];
    const issues = (0, wave_1.validateDeps)(slices);
    const wave = (0, wave_1.computeWave)(slices, new Map(), false);
    return {
        fault: "dangling-cyclic-deps",
        expected: "validateDeps reports dangling+cycles and computeWave stalls (no infinite spin)",
        observed: `dangling=${issues.dangling.length}, cycles=${issues.cycles.length}, stalled=${wave.stalled}`,
        pass: issues.dangling.length > 0 && issues.cycles.length > 0 && wave.stalled,
    };
}
/** Open blocking drift + debate → the stop-gate blocks completion. */
function injectOpenDriftDebate() {
    return withTempProject((paths) => {
        const state = (0, state_store_1.readState)(paths).state;
        state.drift_open_blocking = 1;
        state.debate_open_blocking = 1;
        (0, state_store_1.writeState)(paths, state);
        const gate = (0, hook_1.evaluateStopGate)(paths);
        return {
            fault: "open-drift-debate",
            expected: "stop-gate blocks while blocking drift/debate are open",
            observed: `block=${gate.block}, reasons=${gate.reasons.length}`,
            pass: gate.block && gate.reasons.length > 0,
            gateBlocked: gate.block ? "stop-gate" : undefined,
        };
    });
}
/** Unapproved decision gating the current stage → `gatingObligations` + stop-gate block. */
function injectUnapprovedDecision() {
    return withTempProject((paths) => {
        const state = (0, state_store_1.readState)(paths).state;
        (0, decisions_1.appendDecisionEvent)(paths, {
            id: "DECISION-001",
            event: "proposed",
            title: "Unapproved gating decision",
            rationale: "blocks the current stage until approved",
            links: [(0, decisions_1.canonicalStageLink)(state.current_stage)],
            proposer: "proof",
            proposedAt: new Date().toISOString(),
        });
        const obligations = (0, decisions_1.gatingObligations)((0, decisions_1.reduceDecisions)((0, decisions_1.readDecisionEvents)(paths)), state);
        const gate = (0, hook_1.evaluateStopGate)(paths);
        return {
            fault: "unapproved-decision",
            expected: "gatingObligations + the stop-gate block on an unapproved stage-linked decision",
            observed: `obligations=${obligations.length}, stopGate.block=${gate.block}`,
            pass: obligations.length > 0 && gate.block,
            gateBlocked: gate.block ? "stop-gate" : undefined,
        };
    });
}
const INJECTORS = {
    "corrupt-state": injectCorruptState,
    "stale-lock": injectStaleLock,
    "artifact-hash-mismatch": injectArtifactHashMismatch,
    "dangling-cyclic-deps": injectDanglingCyclicDeps,
    "open-drift-debate": injectOpenDriftDebate,
    "unapproved-decision": injectUnapprovedDecision,
};
/**
 * Inject one fault and assert safe failure. A throw from the injector is captured
 * as a FAILED result (the negative proof must never crash the suite itself).
 */
function injectAndAssert(fault) {
    try {
        return INJECTORS[fault]();
    }
    catch (e) {
        return {
            fault,
            expected: "safe, structured failure (no uncaught crash)",
            observed: `threw: ${e.message}`,
            pass: false,
        };
    }
}
/** Run every enumerated fault, in order. */
function runAllFaults() {
    return exports.ALL_FAULTS.map(injectAndAssert);
}
