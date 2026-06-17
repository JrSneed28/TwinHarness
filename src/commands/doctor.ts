import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { CURRENT_SCHEMA_VERSION } from "../core/state-schema";
import { readLedger, verifyLedgerChain, verifyLedgerSeals, ledgerPath } from "../core/ledger";
import { artifactIntegrity, sliceProgress, reviseEscalations } from "../core/health";
import { computeBreakdown } from "../core/coverage";
import { readVerifyReport } from "../core/verify";
import { staleLeases } from "../core/leases";
import { validateDeps, hasDepIssues } from "../core/wave";

/**
 * `th doctor` — self-diagnostic + run-health audit. Reports environment and
 * project health so a user/agent can tell at a glance whether TwinHarness is
 * wired up and whether the current run is in a healthy state. Read-only; never
 * mutates and never runs anything.
 *
 * Beyond environment + state validity it audits the live run: artifact integrity
 * (on-disk hash vs recorded), coverage status, slice progress, revise-loop
 * escalations, blocking drift, stale locks, and the audit ledger.
 *
 * Exit 0 unless a hard failure is present (unsupported Node, invalid state). All
 * run-health findings are warnings — they inform; they do not fail the process.
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

/**
 * The gate-ledger audit checks ("audit ledger" count + "ledger chain"
 * tamper-evidence), computed INDEPENDENTLY of state.json validity (finding #1).
 *
 * These previously lived inside the valid-state `else`, so a corrupt state.json
 * SUPPRESSED the ledger-chain tamper signal — exactly when an attacker who has
 * also corrupted state would most want it hidden. They are now guarded on the
 * ledger FILE's existence (not state validity), so the chain is verified whenever
 * there is a ledger to verify, whether or not state.json parses. Returns `[]` when
 * no ledger file exists — nothing to audit.
 *
 * WARNING by default (the ledger is a best-effort review aid), escalated to FAIL
 * under `--strict`. Legacy (pre-migration, unsealed) lines are NOT a tamper
 * signal — `verifyLedgerChain` verifies only the sealed run.
 */
function ledgerChecks(paths: ProjectPaths, opts: { strict?: boolean }): Check[] {
  if (!fs.existsSync(ledgerPath(paths))) return [];
  const ledgerEntries = readLedger(paths);
  const ledgerCount = ledgerEntries.length;
  // Count gate mutations separately from high-water anchors (#8): an anchor is a
  // sealed bookkeeping line, not a gate mutation, so the "gate-mutation entries"
  // figure must exclude it to stay accurate.
  const anchors = ledgerEntries.filter((e) => e.event === "high-water").length;
  const gateMutations = ledgerCount - anchors;
  const out: Check[] = [
    {
      name: "audit ledger",
      status: "ok",
      detail: `${gateMutations} gate-mutation entr${gateMutations === 1 ? "y" : "ies"}${anchors > 0 ? ` (+${anchors} high-water anchor${anchors === 1 ? "" : "s"})` : ""}`,
    },
  ];
  const chain = verifyLedgerChain(ledgerEntries);
  if (chain.ok) {
    out.push({ name: "ledger chain", status: "ok", detail: ledgerCount > 0 ? "intact (no tampering detected)" : "no entries to verify" });
  } else {
    out.push({
      name: "ledger chain",
      status: opts.strict ? "fail" : "warn",
      detail: `BROKEN at entry ${chain.brokenAt} (${chain.reason}) — a sealed entry was edited, deleted, or reordered${opts.strict ? "" : " (run \`th doctor --strict\` to fail on this)"}`,
    });
  }

  // Keyed-seal verification (#8) — ONLY when TH_LEDGER_KEY is set. WARN-ONLY (even
  // under --strict): a per-environment key difference or the wrong key must never
  // turn a committed ledger red, so a mismatch informs rather than fails. The
  // in-chain `high-water` anchor needs NO separate check — it is a sealed entry like
  // any other, verified by the chain walk above; do NOT add a circular
  // `count <= sealed-run-length` comparison (it cannot detect truncation — see
  // appendHighWater / the #8 threat model).
  const key = process.env.TH_LEDGER_KEY;
  if (key) {
    const seals = verifyLedgerSeals(ledgerEntries, key);
    if (seals.ok) {
      const sealed = ledgerEntries.filter((e) => typeof e.keyedHash === "string").length;
      out.push({ name: "ledger seals", status: "ok", detail: sealed > 0 ? `${sealed} keyed seal(s) verified` : "no keyed seals present" });
    } else {
      const where = seals.mismatches.map((m) => `entry ${m.index} (${m.event})`).join(", ");
      out.push({ name: "ledger seals", status: "warn", detail: `keyed-seal MISMATCH at ${where} — wrong TH_LEDGER_KEY or a sealed field was tampered (warn-only)` });
    }
  }
  return out;
}

/**
 * @param opts.strict When true, a gate-ledger chain break is escalated from a
 *   WARNING to a hard FAIL (non-zero exit). Default (false) keeps it a warning —
 *   the ledger is a best-effort review aid, so a broken chain informs rather than
 *   fails the run. Mirrors `runAnchorsScan`'s `strict` opt-in (the `--strict`
 *   flag); wiring `--strict` through `th doctor` at the CLI layer is left to the
 *   cli.ts owner — this function honors the signal today.
 */
