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

import * as fs from "node:fs";
import { safeParseJson } from "./jsonl";
import snapshotJson from "./pricing-snapshot.json";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface PricingSnapshot {
  snapshot_date: string;
  models: Record<string, { input: number; output: number; cache_read: number }>;
}

export interface PricingResult {
  /** Estimated cost in USD, or null when the model is unknown/absent from snapshot. */
  cost_usd: number | null;
  /** The snapshot_date from the pricing file, surfaced in the label (AC-12). */
  snapshot_date: string;
  /** Model id used for pricing, or null when unavailable. */
  model_id: string | null;
  /**
   * Human-readable label:
   *   "[unavailable]"                          — model unknown or absent from snapshot
   *   "[estimated • snapshot YYYY-MM-DD]"      — successfully priced (AC-10, AC-12)
   */
  label: string;
}

// ---------------------------------------------------------------------------
// Snapshot loader
// ---------------------------------------------------------------------------

/**
 * Load the bundled pricing snapshot.
 * Rates are USD per 1M input tokens ($/1M tok); divide by 1_000_000 to get
 * a per-token multiplier.
 */
export function loadPricingSnapshot(): PricingSnapshot {
  return snapshotJson as PricingSnapshot;
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
export function priceAvoided(
  avoidedInputTokens: number,
  modelId: string | undefined,
  snapshot: PricingSnapshot = loadPricingSnapshot(),
): PricingResult {
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
export function parseTranscriptModelId(transcriptPath: string): string | undefined {
  try {
    if (!fs.existsSync(transcriptPath)) return undefined;
    const raw = fs.readFileSync(transcriptPath, "utf8");
    const counts = new Map<string, number>();

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = safeParseJson(trimmed);
      if (typeof parsed !== "object" || parsed === null) continue;
      const rec = parsed as Record<string, unknown>;

      // Probe 1: top-level `model`
      let modelId: string | undefined;
      if (typeof rec["model"] === "string" && rec["model"]) {
        modelId = rec["model"];
      }

      // Probe 2: nested `message.model`
      if (!modelId) {
        const msg = rec["message"];
        if (typeof msg === "object" && msg !== null) {
          const msgRec = msg as Record<string, unknown>;
          if (typeof msgRec["model"] === "string" && msgRec["model"]) {
            modelId = msgRec["model"];
          }
        }
      }

      // Probe 3: nested `usage.model`
      if (!modelId) {
        const usage = rec["usage"];
        if (typeof usage === "object" && usage !== null) {
          const usageRec = usage as Record<string, unknown>;
          if (typeof usageRec["model"] === "string" && usageRec["model"]) {
            modelId = usageRec["model"];
          }
        }
      }

      if (modelId) {
        counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
      }
    }

    if (counts.size === 0) return undefined;

    // Return the most-frequent model id; ties broken by first-seen insertion order.
    let best: string | undefined;
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}
