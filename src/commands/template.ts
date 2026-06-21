import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { isAbsoluteOrEscaping } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { structuredLog } from "../core/log";

/**
 * `th template get|list` — the deterministic template resolver (C-10).
 *
 * Agents previously cited bare `templates/X` paths in their prompts, but
 * `templates/` is SHIPPED only at `${pluginRoot}/templates/` (package.json
 * `files[]`); it is NOT copied into a project by `th init`, and does not exist in
 * a Builder worktree at all. A bare `Read templates/04a-ux-design.md` therefore
 * silently misresolved against the agent cwd. This resolver gives agents one
 * mechanical surface that knows WHERE templates live, with an explicit precedence
 * and a structured miss — no directory probing or guessing.
 *
 * Precedence (first hit wins; both layers are tried in order):
 *   ① `${projectRoot}/.twinharness/templates/<name>`  → source "project-override"
 *   ② `${pluginRoot}/templates/<name>`                → source "plugin-bundled"
 *   ③ structured `{ error: "template_not_found", searched: [<①>, <②>] }`
 *
 * It records and computes; it never writes (plan §3 boundary rule).
 */

/** The bundled template file extension. A bare name (`task-file`) gets it appended. */
const TEMPLATE_EXT = ".md";

/** Project-override template dir, relative to the project root (first-segment `.twinharness`). */
const PROJECT_TEMPLATE_REL = path.join(".twinharness", "templates");
/** Bundled template dir, relative to the plugin root. */
const PLUGIN_TEMPLATE_REL = "templates";

/**
 * Resolve the plugin root. Prefer the `CLAUDE_PLUGIN_ROOT` env the harness sets
 * for an enabled plugin; fall back to the compiled location (dist/commands →
 * root). Mirrors `doctor.ts` / `context.ts` `pluginRoot()` plus the env override
 * the manifest/packaging surfaces honor.
 */
export function pluginRoot(): string {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof env === "string" && env.length > 0) return path.resolve(env);
  return path.resolve(__dirname, "..", "..");
}

/**
 * Normalize a caller-supplied template name to its bundled filename, or reject it.
 *
 * A template name is a BARE filename — a single path component, optionally already
 * carrying the bundled `.md` extension. Callers may pass either `task-file` or
 * `task-file.md`; both resolve to `task-file.md`. We reject anything that is not a
 * single safe component: absolute paths, drive/UNC roots, any `..` segment (via the
 * pure cross-platform {@link isAbsoluteOrEscaping}), and any embedded path separator
 * — so a name can never escape the template dir on either platform.
 *
 * Returns the normalized `<name>.md` filename, or `null` when the name is unsafe.
 */
export function normalizeTemplateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  // Reject absolute / drive / UNC / any `..` segment, host-independently.
  if (isAbsoluteOrEscaping(trimmed)) return null;
  // A template name is a single component: no separators of either kind.
  if (/[\\/]/.test(trimmed)) return null;
  // Defense in depth: a leading dot (`.`/`..`) or empty component is not a name.
  if (trimmed === "." || trimmed === "..") return null;
  return trimmed.toLowerCase().endsWith(TEMPLATE_EXT) ? trimmed : trimmed + TEMPLATE_EXT;
}

/** A successful resolution: where the template was found, its bytes, and the layer. */
export interface TemplateResolution {
  /** Absolute path to the resolved template file. */
  path: string;
  /** The template's content (UTF-8). */
  content: string;
  /** Which layer satisfied the lookup. */
  source: "project-override" | "plugin-bundled";
}

/** A failed resolution: the two absolute paths that were tried, in precedence order. */
export interface TemplateMiss {
  error: "template_not_found";
  searched: string[];
}

/**
 * Pure resolver: try the project override, then the plugin bundle, with no probing.
 * Returns the resolution on the first hit, or a structured miss listing exactly the
 * two absolute paths that were checked. `name` MUST be a normalized filename (see
 * {@link normalizeTemplateName}); callers sanitize before reaching here.
 */
