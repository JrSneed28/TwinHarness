"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runVerifyAdd = runVerifyAdd;
exports.runVerifyList = runVerifyList;
exports.runVerifyClear = runVerifyClear;
exports.runVerifyApprove = runVerifyApprove;
exports.runVerifyRun = runVerifyRun;
const output_1 = require("../core/output");
const verify_1 = require("../core/verify");
const state_store_1 = require("../core/state-store");
const decision_1 = require("./decision");
const log_1 = require("../core/log");
/**
 * `th verify` — configure and run the project's own test/check commands.
 *
 * This is the deliberate single exception to the CLI's no-execution boundary
 * (see core/verify.ts). It records a list of operator-authored commands and runs
 * them on demand, writing a report the run-health views consume. It still does
 * NOT decide anything: the orchestrator decides when to verify; this command
 * runs what it is told and records the result.
 *
 *   th verify add <command>   Append a command to the verify list
 *   th verify list            Show the configured commands
 *   th verify clear           Remove all configured commands
 *   th verify approve         Human-confirm the current command set for execution
 *   th verify run             Execute every configured command; exit 1 on any failure
 *
 * Phase 6 hardening (#19): every `add` records provenance (actor + timestamp);
 * `run` supports `--read-only` to refuse repo-mutating commands on untrusted projects.
 *
 * P1 hardening (R-01/R-02/R-03): `approve` is HUMAN-ONLY — a TTY barrier
 * (`requireTTYConfirmation`, shared with `decision approve`) refuses a
 * non-interactive caller, so the automated actor that can `add` can no longer
 * self-approve the commands it will then execute. The approval is sealed into the
 * tamper-evident `verify-approvals.jsonl` ledger; a forged/edited approval breaks
 * the chain and `run` fails CLOSED. `add`/`clear`/`approve` all mutate under
 * `withStateLock` (no lost updates / torn writes), and a corrupt config is refused
 * rather than read as an empty/approved set.
 */
/** Resolve the actor attribution for a verify mutation (provenance, #19, P6-2). */
function resolveVerifyActor(explicit) {
    return (explicit ?? process.env.TH_VERIFY_ACTOR ?? "unknown").trim() || "unknown";
}
/** `th verify add "<command>"` — append a command to verify.json (with provenance). */
function runVerifyAdd(paths, command, opts = {}) {
    const trimmed = command?.trim();
    if (!trimmed)
        return (0, output_1.failure)({ human: 'usage: th verify add "<command>"' });
    // Record provenance (#19, P6-2): who added this command, and when.
    const actor = resolveVerifyActor(opts.as);
    const addedAt = (opts.now ?? (() => new Date()))().toISOString();
    // R-03: serialize the read-modify-write under withStateLock so N concurrent
    // `verify add` calls never lose an update, and the config is written atomically.
    // Adding a command CHANGES the set — no approval-field bookkeeping is needed: the
    // tamper-evident ledger's latest approval no longer matches the new set, so it
    // reads as UNAPPROVED automatically (evaluateCommandSetApproval).
    const result = (0, state_store_1.withStateLock)(paths, () => {
        const config = (0, verify_1.loadVerifyConfig)(paths).config;
        config.commands.push(trimmed);
        config.provenance = [...(config.provenance ?? []), { command: trimmed, actor, addedAt }];
        (0, verify_1.writeVerifyConfig)(paths, config);
        return { commands: config.commands, provenance: config.provenance };
    });
    (0, log_1.structuredLog)({ cmd: "verify add", command: trimmed, actor, count: result.commands.length });
    return (0, output_1.success)({
        data: {
            commands: result.commands,
            provenance: result.provenance,
            approved: (0, verify_1.isCommandSetApproved)(paths, result.commands),
        },
        human: `added: ${trimmed} (by ${actor})\n${result.commands.length} command(s) configured.\n` +
            `This command set is UNAPPROVED for execution — run \`th verify approve\` to confirm it before \`th verify run\`.`,
    });
}
/** `th verify list` — show configured commands (with provenance + approval status). */
function runVerifyList(paths) {
    const config = (0, verify_1.readVerifyConfig)(paths);
    const approved = (0, verify_1.isCommandSetApproved)(paths, config.commands);
    const latest = approved ? (0, verify_1.latestApprovalFor)(paths, config.commands) : undefined;
    const provByCommand = new Map((config.provenance ?? []).map((p) => [p.command, p]));
    const human = config.commands.length
        ? config.commands
            .map((c, i) => {
            const p = provByCommand.get(c);
            const prov = p ? `  (added by ${p.actor} at ${p.addedAt})` : "";
            return `  ${i + 1}. ${c}${prov}`;
        })
            .join("\n") +
            "\n" +
            (approved
                ? `\nSet APPROVED for execution${latest ? ` (by ${latest.approvedBy} at ${latest.approvedAt})` : ""}.`
                : "\nSet UNAPPROVED — run `th verify approve` before `th verify run`.")
        : "(no verify commands configured — add one with `th verify add \"<command>\"`)";
    return (0, output_1.success)({
        data: {
            commands: config.commands,
            provenance: config.provenance ?? [],
            approved,
        },
        human,
    });
}
/** `th verify clear` — remove all configured commands. Serialized + atomic (R-03).
 * The approval ledger is append-only history; an empty set is trivially approved
 * (nothing to run), so no approval entry needs clearing. */
