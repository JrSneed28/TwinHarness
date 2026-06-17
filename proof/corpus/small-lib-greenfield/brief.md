# Brief: `duration` — a small library (greenfield)

## Summary
Build a small, dependency-free library that converts between compact
human-duration strings (`1h30m`, `45s`, `2d`) and milliseconds, in both
directions. Greenfield: a fresh package with no existing code.

## Tier hint
T2 — a handful of cooperating pure functions with a small parser and a typed
error surface. No blast-radius flag applies (no auth/money/migration/data
integrity), but the parser's edge cases warrant a tier above trivial.

## Functional requirements
- `parseDuration(text: string): number` — parse a compact duration into integer
  milliseconds. Supported units: `ms`, `s`, `m`, `h`, `d`. Multiple ordered
  segments compose additively (`1h30m` = 5_400_000).
- `formatDuration(ms: number): string` — render milliseconds back into the
  compact, largest-unit-first form, omitting zero segments.
- Invalid input (unknown unit, empty string, non-numeric magnitude) throws a
  typed `DurationParseError` carrying the offending token.
- Round-trip stability: for any valid `x`, `parseDuration(formatDuration(
  parseDuration(x)))` equals `parseDuration(x)`.

## Non-functional
- Zero runtime dependencies; pure functions only (no IO, no clock).
- Deterministic: same input → same output on every platform.

## Acceptance criteria
See `meta.json` — parse/format/round-trip plus the typed error path, all covered
by unit tests.
