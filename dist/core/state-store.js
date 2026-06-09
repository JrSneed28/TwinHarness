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
exports.readState = readState;
exports.writeState = writeState;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const state_schema_1 = require("./state-schema");
/** Read + validate state.json. Distinguishes "missing" from "present but invalid". */
function readState(paths) {
    if (!fs.existsSync(paths.stateFile)) {
        return { exists: false };
    }
    const raw = fs.readFileSync(paths.stateFile, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { exists: true, raw, issues: [{ path: "$", message: `invalid JSON: ${e.message}` }] };
    }
    const result = (0, state_schema_1.validateState)(parsed);
    if (!result.ok) {
        return { exists: true, raw, issues: result.issues };
    }
    return { exists: true, raw, state: result.state };
}
/**
 * Write state.json atomically (write temp, then rename over the target).
 *
 * The rename is atomic within the directory, so a crashed/partial write is never
 * observed and is *replaced, not duplicated* on resume (spec §18 idempotency).
 */
function writeState(paths, state) {
    fs.mkdirSync(paths.agenticDir, { recursive: true });
    const serialized = (0, state_schema_1.serializeState)(state);
    const tmp = path.join(paths.agenticDir, `state.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, serialized, "utf8");
    fs.renameSync(tmp, paths.stateFile);
}
