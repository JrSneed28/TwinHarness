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
const repo_1 = require("./repo");
const context_pages_1 = require("./context-pages");
/**
 * Forward-compat top-level state keys that `th doctor --strict` tolerates (#15).
 *
 * `validateState` emits a non-fatal WARNING for any top-level key not in the
 * schema (so a typo like `teir` is visible without rejecting the file). Under
 * `--strict`, an unknown key is escalated to a hard FAIL — UNLESS it is listed
 * here, where it is treated as a known forward-compat field. Start minimal: add a
 * key only when a newer field is intentionally carried by an older binary.
 */
const DOCTOR_STRICT_KEY_ALLOWLIST = new Set([]);
/** Resolve the plugin root from the compiled location (dist/commands → root). */
function pluginRoot() {
    return path.resolve(__dirname, "..", "..");
}
/**
 * R-17 — assert every `package.json files[]` entry exists on disk under the plugin
 * root (the install-integrity surface). A marketplace install copies the repo with
 * NO build step, so a missing `files[]` directory is a broken install that produced
 * no error before this check. Returns a single Check: FAIL if any declared entry is
 * absent (a genuinely incomplete package), else OK with a per-component count
 * summary (templates/schemas/hooks/agents) so the package's shape is visible at a
 * glance. Entry-count of a directory entry = its immediate children; a file entry
 * counts as itself.
 */
function packagingCheck(root, files) {
    if (files.length === 0) {
        return { name: "packaging", status: "warn", detail: "package.json declares no files[] — cannot verify install completeness" };
    }
    const missing = [];
    const counts = [];
    for (const entry of files) {
        const abs = path.join(root, entry);
        let st;
        try {
            st = fs.statSync(abs);
        }
        catch {
            missing.push(entry);
            continue;
        }
        if (st.isDirectory()) {
            let n = 0;
            try {
                n = fs.readdirSync(abs).length;
            }
            catch {
                /* unreadable — count stays 0 */
            }
            counts.push(`${entry}/ (${n})`);
        }
        else {
            counts.push(entry);
        }
    }
    if (missing.length > 0) {
        return {
            name: "packaging",
            status: "fail",
            detail: `INCOMPLETE install — missing package.json files[] entr${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}. A marketplace copy is broken; reinstall the plugin.`,
        };
    }
    return { name: "packaging", status: "ok", detail: `all ${files.length} package files[] present: ${counts.join(", ")}` };
}
function nodeMajor() {
    const m = /^v?(\d+)\./.exec(process.version);
    return m ? Number(m[1]) : 0;
}
/**
 * C-10 — surface project template OVERRIDES that SHADOW a plugin-bundled template.
 *
 * `th template get` resolves a project `.twinharness/templates/<name>` ahead of the
 * plugin-bundled `templates/<name>`, so a same-named file under the project state
 * dir silently supersedes the shipped skeleton. That is a supported feature, but it
 * should be INTENTIONAL and VISIBLE — an accidental stray file there changes what
 * every agent renders. Doctor reports it like the other run-health findings: a WARN
 * naming the shadowed templates when any exist, else OK. Informational only; never a
 * hard fail. `root` is the project root; `pluginDir` is the bundled `templates/` dir.
 */
