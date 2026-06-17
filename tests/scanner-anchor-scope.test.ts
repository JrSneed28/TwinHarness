/**
 * finding #2 (ADR-004) — the single-walk scanner's REQ-anchor SCOPE boundary.
 *
 * Accepting the bounded-cost single walk means the anchor map is NOT byte-identical
 * to a hypothetical uncapped two-pass: a REQ-ID that appears ONLY in an oversize
 * file (> MAX_READ_BYTES) or ONLY under a generated/producer directory is
 * INTENTIONALLY excluded. The oversize case is pinned in repo-bounded-cost.test.ts;
 * this golden pins the GENERATED/PRODUCER-dir exclusion AND that normal in-scope
 * anchors are still collected — so a future "fix" that re-includes generated
 * anchors (re-polluting traceability with build output) fails loudly.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { scanRepo } from "../src/core/repo-map/scanner";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("finding #2 (ADR-004): scanner anchor scope — generated/producer dirs are intentionally excluded", () => {
  it("a REQ-ID present ONLY in a generated/producer dir is NOT an anchor; in-scope files ARE", () => {
    tp = makeTempProject();
    const root = tp.root;

    // In-scope normal source → MUST be an anchor.
    write(root, "src/feature.ts", "// Anchor: REQ-INSCOPE-001\nexport const x = 1;\n");
    // Generated dirs at root and NESTED (skipped before descent) → MUST be excluded.
    write(root, "node_modules/pkg/index.js", "// Anchor: REQ-GENERATED-002\n");
    write(root, "dist/bundle.js", "// Anchor: REQ-GENERATED-003\n");
    write(root, "src/sub/dist/inner.js", "// Anchor: REQ-GENERATED-004\n"); // nested generated dir
    // Producer dir (.twinharness) → excluded silently.
    write(root, ".twinharness/notes.txt", "Anchor: REQ-PRODUCER-005\n");

    const map = scanRepo(root);
    const ids = new Set(map.req_anchors.map((r) => r.req_id));

    // In-scope anchor IS collected.
    expect(ids.has("REQ-INSCOPE-001")).toBe(true);
    // Generated / producer anchors are intentionally excluded (the bounded-cost / scope contract).
    expect(ids.has("REQ-GENERATED-002")).toBe(false);
    expect(ids.has("REQ-GENERATED-003")).toBe(false);
    expect(ids.has("REQ-GENERATED-004")).toBe(false);
    expect(ids.has("REQ-PRODUCER-005")).toBe(false);

    // ...and never sneak into any FileEntry.req_ids either.
    const inAnyFile = (id: string): boolean => map.files.some((f) => f.req_ids.includes(id));
    expect(inAnyFile("REQ-GENERATED-002")).toBe(false);
    expect(inAnyFile("REQ-GENERATED-004")).toBe(false);
    expect(inAnyFile("REQ-PRODUCER-005")).toBe(false);
    expect(inAnyFile("REQ-INSCOPE-001")).toBe(true);
  });
});
