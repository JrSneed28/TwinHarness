#!/usr/bin/env node
/**
 * th-receipt-producer.mjs — the EXTERNAL terminal-receipt signer
 * (Axis-B slice-1b / BSC-4 — the INDEPENDENCE primitive).
 *
 * This is DELIBERATELY a standalone Node ESM script, NOT a `th` subcommand and NOT
 * an MCP tool: adding a verb/tool would (a) defeat independence — the very surface
 * the completion gate constrains would gain a signing code path — and (b) perturb
 * the CLI/MCP parity invariant. The genuine un-forgeable property is that this
 * producer runs OUT of process, holds an Ed25519 private key
 * (`TH_RECEIPT_PRIVATE_KEYFILE`), and
 * appends a SIGNED receipt the in-process agent cannot mint (it has no signing code
 * and, in the threat model, no key). The gate then classifies that receipt
 * `valid-grounded`; an in-process-forged equivalent is `valid` (attested, not
 * grounded) and a claimed-but-unsigned/forged one is `forged` (blocked).
 *
 * The SHARED formula is imported from the COMPILED dist so the producer and the
 * in-process validator can NEVER diverge on the binding (one canonicalText, one
 * computeRecordHash). It is the producer's responsibility to have the private key:
 * unlike the fail-SOFT validator path, a missing/unreadable key here is a
 * HARD error (nonzero exit) — a producer with no key cannot produce.
 *
 * BEST-EFFORT CHAIN (caveat): the append to external-receipts.jsonl is
 * UNSYNCHRONIZED — there is no state lock (that is the whole point of the separate
 * store), so two producers running concurrently may FORK `prevHash`. The gate does
 * not care: per-candidate SIGNATURE verification, NOT chain order, is authoritative
 * (the validator never runs verifyReceiptChain on the external store). An advisory
 * producer-side lock to keep this chain single-threaded is a deferred P4 follow-up.
 *
 * Usage:
 *   TH_RECEIPT_PRIVATE_KEYFILE=/path/to/ed25519-private.pem \
 *   node scripts/th-receipt-producer.mjs \
 *     --root <projectRoot> \
 *     --kind <drift-resolve|sim-retire|decision-approve|scan-exception|approval|driver|realization|mutation-kill|grounding> \
 *     [--ref-id <ID>] \
 *     [--target <repo-rel-path>] \
 *     [--stage <humanGate-stage>] \
 *     [--dimension <a,b,c>] \
 *     [--mutation-report <path>] \
 *     [--scope <module>] \
 *     [--grounding-report <path>] \
 *     [--work-class <greenfield|redesign|recreation|integration|migration|greenfield+dep>] \
 *     [--grounding-bound] \
 *     [--manifest-digest <sha256:hex>] \
 *     [--producer-identity <string>]
 *
 * The terminal-receipt kinds (drift-resolve|sim-retire|decision-approve) require
 * `--ref-id` and write the external TERMINAL-receipt store (slice-1b). `--target` is
 * required for drift-resolve|sim-retire and forbidden-empty for decision-approve.
 *
 * `--kind scan-exception` (slice-2b) is a SEPARATE flow that writes a DIFFERENT store
 * (`scan-exceptions.jsonl`) with a DIFFERENT canonical shape — an external-signed,
 * path-and-digest-scoped ack exonerating ONE enumerated `dist/` path the two-tier scan
 * could not deep-inspect. It REQUIRES `--target <repo-rel-path>` (the dist file being
 * excepted), which MUST resolve in source; the ack's `digest` is that file's
 * `hashFileStreaming` digest — byte-identical to the scan's enumerated digest, so the
 * gate's `uncoveredAfterExceptions` subtracts exactly this `(path, digest)`. `--ref-id`
 * is ignored for scan-exception (the `(path, digest)` IS the coordinate).
 *
 * `--kind approval` (slice-3b) is a SEPARATE flow that writes a DIFFERENT store
 * (`external-approvals.jsonl`) with the 3a `HumanApprovalReceipt` canonical shape — an
 * external-signed, stage-scoped approval authorizing ONE `humanGate` stage. It REQUIRES
 * `--stage <humanGate-stage>` (the stage being approved), which MUST be a `humanGate` stage
 * whose governing artifact (`produces`) resolves in source; the approval's
 * `governing_artifact_digest` is that artifact's `computeTargetDigest`. `--ref-id` /
 * `--target` are ignored for approval (the `stage` IS the coordinate). The signed canonical
 * text reuses 3a's `approvalCanonicalText` from the compiled dist (with `stage` IN the
 * signed order, R5), so the 3a in-process validator's signature check (slice-3b C-I) verifies.
 *
 * `--kind driver` (slice-4b) is a SEPARATE flow that writes a DIFFERENT store
 * (`external-driver-receipts.jsonl`) with the 4a `DriverDimensionReceipt` canonical shape — an
 * external-signed receipt recording which verification dimensions a trusted runner exercised.
 * The dimensions are DERIVED from `verify-report.json` via the shared 4a sensor
 * (`observeDriverDimensions`), NOT supplied: `--ref-id` / `--target` are IGNORED (the snapshot
 * coordinate + report ARE the coordinate); an optional `--dimension a,b,c` records only that
 * observed subset (a claimed-but-unobserved name refuses at creation). The signed canonical text
 * reuses 4a's `driverCanonicalText` / `computeDriverRecordHash` from the compiled dist, so the
 * 4a in-process gate validator's signature check classifies it `valid-grounded` (independence >0).
 *
 * `--kind realization` (slice-5 / BSC-1) is a SEPARATE flow that writes a DIFFERENT store
 * (`external-realization-receipts.jsonl`) with the slice-5 `RealizationReceipt` canonical shape
 * — an external-signed receipt binding ONE REQ-ID to a digest-bound source referent. It REQUIRES
 * `--ref-id <REQ-ID>` AND `--target <repo-rel-path>` (the referent source file, which MUST resolve
 * in source); the receipt's `referent.digest` is that file's `computeTargetDigest`. The signed
 * canonical text reuses the slice-5 `realizationCanonicalText` / `computeRealizationRecordHash`
 * from the compiled dist, so the in-process gate validator classifies it `valid-grounded`
 * (BSC-1 independence >0 — SIGNATURE-PROVENANCE only; the referent is still agent-authored).
 *
 * `--kind mutation-kill` (slice-6 / BSC-2 2b) is a SEPARATE flow that writes a DIFFERENT store
 * (`external-mutation-receipts.jsonl`) with the 2a `MutationKillReceipt` canonical shape — an
 * external-signed receipt recording that a controlled mutation-testing runner's suite KILLS
 * injected faults over ONE bounded source module (`scope`). It REQUIRES `--mutation-report <path>`
 * (a JSON report a controlled CI job's mutation tool emitted), which MUST resolve + parse; the
 * report supplies the kill counts + `score` (a minimal `{mutants_generated,mutants_killed,
 * mutants_survived,score,scope}` shape OR a Stryker-style report mapped deterministically). `scope`
 * comes from the report or an explicit `--scope <module>`. The mutation tool itself (Stryker) is
 * NEVER imported/run here — the producer only reads a report the CI job produced, keeping the
 * mutation tool a CI-job-only dependency absent from this producer's dist-import path. The signed
 * canonical text reuses 2a's `mutationKillCanonicalText` / `computeMutationKillRecordHash` from the
 * compiled dist, so the in-process gate validator classifies it `valid-grounded` (BSC-2 independence
 * >0 — SIGNATURE-PROVENANCE over a bounded single-module mutation scope; the module-scoped efficacy
 * signal NEVER overrides the per-REQ assertion-presence rung — presence ≠ efficacy).
 *
 * `--kind grounding` (slice-BSC10b / BSC-10 B1) is a SEPARATE flow that writes TWO stores:
 * `external-grounding-receipts.jsonl` (the main receipt, using `groundingCanonicalText` /
 * `computeGroundingRecordHash` from the compiled dist) and OPTIONALLY `grounding-budgets.jsonl`
 * (the sibling external-signed budget store, PCC-4). It REQUIRES `--grounding-report <path>` (a
 * JSON report supplying the evidence digests / version-pins / conformance values captured under a
 * PINNED environment) and `--work-class <class>`. The report is READ, not re-run — the producer
 * NEVER imports Stryker, a renderer, or axe-core (mirrors mutation-kill: reads a report, signs it).
 * Refuse-at-creation: out-of-range conformance, missing required manifest digest for
 * `digest-manifest` grounds, and inconsistent counts are rejected BEFORE any write. The signed
 * canonical text is byte-identical to what the in-process gate validator re-derives, so a real-key
 * signature classifies `valid-grounded` and a forged/wrong-key one classifies `forged` (blocked).
 *
 * Prints a small JSON result on stdout. Exit 0 on success, nonzero on any error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";

// Resolve the compiled dist relative to THIS script's own location (scripts/ is a
// sibling of dist/), so the producer works regardless of the caller's cwd.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

const receiptsMod = await import(pathToFileUrl(path.join(DIST, "core", "receipts.js")));
const signingMod = await import(pathToFileUrl(path.join(DIST, "core", "receipt-signing.js")));
const pathsMod = await import(pathToFileUrl(path.join(DIST, "core", "paths.js")));
const scanMod = await import(pathToFileUrl(path.join(DIST, "core", "scan-completeness.js")));
const hashMod = await import(pathToFileUrl(path.join(DIST, "core", "hash.js")));
const approvalsMod = await import(pathToFileUrl(path.join(DIST, "core", "approvals.js")));
const stagesMod = await import(pathToFileUrl(path.join(DIST, "core", "stages.js")));
const driverMod = await import(pathToFileUrl(path.join(DIST, "core", "verification-driver.js")));
const realizationMod = await import(pathToFileUrl(path.join(DIST, "core", "realization.js")));
const assertionMod = await import(pathToFileUrl(path.join(DIST, "core", "assertion-presence.js")));
const groundingMod = await import(pathToFileUrl(path.join(DIST, "core", "grounding.js")));

const {
  canonicalText,
  computeRecordHash,
  computeTargetDigest,
  currentReceiptSnapshotCoord,
  externalReceiptsPath,
  readLastExternalReceiptRecordHash,
} = receiptsMod;
const { externalKeyId } = signingMod;
const { resolveProjectPaths } = pathsMod;
const {
  scanExceptionCanonicalText,
  computeScanExceptionRecordHash,
  scanExceptionsPath,
  readLastScanExceptionRecordHash,
} = scanMod;
const { hashFileStreaming } = hashMod;
// slice-3b — reuse the 3a canonical/hash binding + external store helpers from the
// COMPILED dist so the producer and the in-process validator can NEVER diverge on the
// approval canonical field order (`stage` IS signed, R5).
const {
  approvalCanonicalText,
  computeApprovalRecordHash,
  externalApprovalsPath,
  readLastExternalApprovalRecordHash,
  isHumanGateStage,
} = approvalsMod;
const { stageContract } = stagesMod;
// slice-4b — reuse the 4a driver canonical/hash binding + external store helpers + the
// SENSOR (`observeDriverDimensions`) from the COMPILED dist so the producer and the
// in-process gate validator can NEVER diverge on the driver canonical field order
// (`driverCanonicalText` drops `recordHash`; `signature` is excluded as a trailer).
const {
  driverCanonicalText,
  computeDriverRecordHash,
  externalDriverReceiptsPath,
  readLastExternalDriverRecordHash,
  observeDriverDimensions,
} = driverMod;
// slice-5/BSC-1 — reuse the realization canonical/hash binding + external store helpers from
// the COMPILED dist so the producer and the in-process gate validator can NEVER diverge on
// the realization canonical field order (`realizationCanonicalText` drops `recordHash`;
// `signature` is excluded as a trailer).
const {
  realizationCanonicalText,
  computeRealizationRecordHash,
  externalRealizationReceiptsPath,
  readLastExternalRealizationRecordHash,
} = realizationMod;
// slice-6/BSC-2 (2b) — reuse the 2a mutation-kill canonical/hash binding + external store
// helpers from the COMPILED dist so the producer and the in-process gate validator can NEVER
// diverge on the mutation canonical field order (`mutationKillCanonicalText` drops `recordHash`;
// `signature` is excluded as a trailer). `currentReceiptSnapshotCoord` is reused from receipts.js.
const {
  mutationKillCanonicalText,
  computeMutationKillRecordHash,
  externalMutationReceiptsPath,
  readLastExternalMutationRecordHash,
} = assertionMod;
// slice-BSC10b/BSC-10 (B1) — reuse the BSC-10a grounding canonical/hash binding + external store
// helpers from the COMPILED dist so the producer and the in-process gate validator can NEVER diverge
// on the grounding canonical field order (`groundingCanonicalText` drops `recordHash`; `signature`
// is excluded as a trailer). `currentReceiptSnapshotCoord` is reused from receipts.js.
const {
  groundingCanonicalText,
  computeGroundingRecordHash,
  externalGroundingReceiptsPath,
  readLastExternalGroundingRecordHash,
  groundingBudgetsPath,
} = groundingMod;
// Sibling budget canonical text — the SAME helper the gate's `validGroundingBudgets` verifies
// with, so the producer-signed budget and the gate's re-derivation can NEVER drift on field
// order / snapshot-coord ordering (no parallel hand-rolled formula).
const { groundingBudgetCanonicalText } = groundingMod;

/** Convert an absolute filesystem path to a file:// URL (Windows-safe ESM import). */
function pathToFileUrl(abs) {
  let p = abs.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // drive-letter paths need a leading slash
  return new URL("file://" + encodeURI(p));
}

