import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { extractSummary } from "../core/summary";
import { structuredLog } from "../core/log";

/**
 * `th context estimate` — approximate the context/token cost of the plugin's
 * prompt surface (Phase 3; the Goose/Windsurf "no token visibility" gap, and
 * the lever for audit F7). Heuristic only: ~4 chars per token. Flags prompt
 * files that exceed Claude Code's guidance (SKILL/agent bodies < ~500 lines;
 * invoked skills are re-attached keeping only the first ~5,000 tokens after
 * compaction, so a body past that can lose its tail on long runs).
 *
 * Read-only; resolves files relative to the plugin root, not the user's project.
 */

const TOKENS_PER_CHAR = 1 / 4;
const LINE_WARN = 500;
const TOKEN_WARN = 5000;

interface FileEstimate {
  file: string;
  lines: number;
  tokens: number;
  flag: boolean;
}

/** Plugin root from the compiled location (dist/commands → root). */
function pluginRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function listMd(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function estimate(root: string, abs: string): FileEstimate {
  const content = fs.readFileSync(abs, "utf8");
  const lines = content.split(/\r?\n/).length;
  const tokens = Math.round(content.length * TOKENS_PER_CHAR);
  return {
    file: path.relative(root, abs).split(path.sep).join("/"),
    lines,
    tokens,
    flag: lines > LINE_WARN || tokens > TOKEN_WARN,
  };
}

/**
 * `th context estimate` — report per-file and total approximate token cost of
 * the orchestration prompt surface (skill + reference files + agents + commands).
 */
export function runContextEstimate(): CommandResult {
  const root = pluginRoot();
  const files = [
    ...listMd(path.join(root, "skills")),
    ...listMd(path.join(root, "agents")),
    ...listMd(path.join(root, "commands")),
  ]
    .map((abs) => estimate(root, abs))
    .sort((a, b) => b.tokens - a.tokens);

  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  const flagged = files.filter((f) => f.flag);

  const rows = files.map(
    (f) => `${f.flag ? "!" : " "} ${String(f.tokens).padStart(6)} tok  ${String(f.lines).padStart(4)} ln  ${f.file}`,
  );
  const human = [
    "Approximate prompt-surface context cost (~4 chars/token):",
    ...rows,
    "",
    `Total: ~${totalTokens} tokens across ${files.length} prompt files.`,
    flagged.length
      ? `${flagged.length} file(s) exceed the guidance (>${LINE_WARN} lines or >${TOKEN_WARN} tokens): ${flagged.map((f) => f.file).join(", ")}`
      : `All prompt files are within the ${LINE_WARN}-line / ${TOKEN_WARN}-token guidance.`,
  ].join("\n");

  return success({
    data: { files, totalTokens, flagged: flagged.map((f) => f.file), lineWarn: LINE_WARN, tokenWarn: TOKEN_WARN },
    human,
  });
}

/* ------------------------------------------------------------------ *
 * `th context pack` — assemble a slice/agent handoff bundle (spec §9). *
 * ------------------------------------------------------------------ */

export interface ContextPackOptions {
  /** Limit/annotate the pack for a specific slice (SLICE-ID). */
  slice?: string;
}

interface PackedArtifact {
  file: string;
  version: number;
  summary: string | null;
  /** The text actually included (Summary block, head fallback, or directory note). */
  text: string;
  tokens: number;
  exists: boolean;
  isDir: boolean;
}

/**
 * `th context pack [--slice <SLICE-ID>]` — mechanically assemble the §9 handoff
 * bundle: the Summary block of every approved artifact (the handoff currency),
 * plus, when `--slice` is given, that slice's record, its components, and the
 * other slices that share those components (conflict awareness for §16).
 *
 * It COMPUTES a candidate bundle from durable state + artifact summaries; it does
 * NOT decide what to route — the Orchestrator still owns that call. Read-only.
 */
export function runContextPack(paths: ProjectPaths, opts: ContextPackOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return failure({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
  if (!r.state) return failure({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });
  const s = r.state;

  const packed: PackedArtifact[] = s.approved_artifacts.map((a) => {
    const abs = path.resolve(paths.root, a.file);
    let exists = false;
    let isDir = false;
    let content = "";
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        exists = true;
        content = fs.readFileSync(abs, "utf8");
      } else if (stat.isDirectory()) {
        // Directory artifacts (e.g. docs/05-adrs/) have no single Summary block.
        exists = true;
        isDir = true;
      }
    }
    const { summary, head } = extractSummary(content);
    const text = isDir ? `(directory artifact — read ${a.file}/ on demand)` : summary ?? head;
    return { file: a.file, version: a.version, summary, text, tokens: Math.round(text.length / 4), exists, isDir };
  });

  // Slice-specific framing.
  let sliceBlock: { id: string; status: string; components: string[]; sharesWith: Array<{ id: string; shared: string[] }> } | undefined;
  if (opts.slice) {
    const target = s.slices.find((sl) => sl.id === opts.slice);
    if (!target) {
      return failure({
        human: `Unknown slice: ${opts.slice}. Known: ${s.slices.map((sl) => sl.id).join(", ") || "(none)"}`,
        data: { error: "unknown_slice", slice: opts.slice },
      });
    }
    const components = new Set(target.components);
    const sharesWith = s.slices
      .filter((sl) => sl.id !== target.id)
      .map((sl) => ({ id: sl.id, shared: sl.components.filter((c) => components.has(c)) }))
      .filter((x) => x.shared.length > 0);
    sliceBlock = { id: target.id, status: target.status, components: target.components, sharesWith };
  }

  const totalTokens = packed.reduce((sum, p) => sum + p.tokens, 0);
  structuredLog({ cmd: "context pack", slice: opts.slice ?? null, artifacts: packed.length, tokens: totalTokens });

  const header = opts.slice
    ? `Context pack for ${opts.slice} — ${packed.length} artifact summary block(s), ~${totalTokens} tokens`
    : `Context pack — ${packed.length} artifact summary block(s), ~${totalTokens} tokens`;

  const sliceLines = sliceBlock
    ? [
        "",
        `Slice ${sliceBlock.id} [${sliceBlock.status}] — components: ${sliceBlock.components.join(", ") || "(none)"}`,
        sliceBlock.sharesWith.length
          ? `  Shares components with (serialize per §16): ${sliceBlock.sharesWith.map((x) => `${x.id} (${x.shared.join(", ")})`).join("; ")}`
          : "  No component overlap with other slices (safe to parallelize).",
      ]
    : [];

  const artifactLines =
    packed.length === 0
      ? ["", "(no approved artifacts yet — nothing to pack)"]
      : packed.flatMap((p) => [
          "",
          `### ${p.file} (v${p.version})${p.exists ? "" : " — MISSING ON DISK"}${p.summary === null && p.exists && !p.isDir ? " — no Summary block (head shown)" : ""}`,
          p.text || "(empty)",
        ]);

  const human = [header, ...sliceLines, ...artifactLines].join("\n");

  return success({
    data: { slice: sliceBlock ?? null, artifacts: packed, totalTokens },
    human,
  });
}
