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
/** Resolve the plugin root from the compiled location (dist/commands → root). */
function pluginRoot() {
    return path.resolve(__dirname, "..", "..");
}
function nodeMajor() {
    const m = /^v?(\d+)\./.exec(process.version);
    return m ? Number(m[1]) : 0;
}
function runDoctor(paths) {
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
        const ledgerCount = (0, ledger_1.readLedger)(paths).length;
        checks.push({ name: "audit ledger", status: "ok", detail: `${ledgerCount} gate-mutation entr${ledgerCount === 1 ? "y" : "ies"}` });
    }
    const hasFail = checks.some((c) => c.status === "fail");
    const icon = (s) => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
    const human = checks.map((c) => `${icon(c.status)} ${c.name.padEnd(16)} ${c.detail}`).join("\n");
    const result = { checks, ok: !hasFail };
    return hasFail
        ? (0, output_1.failure)({ data: result, human })
        : (0, output_1.success)({ data: result, human });
}
