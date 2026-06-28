"use strict";
/**
 * Pricing snapshot + cost estimation for context-pages token savings (B3).
 *
 * Rates are stored as USD per 1,000,000 input tokens ($/1M tok).
 * To convert avoided_input_tokens to USD:
 *   cost_usd = avoided_input_tokens × (input_rate / 1_000_000)
 *
 * Cache reads are priced via the `cache_read` rate in the snapshot and must
 * NEVER be folded into the headline cost (AC-13). The caller prices cache
 * reads separately for the --detail view.
 *
 * Unknown or undefined modelId, or a modelId absent from the snapshot,
 * yields cost_usd=null, model_id=null, and label="[unavailable]" (AC-11).
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPricingSnapshot = loadPricingSnapshot;
exports.priceAvoided = priceAvoided;
exports.parseTranscriptModelId = parseTranscriptModelId;
const fs = __importStar(require("node:fs"));
const jsonl_1 = require("./jsonl");
const pricing_snapshot_json_1 = __importDefault(require("./pricing-snapshot.json"));
// ---------------------------------------------------------------------------
// Snapshot loader
// ---------------------------------------------------------------------------
/**
 * Load the bundled pricing snapshot.
 * Rates are USD per 1M input tokens ($/1M tok); divide by 1_000_000 to get
 * a per-token multiplier.
 */
function loadPricingSnapshot() {
    return pricing_snapshot_json_1.default;
}
// ---------------------------------------------------------------------------
// priceAvoided
// ---------------------------------------------------------------------------
/**
 * Estimate the USD cost of `avoidedInputTokens` avoided input tokens.
 *
 * Rate unit: USD per 1,000,000 tokens ($/1M tok).
 * Formula:   cost_usd = avoidedInputTokens × (input_rate / 1_000_000)
 *
 * Cache-read tokens are priced via `cache_read` in the snapshot and are
 * intentionally NOT included here (AC-13). Price cache reads separately.
 *
 * @param avoidedInputTokens  Net avoided input tokens from savings calc.
 * @param modelId             Model id detected from the transcript, or undefined.
 * @param snapshot            Pricing snapshot; defaults to the bundled JSON.
 */
function priceAvoided(avoidedInputTokens, modelId, snapshot = loadPricingSnapshot()) {
    const snapshotDate = snapshot.snapshot_date;
    if (!modelId) {
        return { cost_usd: null, snapshot_date: snapshotDate, model_id: null, label: "[unavailable]" };
    }
    const rates = snapshot.models[modelId];
    if (!rates) {
        return { cost_usd: null, snapshot_date: snapshotDate, model_id: null, label: "[unavailable]" };
    }
    // Rates are stored as USD per 1M tokens; divide by 1_000_000 for per-token rate.
    const cost_usd = avoidedInputTokens * (rates.input / 1_000_000);
    return {
        cost_usd,
        snapshot_date: snapshotDate,
        model_id: modelId,
        label: `[estimated • snapshot ${snapshotDate}]`,
    };
}
// ---------------------------------------------------------------------------
// parseTranscriptModelId — tolerant JSONL model-id extraction
// ---------------------------------------------------------------------------
/**
 * Extract the model id from a Claude Code transcript JSONL file.
 *
 * Pinned field probe order per line (first non-empty string wins per line):
 *   1. top-level `model`      e.g. `{"model":"claude-opus-4-8",...}`
 *   2. nested `message.model` e.g. `{"message":{"model":"claude-opus-4-8",...}}`
 *   3. nested `usage.model`   e.g. `{"usage":{"model":"claude-opus-4-8",...}}`
 *
 * Returns the most-frequent non-empty model id found across all lines (ties
 * broken by first-seen insertion order). Returns undefined if the file is
 * missing, empty, fully garbled, or contains no model id in any probed field.
 * Never throws.
 */
function parseTranscriptModelId(transcriptPath) {
    try {
        if (!fs.existsSync(transcriptPath))
            return undefined;
        const raw = fs.readFileSync(transcriptPath, "utf8");
        const counts = new Map();
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parsed = (0, jsonl_1.safeParseJson)(trimmed);
            if (typeof parsed !== "object" || parsed === null)
                continue;
            const rec = parsed;
            // Probe 1: top-level `model`
            let modelId;
            if (typeof rec["model"] === "string" && rec["model"]) {
                modelId = rec["model"];
            }
            // Probe 2: nested `message.model`
            if (!modelId) {
                const msg = rec["message"];
                if (typeof msg === "object" && msg !== null) {
                    const msgRec = msg;
                    if (typeof msgRec["model"] === "string" && msgRec["model"]) {
                        modelId = msgRec["model"];
                    }
                }
            }
            // Probe 3: nested `usage.model`
            if (!modelId) {
                const usage = rec["usage"];
                if (typeof usage === "object" && usage !== null) {
                    const usageRec = usage;
                    if (typeof usageRec["model"] === "string" && usageRec["model"]) {
                        modelId = usageRec["model"];
                    }
                }
            }
            if (modelId) {
                counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
            }
        }
        if (counts.size === 0)
            return undefined;
        // Return the most-frequent model id; ties broken by first-seen insertion order.
        let best;
        let bestCount = 0;
        for (const [id, count] of counts) {
            if (count > bestCount) {
                best = id;
                bestCount = count;
            }
        }
        return best;
    }
    catch {
        return undefined;
    }
}
