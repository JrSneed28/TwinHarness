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
 *     --kind <drift-resolve|sim-retire|decision-approve|scan-exception> \
 *     [--ref-id <ID>] \
 *     [--target <repo-rel-path>] \
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

const KINDS = new Set(["drift-resolve", "sim-retire", "decision-approve", "scan-exception"]);

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args["root"];
  const kind = args["kind"];
  const refId = args["ref-id"];
  const target = args["target"]; // optional
  const producerIdentity = args["producer-identity"] ?? "external:th-receipt-producer";

  if (!root || root === "true") fail("--root <projectRoot> is required");
  if (!kind || !KINDS.has(kind)) fail(`--kind must be one of ${[...KINDS].join("|")}`, { kind: kind ?? null });
  // scan-exception is the SEPARATE slice-2b flow: it is keyed by (path, digest), not a
  // ref-id, so it requires --target (the dist file being excepted) and ignores --ref-id.
  if (kind === "scan-exception") {
    if (!target || target === "true") fail("--target <repo-rel-path> is required for scan-exception");
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