export function runDoctor(paths: ProjectPaths, opts: { strict?: boolean } = {}): CommandResult {
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

  // Claude Code compatibility expectation. Informational only: this binary can't
  // observe the host Claude Code version, so it reports the contract the plugin
  // is built against (declared in .claude-plugin/plugin.json `metadata`). A
  // warning so it's visible, but it never fails the process.
  checks.push({
    name: "claude code",
    status: "warn",
    detail: "plugin targets Claude Code >=1.0.0 (hook+agent schema v1) — informational, not host-checked",
  });

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
    // finding #1: verify the gate-ledger even when state.json is corrupt — the
    // tamper signal must NOT be suppressed by a (possibly attacker-induced)
    // invalid state. Guarded on the ledger file's existence, not state validity.
    checks.push(...ledgerChecks(paths, opts));
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

    // Gate-ledger audit (GOV-2) — "audit ledger" count + "ledger chain"
    // tamper-evidence. Via the shared helper so the SAME checks also run when
    // state.json is corrupt (finding #1); see ledgerChecks above.
    checks.push(...ledgerChecks(paths, opts));

    // --- Run health (read-only; warnings only) ---

    // Artifact integrity: on-disk hash vs the recorded approved hash.
    const integrity = artifactIntegrity(paths, s);
    if (integrity.length === 0) {
      checks.push({ name: "artifacts", status: "ok", detail: "no artifacts registered yet" });
    } else {
      const changed = integrity.filter((i) => i.status === "changed");
      const missing = integrity.filter((i) => i.status === "missing");
      const drifted = [...changed, ...missing];
      checks.push({
        name: "artifacts",
        status: drifted.length > 0 ? "warn" : "ok",
        detail:
          drifted.length > 0
            ? `${changed.length} changed, ${missing.length} missing — re-register or run \`th stale --artifact <file>\`: ${drifted.map((i) => i.file).join(", ")}`
            : `${integrity.length} registered, all match recorded hashes`,
      });
    }

    // Slice progress.
    const prog = sliceProgress(s);
    if (prog.total === 0) {
      checks.push({ name: "slices", status: "ok", detail: "no slices synced yet" });
    } else {
      const unfinished = prog.pending + prog.inProgress;
      checks.push({
        name: "slices",
        status: unfinished > 0 ? "warn" : "ok",
        detail: `${prog.done} done / ${prog.blocked} blocked / ${prog.inProgress} in-progress / ${prog.pending} pending (of ${prog.total})`,
      });

      // Dependency graph: a cycle or dangling ref deadlocks `th build next-wave`.
      const deps = validateDeps(s.slices);
      if (hasDepIssues(deps)) {
        const parts = [
          ...deps.cycles.map((c) => `cycle ${c.join("→")}`),
          ...deps.dangling.map((d) => `${d.slice}→unknown ${d.missing.join(",")}`),
        ];
        checks.push({ name: "slice deps", status: "warn", detail: `unsatisfiable depends_on — will stall next-wave: ${parts.join("; ")}` });
      } else {
        checks.push({ name: "slice deps", status: "ok", detail: "depends_on graph is acyclic with no dangling refs" });
      }

      // Stale component leases: a lease whose owning slice has settled/vanished.
      const stale = staleLeases(paths, s.slices);
      if (stale.length > 0) {
        checks.push({
          name: "build leases",
          status: "warn",
          detail: `${stale.length} stale lease(s) (owning slice done/blocked/missing) — \`th build release <ID>\`: ${stale.map((l) => l.slice).join(", ")}`,
        });
      }
    }

    // Coverage status (best-effort; never a gate here).
    const breakdown = computeBreakdown(paths.root);
    if ("error" in breakdown) {
      checks.push({ name: "coverage", status: "ok", detail: "requirements not authored yet" });
    } else if (breakdown.total === 0) {
      checks.push({ name: "coverage", status: "ok", detail: "no REQ-IDs found in requirements" });
    } else {
      const fullyMapped = breakdown.rows.filter((r) => r.planned && r.tested).length;
      const report = readVerifyReport(paths);
      const passing = report ? (report.ok ? "suite green" : "suite FAILING") : "suite unknown (run `th verify run`)";
      checks.push({
        name: "coverage",
        status: fullyMapped < breakdown.total ? "warn" : "ok",
        detail: `${fullyMapped}/${breakdown.total} planned+tested; ${breakdown.implemented}/${breakdown.total} implemented; ${passing}`,
      });
    }

    // Revise-loop escalations (cap reached → human owes a decision).
    const escalations = reviseEscalations(s);
    if (escalations.length > 0) {
      checks.push({
        name: "revise loops",
        status: "warn",
        detail: `at cap (escalate to human): ${escalations.map((e) => `${e.mode} ${e.count}/${e.cap}`).join(", ")}`,
      });
    } else {
      checks.push({ name: "revise loops", status: "ok", detail: "none at cap" });
    }
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const icon = (s: CheckStatus): string => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
  const human = checks.map((c) => `${icon(c.status)} ${c.name.padEnd(16)} ${c.detail}`).join("\n");

  const result = { checks, ok: !hasFail };
  return hasFail
    ? failure({ data: result, human })
    : success({ data: result, human });
}
