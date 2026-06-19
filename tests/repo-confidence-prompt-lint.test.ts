/**
 * P2-9 — confidence/basis propagation into the CONSUMING agent prompts.
 *
 * The actual consumers of the repo-intelligence surface (`th repo relevant` /
 * `th repo impact` / `th context pack`) are the **Librarian** (the standing owner)
 * and the **Orchestrator** (consumes `context pack`). This lint asserts BOTH of
 * those prompts now read and act on the `basis`/`confidence` labels — treating
 * `low`/`path-token`/`unresolved` as "possible, verify" rather than fact.
 *
 * It is deliberately scoped to the TWO consumers (rev 2.1 re-targeting): the
 * non-consuming agents are NOT required to mention the surface.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const AGENTS_DIR = path.resolve(__dirname, "..", "agents");

function read(name: string): string {
  return fs.readFileSync(path.join(AGENTS_DIR, name), "utf8");
}

describe("P2-9 — repo-intelligence confidence/basis propagated to the consuming agents", () => {
  for (const file of ["librarian.md", "orchestrator.md"]) {
    it(`${file} references the confidence/basis surface and the 'verify' downgrade`, () => {
      const content = read(file);
      // References the confidence + basis fields by name.
      expect(content).toMatch(/confidence/i);
      expect(content).toMatch(/basis/i);
      // Acts on the low-confidence tiers as "possible, verify", not fact.
      expect(content.toLowerCase()).toMatch(/path-token|unresolved/);
      expect(content.toLowerCase()).toMatch(/verify/);
    });
  }

  it("asserts the surface is wired into the OWNER (librarian) explicitly", () => {
    const lib = read("librarian.md");
    // The librarian must surface the label in its answers (CAPSULE).
    expect(lib.toLowerCase()).toMatch(/possible.*verify|verify.*possible/);
  });
});
