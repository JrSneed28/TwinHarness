/**
 * Savings render surface (Phase B6).
 *
 * Two pure renderers over a {@link SavingsResult}:
 *  - {@link renderStatusLine} — the single compact Claude Code statusLine band.
 *  - {@link renderDetail} — the multi-line `th savings --detail` expansion.
 *
 * Accessibility contract (spec AC-16): meaning is carried by TEXT labels, never
 * by color. With `color=false` (or `NO_COLOR` set) the output contains ZERO ANSI
 * escapes; when `color=true` ANSI is a pure visual enhancement layered over text
 * that already reads correctly stripped.
 *
 * Truncation contract (AC-17): as width shrinks, trailing fields drop first in
 * priority order `Saved% > avoided > (honesty) > mode`; the headline `Saved%`
 * is always retained.
 */

import type { SavingsResult } from "./savings";

const SEP = " · ";
const ANSI_DIM = "[2m";
const ANSI_GREEN = "[32m";
const ANSI_RESET = "[0m";

/** Whether color may be emitted: caller opt-in AND `NO_COLOR` not set. */
function colorEnabled(color: boolean): boolean {
  return color && process.env.NO_COLOR === undefined;
}

/** Compact a token count: 1234 → "1.2k", 2_500_000 → "2.5M", small → as-is. */
function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimZero(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

/** One decimal place, trailing ".0" removed. */
function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Render the percentage without a trailing ".00". */
function fmtPct(pct: number): string {
  return Number.isInteger(pct) ? `${pct}` : `${pct}`;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

/**
 * Render the one-line statusLine string. `width` bounds the visible (ANSI-free)
 * length; `color` opts into ANSI enhancement. Idle when no records (AC-14).
 */
export function renderStatusLine(result: SavingsResult, width: number, color: boolean): string {
  if (result.record_count === 0) {
    return "TH · savings idle";
  }

  // Fields in priority order (high → low). Each entry is the plain text.
  const saved = `TH ${fmtPct(result.saved_pct)}%`;
  const fields: string[] = [saved, `${fmtTokens(result.avoided_tokens)} avoided`];
  if (!result.payback_measured) fields.push("upper bound");
  fields.push(result.suppress_mode ? "suppress" : "observe");

  // Drop trailing fields until the joined plain text fits `width`. Always keep
  // the headline (fields[0]).
  let kept = fields.slice();
  while (kept.length > 1 && kept.join(SEP).length > width) {
    kept = kept.slice(0, -1);
  }
  // If even the headline overflows, hard-truncate it (still no mid-ANSI garbage
  // because color has not been applied yet).
  let plain = kept.join(SEP);
  if (plain.length > width && width > 0) {
    plain = plain.slice(0, width);
  }

  if (!colorEnabled(color)) return plain;

  // Color is enhancement only: colorize the headline token, dim the mode.
  const colored = kept.map((f, i) => {
    if (i === 0) return `${ANSI_GREEN}${f}${ANSI_RESET}`;
    if (i === kept.length - 1) return `${ANSI_DIM}${f}${ANSI_RESET}`;
    return f;
  });
  return colored.join(SEP);
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

/**
 * Render the multi-line `--detail` breakdown: headline, per-category lines (the
 * `rehydration` line shown as a subtracted negative) and the cache-read line.
 * Plain text only. The `cost:` line is appended by the command handler (the
 * single source of truth, since it can include the USD amount); `costLabel` is
 * retained for signature compatibility but no longer rendered here.
 */
export function renderDetail(result: SavingsResult, _costLabel?: string): string {
  const lines: string[] = [];

  lines.push(`TwinHarness savings — ${result.headline_label}`);
  lines.push(`  saved:      ${fmtPct(result.saved_pct)}%  [${result.payback_measured ? "measured" : "upper bound"}]`);
  lines.push(`  baseline:   ${result.baseline_tokens} tok`);
  lines.push(`  actual:     ${result.actual_tokens} tok`);
  lines.push(`  avoided:    ${result.avoided_tokens} tok`);
  lines.push(
    `  payback:    ${result.payback_measured ? `${result.payback_tokens} tok [measured]` : "[unavailable]"}`,
  );
  lines.push(`  mode:       ${result.suppress_mode ? "suppress (active)" : "observe-only (S0)"}`);

  lines.push("  categories:");
  for (const cat of result.categories) {
    lines.push(`    ${cat.category.padEnd(18)} ${cat.avoided_tokens} tok  [${cat.label}]`);
  }
  if (result.uncategorized_tokens > 0) {
    lines.push(`    ${"uncategorized".padEnd(18)} ${result.uncategorized_tokens} tok  [incomplete]`);
  }

  lines.push(`  cache-read: ${result.cache_read_tokens} tok  [excluded · separate]`);

  return lines.join("\n");
}
