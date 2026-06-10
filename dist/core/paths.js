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
exports.resolveProjectPaths = resolveProjectPaths;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Resolve all project paths from a root directory.
 *
 * Directory selection for the state directory (cheap fs existence checks —
 * acceptable because this is called once per CLI invocation):
 * 1. If `<root>/.twinharness` exists → use it.
 * 2. Else if `<root>/.agentic-sdlc/state.json` exists → legacy fallback, keep
 *    using `.agentic-sdlc` so the existing project is not broken.
 * 3. Otherwise → default to `.twinharness` (fresh projects).
 */
function resolveProjectPaths(root) {
    const abs = path.resolve(root);
    let stateDir;
    const newDir = path.join(abs, ".twinharness");
    const legacyStateFile = path.join(abs, ".agentic-sdlc", "state.json");
    if (fs.existsSync(newDir)) {
        stateDir = newDir;
    }
    else if (fs.existsSync(legacyStateFile)) {
        // Legacy project: `.agentic-sdlc/state.json` present — stay in legacy dir.
        stateDir = path.join(abs, ".agentic-sdlc");
    }
    else {
        stateDir = newDir;
    }
    return {
        root: abs,
        stateDir,
        stateFile: path.join(stateDir, "state.json"),
        docsDir: path.join(abs, "docs"),
        driftLog: path.join(abs, "drift-log.md"),
    };
}