/** Parse `--flag value` style args (no abbreviation, explicit set). Last wins. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}

/** Print a JSON error to stderr and exit nonzero. */
function fail(message, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, error: message, ...extra }) + "\n");
  process.exit(1);
}

const KINDS = new Set(["drift-resolve", "sim-retire", "decision-approve", "scan-exception", "approval", "driver", "realization", "mutation-kill", "grounding"]);

function loadPrivateKey() {
  const file = process.env.TH_RECEIPT_PRIVATE_KEYFILE;
  if (typeof file !== "string" || file === "") {
    fail("TH_RECEIPT_PRIVATE_KEYFILE is unset — the external producer requires an Ed25519 private key");
  }
  try {
    const key = createPrivateKey(fs.readFileSync(file));
    if (key.asymmetricKeyType !== "ed25519") {
      fail("TH_RECEIPT_PRIVATE_KEYFILE must contain an Ed25519 private key");
    }
    return key;
  } catch (error) {
    fail("TH_RECEIPT_PRIVATE_KEYFILE is unreadable or invalid", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * slice-2b — produce an external-signed scan-exception ack. Writes the SEPARATE
 * `scan-exceptions.jsonl` store with the ack canonical shape (NOT a terminal receipt).
 *
 * The make-or-break contract: the ack's `(path, digest)` MUST be byte-identical to what
 * the dist scan enumerates for the file, or `uncoveredAfterExceptions` will not subtract
 * it. The scan emits `path.relative(root, abs)` forward-slashed (see `relPath` in
 * `commands/sim.ts`) and digests with `hashFileStreaming(abs)` — so we normalize the
 * supplied `--target` to that exact form and hash with the SAME function. If the file
 * does not resolve/exist we refuse at creation (mirroring the terminal flow's
 * target-resolve refusal) rather than mint an ack for a phantom coordinate.
 */
function produceScanException(paths, { target, privateKey, publicKey }) {
  const abs = path.resolve(paths.root, target);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail(`target "${target}" does not resolve to a file in source — refusing to mint an ungrounded scan-exception`, { target });
  }
  // Normalize to the SCAN's coordinate form: repo-relative, forward-slashed.
  const relPath = path.relative(paths.root, abs).split(path.sep).join("/");
  if (!relPath.startsWith("dist/")) {
    fail("scan-exception --target must be a dist/ path — the scan only enumerates dist/", { target });
  }
  const digest = hashFileStreaming(abs);
  const keyId = externalKeyId(publicKey);
  const prevHash = readLastScanExceptionRecordHash(paths);

  // The canonical input — EXACTLY the fields scanExceptionCanonicalText binds
  // (signature + recordHash are trailers, excluded from the canonical text). The
  // signature and recordHash are computed over the IDENTICAL canonical text the
  // in-process validator re-derives, so they can never diverge on the binding.
  const ack = {
    path: relPath,
    digest,
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_kind: "external",
    key_id: keyId,
    prevHash,
  };
  const canonical = scanExceptionCanonicalText(ack);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  const recordHash = computeScanExceptionRecordHash(ack);
  const sealed = { ...ack, signature, recordHash };

  const file = scanExceptionsPath(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(sealed) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind: "scan-exception",
      producer_kind: "external",
      key_id: keyId,
      path: relPath,
      digest,
      recordHash,
      file,
    }) + "\n",
  );
}

