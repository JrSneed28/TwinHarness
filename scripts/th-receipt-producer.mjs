#!/usr/bin/env node
/**
 * th-receipt-producer.mjs — the EXTERNAL, KEYED terminal-receipt producer
 * (Axis-B slice-1b / BSC-4 — the INDEPENDENCE primitive).
 *
 * This is DELIBERATELY a standalone Node ESM script, NOT a `th` subcommand and NOT
 * an MCP tool: adding a verb/tool would (a) defeat independence — the very surface
 * the completion gate constrains would gain a signing code path — and (b) perturb
 * the CLI/MCP parity invariant. The genuine un-forgeable property is that this
 * producer runs OUT of process, holds the HMAC key (`TH_RECEIPT_HMAC_KEYFILE`), and
 * appends a SIGNED receipt the in-process agent cannot mint (it has no signing code
 * and, in the threat model, no key). The gate then classifies that receipt
 * `valid-grounded`; an in-process-forged equivalent is `valid` (attested, not
 * grounded) and a claimed-but-unsigned/forged one is `forged` (blocked).
 *
 * The SHARED formula is imported from the COMPILED dist so the producer and the
 * in-process validator can NEVER diverge on the binding (one canonicalText, one
 * computeRecordHash, one signCanonical). It is the producer's responsibility to have
 * the key: unlike the fail-SOFT validator path, a missing/unreadable key here is a
 * HARD error (nonzero exit) — a producer with no key cannot produce.
 *
 * Usage:
 *   TH_RECEIPT_HMAC_KEYFILE=/path/to/key \
 *   node scripts/th-receipt-producer.mjs \
 *     --root <projectRoot> \
 *     --kind <drift-resolve|sim-retire|decision-approve> \
 *     --ref-id <ID> \
 *     [--target <repo-rel-path>] \
 *     [--producer-identity <string>]
 *
 * Prints a small JSON result on stdout. Exit 0 on success, nonzero on any error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the compiled dist relative to THIS script's own location (scripts/ is a
// sibling of dist/), so the producer works regardless of the caller's cwd.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

const receiptsMod = await import(pathToFileUrl(path.join(DIST, "core", "receipts.js")));
const signingMod = await import(pathToFileUrl(path.join(DIST, "core", "receipt-signing.js")));
const pathsMod = await import(pathToFileUrl(path.join(DIST, "core", "paths.js")));

const {
  canonicalText,
  computeRecordHash,
  computeTargetDigest,
  currentSnapshotCoord,
  externalReceiptsPath,
  readLastExternalReceiptRecordHash,
} = receiptsMod;
const { signCanonical, loadExternalKey, externalKeyId } = signingMod;
const { resolveProjectPaths } = pathsMod;

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

const KINDS = new Set(["drift-resolve", "sim-retire", "decision-approve"]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args["root"];
  const kind = args["kind"];
  const refId = args["ref-id"];
  const target = args["target"]; // optional
  const producerIdentity = args["producer-identity"] ?? "external:th-receipt-producer";

  if (!root || root === "true") fail("--root <projectRoot> is required");
  if (!kind || !KINDS.has(kind)) fail(`--kind must be one of ${[...KINDS].join("|")}`, { kind: kind ?? null });
  if (!refId || refId === "true") fail("--ref-id <ID> is required");

  // The producer MUST have the key — hard-fail (nonzero) if absent/unreadable/empty.
  const key = loadExternalKey();
  if (key === null) {
    fail("TH_RECEIPT_HMAC_KEYFILE is unset, unreadable, or empty — the external producer requires the key");
  }

  const paths = resolveProjectPaths(root);

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

  const keyId = externalKeyId(key);
  const prevHash = readLastExternalReceiptRecordHash(paths);

  // The canonical input — every signed field, recordHash + signature excluded. The
  // canonicalText() / computeRecordHash() / signCanonical() inputs are IDENTICAL.
  const withPrev = {
    kind,
    refId,
    target_resolves_in_source: { path: targetPath, digest },
    snapshot_coord: currentSnapshotCoord(paths.root),
    producer_identity: producerIdentity,
    producer_kind: "external",
    key_id: keyId,
    prevHash,
  };
  const canonical = canonicalText(withPrev);
  const signature = signCanonical(canonical, key);
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
