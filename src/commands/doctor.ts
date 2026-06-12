import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { CURRENT_SCHEMA_VERSION } from "../core/state-schema";
import { readLedger } from "../core/ledger";

/**
 * `th doctor` — self-diagnostic (Phase 3). Reports environment and project
 * health so a user/agent can tell at a glance whether TwinHarness is wired up
 * and whether the current run is in a healthy state. Read-only; never mutates.
 *
 * Exit 0 unless a hard failure is present (unsupported Node, invalid state).
 */

type CheckStatus = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Resolve the plugin root from the compiled location (dist/commands → root). */
function pluginRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function nodeMajor(): number {
  const m = /^v?(\d+)\./.exec(process.version);
  return m ? Number(m[1]) : 0;
}

export function runDoctor(paths: ProjectPaths): CommandResult {
  const checks: Check[] = [];

  // --- Environment ---
  const major = nodeMajor();
  checks.push({
    name: "node",
    status: major >= 18 ? "ok" : "fail",
    detail: major >= 18 ? `${process.version} (>= 18)` : `${process.version} — TwinHarness requires Node >= 18`,
  });

  const root = pluginRoot();
  const distCli = path.join(root, "dist", "cli.js");
  checks.push({
    name: "plugin cli",
    status: fs.existsSync(distCli) ? "ok" : "warn",
    detail: fs.existsSync(distCli) ? distCli : "dist/cli.js not found next to this binary",
  });

  let version = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    /* leave unknown */
  }
  checks.push({ name: "version", status: "ok", detail: version });

  // --- Project ---
  const r = readState(paths);
  if (!r.exists) {
    checks.push({ name: "project", status: "ok", detail: "no TwinHarness run in this directory (gates inactive — fail-open)" });
  } else if (!r.state) {
    checks.push({
      name: "state.json",
      status: "fail",
      detail: `present but INVALID: ${(r.issues ?? []).map((i) => `${i.path}: ${i.message}`).join("; ") || "schema mismatch"}`,
    });
  } else {
    const s = r.state;
    checks.push({ name: "state.json", status: "ok", detail: `valid (tier ${s.tier ?? "unclassified"}, stage ${s.current_stage})` });

    const sv = s.schema_version;
    checks.push({
      name: "schema",
      status: sv === CURRENT_SCHEMA_VERSION ? "ok" : "warn",
      detail:
        sv === CURRENT_SCHEMA_VERSION
          ? `v${sv} (current)`
          : `${sv === undefined ? "legacy (unversioned)" : `v${sv}`} — run \`th migrate\` to reach v${CURRENT_SCHEMA_VERSION}`,
    });

    checks.push({
      name: "blocking drift",
      status: s.drift_open_blocking > 0 ? "warn" : "ok",
      detail: s.drift_open_blocking > 0 ? `${s.drift_open_blocking} open — stop-gate will block completion` : "none",
    });

    // Stale lock from a crashed `th` process.
    const lockDir = path.join(paths.stateDir, ".state.lock");
    if (fs.existsSync(lockDir)) {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockDir).mtimeMs;
      } catch {
        /* ignore */
      }
      checks.push({
        name: "state lock",
        status: "warn",
        detail: `${lockDir} present (${Math.round(age / 1000)}s old) — remove it if no \`th\` process is running`,
      });
    }

    const ledgerCount = readLedger(paths).length;
    checks.push({ name: "audit ledger", status: "ok", detail: `${ledgerCount} gate-mutation entr${ledgerCount === 1 ? "y" : "ies"}` });
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const icon = (s: CheckStatus): string => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
  const human = checks.map((c) => `${icon(c.status)} ${c.name.padEnd(16)} ${c.detail}`).join("\n");

  const result = { checks, ok: !hasFail };
  return hasFail
    ? failure({ data: result, human })
    : success({ data: result, human });
}
