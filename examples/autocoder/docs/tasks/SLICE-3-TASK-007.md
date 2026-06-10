# SLICE-3 / TASK-007 — PathSandbox checkRead / checkWrite / checkExecCwd

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-021 (partial — read/search half), REQ-NFR-007
**Slice:** SLICE-3 — Read & search the repo through the loop (sandboxed)
**Depends on:** SLICE-2 / TASK-005 complete (tools dispatched by the live loop)

---

## Goal

Implement the `path-sandbox` confinement guard as a pure deterministic function: `checkRead` (always
allowed — INV-002), `checkWrite`/`checkExecCwd` (allowed iff the target's real path equals or
descends the canonical root; fail-closed on any resolution doubt), returning the symlink-resolved
canonical path on success or a `PATH_ESCAPE` reason on rejection. Cross-platform: case-fold +
backslash handling on Windows, POSIX semantics elsewhere.

---

## REQ-IDs

- **REQ-021** — File mutations (write/edit) and command execution are confined to the resolved
  working root; any write/exec target that escapes the root (via traversal, absolute path, or
  symlink) is rejected before the operation. Reads may access paths outside the root (read-anywhere).
  *(This task implements the sandbox; the read/search half of REQ-021 is asserted in this slice; the
  write & exec enforcement assertions land in SLICE-4 / SLICE-5.)*
- **REQ-NFR-007** — *Portability:* runs on macOS, Linux, and Windows (Node ≥ 18); path handling
  accounts for cross-platform differences.

---

## Relevant Contracts / Interfaces

```
IF-010 PathSandbox:
  checkWrite(path):  path: string [required] — candidate write target; resolved against canonical root
  checkExecCwd(cwd): cwd:  string [required] — candidate command cwd
  checkRead(path):   path: string [required] — candidate read target (ALWAYS allowed — INV-002)

  → { allowed: boolean,
      canonicalPath: string,                         // resolved symlink-resolved absolute path when allowed
      reason?: { code: "PATH_ESCAPE", message: string } }  // when rejected (write/exec only)

Postconditions:
  - write/exec allowed IFF target real path == or descends the canonical root
    (real path of deepest existing ancestor + non-existing tail; case-folded on Windows).
  - read ALWAYS allowed (deliberate asymmetry — INV-002, ADR-005).
  - FAIL-CLOSED on any resolution doubt.
  - PURE deterministic function of (canonical root, candidate path, filesystem symlink state).

ERR-001 PATH_ESCAPE: write/exec target escapes the root (traversal / absolute-outside /
  symlink-escape / unresolvable) → caller emits error ToolResult.
```

---

## Relevant Design Notes

- **Data-integrity blast radius** — this is the most safety-critical component; it is heavily
  negative-tested. Resolve the **real path of the deepest existing ancestor + the non-existing tail**
  so that not-yet-created files inside the root are allowed and symlink escapes are caught.
- **Fail-closed**: any error/doubt during resolution → rejection, never a permissive default.
- The canonical root is `realpath`-resolved and validated as a directory at startup (SLICE-1 produced
  the resolved root string; this task pins it as the canonical root).

---

## Acceptance Test(s)

- `test_REQNFR007_path_confinement_windows_and_posix` — confinement holds under Windows (case-fold,
  backslash) and POSIX path semantics (via fixtures).
- *(The write/exec PATH_ESCAPE assertions — `test_REQ021_write_traversal_rejected`,
  `..._symlink_escape_rejected`, `..._absolute_outside_rejected`, `..._unresolvable_path_rejected`,
  `test_REQ021_exec_cwd_escape_rejected` — are written in SLICE-4 / SLICE-5 against the tools, but the
  sandbox logic they exercise is implemented here.)*

> This task's own anchored coverage row is REQ-NFR-007 (`test_REQNFR007_path_confinement_*`); the
> REQ-021 partial it supports is asserted via the read/search path in SLICE-3 / TASK-008
> (`test_REQ006_read_outside_root_allowed`, `test_REQ007_search_path_escape`).

---

## Definition of Done

- [ ] `test_REQNFR007_path_confinement_windows_and_posix` passes; the sandbox functions are
      consumed-green by TASK-008's read/search tests.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The sandbox matches IF-010; any newly-pinned detail promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-NFR-007 and the partial REQ-021 still map to passing
      tests in this slice).

---

## Out of Scope for This Task

- The tool bodies that call the sandbox (SLICE-3 / TASK-008 for read/search; SLICE-4/5 for
  write/exec).
- TOCTOU / LWW residual documentation tests (`test_REQ021_toctou_*`, `..._lww`) — SLICE-4 / TASK-010.
- Approval gating (SLICE-4) — the sandbox does not own approval decisions.
