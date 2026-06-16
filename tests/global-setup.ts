/**
 * Vitest global setup — runs once before any test suite.
 * Silences TH_NO_LOG telemetry/structured-log output so test runs don't
 * produce 1200+ JSON lines of noise. Individual tests that need to assert
 * on log output should locally delete process.env.TH_NO_LOG in their own
 * beforeEach/beforeAll and restore it in afterEach/afterAll.
 */
export function setup(): void {
  process.env.TH_NO_LOG = "1";
}
