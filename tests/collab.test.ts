import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  runCollabFragment,
  runCollabList,
  runCollabMerge,
} from "../src/commands/collab";
import type { Fragment } from "../src/core/collab";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-PCO-040: a fragment is written under collab/<stage>/<round>/<name>", () => {
  it("writes the fragment file at the deterministic blackboard path", () => {
    tp = makeTempProject();
    const res = runCollabFragment(tp.paths, {
      stage: "design",
      round: "r1",
      name: "builder-a.md",
      text: "proposal for REQ-001",
    });
    expect(res.ok).toBe(true);

    const expected = path.join(tp.paths.stateDir, "collab", "design", "r1", "builder-a.md");
    expect(res.data?.path).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, "utf8")).toBe("proposal for REQ-001");
  });
});

describe("REQ-PCO-040: list returns the written fragments for a round", () => {
  it("list surfaces the fragment descriptor", () => {
    tp = makeTempProject();
    runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "a.md", text: "REQ-001 a" });

    const res = runCollabList(tp.paths, { stage: "design", round: "r1" });
    expect(res.ok).toBe(true);
    const fragments = res.data?.fragments as Fragment[];
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.name).toBe("a.md");
    expect(fragments[0]!.round).toBe("r1");
    expect(fragments[0]!.stage).toBe("design");
  });
});

describe("REQ-PCO-040: merge concatenates fragments in deterministic sorted order", () => {
  it("merge joins all anchored fragments by sorted name", () => {
    tp = makeTempProject();
    // Write out of order to prove the merge sorts deterministically.
    runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "b.md", text: "REQ-002 beta" });
    runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "a.md", text: "REQ-001 alpha" });

    const res = runCollabMerge(tp.paths, { stage: "design", round: "r1" });
    expect(res.ok).toBe(true);
    const merged = res.data?.merged as string;
    expect(merged).toBe("REQ-001 alpha\n\nREQ-002 beta\n");
    // alpha (a.md) precedes beta (b.md) regardless of write order.
    expect(merged.indexOf("alpha")).toBeLessThan(merged.indexOf("beta"));
  });
});

describe("REQ-PCO-040: merge REJECTS a round with an unanchored fragment", () => {
  it("merge fails ok:false and lists the unanchored fragment names", () => {
    tp = makeTempProject();
    runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "good.md", text: "REQ-001 ok" });
    runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "bad.md", text: "no anchor here" });

    const res = runCollabMerge(tp.paths, { stage: "design", round: "r1" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unanchored_fragments");
    expect(res.data?.unanchored).toEqual(["bad.md"]);
  });
});

describe("REQ-PCO-040: merge is idempotent — two runs yield identical output", () => {
  it("re-running merge on unchanged inputs is byte-identical", () => {
    tp = makeTempProject();
    runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "a.md", text: "REQ-001 alpha" });
    runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "b.md", text: "REQ-002 beta" });

    const first = runCollabMerge(tp.paths, { stage: "design", round: "r1" });
    const second = runCollabMerge(tp.paths, { stage: "design", round: "r1" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.data?.merged).toBe(first.data?.merged);
  });
});
