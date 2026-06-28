/**
 * B3 pricing tests.
 *
 * AC-10: known model → expected cost given a fixed rate
 * AC-11: unknown model → null + "[unavailable]"
 * AC-12: label contains snapshot date
 * AC-13: cache_read rate accessible but not used in headline cost
 * parseTranscriptModelId: fixed transcript fixture returns model id; missing file → undefined
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  loadPricingSnapshot,
  priceAvoided,
  parseTranscriptModelId,
  type PricingSnapshot,
} from "../src/core/pricing";

// ---------------------------------------------------------------------------
// Fixed-rate snapshot for deterministic cost assertions (AC-10, AC-11, AC-12)
// ---------------------------------------------------------------------------

const FIXED_SNAPSHOT: PricingSnapshot = {
  snapshot_date: "2026-06-28",
  models: {
    "claude-sonnet-4-6": { input: 3.0, output: 15.0, cache_read: 0.3 },
  },
};

// ---------------------------------------------------------------------------
// priceAvoided — AC-10: known model → expected cost
// ---------------------------------------------------------------------------

describe("priceAvoided — AC-10: known model → expected cost", () => {
  it("1M avoided tokens at $3/1M → $3.00", () => {
    const result = priceAvoided(1_000_000, "claude-sonnet-4-6", FIXED_SNAPSHOT);
    expect(result.cost_usd).toBeCloseTo(3.0, 6);
    expect(result.model_id).toBe("claude-sonnet-4-6");
  });

  it("500k avoided tokens at $3/1M → $1.50", () => {
    const result = priceAvoided(500_000, "claude-sonnet-4-6", FIXED_SNAPSHOT);
    expect(result.cost_usd).toBeCloseTo(1.5, 6);
  });

  it("0 avoided tokens → $0.00", () => {
    const result = priceAvoided(0, "claude-sonnet-4-6", FIXED_SNAPSHOT);
    expect(result.cost_usd).toBe(0);
  });

  it("100 avoided tokens at $3/1M → $0.0003", () => {
    const result = priceAvoided(100, "claude-sonnet-4-6", FIXED_SNAPSHOT);
    expect(result.cost_usd).toBeCloseTo(0.0003, 9);
  });
});

// ---------------------------------------------------------------------------
// priceAvoided — AC-11: unknown model → null + "[unavailable]"
// ---------------------------------------------------------------------------

describe("priceAvoided — AC-11: unknown model → null + [unavailable]", () => {
  it("undefined model → cost_usd null, model_id null, label [unavailable]", () => {
    const result = priceAvoided(100_000, undefined, FIXED_SNAPSHOT);
    expect(result.cost_usd).toBeNull();
    expect(result.model_id).toBeNull();
    expect(result.label).toBe("[unavailable]");
  });

  it("model string absent from snapshot → cost_usd null, model_id null, label [unavailable]", () => {
    const result = priceAvoided(100_000, "claude-opus-4-8", FIXED_SNAPSHOT);
    expect(result.cost_usd).toBeNull();
    expect(result.model_id).toBeNull();
    expect(result.label).toBe("[unavailable]");
  });

  it("empty string model → cost_usd null, model_id null, label [unavailable]", () => {
    const result = priceAvoided(100_000, "", FIXED_SNAPSHOT);
    expect(result.cost_usd).toBeNull();
    expect(result.model_id).toBeNull();
    expect(result.label).toBe("[unavailable]");
  });
});

// ---------------------------------------------------------------------------
// priceAvoided — AC-12: label contains snapshot date
// ---------------------------------------------------------------------------

describe("priceAvoided — AC-12: label contains snapshot date", () => {
  it("known model label is exactly [estimated • snapshot YYYY-MM-DD]", () => {
    const result = priceAvoided(1_000_000, "claude-sonnet-4-6", FIXED_SNAPSHOT);
    expect(result.label).toBe("[estimated • snapshot 2026-06-28]");
    expect(result.label).toContain("2026-06-28");
  });

  it("snapshot_date is present in result for known model", () => {
    const result = priceAvoided(100, "claude-sonnet-4-6", FIXED_SNAPSHOT);
    expect(result.snapshot_date).toBe("2026-06-28");
  });

  it("snapshot_date is present in result for unknown model too", () => {
    const result = priceAvoided(100, "unknown-model-xyz", FIXED_SNAPSHOT);
    expect(result.snapshot_date).toBe("2026-06-28");
  });
});

// ---------------------------------------------------------------------------
// priceAvoided — AC-13: cache_read rate not used in headline cost
// ---------------------------------------------------------------------------

describe("priceAvoided — AC-13: headline cost uses input rate only", () => {
  it("cost matches input_rate × tokens / 1M, not cache_read rate", () => {
    const snapshot = loadPricingSnapshot();
    const modelId = Object.keys(snapshot.models)[0];
    if (!modelId) return; // guard against empty snapshot
    const rates = snapshot.models[modelId]!;
    const avoided = 1_000_000;

    const result = priceAvoided(avoided, modelId, snapshot);
    expect(result.cost_usd).not.toBeNull();

    const expectedFromInput = avoided * (rates.input / 1_000_000);
    expect(result.cost_usd).toBeCloseTo(expectedFromInput, 8);

    // Verify cache_read rate exists in snapshot but is not what drives the cost
    expect(typeof rates.cache_read).toBe("number");
    if (rates.cache_read !== rates.input) {
      const wouldBeFromCache = avoided * (rates.cache_read / 1_000_000);
      expect(result.cost_usd).not.toBeCloseTo(wouldBeFromCache, 8);
    }
  });
});

// ---------------------------------------------------------------------------
// loadPricingSnapshot — bundled snapshot integrity
// ---------------------------------------------------------------------------

describe("loadPricingSnapshot — bundled snapshot", () => {
  it("has a non-empty snapshot_date string", () => {
    const snapshot = loadPricingSnapshot();
    expect(typeof snapshot.snapshot_date).toBe("string");
    expect(snapshot.snapshot_date.length).toBeGreaterThan(0);
  });

  it("has at least one model entry", () => {
    const snapshot = loadPricingSnapshot();
    expect(Object.keys(snapshot.models).length).toBeGreaterThan(0);
  });

  it("each model entry has numeric input, output, cache_read fields", () => {
    const snapshot = loadPricingSnapshot();
    for (const [id, rates] of Object.entries(snapshot.models)) {
      expect(typeof rates.input, `${id}.input`).toBe("number");
      expect(typeof rates.output, `${id}.output`).toBe("number");
      expect(typeof rates.cache_read, `${id}.cache_read`).toBe("number");
    }
  });

  it("includes expected claude model ids", () => {
    const snapshot = loadPricingSnapshot();
    const ids = Object.keys(snapshot.models);
    expect(ids.some((id) => id.startsWith("claude-"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseTranscriptModelId — tolerant JSONL parser
// ---------------------------------------------------------------------------

describe("parseTranscriptModelId — missing/garbled file", () => {
  it("missing file → undefined (never throws)", () => {
    const result = parseTranscriptModelId(
      path.join(os.tmpdir(), "no-such-transcript-pricing-xyz.jsonl"),
    );
    expect(result).toBeUndefined();
  });

  it("fully garbled file → undefined", () => {
    const f = path.join(os.tmpdir(), `th-pricing-garbled-${Date.now()}.jsonl`);
    fs.writeFileSync(f, "not json\n{broken\n");
    try {
      expect(parseTranscriptModelId(f)).toBeUndefined();
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("file with no model field → undefined", () => {
    const f = path.join(os.tmpdir(), `th-pricing-nomodel-${Date.now()}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ input_tokens: 100, output_tokens: 50 }) + "\n");
    try {
      expect(parseTranscriptModelId(f)).toBeUndefined();
    } finally {
      fs.unlinkSync(f);
    }
  });
});

describe("parseTranscriptModelId — field probe order", () => {
  it("top-level `model` field → returns model id", () => {
    const f = path.join(os.tmpdir(), `th-pricing-toplevel-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: "message", model: "claude-sonnet-4-6", input_tokens: 100 }),
        JSON.stringify({ type: "message", model: "claude-sonnet-4-6", input_tokens: 200 }),
      ].join("\n") + "\n",
    );
    try {
      expect(parseTranscriptModelId(f)).toBe("claude-sonnet-4-6");
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("nested `message.model` field → returns model id", () => {
    const f = path.join(os.tmpdir(), `th-pricing-msgmodel-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      JSON.stringify({
        type: "tool_result",
        message: { model: "claude-haiku-4-5", role: "assistant" },
      }) + "\n",
    );
    try {
      expect(parseTranscriptModelId(f)).toBe("claude-haiku-4-5");
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("nested `usage.model` field → returns model id", () => {
    const f = path.join(os.tmpdir(), `th-pricing-usagemodel-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      JSON.stringify({
        type: "usage_report",
        usage: { model: "claude-opus-4-8", input_tokens: 50 },
      }) + "\n",
    );
    try {
      expect(parseTranscriptModelId(f)).toBe("claude-opus-4-8");
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("top-level `model` takes priority over message.model on the same line", () => {
    const f = path.join(os.tmpdir(), `th-pricing-priority-${Date.now()}.jsonl`);
    // top-level model and message.model both present — top-level wins
    fs.writeFileSync(
      f,
      JSON.stringify({
        model: "claude-sonnet-4-6",
        message: { model: "claude-opus-4-8" },
      }) + "\n",
    );
    try {
      expect(parseTranscriptModelId(f)).toBe("claude-sonnet-4-6");
    } finally {
      fs.unlinkSync(f);
    }
  });
});

describe("parseTranscriptModelId — frequency + tolerance", () => {
  it("most-frequent model id wins across lines", () => {
    const f = path.join(os.tmpdir(), `th-pricing-freq-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ model: "claude-sonnet-4-6" }),
        JSON.stringify({ model: "claude-opus-4-8" }),
        JSON.stringify({ model: "claude-sonnet-4-6" }),
        JSON.stringify({ model: "claude-sonnet-4-6" }),
      ].join("\n") + "\n",
    );
    try {
      expect(parseTranscriptModelId(f)).toBe("claude-sonnet-4-6");
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("garbled lines mixed with valid lines → returns model from valid lines", () => {
    const f = path.join(os.tmpdir(), `th-pricing-mixed-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      [
        "{broken json",
        JSON.stringify({ model: "claude-haiku-4-5" }),
        "not json either",
        JSON.stringify({ model: "claude-haiku-4-5" }),
      ].join("\n") + "\n",
    );
    try {
      expect(parseTranscriptModelId(f)).toBe("claude-haiku-4-5");
    } finally {
      fs.unlinkSync(f);
    }
  });
});
