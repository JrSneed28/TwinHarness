import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  runCollabFragment,
  runCollabList,
  runCollabMerge,
} from "../src/commands/collab";
import { runInit } from "../src/commands/init";
import { type Fragment, writeFragment } from "../src/core/collab";
import { PathContainmentError } from "../src/core/paths";
import { failure, renderResult } from "../src/core/output";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");

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

describe("ARCH-003: a path-escape attempt throws a TYPED PathContainmentError the CLI boundary maps to a structured --json failure (no raw stack)", () => {
  it("`th collab fragment --name \"../x\"` throws PathContainmentError with a stable code (not a raw Error)", () => {
    tp = makeTempProject();
    let caught: unknown;
    try {
      runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "../x", text: "REQ-001" });
    } catch (e) {
      caught = e;
    }
    // Before ARCH-003 this was a raw `Error` whose stack escaped the CLI boundary;
    // now it is the typed, code-bearing error the boundary recognizes.
    expect(caught).toBeInstanceOf(PathContainmentError);
    expect((caught as PathContainmentError).code).toBe("path_containment");
    expect((caught as PathContainmentError).segment).toBe("../x");
  });

  it("the CLI boundary mapping turns that throw into a STRUCTURED failure envelope (typed code, sane exit, no stack)", () => {
    tp = makeTempProject();
    // Reproduce the cli.ts top-level boundary mapping exactly: catch the throw and
    // map a PathContainmentError to a structured `failure(...)`. The evidence is that
    // the result is a well-formed --json envelope keyed by the typed error code —
    // never a raw Node stack — with a non-zero, client-reject exit code (2).
    let result: ReturnType<typeof failure> | undefined;
    try {
      runCollabFragment(tp.paths, { stage: "design", round: "r1", name: "../x", text: "REQ-001" });
    } catch (e) {
      if (e instanceof PathContainmentError) {
        result = failure({ human: e.message, data: { error: e.code, segment: e.segment }, exitCode: 2 });
      } else {
        throw e;
      }
    }
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    expect(result!.exitCode).toBe(2);
    expect(result!.data?.error).toBe("path_containment");
    // The --json rendering is the structured envelope, with no stack-trace text.
    const json = JSON.parse(renderResult(result!, true)) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("path_containment");
    expect(JSON.stringify(json)).not.toMatch(/\bat\s+\w+.*\(/); // no "    at fn (file:line)" stack frame
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

describe("R-16: the collision guard holds under a REAL concurrent race (atomic create-or-fail, no silent clobber)", () => {
  // The old `existsSync`-then-`writeFileSync` guard was a check-then-write TOCTOU:
  // two processes could both see `!existsSync` and both write, the second silently
  // clobbering with NO collision error. The single-threaded test above cannot
  // exercise that schedule — so this spawns N REAL `node dist/cli.js collab fragment`
  // processes dropping the SAME stage/round/name at once and asserts EXACTLY ONE wins
  // (exit 0), every loser is REFUSED (`fragment_exists`, exit 1), and the winner's
  // content survives unclobbered. Runs against the COMPILED CLI (dist/cli.js); CI
  // builds before testing, a local run without a build degrades gracefully (skipIf).
  it.skipIf(!fs.existsSync(CLI))("N parallel `collab fragment` with the same name → exactly one succeeds, the rest are refused", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 16;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        execFileP(
          "node",
          [
            CLI, "collab", "fragment",
            "--stage", "design",
            "--round", "r1",
            "--name", "racer.md",
            "--text", `REQ-001 from writer ${i}`,
            "--json",
            "--cwd", tp!.root,
          ],
          { env: { ...process.env, TH_NO_LOG: "1" } },
        ),
      ),
    );

    // execFileP REJECTS on a non-zero exit; a successful write resolves. So exactly
    // one process must resolve (the create winner) and N-1 must reject (collision).
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    // Every loser failed for the RIGHT reason: a structured `fragment_exists`
    // collision, exit 1 — not a crash, a partial write, or a silent success.
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason as { code?: number; stdout?: string };
      expect(err.code).toBe(1);
      const out = JSON.parse(err.stdout ?? "{}") as { ok: boolean; error?: string };
      expect(out.ok).toBe(false);
      expect(out.error).toBe("fragment_exists");
    }

    // The single winner's content is on disk, unclobbered by any racing writer.
    const file = path.join(tp.paths.stateDir, "collab", "design", "r1", "racer.md");
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).toMatch(/^REQ-001 from writer \d+$/);
    const winnerStdout = JSON.parse((fulfilled[0] as PromiseFulfilledResult<{ stdout: string }>).value.stdout) as {
      ok: boolean;
      path?: string;
    };
    expect(winnerStdout.ok).toBe(true);
    expect(winnerStdout.path).toBe(file);
  }, 30_000);
});
