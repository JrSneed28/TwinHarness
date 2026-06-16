"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDoctor = runDoctor;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const state_schema_1 = require("../core/state-schema");
const ledger_1 = require("../core/ledger");
const health_1 = require("../core/health");
const coverage_1 = require("../core/coverage");
const verify_1 = require("../core/verify");
const leases_1 = require("../core/leases");
const wave_1 = require("../core/wave");
/** Resolve the plugin root from the compiled location (dist/commands → root). */
function pluginRoot() {
    return path.resolve(__dirname, "..", "..");
}
function nodeMajor() {
    const m = /^v?(\d+)\./.exec(process.version);
    return m ? Number(m[1]) : 0;
}
/**
 * @param opts.strict When true, a gate-ledger chain break is escalated from a
 *   WARNING to a hard FAIL (non-zero exit). Default (false) keeps it a warning —
 *   the ledger is a best-effort review aid, so a broken chain informs rather than
 *   fails the run. Mirrors `runAnchorsScan`'s `strict` opt-in (the `--strict`
 *   flag); wiring `--strict` through `th doctor` at the CLI layer is left to the
 *   cli.ts owner — this function honors the signal today.
 */
function runDoctor(paths, opts = {}) {
    const checks = [];
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
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        if (typeof pkg.version === "string")
            version = pkg.version;
    }
    catch {
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
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists) {
        checks.push({ name: "project", status: "ok", detail: "no TwinHarness run in this directory (gates inactive — fail-open)" });
    }
    else if (!r.state) {
        checks.push({
            name: "state.json",
            status: "fail",
            detail: `present but INVALID: ${(r.issues ?? []).map((i) => `${i.path}: ${i.message}`).join("; ") || "schema mismatch"}`,
        });
    }
    else {
        const s = r.state;
        checks.push({ name: "state.json", status: "ok", detail: `valid (tier ${s.tier ?? "unclassified"}, stage ${s.current_stage})` });
        const sv = s.schema_version;
        checks.push({
            name: "schema",
            status: sv === state_schema_1.CURRENT_SCHEMA_VERSION ? "ok" : "warn",
            detail: sv === state_schema_1.CURRENT_SCHEMA_VERSION
                ? `v${sv} (current)`
                : `${sv === undefined ? "legacy (unversioned)" : `v${sv}`} — run \`th migrate\` to reach v${state_schema_1.CURRENT_SCHEMA_VERSION}`,
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
            }
            catch {
                /* ignore */
            }
            checks.push({
                name: "state lock",
                status: "warn",
                detail: `${lockDir} present (${Math.round(age / 1000)}s old) — remove it if no \`th\` process is running`,
            });
        }
        const ledgerEntries = (0, ledger_1.readLedger)(paths);
        const ledgerCount = ledgerEntries.length;
        checks.push({ name: "audit ledger", status: "ok", detail: `${ledgerCount} gate-mutation entr${ledgerCount === 1 ? "y" : "ies"}` });
        // Tamper-evidence (GOV-2): verify the gate-ledger's hash chain. A break means
        // a sealed entry was edited/backdated, deleted, or reordered. WARNING by
        // default (the ledger is a best-effort review aid), escalated to FAIL under
        // strict. Legacy (pre-migration, unsealed) lines are NOT a tamper signal —
        // `verifyLedgerChain` verifies only the sealed run.
        const chain = (0, ledger_1.verifyLedgerChain)(ledgerEntries);
        if (chain.ok) {
            checks.push({ name: "ledger chain", status: "ok", detail: ledgerCount > 0 ? "intact (no tampering detected)" : "no entries to verify" });
        }
        else {
            checks.push({
                name: "ledger chain",
                status: opts.strict ? "fail" : "warn",
                detail: `BROKEN at entry ${chain.brokenAt} (${chain.reason}) — a sealed entry was edited, deleted, or reordered${opts.strict ? "" : " (run \`th doctor --strict\` to fail on this)"}`,
            });
        }
        // --- Run health (read-only; warnings only) ---
        // Artifact integrity: on-disk hash vs the recorded approved hash.
        const integrity = (0, health_1.artifactIntegrity)(paths, s);
        if (integrity.length === 0) {
            checks.push({ name: "artifacts", status: "ok", detail: "no artifacts registered yet" });
        }
        else {
            const changed = integrity.filter((i) => i.status === "changed");
            const missing = integrity.filter((i) => i.status === "missing");
            const drifted = [...changed, ...missing];
            checks.push({
                name: "artifacts",
                status: drifted.length > 0 ? "warn" : "ok",
                detail: drifted.length > 0
                    ? `${changed.length} changed, ${missing.length} missing — re-register or run \`th stale --artifact <file>\`: ${drifted.map((i) => i.file).join(", ")}`
                    : `${integrity.length} registered, all match recorded hashes`,
            });
        }
        // Slice progress.
        const prog = (0, health_1.sliceProgress)(s);
        if (prog.total === 0) {
            checks.push({ name: "slices", status: "ok", detail: "no slices synced yet" });
        }
        else {
            const unfinished = prog.pending + prog.inProgress;
            checks.push({
                name: "slices",
                status: unfinished > 0 ? "warn" : "ok",
                detail: `${prog.done} done / ${prog.blocked} blocked / ${prog.inProgress} in-progress / ${prog.pending} pending (of ${prog.total})`,
            });
            // Dependency graph: a cycle or dangling ref deadlocks `th build next-wave`.
            const deps = (0, wave_1.validateDeps)(s.slices);
            if ((0, wave_1.hasDepIssues)(deps)) {
                const parts = [
                    ...deps.cycles.map((c) => `cycle ${c.join("→")}`),
                    ...deps.dangling.map((d) => `${d.slice}→unknown ${d.missing.join(",")}`),
                ];
                checks.push({ name: "slice deps", status: "warn", detail: `unsatisfiable depends_on — will stall next-wave: ${parts.join("; ")}` });
            }
            else {
                checks.push({ name: "slice deps", status: "ok", detail: "depends_on graph is acyclic with no dangling refs" });
            }
            // Stale component leases: a lease whose owning slice has settled/vanished.
            const stale = (0, leases_1.staleLeases)(paths, s.slices);
            if (stale.length > 0) {
                checks.push({
                    name: "build leases",
                    status: "warn",
                    detail: `${stale.length} stale lease(s) (owning slice done/blocked/missing) — \`th build release <ID>\`: ${stale.map((l) => l.slice).join(", ")}`,
                });
            }
        }
        // Coverage status (best-effort; never a gate here).
        const breakdown = (0, coverage_1.computeBreakdown)(paths.root);
        if ("error" in breakdown) {
            checks.push({ name: "coverage", status: "ok", detail: "requirements not authored yet" });
        }
        else if (breakdown.total === 0) {
            checks.push({ name: "coverage", status: "ok", detail: "no REQ-IDs found in requirements" });
        }
        else {
            const fullyMapped = breakdown.rows.filter((r) => r.planned && r.tested).length;
            const report = (0, verify_1.readVerifyReport)(paths);
            const passing = report ? (report.ok ? "suite green" : "suite FAILING") : "suite unknown (run `th verify run`)";
            checks.push({
                name: "coverage",
                status: fullyMapped < breakdown.total ? "warn" : "ok",
                detail: `${fullyMapped}/${breakdown.total} planned+tested; ${breakdown.implemented}/${breakdown.total} implemented; ${passing}`,
            });
        }
        // Revise-loop escalations (cap reached → human owes a decision).
        const escalations = (0, health_1.reviseEscalations)(s);
        if (escalations.length > 0) {
            checks.push({
                name: "revise loops",
                status: "warn",
                detail: `at cap (escalate to human): ${escalations.map((e) => `${e.mode} ${e.count}/${e.cap}`).join(", ")}`,
            });
        }
        else {
            checks.push({ name: "revise loops", status: "ok", detail: "none at cap" });
        }
    }
    const hasFail = checks.some((c) => c.status === "fail");
    const icon = (s) => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
    const human = checks.map((c) => `${icon(c.status)} ${c.name.padEnd(16)} ${c.detail}`).join("\n");
    const result = { checks, ok: !hasFail };
    return hasFail
        ? (0, output_1.failure)({ data: result, human })
        : (0, output_1.success)({ data: result, human });
}
