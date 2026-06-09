"use strict";
/**
 * Task brief model — the input to the Tier-0 classifier (spec §5).
 *
 * A brief captures the five Tier-0 conditions plus any detected blast-radius
 * flags. Validation is hand-rolled (zero runtime dependencies — plan Principle
 * 3) and mirrors `validateState`'s style: a precise issue list so the `th tier`
 * commands can explain *what* is wrong with a brief.json.
 *
 * The CLI only *records and computes* against a brief; it never decides the
 * tier number (plan §3 boundary rule). The one mechanical truth it enforces is
 * the blast-radius veto floor (`th tier veto-check`).
 */
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
exports.validateBrief = validateBrief;
exports.loadBriefFromFile = loadBriefFromFile;
const fs = __importStar(require("node:fs"));
const state_schema_1 = require("./state-schema");
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Validate an arbitrary parsed value against the brief schema. */
function validateBrief(value) {
    const issues = [];
    if (!isPlainObject(value)) {
        return { ok: false, issues: [{ path: "$", message: "brief must be a JSON object" }] };
    }
    const v = value;
    if (!(v.description === undefined || typeof v.description === "string")) {
        issues.push({ path: "description", message: "must be a string if present" });
    }
    for (const key of [
        "single_file_or_local",
        "changes_public_interface",
        "adds_dependency",
        "obvious_testable_answer",
    ]) {
        if (typeof v[key] !== "boolean") {
            issues.push({ path: key, message: "must be a boolean" });
        }
    }
    if (!Array.isArray(v.blast_radius_flags)) {
        issues.push({ path: "blast_radius_flags", message: "must be an array" });
    }
    else {
        v.blast_radius_flags.forEach((f, i) => {
            if (typeof f !== "string" || !state_schema_1.BLAST_RADIUS_FLAGS.includes(f)) {
                issues.push({ path: `blast_radius_flags[${i}]`, message: `invalid flag "${String(f)}"` });
            }
        });
    }
    if (issues.length > 0)
        return { ok: false, issues };
    return { ok: true, issues: [], brief: value };
}
/** Read + JSON.parse a brief.json file, then validate it. */
function loadBriefFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { ok: false, issues: [{ path: "$", message: `brief file not found: ${filePath}` }] };
    }
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    }
    catch (e) {
        return { ok: false, issues: [{ path: "$", message: `could not read brief: ${e.message}` }] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { ok: false, issues: [{ path: "$", message: `invalid JSON: ${e.message}` }] };
    }
    return validateBrief(parsed);
}
