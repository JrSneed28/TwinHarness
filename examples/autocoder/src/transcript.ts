/**
 * IF-012 TranscriptWriter — append-only, durable-per-entry JSONL audit log
 * (ADR-002, RULE-010, REQ-022, REQ-NFR-008). The writer assigns `seq`
 * monotonically; entries are strictly ordered and never rewritten (INV-009).
 *
 * SLICE-8 hardening (TASK-016): the writer is now a real durable append-only log.
 *  - `open(runId)` opens ONE persistent file handle in append mode (single writer
 *    per run — REQ-NFR-002; no concurrent writers, the loop is sequential).
 *  - `append(entry)` assigns a monotonic, gap-free `seq`, writes ONE JSONL line and
 *    fsync-class flushes it to disk BEFORE returning. A crash therefore loses at
 *    most the in-flight line (ADR-002): every prior entry is already durable.
 *  - `flush()` is the final flush at Terminating (each append already fsyncs, so it
 *    is a no-op on the happy path; it remains so the lifecycle contract is complete
 *    and a future buffered impl has a hook).
 *  - A write/flush FAILURE is FATAL (ERR-014): `append`/`flush` throw a
 *    `TranscriptWriteError` (code `TRANSCRIPT_WRITE_FAILED`). `agent-run` catches it
 *    on the unrecoverable-error path → Failed (audit must not be silently lost —
 *    RULE-010). It is NOT a clean stop and is NOT swallowed.
 *
 * The envelope (`schemaVersion`/`seq`/`ts`/`runId`/`type`/`payload`) is sufficient to
 * RECONSTRUCT the run: each tool call's I/O (tool-called + tool-result) and each stop
 * decision (run-stopped + run-completed) are recorded in seq order (REQ-NFR-008).
 * The `apiKey` is NEVER serialized into any entry — emitters never place it in a
 * payload, and the writer adds no fields of its own beyond the envelope [SENSITIVE].
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  SCHEMA_VERSION,
  type TranscriptWriter,
  type TranscriptEntryInput,
  type TranscriptEntry,
} from "./contracts.js";

/** The fatal error code surfaced when an audit write/flush fails (ERR-014). */
export const TRANSCRIPT_WRITE_FAILED = "TRANSCRIPT_WRITE_FAILED";

/**
 * A write/flush failure to the audit log (ERR-014, Channel B — FATAL). It carries a
 * stable `code` so `agent-run` routes it to the unrecoverable-error → Failed path
 * (RULE-010: audit must not be silently lost). It is deliberately distinct from a
 * `UserAbortError` (clean stop), so `agent-run`'s catch classifies it as
 * unrecoverable-error, never a clean user-abort.
 */
export class TranscriptWriteError extends Error {
  readonly code = TRANSCRIPT_WRITE_FAILED;
  constructor(message: string, cause?: unknown) {
    // The original fs error is preserved via the standard Error `cause` option.
    super(`${TRANSCRIPT_WRITE_FAILED}: ${message}`, { cause });
    this.name = "TranscriptWriteError";
  }
}

/** True iff `err` is the fatal transcript-write class (ERR-014). */
export function isTranscriptWriteError(err: unknown): err is TranscriptWriteError {
  return err instanceof TranscriptWriteError;
}

export interface FileTranscriptOptions {
  /** Directory to write the per-run transcript file into. */
  dir: string;
}

/**
 * File-backed transcript writer. Holds ONE append-mode file handle per run (the
 * single writer); each `append` writes one JSONL line and fsync-class flushes it to
 * disk before returning (durable per entry — a crash loses at most the in-flight
 * line, ADR-002). Any underlying write/flush failure is re-raised as a fatal
 * `TranscriptWriteError` (ERR-014).
 */
export function createTranscriptWriter(opts: FileTranscriptOptions): TranscriptWriter {
  let filePath: string | null = null;
  // The single persistent append-mode handle for this run (single writer — no
  // concurrent writers; the loop is sequential, REQ-NFR-002).
  let handle: fs.FileHandle | null = null;
  let seq = 0;

  return {
    async open(runId: string): Promise<void> {
      try {
        await fs.mkdir(opts.dir, { recursive: true });
        filePath = path.join(opts.dir, `${runId}.jsonl`);
        // Fresh chain per run (no resume in the MVP — V1 out of scope): truncate or
        // create the per-run file, then hold ONE append-mode handle for the run.
        await fs.writeFile(filePath, "", { encoding: "utf8" });
        handle = await fs.open(filePath, "a");
        seq = 0;
      } catch (err) {
        // A failure to open the audit log is itself fatal — the run cannot produce a
        // reconstructable transcript, so it must not start silently (RULE-010).
        throw new TranscriptWriteError(
          `failed to open transcript for run ${runId}`,
          err,
        );
      }
    },

    async append(entry: TranscriptEntryInput): Promise<void> {
      if (handle === null) {
        throw new TranscriptWriteError("append before open");
      }
      // Assign the monotonic, gap-free seq HERE (the writer is the single owner of
      // seq — INV-009). It is assigned only once we are about to write, so a failed
      // write does not consume a seq for a line that never lands.
      const full: TranscriptEntry = {
        ...entry,
        schemaVersion: entry.schemaVersion ?? SCHEMA_VERSION,
        seq,
      };
      const line = JSON.stringify(full) + "\n";
      try {
        // Durable per entry: append the line, then fsync-class flush so the byte is
        // on stable storage BEFORE we return (ADR-002). A crash now loses at most a
        // future in-flight line, never this one.
        await handle.write(line);
        await handle.sync();
      } catch (err) {
        // Channel B FATAL (ERR-014): a write/flush failure is unrecoverable — the
        // audit trail can no longer be trusted, so surface it rather than swallow it
        // (RULE-010). seq is NOT advanced, so no gap is introduced.
        throw new TranscriptWriteError(
          `failed to write entry seq=${seq} type=${entry.type}`,
          err,
        );
      }
      // Advance seq only AFTER a durable write (gap-free, strictly increasing).
      seq += 1;
    },

    async flush(): Promise<void> {
      // Each append already fsyncs, so nothing is buffered at Terminating. We still
      // issue a final sync (when a handle is open) so the lifecycle contract holds
      // and any future buffered impl has its flush hook here. A failure is fatal.
      if (handle === null) return;
      try {
        await handle.sync();
      } catch (err) {
        throw new TranscriptWriteError("final flush failed", err);
      }
    },
  };
}

/**
 * Read a transcript file back into ordered entries (test/inspection helper).
 *
 * CRASH TOLERANCE (ADR-002): a crash mid-write can leave a PARTIAL last line (the
 * in-flight entry that never finished fsyncing). The reader therefore parse-SKIPS a
 * trailing line that is not valid JSON rather than throwing — the durable prefix is
 * always recoverable. Only the final line may be partial (each prior line was
 * fsynced whole before the next began), so a parse failure anywhere but the last
 * line indicates real corruption and is surfaced.
 */
export async function readTranscript(filePath: string): Promise<TranscriptEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new TranscriptWriteError(`failed to read transcript ${filePath}`, err);
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    const line = lines[i] ?? "";
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch (err) {
      if (isLast) {
        // Tolerate a partial in-flight last line (crash mid-write) — skip it; the
        // durable prefix above is intact and reconstructable.
        break;
      }
      // A non-terminal unparseable line is genuine corruption, not a crash artifact.
      throw new TranscriptWriteError(
        `corrupt transcript line ${i} in ${filePath}`,
        err,
      );
    }
  }
  return entries;
}