function runVerifyClear(paths) {
    (0, state_store_1.withStateLock)(paths, () => (0, verify_1.writeVerifyConfig)(paths, { commands: [] }));
    (0, log_1.structuredLog)({ cmd: "verify clear" });
    return (0, output_1.success)({ data: { commands: [] }, human: "verify commands cleared." });
}
/**
 * `th verify approve` — HUMAN-confirm the CURRENT command set for execution
 * (R-01). The TTY barrier (`requireTTYConfirmation`, shared with `decision
 * approve`) runs before any approval write: a caller with no controlling TTY (an
 * agent's tool shell, CI, a pipe) is refused, and there is NO `--yes`/override
 * flag — so the same automated actor that can `add` a command can no longer
 * self-approve it. On confirmation the approval is sealed into the tamper-evident
 * `verify-approvals.jsonl` ledger (R-02), serialized under `withStateLock` (R-03).
 * Attribution (NOT a barrier) comes from `--as` / TH_VERIFY_ACTOR.
 *
 * The "nothing to approve" / corrupt-config checks run BEFORE the barrier (they are
 * reads, perform no approval write, and reporting them needs no TTY — mirroring the
 * pre-barrier disposition check in `decision approve`).
 */
function runVerifyApprove(paths, opts = {}) {
    const pre = (0, verify_1.loadVerifyConfig)(paths);
    if (pre.status === "corrupt") {
        (0, log_1.structuredLog)({ cmd: "verify approve", error: "corrupt_config" });
        return (0, output_1.failure)({
            human: "verify.json is present but unreadable/corrupt — refusing to approve. Inspect it, or run " +
                "`th verify clear` and re-add the commands, then approve.",
            data: { error: "corrupt_config" },
        });
    }
    if (pre.config.commands.length === 0) {
        return (0, output_1.failure)({
            human: "No verify commands configured — nothing to approve. Add one with `th verify add \"<command>\"`.",
            data: { error: "no_verify_commands" },
        });
    }
    // ---- R-01 BARRIER (runs before any approval write) ------------------------
    const confirm = (0, decision_1.requireTTYConfirmation)("the verify command set", "approve", opts.tty);
    if (!confirm.ok) {
        (0, log_1.structuredLog)({ cmd: "verify approve", error: confirm.error });
        return (0, output_1.failure)({
            human: confirm.error === "no_tty"
                ? "Approving a verify command set requires an interactive terminal (no controlling TTY). " +
                    "This blocks a non-interactive/agent caller from self-approving the commands it will then execute."
                : "Approval declined at the confirmation prompt.",
            data: { error: confirm.error },
        });
    }
    const actor = resolveVerifyActor(opts.as);
    const approvedAt = (opts.now ?? (() => new Date()))().toISOString();
    // Re-read the command set under the lock and seal the approval to whatever set is
    // current at lock time (R-03 — no add/approve race can stamp a stale set). Echo
    // the SAME in-lock set in the result so the reported commands match what was sealed.
    const { sealed, commands } = (0, state_store_1.withStateLock)(paths, () => {
        const locked = (0, verify_1.loadVerifyConfig)(paths).config.commands;
        const event = (0, verify_1.appendVerifyApproval)(paths, {
            approvedHash: (0, verify_1.commandSetHash)(locked),
            commandCount: locked.length,
            approvedBy: actor,
            approvedAt,
        });
        return { sealed: event, commands: locked };
    });
    (0, log_1.structuredLog)({ cmd: "verify approve", actor, commands: sealed.commandCount, hash: sealed.approvedHash });
    return (0, output_1.success)({
        data: { approved: true, approvedHash: sealed.approvedHash, approvedBy: actor, commands },
        human: `Approved ${sealed.commandCount} verify command(s) for execution (by ${actor}). ` +
            "The approval is sealed in the tamper-evident verify-approvals ledger; `th verify run` may now execute this set.",
    });
}
function renderReport(report) {
    const lines = report.results.map((r) => `  ${r.ok ? "✓" : "✗"} (${r.exitCode}) ${r.command}  [${r.durationMs}ms]`);
    const failed = report.results.filter((r) => !r.ok);
    const tail = failed.length
        ? ["", "First failure output (tail):", ...failed[0].outputTail.split(/\r?\n/).map((l) => `    ${l}`)]
        : [];
    return [
        report.ok ? `verify PASS — ${report.results.length} command(s) green` : `verify FAIL — ${failed.length}/${report.results.length} command(s) failed`,
        ...lines,
        ...tail,
    ].join("\n");
}
/**
 * `th verify run` — execute every configured command in order, write the report,
 * and exit non-zero if any command failed. With no commands configured it is a
 * usage failure (nothing to verify).
 *
 * Phase 6 (#19): refuses to run an UNAPPROVED command set — a new/changed set must
 * be confirmed via `th verify approve` first; passes a curated env and redacts
 * secrets from the report (P6-3, in core/verify); and supports `--read-only`
 * (P6-5) to refuse repo-mutating commands on untrusted projects.
 *
 * P1 (R-02/R-03): a CORRUPT config fails CLOSED (refused, never read as an
 * empty/approved set), and a TAMPERED approval ledger (broken hash chain) is
 * refused distinctly from a plain unapproved set.
 */