function templateShadowCheck(root, pluginDir) {
    const projectDir = path.join(root, ".twinharness", "templates");
    const mdFiles = (dir) => {
        try {
            if (!fs.statSync(dir).isDirectory())
                return new Set();
            return new Set(fs.readdirSync(dir, { withFileTypes: true })
                .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
                .map((e) => e.name));
        }
        catch {
            return new Set();
        }
    };
    const overrides = mdFiles(projectDir);
    if (overrides.size === 0) {
        return { name: "templates", status: "ok", detail: "no project template overrides (.twinharness/templates/ — bundled templates in use)" };
    }
    const bundled = mdFiles(pluginDir);
    const shadowed = [...overrides].filter((n) => bundled.has(n)).sort();
    if (shadowed.length === 0) {
        return { name: "templates", status: "ok", detail: `${overrides.size} project template override(s), none shadowing a bundled template` };
    }
    return {
        name: "templates",
        status: "warn",
        detail: `${shadowed.length} project override(s) SHADOW a bundled template (intentional? \`th template get\` resolves these ahead of the shipped skeleton): ${shadowed.join(", ")}`,
    };
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
function ledgerChecks(paths, opts) {
    if (!fs.existsSync((0, ledger_1.ledgerPath)(paths)))
        return [];
    const ledgerEntries = (0, ledger_1.readLedger)(paths);
    const ledgerCount = ledgerEntries.length;
    // Count gate mutations separately from high-water anchors (#8): an anchor is a
    // sealed bookkeeping line, not a gate mutation, so the "gate-mutation entries"
    // figure must exclude it to stay accurate.
    const anchors = ledgerEntries.filter((e) => e.event === "high-water").length;
    const gateMutations = ledgerCount - anchors;
    const out = [
        {
            name: "audit ledger",
            status: "ok",
            detail: `${gateMutations} gate-mutation entr${gateMutations === 1 ? "y" : "ies"}${anchors > 0 ? ` (+${anchors} high-water anchor${anchors === 1 ? "" : "s"})` : ""}`,
        },
    ];
    const chain = (0, ledger_1.verifyLedgerChain)(ledgerEntries);
    if (chain.ok) {
        out.push({ name: "ledger chain", status: "ok", detail: ledgerCount > 0 ? "intact (no tampering detected)" : "no entries to verify" });
    }
    else {
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
        const seals = (0, ledger_1.verifyLedgerSeals)(ledgerEntries, key);
        if (seals.ok) {
            const sealed = ledgerEntries.filter((e) => typeof e.keyedHash === "string").length;
            out.push({ name: "ledger seals", status: "ok", detail: sealed > 0 ? `${sealed} keyed seal(s) verified` : "no keyed seals present" });
        }
        else {
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
function runDoctor(paths, opts = {}) {
    const checks = [];
    // --- Environment ---
    const major = nodeMajor();
    checks.push({
        name: "node",
        status: major >= 20 ? "ok" : "fail",
        detail: major >= 20 ? `${process.version} (>= 20)` : `${process.version} — TwinHarness requires Node >= 20`,
    });
    const root = pluginRoot();
    const distCli = path.join(root, "dist", "cli.js");
    checks.push({
        name: "plugin cli",
        status: fs.existsSync(distCli) ? "ok" : "warn",
        detail: fs.existsSync(distCli) ? distCli : "dist/cli.js not found next to this binary",
    });
    let version = "unknown";
    let pkgFiles = [];
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        if (typeof pkg.version === "string")
            version = pkg.version;
        if (Array.isArray(pkg.files))
            pkgFiles = pkg.files.filter((f) => typeof f === "string");
    }
    catch {
        /* leave unknown */
    }
    checks.push({ name: "version", status: "ok", detail: version });
    // R-17 — package-completeness. A marketplace install COPIES the repo (no build
    // step), so every `package.json files[]` entry — templates/, schemas/, hooks/,
    // agents/, etc. — must be present on disk next to this binary. Doctor previously
    // checked only `dist/cli.js`, so a copy missing `templates/` or `schemas/` passed
    // silently and agents then improvised structure with no mechanical error. Reported
    // in the style of the artifact-drift check: a WARN listing the missing entries, plus
    // a per-dir presence/count summary so an operator can see the package is intact.
    checks.push(packagingCheck(root, pkgFiles));
    // C-10 — project template overrides that shadow a plugin-bundled template. Runs in
    // the environment section (independent of run state) so a stray override is visible
    // even before `th init`. `root` is the plugin root for the bundled `templates/` dir;
    // the project override dir is derived from `paths.root` inside the helper.
    checks.push(templateShadowCheck(paths.root, path.join(root, "templates")));
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
        // finding #1: verify the gate-ledger even when state.json is corrupt — the
        // tamper signal must NOT be suppressed by a (possibly attacker-induced)
        // invalid state. Guarded on the ledger file's existence, not state validity.
        checks.push(...ledgerChecks(paths, opts));
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
        // P6-7 (#18) — write-gate honesty signal. Surface the active write-gate mode
        // AND the guardrail-not-sandbox caveat at the point an operator inspects health.
        // The gate is a guardrail for a COMPLIANT agent, not a security sandbox: a
        // determined/non-compliant agent can still write via an unparsed Bash construct
        // (here-docs, subshells, variable indirection, `python -c`/`node -e`). Make that
        // explicit so nobody mistakes the gate for containment.
        const writeMode = s.write_gate ?? "ask (default)";
        checks.push({
            name: "write gate",
            status: "ok",
            detail: `mode: ${writeMode} — GUARDRAIL for a compliant agent, NOT a security sandbox. ` +
                `The Bash heuristic is conservative and fail-open (unparsed here-docs/subshells/variable ` +
                `indirection and program-mediated writes like \`python -c\`/\`node -e\` bypass it). ` +
                `Do not run TwinHarness against untrusted repos and review \`th verify list\` before \`th verify run\`.`,
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
                detail: `${lockDir} present (${Math.round(age / 1000)}s old) — if no \`th\` process is running, reclaim it with \`th state unlock\` (or \`th state unlock --force\` for a still-live-looking lock)`,
            });
        }
        // Gate-ledger audit (GOV-2) — "audit ledger" count + "ledger chain"
        // tamper-evidence. Via the shared helper so the SAME checks also run when
        // state.json is corrupt (finding #1); see ledgerChecks above.
        checks.push(...ledgerChecks(paths, opts));
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
        // P4-2 (#10) — repo-map freshness, reported like the artifact-drift check above:
        // added/removed/modified counts when the persisted map has drifted from the
        // working tree, plus a distinct PARTIAL signal when the scan was capped (an
        // incomplete map is untrustworthy even when otherwise "fresh"). Read-only; uses
        // the cached freshness check (P4-10). A missing map is informational (warn), not a
        // hard fail — `th repo map` may simply not have been run yet.
        const repo = (0, repo_1.repoFreshnessSummary)(paths);
        if (!repo.mapPresent) {
            checks.push({ name: "repo map", status: "warn", detail: "no repo-map.json — run `th repo map` to build it (relevance/impact/freshness inactive until then)" });
        }
        else if (repo.partial) {
            checks.push({
                name: "repo map",
                status: "warn",
                detail: `PARTIAL scan (cap hit: ${repo.capHit}) — the map is INCOMPLETE; raise the scan caps and re-run \`th repo map\``,
            });
        }
        else if (repo.stale) {
            checks.push({
                name: "repo map",
                status: "warn",
                detail: `STALE — ${repo.added} added, ${repo.removed} removed, ${repo.modified} modified vs the working tree; run \`th repo map\` to refresh`,
            });
        }
        else {
            checks.push({ name: "repo map", status: "ok", detail: "fresh — matches the working tree" });
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
        // #10 — surface the configured verify commands so an operator / security
        // review can see exactly which commands `th verify run` will execute. Additive
        // output; never fails. `th verify run` runs ONLY these pre-configured commands.
        const verifyCfg = (0, verify_1.readVerifyConfig)(paths);
        checks.push({
            name: "verify commands",
            status: "ok",
            detail: verifyCfg.commands.length
                ? `${verifyCfg.commands.length} configured (run by \`th verify run\`): ${verifyCfg.commands.map((c) => `"${c}"`).join(", ")}`
                : "none configured (add with `th verify add \"<command>\"`)",
        });
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
    // #15 — unknown top-level state keys. `validateState` surfaces them as non-fatal
    // warnings (a forward-compat / typo signal). Normal mode keeps that as a WARNING;
    // `--strict` escalates any key NOT in DOCTOR_STRICT_KEY_ALLOWLIST to a hard FAIL,
    // catching typos like `teir`. Threaded through readState's `warnings` so it works
    // whether or not state.json otherwise validates.
    const unknownKeyWarnings = (r.warnings ?? []).filter((w) => w.message.includes("unknown top-level key"));
    if (unknownKeyWarnings.length > 0) {
        const keys = unknownKeyWarnings.map((w) => w.path);
        const offending = keys.filter((k) => !DOCTOR_STRICT_KEY_ALLOWLIST.has(k));
        const allowed = keys.filter((k) => DOCTOR_STRICT_KEY_ALLOWLIST.has(k));
        if (offending.length > 0) {
            checks.push({
                name: "state keys",
                status: opts.strict ? "fail" : "warn",
                detail: `unknown top-level key(s): ${offending.join(", ")}` +
                    (opts.strict
                        ? " — not in the --strict allowlist (a typo like `teir`?)"
                        : " — run `th doctor --strict` to fail on this"),
            });
        }
        else {
            checks.push({
                name: "state keys",
                status: "ok",
                detail: `${allowed.length} allowlisted forward-compat key(s): ${allowed.join(", ")}`,
            });
        }
    }
    // Context-pages cold-store usage (#5): warn when over (or approaching) the
    // configured byte cap so growth is visible before it becomes operationally
    // significant. Fail-safe: any error skips the check rather than failing doctor.
    try {
        const s = (0, context_pages_1.storageReport)(paths);
        const pct = s.max_bytes > 0 ? Math.round((s.cold_bytes / s.max_bytes) * 100) : 0;
        const approaching = pct >= 80;
        checks.push({
            name: "context-pages",
            status: s.over_cap || (approaching && s.cold_objects > 0) ? "warn" : "ok",
            detail: s.cold_objects === 0
                ? "cold store empty (raw persistence is metadata-only by default)"
                : `${s.cold_objects} cold object(s), ${(0, context_pages_1.fmtBytes)(s.cold_bytes)} / ${(0, context_pages_1.fmtBytes)(s.max_bytes)} cap (${pct}%)` +
                    (s.over_cap
                        ? " — OVER CAP, run `th context-pages gc`"
                        : approaching
                            ? " — approaching cap"
                            : ""),
        });
    }
    catch {
        // skip on any error
    }
    const hasFail = checks.some((c) => c.status === "fail");
    const icon = (s) => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
    const human = checks.map((c) => `${icon(c.status)} ${c.name.padEnd(16)} ${c.detail}`).join("\n");
    const result = { checks, ok: !hasFail };
    return hasFail
        ? (0, output_1.failure)({ data: result, human })
        : (0, output_1.success)({ data: result, human });
}
