"use strict";
/**
 * Decision keyed-seal key resolver (C-3b).
 *
 * OPT-IN ONLY. Returns `TH_DECISION_KEY` when it is explicitly set to a non-empty
 * value, else null. We deliberately DO NOT auto-generate or persist a local key:
 *   - an auto-generated key stored on the same machine as `decisions.jsonl` gives
 *     no resistance against the actual threat (an attacker who can edit the ledger
 *     can read a same-machine keystore);
 *   - a per-machine key produces FALSE `chain_broken`/seal-mismatch when a
 *     legitimate, committed ledger is verified on another machine or in CI;
 *   - a `0600` mode bit is meaningless on Windows NTFS, so it protects nothing.
 *
 * The keyless hash chain (`verifyChain`) is the tamper-EVIDENCE primitive and is
 * always on. The keyed seal is an optional, explicit-key, warn-only upgrade for a
 * specific threat model (an operator who keeps the key out of band). See SECURITY.md:
 * "tamper-evident via chain continuity, not tamper-proof."
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDecisionKey = resolveDecisionKey;
function resolveDecisionKey() {
    const key = process.env.TH_DECISION_KEY;
    return key && key.length > 0 ? key : null;
}
