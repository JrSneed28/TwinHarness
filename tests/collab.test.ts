import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  runCollabFragment,
  runCollabList,
  runCollabMerge,
} from "../src/commands/collab";
import { type Fragment, writeFragment } from "../src/core/collab";

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

describe("REQ-PCO-040: path traversal is rejected in stage/round/name segments", () => {
  it("rejects an absolute stage", () => {
    tp = makeTempProject();
    expect(() => runCollabFragment(tp.paths, { stage: "/tmp", round: "r1", name: "a.md", text: "REQ-001" })).toThrow();
  });

  it("rejects a '..' stage", () => {
    tp = makeTempProject();
    expect(() => runCollabFragment(tp.paths, { stage: "..", round: "r1", name: "a.md", text: "REQ-001" })).toThrow();
  });

  it("rejects a stage containing a path separator", () => {
    tp = makeTempProject();
    expect(() => runCollabFragment(tp.paths, { stage: "foo/bar", round: "r1", name: "a.md", text: "REQ-001" })).toThrow();
  });

  it("rejects a '..' round", () => {
    tp = makeTempProject();
    expect(() => runCollabFragment(tp.paths, { stage: "design", round: "..", name: "a.md", text: "REQ-001" })).toThrow();
  });

  it("rejects a name containing a path separator", () => {
    tp = makeTempProject();
    expect(() => runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "sub/a.md", text: "REQ-001" })).toThrow();
  });
});

describe("REQ-PCO-040: fragment writes are collision-safe (no silent clobber between parallel agents)", () => {
  it("re-writing the SAME stage/round/name WITHOUT force fails and leaves the original content untouched", () => {
    tp = makeTempProject();

    const first = runCollabFragment(tp.paths, {
      stage: "design",
      round: "r1",
      name: "builder-a.md",
      text: "REQ-001 original proposal",
    });
    expect(first.ok).toBe(true);
    const file = path.join(tp.paths.stateDir, "collab", "design", "r1", "builder-a.md");
    expect(fs.readFileSync(file, "utf8")).toBe("REQ-001 original proposal");

    // A second writer drops the same name without --force → collision failure.
    const second = runCollabFragment(tp.paths, {
      stage: "design",
      round: "r1",
      name: "builder-a.md",
      text: "REQ-001 clobbering proposal",
    });
    expect(second.ok).toBe(false);
    expect(second.data?.error).toBe("fragment_exists");
    expect(second.data?.stage).toBe("design");
    expect(second.data?.round).toBe("r1");
    expect(second.data?.name).toBe("builder-a.md");

    // The original content survives — no silent clobber.
    expect(fs.readFileSync(file, "utf8")).toBe("REQ-001 original proposal");
  });

  it("re-writing the SAME stage/round/name WITH force overwrites the on-disk content", () => {
    tp = makeTempProject();

    runCollabFragment(tp.paths, {
      stage: "design",
      round: "r1",
      name: "builder-a.md",
      text: "REQ-001 original proposal",
    });
    const file = path.join(tp.paths.stateDir, "collab", "design", "r1", "builder-a.md");

    const forced = runCollabFragment(tp.paths, {
      stage: "design",
      round: "r1",
      name: "builder-a.md",
      text: "REQ-001 forced overwrite",
      force: true,
    });
    expect(forced.ok).toBe(true);
    expect(forced.data?.path).toBe(file);

    // The new content replaced the old.
    expect(fs.readFileSync(file, "utf8")).toBe("REQ-001 forced overwrite");
  });

  it("two DIFFERENT names in the same round both succeed and coexist (no false collision)", () => {
    tp = makeTempProject();

    const a = runCollabFragment(tp.paths, {
      stage: "design",
      round: "r1",
      name: "builder-a.md",
      text: "REQ-001 from a",
    });
    const b = runCollabFragment(tp.paths, {
      stage: "design",
      round: "r1",
      name: "builder-b.md",
      text: "REQ-002 from b",
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const fileA = path.join(tp.paths.stateDir, "collab", "design", "r1", "builder-a.md");
    const fileB = path.join(tp.paths.stateDir, "collab", "design", "r1", "builder-b.md");
    expect(fs.readFileSync(fileA, "utf8")).toBe("REQ-001 from a");
    expect(fs.readFileSync(fileB, "utf8")).toBe("REQ-002 from b");

    // Both descriptors are visible in the round.
    const list = runCollabList(tp.paths, { stage: "design", round: "r1" });
    const fragments = list.data?.fragments as Fragment[];
    expect(fragments.map((f) => f.name)).toEqual(["builder-a.md", "builder-b.md"]);
  });

  it("core writeFragment throws on a collision without force (command layer converts it to a failure)", () => {
    tp = makeTempProject();

    writeFragment(tp.paths, { stage: "design", round: "r1", name: "a.md", content: "REQ-001 first" });
    expect(() =>
      writeFragment(tp.paths, { stage: "design", round: "r1", name: "a.md", content: "REQ-001 second" }),
    ).toThrow(/fragment already exists/);
    // With force it does not throw.
    expect(() =>
      writeFragment(tp.paths, { stage: "design", round: "r1", name: "a.md", content: "REQ-001 forced", force: true }),
    ).not.toThrow();
  });
});