function runVerifyRun(paths, opts = {}) {
    const loaded = (0, verify_1.loadVerifyConfig)(paths);
    if (loaded.status === "corrupt") {
        // R-03: fail CLOSED — an unreadable/torn config must never be treated as an
        // empty (and therefore trivially "approved") command set.
        return (0, output_1.failure)({
            human: "verify.json is present but unreadable/corrupt — refusing to run (fail-closed). " +
                "It is NOT treated as an empty/approved set. Inspect it, or run `th verify clear` and re-configure.",
            data: { error: "corrupt_config" },
        });
    }
    const config = loaded.config;
    if (config.commands.length === 0) {
        return (0, output_1.failure)({
            human: 'No verify commands configured. Add one with `th verify add "<command>"` (e.g. `th verify add "npm test"`).',
            data: { error: "no_verify_commands" },
        });
    }
    // R-01/R-02: a new/changed command set must be human-confirmed (sealed in the
    // tamper-evident ledger) before its first run; a broken ledger chain → tampered.
    const approval = (0, verify_1.evaluateCommandSetApproval)(paths, config.commands);
    if (!approval.approved) {
        const tampered = approval.reason === "chain_broken";
        return (0, output_1.failure)({
            human: tampered
                ? "The verify approval ledger (.twinharness/verify-approvals.jsonl) is TAMPERED — its hash chain is broken. " +
                    "Refusing to run on a possibly-forged approval. Inspect the ledger, then re-approve with `th verify approve`."
                : "This verify command set is UNAPPROVED for execution. A new or changed command set must be human-confirmed " +
                    "before the first run (defense against an injected/changed command running silently). " +
                    "Review it with `th verify list`, then run `th verify approve` to confirm, then `th verify run`.",
            data: {
                error: tampered ? "tampered_approval" : "unapproved_command_set",
                commandHash: (0, verify_1.commandSetHash)(config.commands),
            },
        });
    }
    const report = (0, verify_1.runCommands)(paths.root, config.commands, { readOnly: opts.readOnly });
    (0, verify_1.writeVerifyReport)(paths, report);
    (0, log_1.structuredLog)({ cmd: "verify run", ok: report.ok, commands: report.results.length, readOnly: Boolean(opts.readOnly) });
    const data = { ok: report.ok, ranAt: report.ranAt, results: report.results };
    return report.ok
        ? (0, output_1.success)({ data, human: renderReport(report) })
        : (0, output_1.failure)({ data, human: renderReport(report) });
}
