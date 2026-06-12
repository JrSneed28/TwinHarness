import * as fs from "node:fs";
import * as path from "node:path";
import { type CommandResult, success } from "../core/output";

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
