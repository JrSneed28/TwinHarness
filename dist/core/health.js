"use strict";
/**
 * Shared run-health computations — the single core behind `th doctor` (the
 * run-health audit), `th next` (the next-action oracle), and the slice/coverage
 * views. Keeping these in one place means the audit and the oracle can never
 * disagree about whether an artifact has drifted, a slice is unfinished, or a
 * revise loop has hit its cap.
 *
 * All functions are read-only and clock-free: they record and compute over
 * durable state + on-disk anchors. They never decide which stage runs.
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
exports.DEFAULT_REVISE_CAP = void 0;
exports.artifactIntegrity = artifactIntegrity;
exports.sliceProgress = sliceProgress;
exports.reviseEscalations = reviseEscalations;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const hash_1 = require("./hash");
/** Default Agent↔Critic revise-loop cap (spec §18). Mirrors commands/revise.ts. */
exports.DEFAULT_REVISE_CAP = 3;
/**
 * Compare each approved artifact's recorded hash against its current on-disk
 * hash (file or directory). Surfaces governed docs that were edited without
 * re-registration (silent drift) — the same comparison `th stale` does for one
 * artifact, applied to all.
 */
function artifactIntegrity(paths, state) {
    return state.approved_artifacts.map((a) => {
        const abs = path.resolve(paths.root, a.file);
        if (!fs.existsSync(abs))
            return { file: a.file, status: "missing" };
        try {
            return { file: a.file, status: (0, hash_1.shortHashPath)(abs) === a.hash ? "ok" : "changed" };
        }
        catch {
            return { file: a.file, status: "missing" };
        }
    });
}
function sliceProgress(state) {
    const by = (status) => state.slices.filter((s) => s.status === status).length;
    const done = by("done");
    const blocked = by("blocked");
    const inProgress = by("in-progress");
    const pending = by("pending");
    return {
        total: state.slices.length,
        done,
        blocked,
        inProgress,
        pending,
        allSettled: state.slices.length > 0 && inProgress === 0 && pending === 0,
    };
}
/** Revise modes whose count has reached the cap (escalate-to-human per §18). */
function reviseEscalations(state, cap = exports.DEFAULT_REVISE_CAP) {
    return Object.entries(state.revise_loop_counts)
        .filter(([, count]) => count >= cap)
        .map(([mode, count]) => ({ mode, count, cap }));
}