/**
 * slice-3b — produce an external-signed `HumanApprovalReceipt`. Writes the SEPARATE
 * `external-approvals.jsonl` store (parallel to `external-receipts.jsonl` /
 * `scan-exceptions.jsonl`) with the 3a approval canonical shape — NOT a terminal receipt.
 *
 * The make-or-break contract for C-I: the SIGNED canonical text MUST be byte-identical to
 * what the 3a in-process validator re-derives, so the signature it imports
 * (`approvalCanonicalText` + `computeApprovalRecordHash` from the compiled dist) is exactly
 * the 3a binding (with `stage` IN the canonical input, R5). `signature` + `recordHash` are
 * trailers, EXCLUDED from the canonical text, computed over the IDENTICAL bytes.
 *
 * Refuse-at-creation (mirrors the terminal flow's target-resolve refusal): `--stage` MUST
 * be a `humanGate` stage AND its governing artifact (`produces`) MUST resolve in source —
 * else we refuse BEFORE any write rather than mint an approval whose ground is already gone.
 */
/**
 * BSC-10 Slice-C / C4a: `groundingBound` and `manifestDigest` are additive-optional.
 * Passing `groundingBound:true` sets `grounding_bound:true` on the approval receipt.
 * Passing `manifestDigest` threads the evidence-spine `manifest_digest` field.
 * Both are omit-when-absent; the dist's canonical helper serializes them in the correct order.
 */
function produceApproval(paths, { stage, producerIdentity, privateKey, publicKey, groundingBound, manifestDigest }) {
  if (!isHumanGateStage(stage)) {
    fail(`--stage "${stage}" is not a humanGate stage — refusing to mint an approval`, { stage });
  }
  const contract = stageContract(stage);
  const artifact = contract ? contract.produces : "";
  const digest = computeTargetDigest(paths.root, artifact);
  if (digest === null) {
    fail(
      `governing artifact "${artifact}" for stage "${stage}" does not resolve in source — refusing to mint an ungrounded approval`,
      { stage, artifact },
    );
  }
  const keyId = externalKeyId(publicKey);
  const prevHash = readLastExternalApprovalRecordHash(paths);

  // The canonical input — EXACTLY the fields approvalCanonicalText binds (signature +
  // recordHash are trailers, excluded). Field order is owned by 3a's
  // APPROVAL_CANONICAL_FIELD_ORDER inside approvalCanonicalText; the producer never
  // re-orders, it hands the object to the imported helper so the bytes can never drift.
  // C4a opt-in: grounding_bound (BEFORE manifest_digest in canonical order) and
  // manifest_digest are omit-when-absent — absent approval stays byte-identical to pre-C4a.
  const withPrev = {
    kind: "human-approval",
    stage,
    approval_of: {
      snapshot_coord: currentReceiptSnapshotCoord(paths),
      governing_artifact_digest: digest,
    },
    producer_identity: producerIdentity,
    producer_kind: "external",
    key_id: keyId,
    ...(groundingBound === true ? { grounding_bound: true } : {}),
    ...(manifestDigest !== undefined ? { manifest_digest: manifestDigest } : {}),
    prevHash,
  };
  const canonical = approvalCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  const recordHash = computeApprovalRecordHash(withPrev);
  const sealed = { ...withPrev, signature, recordHash };

  const file = externalApprovalsPath(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(sealed) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind: "approval",
      producer_kind: "external",
      key_id: keyId,
      stage,
      governing_artifact_digest: digest,
      recordHash,
      file,
    }) + "\n",
  );
}

/**
 * slice-4b — produce an external-signed {@link DriverDimensionReceipt}. Writes the SEPARATE
 * `external-driver-receipts.jsonl` store (parallel to `external-receipts.jsonl` /
 * `external-approvals.jsonl` / `scan-exceptions.jsonl`) with the 4a driver canonical shape —
 * NOT a terminal receipt.
 *
 * The make-or-break contract for the BSC-3 independence flip: the SIGNED canonical text MUST
 * be byte-identical to what the in-process gate validator re-derives, so the signature it
 * imports (`driverCanonicalText` + `computeDriverRecordHash` from the compiled dist) is exactly
 * the 4a binding. `signature` + `recordHash` are trailers, EXCLUDED from the canonical text.
 *
 * Refuse-at-creation (mirrors the approval flow's ground-resolve refusal): the dimensions are
 * DERIVED from `verify-report.json` via the shared SENSOR (`observeDriverDimensions`) — a
 * report that observes NOTHING refuses BEFORE any write rather than mint an ungrounded receipt.
 * A `--dimension` claim is INTERSECTED with the observed set; a claimed-but-unobserved name
 * refuses (nonzero exit, no line), exactly like the in-process `appendDriverReceipt`.
 *
 * BSC-10 Slice C / C4a opt-in: `--grounding-bound` sets `grounding_bound:true` on the receipt,
 * declaring that this driver is bound to a grounding manifest. `--manifest-digest <digest>` sets
 * the `manifest_digest` field (the evidence-spine thread). Both are omit-when-absent so a receipt
 * without either flag is byte-identical to a pre-C4a receipt. The canonical field order
 * (grounding_bound BEFORE manifest_digest) is owned by the compiled dist's DRIVER_CANONICAL_FIELD_ORDER;
 * the producer just passes the fields and lets the helper serialize them in the correct order.
 */
