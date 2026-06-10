/**
 * `allowlist` component (REQ-016, ADR-006) — the auto-run matcher.
 *
 * Holds the configured `AllowlistEntry[]` and decides whether a command line is
 * allowlisted for AUTO-RUN. Matching is **token-sequence PREFIX** (ADR-006), NOT
 * substring: an entry `"git status"` matches `git status -s` (its tokens are a
 * prefix of the command's tokens) but does NOT match `git statusfoo` (`statusfoo`
 * is a different token) nor `git` alone (the entry has more tokens than the command).
 *
 * Two security-sensitive invariants (the negative tests guard the blast radius):
 *  - **Substring is not a match.** `git statusfoo` must NOT auto-run on a `git status`
 *    entry (`test_REQ016_allowlist_prefix_match_is_token_exact`).
 *  - **Chained / redirected forms NEVER auto-run** even if the head token is
 *    allowlisted — `;`, `&&`, `||`, `|`, `>`, `<`, backtick, `$(` force confirmation
 *    (INV-010, `test_REQ016_chained_command_never_auto_runs`). This is enforced at
 *    the matcher AND re-checked at `approval-gate.resolveCommand` (defense in depth).
 *
 * This component does ONLY matching. Allowlist inspect/add/remove UX + persistence is
 * SLICE-9 — not here.
 */
import type { AllowlistEntry } from "./contracts.js";

/**
 * Shell metacharacters that turn a single command into a CHAINED or REDIRECTED form.
 * Their presence ANYWHERE in the command line disqualifies it from auto-run (INV-010),
 * because the head token being allowlisted says nothing about the rest of the pipeline
 * (`git status && rm -rf /` has an allowlisted head but a destructive tail).
 *
 * Detected (as raw substrings of the command line, before tokenization):
 *   `;`  command separator
 *   `&&` / `||`  logical chaining (and the bare `&` backgrounding operator)
 *   `|`  pipe
 *   `>` / `<`  redirection (covers `>>`, `2>`, `<<` etc.)
 *   `` ` ``  backtick command substitution
 *   `$(` command substitution
 *   `\n`  a newline embeds a second command line
 */
const CHAINING_METACHARS: readonly string[] = [";", "&", "|", ">", "<", "`", "$(", "\n", "\r"];

/**
 * True iff `command` contains any chaining/redirection metacharacter (INV-010). Such
 * a command is NEVER auto-run — it forces confirmation regardless of its head token.
 * Detection is on the RAW command line (pre-tokenization) so an operator glued to a
 * token (`a&&b`, `cmd>out`) is still caught.
 */
export function isChainedOrRedirected(command: string): boolean {
  return CHAINING_METACHARS.some((meta) => command.includes(meta));
}

/**
 * Tokenize a command line into argv tokens. Whitespace-separated; honors single and
 * double quotes so a quoted segment is ONE token (a quoted space does not split). This
 * is the argv the token-sequence-prefix matcher compares against. (Chained/redirected
 * forms are rejected upstream by `isChainedOrRedirected`, so this tokenizer never needs
 * to interpret operators — it only needs faithful word/quote splitting.)
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * True iff `entryTokens` is a TOKEN-SEQUENCE PREFIX of `commandTokens`: every entry
 * token equals the command token at the same position, AND the command has at least
 * as many tokens as the entry. An empty entry matches nothing (a degenerate pattern
 * must never auto-run everything).
 */
function isTokenPrefix(entryTokens: string[], commandTokens: string[]): boolean {
  if (entryTokens.length === 0) return false;
  if (entryTokens.length > commandTokens.length) return false;
  for (let i = 0; i < entryTokens.length; i++) {
    if (entryTokens[i] !== commandTokens[i]) return false;
  }
  return true;
}

/** The `allowlist` matcher surface. */
export interface Allowlist {
  /** The configured entries (read-only view). */
  readonly entries: readonly AllowlistEntry[];
  /**
   * True iff `command` is allowlisted for AUTO-RUN: it is NOT chained/redirected
   * (INV-010) AND at least one entry's tokens are a token-sequence prefix of the
   * command's tokens (ADR-006). Otherwise false (the caller forces confirmation).
   */
  isAllowed(command: string): boolean;
}

/**
 * Build an `allowlist` from the configured entries. Holds the set; provides
 * token-sequence-prefix matching with the chained/redirected disqualifier.
 */
export function createAllowlist(entries: AllowlistEntry[]): Allowlist {
  // Pre-tokenize each entry pattern once.
  const entryTokenLists = entries.map((e) => tokenize(e.pattern));

  return {
    entries,
    isAllowed(command: string): boolean {
      // INV-010: a chained/redirected command is NEVER auto-run, full stop — even if
      // its head token is allowlisted. Checked FIRST, before any prefix match.
      if (isChainedOrRedirected(command)) {
        return false;
      }
      const commandTokens = tokenize(command);
      if (commandTokens.length === 0) return false;
      return entryTokenLists.some((entryTokens) => isTokenPrefix(entryTokens, commandTokens));
    },
  };
}
