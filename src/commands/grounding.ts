/**
 * `th grounding record` / `th grounding check` (Axis-B slice-A / BSC-10) — in-process
 * external-reference grounding producer and reader/validator.
 *
 * BSC-10 identified that external references (dependency versions, visual renderings,
 * API manifests) carried by a slice could silently drift or be unverified — a version pin
 * could be claimed without a digest binding, a UI assertion could be declared without a
 * perceptual hash, and the completion gate would not notice (BSC-10). These two verbs are
 * the missing in-process SENSOR surface:
 *
 *   `th grounding record`  — appends a GroundingReceipt to
 *     `<stateDir>/grounding-receipts.jsonl`, hash-chained, under `withStateLock` (exactly
 *     like `th driver record` / `th approve` / `th realize`). ATTRIBUTION-ONLY (zero trust
 *     weight) — the agent can mint it, so its trust label is `valid` NEVER `valid-grounded`;
 *     independent grounding arrives only with the Slice-B external Ed25519-signed producer.
 *
 *   `th grounding check`   — READ-ONLY validator: recomputes/validates the chain and prints
 *     a summary. Appends NOTHING. Leaves NO breadcrumb file. The write-surface snapshot must
 *     show zero delta for this verb (enforced by the MCP write-surface audit test).
 *
 * The core store and classifier live in `src/core/grounding.ts`; this is the governed CLI
 * writer/reader surface (mirroring the driver/realization/assertion-presence producer split).
 */

import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { withStateLock, readState } from "../core/state-store";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { NOT_INIT } from "../core/guards";
import {
  type GroundingGround,
  appendGroundingReceipt,
  groundingReceiptsPath,
  readGroundingReceipts,
  readGroundingValidated,
  verifyGroundingChain,
} from "../core/grounding";

export interface GroundingRecordOptions {
  /** The ground kind discriminant: "digest-manifest" | "version-pin" | "visual-hash". Required. */
  groundKind?: string;
  /** The work-class this receipt is minted for (drives the required-ground matrix). Required. */
  workClass?: string;
  /** For digest-manifest: the manifest digest string. */
  manifestDigest?: string;
  /** For version-pin: the package name. */
  pkg?: string;
  /**
   * For version-pin: the pinned version string. Named `pinVersion` (not `version`) to avoid
   * colliding with the existing numeric `--version` / `version?: number` artifact-versioning flag
   * in `ParsedArgs`.
   */
  pinVersion?: string;
  /** For visual-hash: the perceptual hash string. */
  perceptualHash?: string;
  /** For visual-hash: optional renderer identifier. */
  renderer?: string;
  /** Self-asserted producer identity (attribution-only, zero in-process trust weight). */
  producerIdentity?: string;
}

export interface GroundingCheckOptions {
  // No write flags — th grounding check is strictly read-only.
}

/**
 * `th grounding record --ground-kind <k> --work-class <c> [--identity <who>] [...]` — mint an
 * in-process grounding receipt and append it to the grounding receipts store. Serialized under
 * the state lock so the chain append is atomic (mirrors `th approve` / `th driver record`).
 */
export function runGroundingRecord(paths: ProjectPaths, opts: GroundingRecordOptions = {}): CommandResult {
  return withStateLock(paths, () => runGroundingRecordLocked(paths, opts));
}