function produceDriver(paths, { dimensionNames, producerIdentity, privateKey, publicKey, groundingBound, manifestDigest }) {
  // SENSOR: what the report actually OBSERVES (the ONLY thing recordable). A report that
  // observes nothing ⇒ refuse — a receipt with no grounded dimension is ungrounded.
  const observed = observeDriverDimensions(paths);
  if (observed.length === 0) {
    fail("no driver dimension observed in verify-report.json — refusing to mint an ungrounded driver receipt");
  }

  // Negative-control (refuse-at-creation): a CLAIMED dimension the report did not observe is
  // refused — a claim-without-observation can never be minted. Then filter to the claimed set.
  let dimensions = observed;
  if (dimensionNames !== undefined) {
    const observedNames = new Set(observed.map((d) => d.name));
    const unobserved = dimensionNames.filter((n) => !observedNames.has(n));
    if (unobserved.length > 0) {
      fail(`refusing to record driver dimension(s) not observed in verify-report.json: ${unobserved.join(", ")}`, {
        unobserved,
      });
    }
    dimensions = observed.filter((d) => dimensionNames.includes(d.name));
  }

  const coord = currentReceiptSnapshotCoord(paths);
  const keyId = externalKeyId(publicKey);
  const prevHash = readLastExternalDriverRecordHash(paths);

  // The canonical input — EXACTLY the fields driverCanonicalText binds (signature + recordHash
  // are trailers, excluded; `undefined` keys are dropped by the helper). Field order is owned
  // by 4a's DRIVER_CANONICAL_FIELD_ORDER inside driverCanonicalText; the producer never
  // re-orders, it hands the object to the imported helper so the bytes can never drift.
  // C4a opt-in fields (omit-when-absent so pre-C4a receipts stay byte-identical):
  //   grounding_bound: true declares this driver is bound to a grounding manifest.
  //   manifest_digest: the evidence-spine thread (sha256:<hex>).
  // Field order in canonical text is owned by the dist's DRIVER_CANONICAL_FIELD_ORDER
  // (grounding_bound BEFORE manifest_digest, both BEFORE prevHash). The helper skips
  // undefined keys so omitted fields produce no canonical bytes.
  const withPrev = {
    kind: "driver-dimension",
    refId: coord.gitHead ?? "no-git",
    dimensions,
    snapshot_coord: coord,
    producer_identity: producerIdentity,
    producer_kind: "external",
    key_id: keyId,
    ...(groundingBound === true ? { grounding_bound: true } : {}),
    ...(manifestDigest !== undefined ? { manifest_digest: manifestDigest } : {}),
    prevHash,
  };
  const canonical = driverCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  const recordHash = computeDriverRecordHash(withPrev);
  const sealed = { ...withPrev, signature, recordHash };

  const file = externalDriverReceiptsPath(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(sealed) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind: "driver",
      producer_kind: "external",
      key_id: keyId,
      dimensions: dimensions.map((d) => d.name),
      recordHash,
      file,
    }) + "\n",
  );
}

/**
 * slice-5/BSC-1 — produce an external-signed {@link RealizationReceipt}. Writes the SEPARATE
 * `external-realization-receipts.jsonl` store (parallel to the driver/approval/scan external
 * stores) with the 5 realization canonical shape — NOT a terminal receipt.
 *
 * The make-or-break contract for the BSC-1 signature-provenance independence flip: the SIGNED
 * canonical text MUST be byte-identical to what the in-process gate validator re-derives, so
 * the signature it imports (`realizationCanonicalText` + `computeRealizationRecordHash` from
 * the compiled dist) is exactly the in-process binding. `signature` + `recordHash` are
 * trailers, EXCLUDED from the canonical text.
 *
 * Refuse-at-creation (mirrors the driver/approval ground-resolve refusal): `--ref-id` (the
 * REQ-ID) is required and `--target` (the referent source path) MUST resolve in source — else
 * we refuse BEFORE any write rather than mint a realization whose referent is already gone.
 * NOTE the independence is SIGNATURE-PROVENANCE only — the referent anchor is still agent-
 * authored (the producer signs an agent-chosen path); it proves the receipt was not forged
 * in-process, NOT that the referent is independent.
 */
/**
 * BSC-10 Slice-C / C4a: `groundingBound` and `manifestDigest` are additive-optional.
 * Passing `groundingBound:true` sets `grounding_bound:true` on the realization receipt.
 * Passing `manifestDigest` threads the evidence-spine `manifest_digest` field.
 * Both are omit-when-absent; the dist's canonical helper serializes them in the correct order.
 */
function produceRealization(paths, { reqId, target, producerIdentity, privateKey, publicKey, groundingBound, manifestDigest }) {
  const digest = computeTargetDigest(paths.root, target);
  if (digest === null) {
    fail(`--target "${target}" does not resolve in source — refusing to mint an ungrounded realization receipt`, { target });
  }
  const keyId = externalKeyId(publicKey);
  const prevHash = readLastExternalRealizationRecordHash(paths);

  // The canonical input — EXACTLY the fields realizationCanonicalText binds (signature +
  // recordHash are trailers, excluded; `undefined` keys dropped by the helper). Field order
  // is owned by the slice-5 CANONICAL_FIELD_ORDER inside realizationCanonicalText; the
  // producer never re-orders, it hands the object to the imported helper so bytes can't drift.
  // `owning_slice` is left empty here — the producer is out-of-process and does not consult
  // state; the in-process gate recomputes ownership fresh and never trusts this field.
  // C4a opt-in: grounding_bound (BEFORE manifest_digest in canonical order) and manifest_digest
  // are omit-when-absent — an absent realization stays byte-identical to pre-C4a.
  const withPrev = {
    kind: "realization",
    req_id: reqId,
    owning_slice: "",
    referent: { path: target, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: producerIdentity,
    producer_kind: "external",
    key_id: keyId,
    ...(groundingBound === true ? { grounding_bound: true } : {}),
    ...(manifestDigest !== undefined ? { manifest_digest: manifestDigest } : {}),
    prevHash,
  };
  const canonical = realizationCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  const recordHash = computeRealizationRecordHash(withPrev);
  const sealed = { ...withPrev, signature, recordHash };

  const file = externalRealizationReceiptsPath(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(sealed) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind: "realization",
      producer_kind: "external",
      key_id: keyId,
      req_id: reqId,
      referent: sealed.referent,
      recordHash,
      file,
    }) + "\n",
  );
}

/**
 * Parse + map a mutation-report JSON into the canonical {@link MutationKillGround} shape. Accepts
 * EITHER a minimal canonical report `{ mutants_generated, mutants_killed, mutants_survived, score,
 * scope }` OR a Stryker-style report (mutant statuses Killed/Survived/NoCoverage/Timeout mapped to
 * killed/survived, score from the report's `mutationScore`/100 or derived `killed/(killed+survived)`).
 * Deterministic + simple. `scopeOverride` (the `--scope` flag) wins over any report-supplied scope.
 * Returns `{ ground }` on success; throws an Error (message) on a malformed report so the caller can
 * refuse-at-creation (nonzero exit, no line written).
 */