export function resolve(name: string, projectRoot: string, plugin: string): TemplateResolution | TemplateMiss {
  const projectPath = path.join(projectRoot, PROJECT_TEMPLATE_REL, name);
  const pluginPath = path.join(plugin, PLUGIN_TEMPLATE_REL, name);
  for (const [abs, source] of [
    [projectPath, "project-override"],
    [pluginPath, "plugin-bundled"],
  ] as const) {
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) return { path: abs, content: fs.readFileSync(abs, "utf8"), source };
    } catch {
      // Not present at this layer — fall through to the next.
    }
  }
  return { error: "template_not_found", searched: [projectPath, pluginPath] };
}

/**
 * `th template get <name>` — resolve one template by name and return its path,
 * content, and source layer. A traversal/absolute name is refused (not resolved);
 * a missing template returns the structured `template_not_found` with the searched
 * paths so the caller sees exactly where it looked.
 */
export function runTemplateGet(paths: ProjectPaths, name: string | undefined): CommandResult {
  if (name === undefined || name.trim() === "") {
    structuredLog({ cmd: "template get", error: "missing_name" });
    return failure({ human: "usage: th template get <name>", data: { error: "missing_name" } });
  }
  const normalized = normalizeTemplateName(name);
  if (normalized === null) {
    structuredLog({ cmd: "template get", name, error: "invalid_name" });
    return failure({
      human: `Refusing an unsafe template name: ${name}. A template name is a bare filename (e.g. \`task-file\` or \`task-file.md\`).`,
      data: { error: "invalid_name", name },
    });
  }

  const r = resolve(normalized, paths.root, pluginRoot());
  if ("error" in r) {
    structuredLog({ cmd: "template get", name: normalized, error: "template_not_found" });
    return failure({
      human:
        `Template not found: ${normalized}. Searched (in precedence order):\n` +
        r.searched.map((p) => `  - ${p}`).join("\n"),
      data: { error: "template_not_found", name: normalized, searched: r.searched },
    });
  }

  structuredLog({ cmd: "template get", name: normalized, source: r.source });
  return success({
    data: { name: normalized, path: r.path, source: r.source, content: r.content },
    human: r.content,
  });
}

/** A listed template: its name, the layer it resolves from, and whether it shadows a bundled one. */
export interface TemplateListing {
  name: string;
  source: "project-override" | "plugin-bundled";
  /** True for a project override that shadows a same-named plugin-bundled template. */
  shadowsBundled?: boolean;
}

/** Enumerate the `.md` template files directly under `dir` (non-recursive; templates are flat). */
function listTemplateDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(TEMPLATE_EXT))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * `th template list` — enumerate every resolvable template across both layers,
 * deduped with the SAME precedence the resolver uses: a project override wins its
 * name and is marked `shadowsBundled` when a bundled template of the same name
 * exists. Sorted by name for deterministic output.
 */
export function runTemplateList(paths: ProjectPaths): CommandResult {
  const projectDir = path.join(paths.root, PROJECT_TEMPLATE_REL);
  const pluginDir = path.join(pluginRoot(), PLUGIN_TEMPLATE_REL);
  const projectNames = new Set(listTemplateDir(projectDir));
  const pluginNames = new Set(listTemplateDir(pluginDir));

  const byName = new Map<string, TemplateListing>();
  // Bundled first, then let overrides supersede — so `source` reflects what `get` returns.
  for (const name of pluginNames) byName.set(name, { name, source: "plugin-bundled" });
  for (const name of projectNames) {
    byName.set(name, { name, source: "project-override", shadowsBundled: pluginNames.has(name) });
  }

  const templates = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const shadowed = templates.filter((t) => t.shadowsBundled).map((t) => t.name);

  structuredLog({ cmd: "template list", count: templates.length, overrides: projectNames.size, shadowed: shadowed.length });

  const human =
    templates.length === 0
      ? `No templates found. Searched:\n  - ${projectDir}\n  - ${pluginDir}`
      : [
          `${templates.length} template(s) (resolve with \`th template get <name>\`):`,
          ...templates.map(
            (t) => `  ${t.name}  [${t.source}]${t.shadowsBundled ? " (shadows bundled)" : ""}`,
          ),
        ].join("\n");

  return success({ data: { templates, count: templates.length }, human });
}
