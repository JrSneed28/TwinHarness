import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Plugin-packaging integrity (spec §11 applied to ourselves): the manifests and
 * component files that make TwinHarness installable as a Claude Code plugin are
 * mechanical truths — so they are asserted by code, not by eyeballing.
 *
 * Load-bearing facts these tests pin down:
 * - Marketplace installs COPY the repo into the plugin cache; no build step runs.
 *   Therefore dist/cli.js must exist and must not be gitignored.
 * - `th` is never on the installed user's PATH. Therefore every skill, command,
 *   and agent must carry the `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` invocation
 *   (the variable is substituted inline in skill/agent content by Claude Code).
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;

/** Minimal frontmatter block parser — enough to assert required keys exist. */
function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m || !m[1]) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv && kv[1] && kv[2] !== undefined) out[kv[1]] = kv[2];
  }
  return out;
}

const CLI_INVOCATION = '"${CLAUDE_PLUGIN_ROOT}/dist/cli.js"';

describe("REQ-PLUGIN-001: plugin manifest is valid and complete", () => {
  it("plugin.json parses with required + recommended fields", () => {
    const manifest = readJson(".claude-plugin/plugin.json");
    expect(manifest.name).toBe("twinharness");
    expect(typeof manifest.version).toBe("string");
    expect(typeof manifest.description).toBe("string");
  });

  it("plugin.json version === package.json version", () => {
    const plugin = readJson(".claude-plugin/plugin.json");
    const pkg = readJson("package.json");
    expect(plugin.version).toBe(pkg.version);
  });

  it("marketplace.json parses, and its plugin entry matches plugin.json", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(typeof marketplace.name).toBe("string");
    expect((marketplace.owner as Record<string, unknown>).name).toBeTruthy();
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe(readJson(".claude-plugin/plugin.json").name);
    expect(plugins[0]?.source).toBe("./");
  });
});

describe("REQ-PLUGIN-002: the compiled CLI ships with the plugin", () => {
  it("dist/cli.js exists (build output is part of the deliverable)", () => {
    expect(fs.existsSync(path.join(ROOT, "dist/cli.js"))).toBe(true);
  });

  it("dist/ is NOT gitignored (installs copy the repo; no build step runs)", () => {
    const lines = read(".gitignore")
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).not.toContain("dist/");
    expect(lines).not.toContain("dist");
  });

  it("the Stop hook invokes the shipped CLI via ${CLAUDE_PLUGIN_ROOT}", () => {
    const hooks = readJson("hooks/hooks.json") as {
      hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> };
    };
    const stop = hooks.hooks.Stop[0]?.hooks[0];
    expect(stop?.type).toBe("command");
    expect(stop?.command).toContain(CLI_INVOCATION);
    expect(stop?.command).toContain("hook stop-gate");
  });

  it("hooks.json contains a PreToolUse entry for Write|Edit|NotebookEdit that invokes th hook pretool-gate", () => {
    const hooks = readJson("hooks/hooks.json") as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
      };
    };
    const preToolUseEntries = hooks.hooks.PreToolUse;
    expect(preToolUseEntries).toBeDefined();
    expect(Array.isArray(preToolUseEntries)).toBe(true);

    const writeGateEntry = preToolUseEntries.find(
      (entry) => entry.matcher === "Write|Edit|NotebookEdit",
    );
    expect(writeGateEntry).toBeDefined();

    const hook = writeGateEntry?.hooks[0];
    expect(hook?.type).toBe("command");
    expect(hook?.command).toContain(CLI_INVOCATION);
    expect(hook?.command).toContain("hook pretool-gate");
  });
});

describe("REQ-PLUGIN-003: every component resolves `th` without relying on PATH", () => {
  const skillFiles = ["skills/twinharness/SKILL.md"];
  const commandFiles = fs
    .readdirSync(path.join(ROOT, "commands"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `commands/${f}`);
  const agentFiles = fs
    .readdirSync(path.join(ROOT, "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `agents/${f}`);

  it("expected component counts (7 agents, 4 commands, 1 skill)", () => {
    expect(agentFiles).toHaveLength(7);
    expect(commandFiles).toHaveLength(4);
  });

  it.each([...skillFiles, ...commandFiles, ...agentFiles])(
    "%s carries the ${CLAUDE_PLUGIN_ROOT}/dist/cli.js invocation",
    (rel) => {
      expect(read(rel)).toContain(CLI_INVOCATION);
    },
  );

  it.each(agentFiles)("%s has name + description frontmatter", (rel) => {
    const fm = frontmatter(read(rel));
    expect(fm.name).toBe(path.basename(rel, ".md"));
    expect(fm.description).toBeTruthy();
  });

  it.each(commandFiles)("%s has description frontmatter", (rel) => {
    expect(frontmatter(read(rel)).description).toBeTruthy();
  });

  it("the skill has name + description frontmatter", () => {
    const fm = frontmatter(read("skills/twinharness/SKILL.md"));
    expect(fm.name).toBe("twinharness");
    expect(fm.description).toBeTruthy();
  });
});
