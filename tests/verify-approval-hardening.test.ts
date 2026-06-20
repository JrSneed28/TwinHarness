/**
 * P1 — verify.json to the decision-record standard (R-01 + R-02 + R-03).
 *
 * Adversarial regression suite for the verify-approval hardening:
 *   R-01  `th verify approve` is HUMAN-only — a caller with no TTY is refused, so
 *         the automated actor that can `add` can no longer self-approve.
 *   R-02  the approval is sealed in a tamper-EVIDENT, hash-chained ledger; a forged
 *         /edited approval breaks the chain and `verify run` fails CLOSED.
 *   R-03  a corrupt verify.json is refused (never read as an empty/approved set).
 *
 * (Concurrency for R-03's lock is covered in concurrency.test.ts; the write-gate
 * narrowing for R-02 is covered in pretool-gate.test.ts REQ-WGATE-010.)
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runVerifyAdd, runVerifyApprove, runVerifyClear, runVerifyRun } from "../src/commands/verify";
import {
  readVerifyConfig,
  isCommandSetApproved,
  evaluateCommandSetApproval,
  readVerifyApprovals,
  verifyApprovalChain,
  verifyApprovalsPath,
  verifyConfigPath,
  commandSetHash,
} from "../src/core/verify";

const PASS_CMD = `node -e "process.exit(0)"`;
const TTY_YES = { isTTY: true, stdinLine: "y" } as const;

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// ===========================================================================
// R-01 — TTY barrier on `th verify approve` (no silent self-approve)
// ===========================================================================

describe("REQ-VERIFY-P1-R01: approve requires an interactive human TTY", () => {
  it("no-TTY approve is REFUSED (no_tty); the set stays unapproved; run still refuses", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);

    const res = runVerifyApprove(tp.paths, { as: "agent", tty: { isTTY: false } });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("no_tty");

    // No approval was sealed — the set is still unapproved and run refuses it.
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(false);
    expect(readVerifyApprovals(tp.paths)).toHaveLength(0);
    expect(runVerifyRun(tp.paths).data?.error).toBe("unapproved_command_set");
  });

  it("declining at the prompt (n/EOF) is REFUSED (confirmation_declined); stays unapproved", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);

    const res = runVerifyApprove(tp.paths, { as: "human", tty: { isTTY: true, stdinLine: "n" } });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("confirmation_declined");
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(false);
    expect(readVerifyApprovals(tp.paths)).toHaveLength(0);
  });

  it("an interactive 'y' approves: the set becomes runnable and the approval is sealed", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);

    const res = runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES });
    expect(res.ok).toBe(true);
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(true);
    expect(runVerifyRun(tp.paths).ok).toBe(true);

    const events = readVerifyApprovals(tp.paths);
    expect(events).toHaveLength(1);
    expect(events[0]!.approvedBy).toBe("human");
    expect(events[0]!.approvedHash).toBe(commandSetHash([PASS_CMD]));
  });

  it("there is no --yes/override: only an interactive confirmation can approve", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    // An empty/garbage line is NOT a confirmation.
    expect(runVerifyApprove(tp.paths, { as: "x", tty: { isTTY: true, stdinLine: "" } }).data?.error).toBe(
      "confirmation_declined",
    );
    expect(runVerifyApprove(tp.paths, { as: "x", tty: { isTTY: true, stdinLine: "sure" } }).data?.error).toBe(
      "confirmation_declined",
    );
  });
});

// ===========================================================================
// R-02 — tamper-evident, hash-chained approval ledger
// ===========================================================================

describe("REQ-VERIFY-P1-R02: the approval ledger is tamper-evident (fail closed)", () => {
  it("a forged approvedHash (direct ledger edit) breaks the chain → run refuses (tampered)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES }).ok).toBe(true);

    // Forge the sealed approvedHash by editing the ledger line directly, leaving the
    // (now-stale) recordHash in place — exactly the "forge approval" attack.
    const ledger = verifyApprovalsPath(tp.paths);
    const event = JSON.parse(fs.readFileSync(ledger, "utf8").trim());
    event.approvedHash = commandSetHash(["rm -rf /"]); // valid hex64, but not the sealed value
    fs.writeFileSync(ledger, JSON.stringify(event) + "\n", "utf8");

    const evalRes = evaluateCommandSetApproval(tp.paths, readVerifyConfig(tp.paths).commands);
    expect(evalRes.approved).toBe(false);
    expect(evalRes.reason).toBe("chain_broken");

    const run = runVerifyRun(tp.paths);
    expect(run.ok).toBe(false);
    expect(run.data?.error).toBe("tampered_approval");
  });

  it("a structurally-invalid forged line is skipped → set reads UNAPPROVED, not approved", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);

    // Drop in a hand-written 'approval' with the right approvedHash but a bogus
    // recordHash (not 64-hex) — it fails validation, is skipped, and never approves.
    fs.writeFileSync(
      verifyApprovalsPath(tp.paths),
      JSON.stringify({
        approvedHash: commandSetHash([PASS_CMD]),
        commandCount: 1,
        approvedBy: "attacker",
        approvedAt: "2026-01-01T00:00:00.000Z",
        prevHash: "0".repeat(64),
        recordHash: "not-a-real-hash",
      }) + "\n",
      "utf8",
    );
    expect(isCommandSetApproved(tp.paths, [PASS_CMD])).toBe(false);
    expect(runVerifyRun(tp.paths).data?.error).toBe("unapproved_command_set");
  });

  it("adding a command after approval re-requires approval; re-approval extends the chain", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES }).ok).toBe(true);

    // Change the set → the latest approval no longer matches → unapproved.
    runVerifyAdd(tp.paths, `node -e "process.exit(0)" && echo two`);
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(false);
    expect(runVerifyRun(tp.paths).data?.error).toBe("unapproved_command_set");

    // Re-approve the new set → a second chained event; chain stays intact.
    expect(runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES }).ok).toBe(true);
    const events = readVerifyApprovals(tp.paths);
    expect(events).toHaveLength(2);
    expect(verifyApprovalChain(events).ok).toBe(true);
    expect(events[1]!.prevHash).toBe(events[0]!.recordHash); // properly chained
    expect(runVerifyRun(tp.paths).ok).toBe(true);
  });

  // add‖approve race post-condition (spec: "add‖approve never yields approved-set-
  // missing-a-command"). True OS-level concurrency for approve is infeasible (the
  // TTY barrier blocks a spawned, TTY-less child), so we pin the LOCK's
  // post-condition that defeats the race: approve re-reads the set UNDER the lock and
  // seals the FULL current set — never a stale pre-add subset.
  it("approve seals the FULL current set (in-lock re-read), never a stale subset", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    runVerifyAdd(tp.paths, `node -e "process.exit(0)" && echo two`);

    expect(runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES }).ok).toBe(true);
    const commands = readVerifyConfig(tp.paths).commands;
    expect(commands).toHaveLength(2);

    const last = readVerifyApprovals(tp.paths).at(-1)!;
    expect(last.commandCount).toBe(2);
    expect(last.approvedHash).toBe(commandSetHash(commands)); // sealed the whole set
    expect(isCommandSetApproved(tp.paths, commands)).toBe(true);
  });

  it("an earlier-but-no-longer-latest approved set reads UNAPPROVED (latest-event-only)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD); // set A
    expect(runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES }).ok).toBe(true);

    // Approve a different set B (event 2 is now the latest).
    runVerifyAdd(tp.paths, `node -e "process.exit(0)" && echo b`); // set A+B
    expect(runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES }).ok).toBe(true);

    // Reconstruct exactly set A. Its approval (event 1) is no longer the latest, so
    // the gate must NOT silently re-authorize it without a fresh confirmation.
    runVerifyClear(tp.paths);
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(readVerifyConfig(tp.paths).commands).toEqual([PASS_CMD]);
    expect(isCommandSetApproved(tp.paths, [PASS_CMD])).toBe(false);
    expect(runVerifyRun(tp.paths).data?.error).toBe("unapproved_command_set");
  });

  it("a torn final ledger line is skipped; the prior valid approval still holds (fail-safe)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES }).ok).toBe(true);

    // Simulate a torn append (a crash mid-write leaves a partial last line).
    fs.appendFileSync(verifyApprovalsPath(tp.paths), '{ "approvedHash": "deadb', "utf8");

    const events = readVerifyApprovals(tp.paths);
    expect(events).toHaveLength(1); // the torn line is skipped, not parsed
    expect(verifyApprovalChain(events).ok).toBe(true);
    expect(isCommandSetApproved(tp.paths, [PASS_CMD])).toBe(true); // last good approval stands
    expect(runVerifyRun(tp.paths).ok).toBe(true);
  });
});

// ===========================================================================
// R-03 — corrupt config fails CLOSED (never an empty/approved set)
// ===========================================================================

describe("REQ-VERIFY-P1-R03: a corrupt verify.json is refused, not read as empty/approved", () => {
  it("run on a present-but-unparseable config → corrupt_config (not no_verify_commands/approved)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES });

    // Corrupt the config bytes AFTER a legit approval — the old reader would have
    // degraded this to "no commands" (empty set ⇒ trivially "approved" ⇒ pass).
    fs.writeFileSync(verifyConfigPath(tp.paths), "{ not valid json", "utf8");

    const run = runVerifyRun(tp.paths);
    expect(run.ok).toBe(false);
    expect(run.data?.error).toBe("corrupt_config");
  });

  it("approve on a corrupt config → corrupt_config (refuses to approve a set it cannot read)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(verifyConfigPath(tp.paths), "}{ broken", "utf8");

    const res = runVerifyApprove(tp.paths, { as: "human", tty: TTY_YES });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("corrupt_config");
  });

  it("a legacy verify.json carrying the old approvedHash field reads UNAPPROVED", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // A pre-P1 file whose self-attested approvedHash matches the commands. With no
    // ledger event, the forgeable inline field must NOT be honored (R-02 read-tolerance).
    fs.writeFileSync(
      verifyConfigPath(tp.paths),
      JSON.stringify({
        commands: [PASS_CMD],
        approvedHash: commandSetHash([PASS_CMD]),
        approvedBy: "legacy",
        approvedAt: "2026-01-01T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );
    expect(readVerifyConfig(tp.paths).commands).toEqual([PASS_CMD]); // commands still read
    expect(isCommandSetApproved(tp.paths, [PASS_CMD])).toBe(false); // but NOT approved
    expect(runVerifyRun(tp.paths).data?.error).toBe("unapproved_command_set");
  });
});

// ===========================================================================
// R-20 — confirm→seal TOCTOU: a set that changes after the human confirms is
// REJECTED under the lock (the human approves CONTENT, not a generic id).
// ===========================================================================

describe("REQ-VERIFY-P1-R20: confirm→seal TOCTOU is closed", () => {
  it("a `verify add` injected between confirm and lock ABORTS the approval (nothing sealed)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);

    // The human confirms the 1-command set; a concurrent `add` injects a second command
    // in the confirm→lock window (deterministically, via the onAfterConfirm seam).
    const res = runVerifyApprove(tp.paths, {
      as: "human",
      tty: TTY_YES,
      onAfterConfirm: () => {
        runVerifyAdd(tp.paths, `node -e "process.exit(1)"`);
      },
    });

    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("command_set_changed");
    // Nothing sealed: no ledger entry; the (now 2-command) set is unapproved; run refuses.
    expect(readVerifyApprovals(tp.paths)).toHaveLength(0);
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(false);
    expect(runVerifyRun(tp.paths).data?.error).toBe("unapproved_command_set");
  });

  it("an UNCHANGED set through the window still seals normally (no false abort)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);

    let called = false;
    const res = runVerifyApprove(tp.paths, {
      as: "human",
      tty: TTY_YES,
      onAfterConfirm: () => {
        called = true; // observe the window, but do NOT mutate the set
      },
    });

    expect(called).toBe(true);
    expect(res.ok).toBe(true);
    expect(readVerifyApprovals(tp.paths)).toHaveLength(1);
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(true);
  });

  // NOTE (OPT-2): runVerifyApprove also prints the actual command list + a short hash
  // fingerprint to stderr before the barrier so the confirmation is content-bound (not a
  // blind "approve the verify command set?"). That preview is informational UX; per repo
  // convention these command tests assert on the returned CommandResult, not on stderr
  // bytes (vitest's stdio handling makes stderr capture unreliable here), so the preview
  // is intentionally not asserted. The SECURITY guarantee — reject-on-drift — is covered above.
});
