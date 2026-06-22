"use strict";
/**
 * Receipt public-key verification (Axis-B slice-1b / BSC-4).
 *
 * The completion-gate runtime receives only an Ed25519 PUBLIC key. The external
 * producer holds the corresponding PRIVATE key and performs signing out of
 * process. This module intentionally exports no signing primitive and no private
 * key loader, so code controlling the verifier cannot mint a trusted receipt.
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
exports.verifyCanonical = verifyCanonical;
exports.loadExternalPublicKey = loadExternalPublicKey;
exports.externalKeyId = externalKeyId;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
/** Base64-encoded Ed25519 signatures are exactly 64 bytes. */
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/**
 * Verify an Ed25519 signature over the receipt's canonical text. Returns false on
 * malformed input, the wrong key type, or any crypto error; never throws.
 */
function verifyCanonical(canonicalText, signature, publicKey) {
    try {
        if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
            return false;
        if (typeof signature !== "string" || !SIGNATURE_BASE64.test(signature))
            return false;
        const bytes = Buffer.from(signature, "base64");
        if (bytes.length !== 64)
            return false;
        return (0, node_crypto_1.verify)(null, Buffer.from(canonicalText, "utf8"), publicKey, bytes);
    }
    catch {
        return false;
    }
}
/**
 * Load the verifier's Ed25519 public key from `TH_RECEIPT_PUBLIC_KEYFILE`.
 * Missing, unreadable, malformed, private, or non-Ed25519 keys fail soft to null;
 * an external claim then classifies as forged and blocks.
 */
function loadExternalPublicKey() {
    const file = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
    if (typeof file !== "string" || file === "")
        return null;
    try {
        const raw = fs.readFileSync(file);
        try {
            (0, node_crypto_1.createPrivateKey)(raw);
            return null;
        }
        catch {
            // Expected for public-only material.
        }
        const key = (0, node_crypto_1.createPublicKey)(raw);
        if (key.asymmetricKeyType !== "ed25519")
            return null;
        return key;
    }
    catch {
        return null;
    }
}
/**
 * Stable non-secret key id: first eight hex characters of SHA-256 over the public
 * SubjectPublicKeyInfo DER encoding. Private material is never required.
 */
function externalKeyId(publicKey) {
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
        throw new TypeError("externalKeyId requires an Ed25519 public key");
    }
    const der = publicKey.export({ type: "spki", format: "der" });
    return (0, node_crypto_1.createHash)("sha256").update(der).digest("hex").slice(0, 8);
}