function mapMutationReport(report, scopeOverride) {
  if (typeof report !== "object" || report === null) {
    throw new Error("mutation report is not a JSON object");
  }
  const r = report;

  let mutants_generated;
  let mutants_killed;
  let mutants_survived;
  let score;
  let scope;

  if (
    typeof r.mutants_generated === "number" &&
    typeof r.mutants_killed === "number" &&
    typeof r.mutants_survived === "number"
  ) {
    // Minimal canonical report.
    mutants_generated = r.mutants_generated;
    mutants_killed = r.mutants_killed;
    mutants_survived = r.mutants_survived;
    score =
      typeof r.score === "number"
        ? r.score
        : mutants_killed + mutants_survived > 0
          ? mutants_killed / (mutants_killed + mutants_survived)
          : 0;
    scope = typeof r.scope === "string" ? r.scope : undefined;
  } else if (r.files && typeof r.files === "object") {
    // Stryker-style report: aggregate every file's mutant statuses.
    let killed = 0;
    let survived = 0;
    let total = 0;
    for (const file of Object.values(r.files)) {
      const mutants = file && typeof file === "object" ? file.mutants : undefined;
      if (!Array.isArray(mutants)) continue;
      for (const m of mutants) {
        const status = m && typeof m === "object" ? m.status : undefined;
        total++;
        if (status === "Killed" || status === "Timeout") killed++;
        else if (status === "Survived" || status === "NoCoverage") survived++;
      }
    }
    mutants_generated = total;
    mutants_killed = killed;
    mutants_survived = survived;
    score =
      typeof r.mutationScore === "number"
        ? r.mutationScore / 100
        : killed + survived > 0
          ? killed / (killed + survived)
          : 0;
    // Stryker reports are keyed by file; a single-module run has one file key.
    const fileKeys = Object.keys(r.files);
    scope = fileKeys.length === 1 ? fileKeys[0] : undefined;
  } else {
    throw new Error("mutation report is neither a minimal canonical shape nor a Stryker-style report");
  }

  if (typeof scopeOverride === "string" && scopeOverride !== "" && scopeOverride !== "true") {
    scope = scopeOverride;
  }

  // Validate the 5 fields — refuse a malformed/incomplete ground rather than mint a phantom one.
  for (const [k, v] of [
    ["mutants_generated", mutants_generated],
    ["mutants_killed", mutants_killed],
    ["mutants_survived", mutants_survived],
    ["score", score],
  ]) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`mutation report field "${k}" is missing or not a finite number`);
    }
  }
  // Bounds + count-invariant (refuse-at-creation parity): the in-process gate validator only
  // checks finiteness, so a phantom efficacy signal (score 7, killed+survived > generated,
  // negative counts) must be refused HERE rather than minted and signed.
  for (const [k, v] of [
    ["mutants_generated", mutants_generated],
    ["mutants_killed", mutants_killed],
    ["mutants_survived", mutants_survived],
  ]) {
    if (v < 0 || !Number.isInteger(v)) {
      throw new Error(`mutation report field "${k}" must be a non-negative integer`);
    }
  }
  if (score < 0 || score > 1) {
    throw new Error(`mutation report \`score\` (${score}) is out of range — must be in [0, 1]`);
  }
  if (mutants_killed + mutants_survived > mutants_generated) {
    throw new Error(
      `mutation report counts are inconsistent: killed (${mutants_killed}) + survived (${mutants_survived}) exceeds generated (${mutants_generated})`,
    );
  }
  if (typeof scope !== "string" || scope === "") {
    throw new Error("mutation report has no `scope` — supply one in the report or via --scope <module>");
  }

  return { mutants_generated, mutants_killed, mutants_survived, score, scope };
}

/**
 * slice-6/BSC-2 (2b) — produce an external-signed {@link MutationKillReceipt}. Writes the SEPARATE
 * `external-mutation-receipts.jsonl` store (parallel to the driver/realization/approval external
 * stores) with the 2a mutation canonical shape — NOT a terminal receipt.
 *
 * The make-or-break contract for the BSC-2 signature-provenance independence flip: the SIGNED
 * canonical text MUST be byte-identical to what the in-process gate validator re-derives, so the
 * signature it imports (`mutationKillCanonicalText` + `computeMutationKillRecordHash` from the
 * compiled dist) is exactly the 2a binding. `signature` + `recordHash` are trailers, EXCLUDED from
 * the canonical text. `producer_kind` is the FIXED literal `"controlled-runner"` (part of the
 * signed input — a producer-kind swap breaks the signature).
 *
 * Refuse-at-creation (mirrors the driver/realization ground-resolve refusal): `--mutation-report`
 * is required and MUST resolve + parse into a well-formed mutation ground — else we refuse BEFORE
 * any write rather than mint an ungrounded mutation receipt. The mutation tool (Stryker) is NEVER
 * imported/run here; the producer only reads a report a controlled CI job emitted.
 *
 * NOTE the independence is SIGNATURE-PROVENANCE only over a bounded single-module `scope` — it
 * proves the receipt was not forged in-process, NOT that the suite kills every fault everywhere;
 * the module-scoped efficacy signal NEVER overrides the per-REQ assertion-presence rung.
 */
