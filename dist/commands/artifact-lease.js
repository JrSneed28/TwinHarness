"use strict";
/**
 * Section-level artifact leases (Phase 4 Slice 6, REQ-PCO-041).
 *
 * `th artifact claim|release|leases` — the section-grained sibling of the
 * component leases in `commands/build.ts`. Where a component lease serializes
 * whole slices over a shared component, a SECTION lease serializes co-editors
 * over a single `<file>#<section>` region of one artifact. The point: two agents
 * may edit DIFFERENT sections of the SAME file concurrently, but never the SAME
 * section at once.
 *
 * It is the SAME mechanism as `runBuildClaim`/`runBuildRelease` — the same
 * append-only lease ledger (via `appendLeaseEvent`), the same collision guard
 * (a claim refuses an overlapping active lease held by a different holder), and
 * the same serialization under `withStateLock` so two concurrent claims can't
 * both win the same section — only keyed by a `<file>#<section>` section id and a
 * holder id instead of a slice id and its component set. These handlers are pure
 * `CommandResult` producers; cli.ts wires the `th artifact ...` subcommands and
 * prints / sets the exit code.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runArtifactClaim = runArtifactClaim;
exports.runArtifactRelease = runArtifactRelease;
exports.runArtifactLeases = runArtifactLeases;
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const guards_1 = require("../core/guards");
const leases_1 = require("../core/leases");
const log_1 = require("../core/log");
const tier_1 = require("./tier");
const CLAIM_USAGE = "usage: th artifact claim <file>#<section> --holder <id>";
const RELEASE_USAGE = "usage: th artifact release <file>#<section> --holder <id>";
/** Validate the `{section, holder}` pair common to claim/release. */
function validate(opts, usage) {
    const section = opts.section;
    const holder = opts.holder;
    if (!section || !holder) {
        return { ok: false, result: (0, output_1.failure)({ human: usage, data: { error: "missing_args" } }) };
    }
    if (!(0, leases_1.isSectionId)(section)) {
        return {
            ok: false,
            result: (0, output_1.failure)({
                human: `Invalid section id: "${section}". Expected <file>#<section> (a non-empty file and section separated by a single '#'). ${usage}`,
                data: { error: "invalid_section_id", section },
            }),
        };
    }
    // R-11 / R-22: reject an absolute or parent-escaping FILE part via the shared
    // cross-platform `isAbsoluteOrEscaping` predicate (same one the `th_artifact_register`
    // MCP pre-check now uses). The section id is an opaque ledger key (never joined to
    // disk for a write), but the validation contract must be UNIFORM across the artifact
    // tools AND cross-platform: a `/etc/passwd#x`, `C:\Windows\x#s` (R-22 — host-native
    // `path.isAbsolute` missed this on POSIX), `\\server\share#s`, or `..\..\x#s` that
    // `register` refuses must not slip in as a lease key. `parseSectionId` cannot return
    // undefined here (isSectionId passed), so the `file` part is well-formed.
    const file = (0, leases_1.parseSectionId)(section).file;
    if ((0, paths_1.isAbsoluteOrEscaping)(file)) {
        return {
            ok: false,
            result: (0, output_1.failure)({
                human: `Refusing a section whose file part is absolute or escapes the project root: "${section}". ${usage}`,
                data: { error: "path_escape", section },
            }),
        };
    }
    return { ok: true, section, holder };
}
/**
 * `th artifact claim <file>#<section> --holder <id>` — take a section lease.
 * The collision guard: refuses (ok:false, exit 1) if that EXACT section is
 * already actively leased to a DIFFERENT holder, mirroring `runBuildClaim`'s
 * component-conflict refusal. A re-claim by the SAME holder is idempotent-safe
 * (re-records the lease, never a conflict). Serialized under `withStateLock` so
 * two concurrent claims can't both win the same section.
 */
function runArtifactClaim(paths, opts = {}) {
    const locked = (0, tier_1.assertFeatureUnlocked)(paths, "section-lease");
    if (locked)
        return locked;
    const v = validate(opts, CLAIM_USAGE);
    if (!v.ok)
        return v.result;
    const { section, holder } = v;
    return (0, state_store_1.withStateLock)(paths, () => {
        const sr = (0, guards_1.requireState)(paths);
        if (sr.result)
            return sr.result;
        // Collision guard: refuse if the SAME section is held by a DIFFERENT holder.
        if ((0, leases_1.isSectionLeased)(paths, section, holder)) {
            const owner = (0, leases_1.sectionLeaseHolder)(paths, section);
            return (0, output_1.failure)({
                human: `Cannot claim ${section}: already leased to ${owner}. Co-edit a different section, or wait for it to be released (REQ-PCO-041).`,
                data: { error: "section_lease_conflict", section, holder: owner },
            });
        }
        // Reuse the component-lease ledger: section id is the lease key (`slice`),
        // the holder is stored as the sole `components` entry.
        (0, leases_1.appendLeaseEvent)(paths, { event: "claim", slice: section, components: [holder] });
        (0, log_1.structuredLog)({ cmd: "artifact claim", section, holder });
        return (0, output_1.success)({ data: { section, holder }, human: `claimed ${section} for ${holder}` });
    });
}
/**
 * `th artifact release <file>#<section> --holder <id>` — release a section
 * lease. Records a `release` event in the shared ledger (mirrors
 * `runBuildRelease`); after it, the section is free for another holder.
 */
function runArtifactRelease(paths, opts = {}) {
    const locked = (0, tier_1.assertFeatureUnlocked)(paths, "section-lease");
    if (locked)
        return locked;
    const v = validate(opts, RELEASE_USAGE);
    if (!v.ok)
        return v.result;
    const { section, holder } = v;
    return (0, state_store_1.withStateLock)(paths, () => {
        const sr = (0, guards_1.requireState)(paths);
        if (sr.result)
            return sr.result;
        (0, leases_1.appendLeaseEvent)(paths, { event: "release", slice: section, components: [holder] });
        (0, log_1.structuredLog)({ cmd: "artifact release", section, holder });
        return (0, output_1.success)({ data: { section, holder }, human: `released ${section}.` });
    });
}
/**
 * `th artifact leases` — list the active section leases and their holders.
 */
function runArtifactLeases(paths) {
    const locked = (0, tier_1.assertFeatureUnlocked)(paths, "section-lease");
    if (locked)
        return locked;
    const sr = (0, guards_1.requireState)(paths);
    if (sr.result)
        return sr.result;
    const leases = (0, leases_1.activeSectionLeases)(paths);
    const human = leases.length
        ? leases.map((l) => `${l.section} → ${l.holder}`).join("\n")
        : "(no active section leases)";
    return (0, output_1.success)({ data: { leases }, human });
}