function runGroundingRecordLocked(paths: ProjectPaths, opts: GroundingRecordOptions): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: "state.json is invalid; fix it before recording a grounding receipt.",
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const groundKind = (opts.groundKind ?? "").trim();
  if (groundKind === "") {
    return failure({
      human:
        "Usage: th grounding record --ground-kind <digest-manifest|version-pin|visual-hash> --work-class <c> [...].\n" +
        "The --ground-kind discriminant is required.",
      data: { error: "grounding_kind_missing" },
    });
  }

  const workClass = (opts.workClass ?? "").trim();
  if (workClass === "") {
    return failure({
      human:
        "Usage: th grounding record --ground-kind <k> --work-class <c> [...].\n" +
        "The --work-class field is required (drives the required-ground matrix).",
      data: { error: "grounding_work_class_missing" },
    });
  }

  // Build the discriminated GroundingGround union from the kind-specific CLI flags.
  // Each variant requires its own mandatory fields; missing required fields are surfaced
  // as a refuse-at-creation error (mirrors `th driver record` / `th realize`).
  let ground: GroundingGround;
  switch (groundKind) {
    case "digest-manifest": {
      const manifestDigest = (opts.manifestDigest ?? "").trim();
      if (manifestDigest === "") {
        return failure({
          human:
            "Usage: th grounding record --ground-kind digest-manifest --manifest-digest <d> --work-class <c>.\n" +
            "--manifest-digest is required for ground kind 'digest-manifest'.",
          data: { error: "grounding_manifest_digest_missing" },
        });
      }
      ground = { groundKind: "digest-manifest", manifestDigest };
      break;
    }
    case "version-pin": {
      const pkg = (opts.pkg ?? "").trim();
      const version = (opts.pinVersion ?? "").trim();
      if (pkg === "" || version === "") {
        return failure({
          human:
            "Usage: th grounding record --ground-kind version-pin --pkg <p> --pin-version <v> --work-class <c>.\n" +
            "--pkg and --pin-version are both required for ground kind 'version-pin'.",
          data: { error: "grounding_version_pin_fields_missing" },
        });
      }
      ground = { groundKind: "version-pin", pkg, version };
      break;
    }
    case "visual-hash": {
      const perceptualHash = (opts.perceptualHash ?? "").trim();
      if (perceptualHash === "") {
        return failure({
          human:
            "Usage: th grounding record --ground-kind visual-hash --perceptual-hash <h> --work-class <c>.\n" +
            "--perceptual-hash is required for ground kind 'visual-hash'.",
          data: { error: "grounding_perceptual_hash_missing" },
        });
      }
      const renderer = (opts.renderer ?? "").trim() || undefined;
      ground = { groundKind: "visual-hash", perceptualHash, ...(renderer ? { renderer } : {}) };
      break;
    }
    default:
      return failure({
        human:
          `Unknown --ground-kind value: "${groundKind}". ` +
          `Must be one of: digest-manifest, version-pin, visual-hash.`,
        data: { error: "grounding_kind_unknown", groundKind },
      });
  }

  const sealed = appendGroundingReceipt(paths, {
    workClass,
    ground,
    producerIdentity: opts.producerIdentity ?? "cli:th grounding record",
  });

  const rel = path.relative(paths.root, groundingReceiptsPath(paths)).split(path.sep).join("/");

  // Audit trail (mirrors the driver/realization/assertion-presence writers): a grounding
  // receipt grounds the BSC-10 external-reference rung. Key the chain digest as
  // `groundingRecordHash` so it never collides with the ledger entry's own seal fields.
  appendLedger(paths, {
    event: "grounding-record",
    groundKind,
    workClass,
    groundingRecordHash: sealed.recordHash,
  });
  structuredLog({ cmd: "grounding record", groundKind, workClass, groundingRecordHash: sealed.recordHash });

  return success({
    data: {
      file: rel,
      groundKind,
      workClass,
      producer_kind: sealed.producer_kind ?? "in-process",
      recordHash: sealed.recordHash,
    },
    human:
      `Recorded an in-process grounding receipt at ${rel} ` +
      `(groundKind: ${groundKind}, workClass: ${workClass}). ` +
      `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
      `independent grounding requires the Slice-B external Ed25519-signed producer.`,
    receipts: [{ file: rel, hash: sealed.recordHash }],
  });
}

/**
 * `th grounding check` — READ-ONLY: recompute/validate the grounding chain and print a
 * summary. Appends NOTHING and leaves NO breadcrumb file. The write-surface snapshot must
 * show zero delta for this verb.
 */
export function runGroundingCheck(paths: ProjectPaths, _opts: GroundingCheckOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: "state.json is invalid; fix it before checking grounding receipts.",
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  // Pure read: verify raw chain integrity, then load the validated (trust-labelled) view.
  // readGroundingReceipts — raw JSONL parse (tolerant, never throws); used for chain walk.
  // readGroundingValidated — trust-labels each receipt (byKind Map); also pure read.
  // Neither call writes anything; no withStateLock needed.
  const rawReceipts = readGroundingReceipts(paths);
  const chainResult = verifyGroundingChain(rawReceipts);
  const validated = readGroundingValidated(paths);

  const total = rawReceipts.length;
  const chainOk = chainResult.ok;

  // Summarise the byKind Map into a stable array for the output payload.
  const byKindSummary = Array.from(validated.byKind.entries()).map(([groundKind, entry]) => ({
    groundKind,
    recordHash: entry.receipt.recordHash,
    trustLabel: entry.trustLabel,
    workClass: entry.receipt.workClass,
  }));

  structuredLog({
    cmd: "grounding check",
    total,
    chainOk,
    inProcessChainOk: validated.inProcessChainOk,
    byKindCount: validated.byKind.size,
  });

  return success({
    data: {
      total,
      chainOk,
      inProcessChainOk: validated.inProcessChainOk,
      ...(!chainOk
        ? { chainBrokenAt: (chainResult as { ok: false; brokenAt: number; reason: string }).brokenAt,
            chainBreakReason: (chainResult as { ok: false; brokenAt: number; reason: string }).reason }
        : {}),
      byKind: byKindSummary,
    },
    human:
      `Grounding receipts: ${total} total; chain ${chainOk ? "OK" : "BROKEN"}` +
      (!chainOk
        ? ` (broken at index ${(chainResult as { ok: false; brokenAt: number; reason: string }).brokenAt},` +
          ` reason: ${(chainResult as { ok: false; brokenAt: number; reason: string }).reason})`
        : "") +
      `; ${validated.byKind.size} trusted kind(s): ${byKindSummary.map((e) => e.groundKind).join(", ") || "(none)"}` +
      `. (Read-only — no state written.)`,
  });
}
