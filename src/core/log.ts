/**
 * Structured, single-line observability log (plan §1 "Observability": every CLI
 * command emits a structured log line). Written to stderr so it never pollutes
 * the stdout payload that `--json` consumers and hooks parse.
 *
 * Set `TH_NO_LOG=1` to silence (used to keep test output clean).
 */
export function structuredLog(event: Record<string, unknown>): void {
  if (process.env.TH_NO_LOG === "1") return;
  try {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch {
    // Logging must never crash a command.
  }
}