function produceMutationKill(paths, { mutationReportPath, scopeOverride, privateKey, publicKey }) {
  const abs = path.resolve(paths.root, mutationReportPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail(`--mutation-report "${mutationReportPath}" does not resolve to a file — refusing to mint an ungrounded mutation receipt`, {
      mutationReport: mutationReportPath,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (error) {
    fail(`--mutation-report "${mutationReportPath}" is not valid JSON — refusing to mint an ungrounded mutation receipt`, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  let ground;
  try {
    ground = mapMutationReport(parsed, scopeOverride);
  } catch (error) {
    fail(`--mutation-report "${mutationReportPath}" is malformed — refusing to mint an ungrounded mutation receipt`, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const coord = currentReceiptSnapshotCoord(paths);
  const keyId = externalKeyId(publicKey);
  const prevHash = readLastExternalMutationRecordHash(paths);

  // The canonical input — EXACTLY the fields mutationKillCanonicalText binds (signature +
  // recordHash are trailers, excluded; the ground + snapshot are re-emitted in their fixed key
  // order by the helper). Field order is owned by 2a's MUTATION_CANONICAL_FIELD_ORDER inside
  // mutationKillCanonicalText; the producer never re-orders, it hands the object to the imported
  // helper so the bytes can never drift. `producer_kind` is the FIXED `"controlled-runner"` literal.
  const withPrev = {
    kind: "mutation-kill",
    refId: coord.gitHead ?? "no-git",
    ground,
    snapshot_coord: coord,
    producer_kind: "controlled-runner",
    key_id: keyId,
    prevHash,
  };
  const canonical = mutationKillCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  const recordHash = computeMutationKillRecordHash(withPrev);
  const sealed = { ...withPrev, signature, recordHash };

  const file = externalMutationReceiptsPath(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(sealed) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind: "mutation-kill",
      producer_kind: "controlled-runner",
      key_id: keyId,
      scope: ground.scope,
      score: ground.score,
      recordHash,
      file,
    }) + "\n",
  );
}

/**
 * Parse + validate a grounding-report JSON into the canonical shape expected by the producer.
 * Accepts a report object with `ground` (the computable ground fields), optional `conformance`
 * (array of metric objects), optional `budgets` (array of budget objects to write to the sibling
 * store), and required `workClass`. Returns `{ ground, conformance, budgets }` on success; throws
 * an Error (message) on a malformed report so the caller can refuse-at-creation (nonzero exit, no
 * line written). The producer NEVER imports Stryker, a renderer, or axe-core — it only reads the
 * report a pinned CI/measurement job emitted. Refuse-at-creation mirrors mutation-kill.
 */
function mapGroundingReport(report, workClassOverride) {
  if (typeof report !== "object" || report === null) {
    throw new Error("grounding report is not a JSON object");
  }
  const r = report;

  // Work-class: override flag wins; else report-supplied; else refuse.
  const workClass =
    typeof workClassOverride === "string" && workClassOverride !== "" && workClassOverride !== "true"
      ? workClassOverride
      : typeof r.workClass === "string" && r.workClass !== ""
        ? r.workClass
        : undefined;
  if (typeof workClass !== "string" || workClass === "") {
    throw new Error("grounding report has no `workClass` — supply one in the report or via --work-class <class>");
  }

  // Ground: the computable ground object. Must have a `groundKind` discriminator.
  const ground = r.ground;
  if (typeof ground !== "object" || ground === null) {
    throw new Error("grounding report missing required `ground` field (must be an object with `groundKind`)");
  }
  const g = ground;
  const groundKind = g.groundKind;
  if (groundKind !== "digest-manifest" && groundKind !== "version-pin" && groundKind !== "visual-hash") {
    throw new Error(
      `grounding report \`ground.groundKind\` must be "digest-manifest", "version-pin", or "visual-hash" — got: ${JSON.stringify(groundKind)}`,
    );
  }

  // Kind-specific refuse-at-creation checks.
  if (groundKind === "digest-manifest") {
    if (typeof g.manifestDigest !== "string" || g.manifestDigest === "") {
      throw new Error('grounding report `ground.manifestDigest` is required for "digest-manifest" kind');
    }
    if (g.entries !== undefined) {
      if (!Array.isArray(g.entries)) {
        throw new Error('grounding report `ground.entries` must be an array when present');
      }
      for (const e of g.entries) {
        if (typeof e !== "object" || e === null || typeof e.path !== "string" || typeof e.digest !== "string") {
          throw new Error('grounding report `ground.entries[]` must have string `path` and `digest` fields');
        }
      }
    }
  } else if (groundKind === "version-pin") {
    if (typeof g.pkg !== "string" || g.pkg === "") {
      throw new Error('grounding report `ground.pkg` is required for "version-pin" kind');
    }
    if (typeof g.version !== "string" || g.version === "") {
      throw new Error('grounding report `ground.version` is required for "version-pin" kind');
    }
  } else if (groundKind === "visual-hash") {
    if (typeof g.perceptualHash !== "string" || g.perceptualHash === "") {
      throw new Error('grounding report `ground.perceptualHash` is required for "visual-hash" kind');
    }
  }

  // Conformance: optional array of metric objects in the EXACT `ConformanceMetric` shape:
  // `{ metric: "version"|"api"|"visual"|"a11y", observed: string|number|"unobserved",
  //    status: "within-budget"|"over-budget"|"unobserved" }`.
  // This is the shape `isValidConformanceMetric` in grounding.ts enforces — a receipt whose
  // conformance entries use any other field names (e.g. `value`) fails `isValidGroundingReceipt`
  // and is never classified `valid-grounded`. Default to `[]` (absent ⇒ empty array) so the
  // validator's `Array.isArray(r.conformance)` check always passes.
  let conformance = [];
  if (r.conformance !== undefined) {
    if (!Array.isArray(r.conformance)) {
      throw new Error("grounding report `conformance` must be an array when present");
    }
    const validMetrics = ["version", "api", "visual", "a11y"];
    const validStatuses = ["within-budget", "over-budget", "unobserved"];
    for (const m of r.conformance) {
      if (typeof m !== "object" || m === null) {
        throw new Error("grounding report `conformance[]` entries must be objects");
      }
      const cm = m;
      if (!validMetrics.includes(cm.metric)) {
        throw new Error(
          `grounding report \`conformance[].metric\` must be one of ${validMetrics.join("|")} — got: ${JSON.stringify(cm.metric)}`,
        );
      }
      // `observed`: measured value (string or finite number) OR the literal "unobserved".
      if (cm.observed !== "unobserved") {
        if (typeof cm.observed !== "string" && (typeof cm.observed !== "number" || !Number.isFinite(cm.observed))) {
          throw new Error(
            `grounding report \`conformance[].observed\` must be a string, finite number, or "unobserved" — got: ${JSON.stringify(cm.observed)}`,
          );
        }
      }
      // `status`: the fail-closed verdict — must be one of the three literals.
      if (!validStatuses.includes(cm.status)) {
        throw new Error(
          `grounding report \`conformance[].status\` must be one of ${validStatuses.join("|")} — got: ${JSON.stringify(cm.status)}`,
        );
      }
      // Consistency: "unobserved" observed value must pair with status "unobserved" (and vice versa).
      if (cm.observed === "unobserved" && cm.status !== "unobserved") {
        throw new Error(
          `grounding report \`conformance[]\` inconsistency: observed="unobserved" but status="${cm.status}" — must also be "unobserved"`,
        );
      }
      if (cm.observed !== "unobserved" && cm.status === "unobserved") {
        throw new Error(
          `grounding report \`conformance[]\` inconsistency: observed=${JSON.stringify(cm.observed)} (measured) but status="unobserved" — use "within-budget" or "over-budget"`,
        );
      }
    }
    // Strip stray keys — pass only the three canonical fields the gate validator checks.
    conformance = r.conformance.map((m) => ({ metric: m.metric, observed: m.observed, status: m.status }));
  }

  // Budgets: optional array for the sibling grounding-budgets.jsonl store (PCC-4). Each entry
  // must have the required budget fields — refuse rather than sign a malformed budget.
  let budgets = undefined;
  if (r.budgets !== undefined) {
    if (!Array.isArray(r.budgets)) {
      throw new Error("grounding report `budgets` must be an array when present");
    }
    const validKinds = ["digest-manifest", "version-pin", "visual-hash"];
    const validMetrics = ["version", "api", "visual", "a11y"];
    for (const b of r.budgets) {
      if (typeof b !== "object" || b === null) {
        throw new Error("grounding report `budgets[]` entries must be objects");
      }
      const bv = b;
      if (typeof bv.workClass !== "string" || bv.workClass === "") {
        throw new Error("grounding report `budgets[].workClass` must be a non-empty string");
      }
      if (!validKinds.includes(bv.groundKind)) {
        throw new Error(
          `grounding report \`budgets[].groundKind\` must be one of ${validKinds.join("|")} — got: ${JSON.stringify(bv.groundKind)}`,
        );
      }
      if (!validMetrics.includes(bv.metric)) {
        throw new Error(
          `grounding report \`budgets[].metric\` must be one of ${validMetrics.join("|")} — got: ${JSON.stringify(bv.metric)}`,
        );
      }
      if (typeof bv.threshold !== "number" || !Number.isFinite(bv.threshold) || bv.threshold < 0) {
        throw new Error(
          `grounding report \`budgets[].threshold\` must be a non-negative finite number — got: ${JSON.stringify(bv.threshold)}`,
        );
      }
    }
    budgets = r.budgets;
  }

  return { workClass, ground, conformance, budgets };
}

/**
 * slice-BSC10b/BSC-10 (B1) — produce an external-signed {@link GroundingReceipt}. Writes the
 * SEPARATE `external-grounding-receipts.jsonl` store (parallel to the mutation/driver/realization
 * external stores) with the BSC-10a grounding canonical shape — NOT a terminal receipt. Optionally
 * also writes the sibling `grounding-budgets.jsonl` store for each budget supplied in the report
 * (PCC-4 — 3-party budget authority; the agent cannot self-sign its own budget).
 *
 * The make-or-break contract for the BSC-10 signature-provenance independence flip: the SIGNED
 * canonical text MUST be byte-identical to what the in-process gate validator re-derives, so the
 * signature it imports (`groundingCanonicalText` + `computeGroundingRecordHash` from the compiled
 * dist) is exactly the BSC-10a binding. `signature` + `recordHash` are trailers, EXCLUDED from
 * the canonical text. `producer_kind` is the FIXED literal `"external"`.
 *
 * Refuse-at-creation (mirrors mutation-kill/realization ground-resolve refusal): `--grounding-report`
 * is required and MUST resolve + parse into a well-formed grounding ground — else we refuse BEFORE
 * any write rather than mint an ungrounded grounding receipt. The measurement toolchain (Stryker /
 * renderer / axe-core) is NEVER imported/run here; the producer only reads a report a pinned
 * CI/measurement job emitted (exactly like mutation-kill reads a Stryker report).
 *
 * NOTE the independence is SIGNATURE-PROVENANCE only — it proves the receipt was not forged
 * in-process. The budget authority is 3-party: the producer signs the threshold; the agent cannot
 * alter it without the private key (unsigned/wrong-key budget exempts NOTHING, M4).
 */
function produceGrounding(paths, { groundingReportPath, workClassOverride, producerIdentity, privateKey, publicKey }) {
  const abs = path.resolve(paths.root, groundingReportPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail(
      `--grounding-report "${groundingReportPath}" does not resolve to a file — refusing to mint an ungrounded grounding receipt`,
      { groundingReport: groundingReportPath },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (error) {
    fail(
      `--grounding-report "${groundingReportPath}" is not valid JSON — refusing to mint an ungrounded grounding receipt`,
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
  let groundingData;
  try {
    groundingData = mapGroundingReport(parsed, workClassOverride);
  } catch (error) {
    fail(
      `--grounding-report "${groundingReportPath}" is malformed — refusing to mint an ungrounded grounding receipt`,
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
  const { workClass, ground, conformance, budgets } = groundingData;

  const coord = currentReceiptSnapshotCoord(paths);
  const keyId = externalKeyId(publicKey);
  const prevHash = readLastExternalGroundingRecordHash(paths);

  // The canonical input — EXACTLY the fields groundingCanonicalText binds (signature +
  // recordHash are trailers, excluded; `undefined` keys dropped by the helper). Field order is
  // owned by BSC-10a's GROUNDING_CANONICAL_FIELD_ORDER inside groundingCanonicalText; the producer
  // never re-orders, it hands the object to the imported helper so the bytes can never drift.
  // `producer_kind` is the FIXED `"external"` literal (part of the signed input — a swap breaks
  // the signature).
  // `conformance` is always an array ([] when absent in the report) — isValidGroundingReceipt
  // requires Array.isArray(r.conformance), so it must never be absent from the sealed receipt.
  const withPrev = {
    kind: "grounding",
    refId: coord.gitHead ?? "no-git",
    workClass,
    ground,
    conformance,
    snapshot_coord: coord,
    producer_identity: producerIdentity,
    producer_kind: "external",
    key_id: keyId,
    prevHash,
  };
  const canonical = groundingCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  const recordHash = computeGroundingRecordHash(withPrev);
  const sealed = { ...withPrev, signature, recordHash };

  const file = externalGroundingReceiptsPath(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(sealed) + "\n", "utf8");

  // PCC-4 sibling budget store: sign each budget independently and append to
  // grounding-budgets.jsonl. An unsigned budget exempts NOTHING (M4 fail-closed) — so the
  // producer MUST sign every budget entry it writes. The signed/hashed canonical text is
  // produced by the SHARED `groundingBudgetCanonicalText` helper imported from the dist — the
  // exact formula the gate's `validGroundingBudgets` re-derives with — so the binding can never
  // drift between producer and gate (mirrors the main-receipt reuse of `groundingCanonicalText`).
  let budgetFile = undefined;
  let budgetCount = 0;
  if (budgets !== undefined && budgets.length > 0) {
    budgetFile = groundingBudgetsPath(paths);
    // Read the last recordHash in the budget store to seed prevHash for the chain.
    let budgetPrevHash = (() => {
      try {
        if (!fs.existsSync(budgetFile)) return "0".repeat(64);
        const lines = fs.readFileSync(budgetFile, "utf8").trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              typeof parsed.recordHash === "string" &&
              /^[0-9a-f]{64}$/.test(parsed.recordHash)
            ) {
              return parsed.recordHash;
            }
          } catch {
            // skip malformed line
          }
        }
      } catch {
        // file unreadable or absent
      }
      return "0".repeat(64);
    })();

    for (const b of budgets) {
      const budgetEntry = {
        kind: "grounding-budget",
        workClass: b.workClass,
        groundKind: b.groundKind,
        metric: b.metric,
        threshold: b.threshold,
        snapshot_coord: coord,
        producer_kind: "external",
        key_id: keyId,
        prevHash: budgetPrevHash,
      };
      // Canonical text via the SHARED dist helper (signature + recordHash excluded as trailers) —
      // byte-identical to what `validGroundingBudgets` verifies, by construction not by accident.
      const budgetCanonical = groundingBudgetCanonicalText(budgetEntry);
      const budgetSignature = sign(null, Buffer.from(budgetCanonical, "utf8"), privateKey).toString("base64");
      // hashContent from the already-loaded hash module for the recordHash (same as the gate's chain walk).
      const { hashContent } = hashMod;
      const budgetRecordHash = hashContent(budgetCanonical);
      const sealedBudget = { ...budgetEntry, signature: budgetSignature, recordHash: budgetRecordHash };

      fs.appendFileSync(budgetFile, JSON.stringify(sealedBudget) + "\n", "utf8");
      budgetPrevHash = budgetRecordHash;
      budgetCount++;
    }
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind: "grounding",
      producer_kind: "external",
      key_id: keyId,
      workClass,
      groundKind: ground.groundKind,
      recordHash,
      file,
      ...(budgetFile !== undefined ? { budgetFile, budgetCount } : {}),
    }) + "\n",
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args["root"];
  const kind = args["kind"];
  const refId = args["ref-id"];
  const target = args["target"]; // optional
  const stage = args["stage"]; // approval only
  // driver only: comma-separated dimension subset (optional). Omitted ⇒ all observed dims.
  const dimensionArg = args["dimension"]; // optional
  const dimensionNames =
    dimensionArg !== undefined && dimensionArg !== "true"
      ? dimensionArg.split(",").map((s) => s.trim()).filter((s) => s !== "")
      : undefined;
  // mutation-kill only: the controlled CI job's mutation-report path + optional --scope override.
  const mutationReportPath = args["mutation-report"]; // optional (required for mutation-kill)
  const scopeOverride = args["scope"]; // optional
  // grounding only: the pinned-env measurement report path + optional --work-class override.
  const groundingReportPath = args["grounding-report"]; // optional (required for grounding)
  const workClassOverride = args["work-class"]; // optional (wins over report-supplied workClass)
  // BSC-10 Slice-C / C4a opt-in: for driver|realization|approval receipts, these two flags
  // declare that the receipt participates in the BSC-10 evidence spine.
  //   --grounding-bound   sets `grounding_bound:true` (boolean flag, no value needed)
  //   --manifest-digest <sha256:hex>   threads the evidence-spine manifest_digest field
  // Both are omit-when-absent; a receipt without either flag is byte-identical to pre-C4a.
  const groundingBound = args["grounding-bound"] !== undefined; // presence of flag = true
  const manifestDigest =
    args["manifest-digest"] !== undefined && args["manifest-digest"] !== "true"
      ? args["manifest-digest"]
      : undefined;
  const producerIdentity = args["producer-identity"] ?? "external:th-receipt-producer";

  if (!root || root === "true") fail("--root <projectRoot> is required");
  if (!kind || !KINDS.has(kind)) fail(`--kind must be one of ${[...KINDS].join("|")}`, { kind: kind ?? null });
  // scan-exception is the SEPARATE slice-2b flow: it is keyed by (path, digest), not a
  // ref-id, so it requires --target (the dist file being excepted) and ignores --ref-id.
  // approval is the SEPARATE slice-3b flow: it is keyed by `stage`, not a ref-id/target.
  if (kind === "scan-exception") {
    if (!target || target === "true") fail("--target <repo-rel-path> is required for scan-exception");
  } else if (kind === "approval") {
    if (!stage || stage === "true") fail("--stage <humanGate-stage> is required for approval");
  } else if (kind === "driver") {
    // driver is the SEPARATE slice-4b flow: dimensions derive from verify-report.json, so it
    // requires NEITHER --ref-id NOR --target (the snapshot coordinate + report ARE the ground).
  } else if (kind === "realization") {
    // realization is the SEPARATE slice-5 flow: keyed by (REQ-ID, referent path), so it
    // requires --ref-id (the REQ-ID) AND --target (the referent source path).
    if (!refId || refId === "true") fail("--ref-id <REQ-ID> is required for realization");
    if (!target || target === "true") fail("--target <repo-rel-path> is required for realization");
  } else if (kind === "mutation-kill") {
    // mutation-kill is the SEPARATE slice-6/2b flow: keyed by the controlled CI job's mutation
    // report, so it requires --mutation-report (the report path) and ignores --ref-id/--target.
    if (!mutationReportPath || mutationReportPath === "true") {
      fail("--mutation-report <path> is required for mutation-kill");
    }
  } else if (kind === "grounding") {
    // grounding is the SEPARATE slice-BSC10b/BSC-10 B1 flow: keyed by the pinned-env measurement
    // report, so it requires --grounding-report (the report path); --work-class is optional (the
    // report may supply it). --ref-id/--target/--stage/--dimension/--mutation-report are IGNORED.
    if (!groundingReportPath || groundingReportPath === "true") {
      fail("--grounding-report <path> is required for grounding");
    }
  } else {
    if (!refId || refId === "true") fail("--ref-id <ID> is required");
    if ((kind === "drift-resolve" || kind === "sim-retire") && (!target || target === "true")) {
      fail(`--target <repo-rel-path> is required for ${kind}`);
    }
  }

  // The producer MUST have the private key — hard-fail if absent or invalid.
  const privateKey = loadPrivateKey();
  const publicKey = createPublicKey(privateKey);

  const paths = resolveProjectPaths(root);

  // slice-2b: the external-signed exception ack writes a DIFFERENT store with a DIFFERENT
  // canonical shape — branch BEFORE the terminal-receipt machinery so that flow is untouched.
  if (kind === "scan-exception") {
    produceScanException(paths, { target, privateKey, publicKey });
    return;
  }

  // slice-3b: the external-signed human-approval writes a DIFFERENT store
  // (`external-approvals.jsonl`) with the 3a approval canonical shape — branch BEFORE the
  // terminal-receipt machinery so that flow stays byte-identical.
  if (kind === "approval") {
    produceApproval(paths, { stage, producerIdentity, privateKey, publicKey, groundingBound, manifestDigest });
    return;
  }

  // slice-4b: the external-signed driver-dimension receipt writes a DIFFERENT store
  // (`external-driver-receipts.jsonl`) with the 4a driver canonical shape — branch BEFORE the
  // terminal-receipt machinery so that flow stays byte-identical.
  if (kind === "driver") {
    produceDriver(paths, { dimensionNames, producerIdentity, privateKey, publicKey, groundingBound, manifestDigest });
    return;
  }

  // slice-5: the external-signed realization receipt writes a DIFFERENT store
  // (`external-realization-receipts.jsonl`) with the slice-5 realization canonical shape —
  // branch BEFORE the terminal-receipt machinery so that flow stays byte-identical.
  if (kind === "realization") {
    produceRealization(paths, { reqId: refId, target, producerIdentity, privateKey, publicKey, groundingBound, manifestDigest });
    return;
  }

  // slice-6/2b: the external-signed mutation-kill receipt writes a DIFFERENT store
  // (`external-mutation-receipts.jsonl`) with the 2a mutation canonical shape — branch BEFORE the
  // terminal-receipt machinery so that flow stays byte-identical.
  if (kind === "mutation-kill") {
    produceMutationKill(paths, { mutationReportPath, scopeOverride, privateKey, publicKey });
    return;
  }

  // slice-BSC10b/BSC-10 (B1): the external-signed grounding receipt writes a DIFFERENT store
  // (`external-grounding-receipts.jsonl`) with the BSC-10a grounding canonical shape + optionally
  // the sibling `grounding-budgets.jsonl` (PCC-4) — branch BEFORE the terminal-receipt machinery
  // so that flow stays byte-identical.
  if (kind === "grounding") {
    produceGrounding(paths, { groundingReportPath, workClassOverride, producerIdentity, privateKey, publicKey });
    return;
  }

  // Build the content-bound ground. If a --target is supplied it MUST resolve in
  // source (refuse-at-creation, mirroring appendTerminalReceipt); else empty ground
  // (decision-approve build-coordinate-only / no linked artifact).
  let targetPath = "";
  let digest = "";
  if (target !== undefined && target !== "" && target !== "true") {
    const d = computeTargetDigest(paths.root, target);
    if (d === null) {
      fail(`target "${target}" does not resolve in source — refusing to mint an ungrounded receipt`, { target });
    }
    targetPath = target;
    digest = d;
  }

  const keyId = externalKeyId(publicKey);
  const prevHash = readLastExternalReceiptRecordHash(paths);

  // The canonical input — every signed field, recordHash + signature excluded. The
  // canonicalText(), computeRecordHash(), and the Ed25519 signature bind IDENTICAL input.
  const withPrev = {
    kind,
    refId,
    target_resolves_in_source: { path: targetPath, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: producerIdentity,
    producer_kind: "external",
    key_id: keyId,
    prevHash,
  };
  const canonical = canonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  const recordHash = computeRecordHash(withPrev);
  const sealed = { ...withPrev, signature, recordHash };

  // Append one JSON line to the EXTERNAL store (its own append-only chain). This file
  // is under the governed stateDir; the producer writes it directly (no in-process
  // lock — that is the whole point of the separate store).
  const file = externalReceiptsPath(paths);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(sealed) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind,
      refId,
      producer_kind: "external",
      key_id: keyId,
      target_resolves_in_source: sealed.target_resolves_in_source,
      recordHash,
      file,
    }) + "\n",
  );
}

main();
