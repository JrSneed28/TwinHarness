"use strict";
/**
 * The DECLARED dimension set (Axis-B slice-7 / BSC-5) — the COMMITTED source artifact
 * the dimension-set-coverage gate rung READS.
 *
 * INTERP A (the keystone decision of the BSC-5 lane). The declared set is NOT minted at
 * attestation time and is NOT self-asserted by the run under test. It is a committed
 * `core/` constant — exactly like {@link SEED_DIMENSIONS} in `verification-driver.ts` —
 * so that NARROWING it (dropping a required dimension to hide an unobserved one) is a
 * REVIEWABLE code diff that must pass CI's committed-`dist/` invariant, NEVER a silent
 * runtime move. The gate imports this constant directly; there is no on-disk declared-set
 * file an agent could rewrite between mint and gate.
 *
 *   - WHO WRITES IT: a committed change to THIS file, under code review. The compiled
 *     form lands in the committed `dist/` (and is bundled into `dist/mcp-server.js`), so
 *     a narrowing is visible in both the `src/` and `dist/` diff (BSC-5 negative-control d).
 *   - CANONICAL FORM: the sorted, de-duplicated set of dimension names, joined by `\n`
 *     ({@link declaredDimensionSetCanonical}). Order-independent + duplicate-independent so
 *     the digest is stable under a reorder/typo-dupe that does not change the SET.
 *   - HOW THE GATE READS IT: {@link declaredDimensionSet} returns the names; the rung
 *     asserts `declared ⊆ observed` where `observed` is re-derived from `verify-report.json`
 *     at gate time (the shared `observedDimensionsFromReport`). The receipt records
 *     {@link declaredDimensionSetDigest} so a stored coverage claim is bound to the EXACT
 *     committed declared set it was minted against — a post-mint narrowing of this file
 *     changes the digest and the gate detects the divergence (it recomputes the digest
 *     from the live constant, never trusts the stored one).
 *
 * The declared set is a SUBSET of (or equal to) the {@link SEED_DIMENSION_NAMES} open
 * vocabulary the BSC-3 sensor observes: a dimension can only be DECLARED-required if the
 * sensor can OBSERVE it. A declared name with no matching seed dimension would be
 * unobservable-by-construction (always-absent ⇒ always-blocking), so the schema guard
 * {@link assertDeclaredDimensionsObservable} enforces declared ⊆ seed at module load.
 *
 * BSC-10 enumeration-completeness (is the declared SET itself complete?) stays a tracked
 * assumption (consensus plan §5/§9) — this rung enforces coverage of the declared set, not
 * that the declared set names every dimension that could ever matter.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DECLARED_DIMENSION_SET = void 0;
exports.declaredDimensionSetCanonical = declaredDimensionSetCanonical;
exports.declaredDimensionSetDigest = declaredDimensionSetDigest;
exports.declaredDimensionSet = declaredDimensionSet;
exports.assertDeclaredDimensionsObservable = assertDeclaredDimensionsObservable;
const hash_1 = require("./hash");
const verification_driver_1 = require("./verification-driver");
/**
 * The committed declared dimension set (Interp A). Completion asserts that EVERY name here
 * was observed (a passing matching command in `verify-report.json`) at gate time. This is
 * the seed trio — `tests-executed`, `typecheck`, `build` — the three dimensions a TwinHarness
 * run is expected to exercise. Each MUST be a member of {@link SEED_DIMENSION_NAMES} (the
 * sensor's observable vocabulary); see {@link assertDeclaredDimensionsObservable}.
 *
 * Narrowing this array (removing a name) is the BSC-5 negative-control (d): a reviewable
 * `src/` + `dist/` diff, gated by CI's committed-`dist/` check and code review — never a
 * runtime self-attest.
 */
exports.DECLARED_DIMENSION_SET = ["tests-executed", "typecheck", "build"];
/**
 * The declared set's CANONICAL form: sorted, de-duplicated names joined by `\n`. Order- and
 * duplicate-independent so the digest is stable under a reorder or an accidental duplicate
 * that does not change the underlying SET. The SINGLE canonicalization both the producer (at
 * mint) and the gate (at validation) use, so the two sides never drift on what the declared
 * set's identity is.
 */
function declaredDimensionSetCanonical() {
    return [...new Set(exports.DECLARED_DIMENSION_SET)].sort().join("\n");
}
/**
 * SHA-256 hex of {@link declaredDimensionSetCanonical}. The stable identity of the committed
 * declared set: a receipt records this so a stored coverage claim is bound to the EXACT
 * committed set it was minted against. The gate RECOMPUTES it from the live constant and
 * compares — it never trusts the receipt's stored digest — so a post-mint narrowing of the
 * committed set is detected as a divergence, not silently honored.
 */
function declaredDimensionSetDigest() {
    return (0, hash_1.hashContent)(declaredDimensionSetCanonical());
}
/**
 * The declared dimension NAMES (the committed required set). Returned as a fresh array so a
 * caller cannot mutate the constant.
 */
function declaredDimensionSet() {
    return [...exports.DECLARED_DIMENSION_SET];
}
/**
 * Schema guard (load-time): every DECLARED dimension MUST be observable by the BSC-3 sensor,
 * i.e. a member of {@link SEED_DIMENSION_NAMES}. A declared name the sensor can never observe
 * would be always-absent ⇒ always-blocking — a mis-declaration, not a real coverage gap. This
 * fails CLOSED at module load (a `throw`, caught by the unit guard test) so a future edit that
 * declares an unobservable dimension is a build-time error, not a silent always-red gate.
 */
function assertDeclaredDimensionsObservable() {
    const seed = new Set(verification_driver_1.SEED_DIMENSION_NAMES);
    const unobservable = exports.DECLARED_DIMENSION_SET.filter((d) => !seed.has(d));
    if (unobservable.length > 0) {
        throw new Error(`DECLARED_DIMENSION_SET contains dimension(s) the BSC-3 sensor cannot observe (not in SEED_DIMENSION_NAMES): ${unobservable.join(", ")}. ` +
            `A declared dimension must be observable, or it is an always-absent always-blocking mis-declaration.`);
    }
}
// Fail-closed at module load: a declared dimension outside the sensor vocabulary is a
// build-time error, never a silently always-red gate.
assertDeclaredDimensionsObservable();
