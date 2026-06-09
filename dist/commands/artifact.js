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
exports.runArtifactRegister = runArtifactRegister;
exports.runArtifactList = runArtifactList;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const hash_1 = require("../core/hash");
const log_1 = require("../core/log");
/**
 * `th artifact` — content-hash and record an approved, versioned artifact
 * (spec §12: "each artifact is versioned with a content hash referenced by
 * state.json"; §18 `approved_artifacts`).
 *
 * Mechanical only (plan §3 boundary rule): the CLI computes a deterministic
 * content hash and records the version it is told. It never decides *whether* an
 * artifact is approved — the caller supplies the version when it approves.
 */
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
const NOT_INIT = (0, output_1.failure)({
    human: "No state.json found. Run `th init` first.",
    data: { error: "not_initialized" },
});
/** Normalize a root-relative path to forward slashes for cross-platform stable storage. */
function toRelKey(root, file) {
    const abs = path.resolve(root, file);
    return path.relative(root, abs).split(path.sep).join("/");
}
/**
 * `th artifact register <file> --version <n>` — compute the content hash of a
 * file (relative to the project root) and upsert it into `approved_artifacts`.
 * Re-registering the same file REPLACES its entry (version bump, no duplicate).
 */
function runArtifactRegister(paths, file, version) {
    if (!file)
        return (0, output_1.failure)({ human: "usage: th artifact register <file> --version <n>" });
    if (version === undefined || !Number.isInteger(version) || version < 1) {
        return (0, output_1.failure)({ human: "usage: th artifact register <file> --version <n>" });
    }
    const abs = path.resolve(paths.root, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return (0, output_1.failure)({ human: `File not found: ${file}`, data: { error: "file_not_found", file } });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `Existing state.json is invalid; fix it before registering:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const content = fs.readFileSync(abs, "utf8");
    const hash = (0, hash_1.shortHash)(content);
    const relKey = toRelKey(paths.root, file);
    const entry = { file: relKey, version, hash };
    const next = { ...r.state, approved_artifacts: [...r.state.approved_artifacts] };
    const idx = next.approved_artifacts.findIndex((a) => a.file === relKey);
    if (idx >= 0)
        next.approved_artifacts[idx] = entry;
    else
        next.approved_artifacts.push(entry);
    (0, state_store_1.writeState)(paths, next);
    (0, log_1.structuredLog)({ cmd: "artifact register", file: relKey, version, hash });
    return (0, output_1.success)({
        data: { file: relKey, version, hash },
        human: `registered ${relKey} v${version} (${hash})`,
    });
}
/** `th artifact list` — list every recorded approved artifact. */
function runArtifactList(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const artifacts = r.state.approved_artifacts;
    const human = artifacts.length
        ? artifacts.map((a) => `${a.file}  v${a.version}  ${a.hash}`).join("\n")
        : "(none)";
    return (0, output_1.success)({ data: { artifacts }, human });
}
