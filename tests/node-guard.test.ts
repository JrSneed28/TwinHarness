/**
 * P0-4 (#20) — CLI Node-version startup guard.
 *
 * `th` must refuse to run on an unsupported Node with a friendly, actionable
 * message rather than failing later with an opaque syntax/API error. The guard
 * logic is a pure, exported helper (`checkNodeVersion`) so we can pin its exact
 * behaviour without spawning a process on an old runtime we cannot install here.
 */

import { describe, it, expect } from "vitest";
import { checkNodeVersion, MIN_NODE_MAJOR } from "../src/cli";

describe("P0-4: checkNodeVersion gates on the supported Node floor", () => {
  it("accepts the current (supported) runtime", () => {
    const r = checkNodeVersion(process.version);
    expect(r.ok).toBe(true);
    expect(r.major).toBeGreaterThanOrEqual(MIN_NODE_MAJOR);
  });

  it.each(["v20.0.0", "v22.11.0", "v24.0.0", "20.5.1"])(
    "accepts Node %s (>= floor)",
    (v) => {
      expect(checkNodeVersion(v).ok).toBe(true);
    },
  );

  it.each(["v18.20.4", "v16.0.0", "v14.21.3", "v0.10.48"])(
    "rejects Node %s (< floor) with an upgrade pointer",
    (v) => {
      const r = checkNodeVersion(v);
      expect(r.ok).toBe(false);
      // The message reuses the doctor wording and points to a concrete upgrade path.
      expect(r.message).toContain(`requires Node >= ${MIN_NODE_MAJOR}`);
      expect(r.message).toContain("nvm install 20");
      expect(r.message).toContain("nodejs.org");
    },
  );

  it("treats an unparseable version string as unsupported (fail-closed)", () => {
    const r = checkNodeVersion("not-a-version");
    expect(r.ok).toBe(false);
    expect(r.major).toBe(0);
  });

  it("the supported-runtime message reports the version and the floor", () => {
    const r = checkNodeVersion("v20.11.0");
    expect(r.message).toBe(`v20.11.0 (>= ${MIN_NODE_MAJOR})`);
  });
});
