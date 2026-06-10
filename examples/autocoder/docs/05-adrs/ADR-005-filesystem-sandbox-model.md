# ADR-005 — Filesystem sandbox model: read-anywhere, write/exec confined to root

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** The data-integrity safety posture is **read-anywhere, write-and-exec confined
to the resolved working root** — every write/exec target that escapes the root (traversal, absolute
path, symlink) is rejected before the operation, while reads may range outside the root.

---

## Title / ID

**ADR-005** — Filesystem sandbox model = read-anywhere / write+exec confined to root

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* human-gated decision — OQ-3 resolved 2026-06-09 ("read-anywhere, write/exec-in-root"). This
is the project's data-integrity blast-radius posture.

---

## Context

Autocoder mutates files and executes shell commands on the developer's machine — the reason it is a
Tier-3, data-integrity blast-radius project. The model's tool calls are **untrusted input** crossing
the filesystem/shell boundary, so the harness must define exactly how far a write or an execution can
reach. REQ-021 and RULE-001 make confinement a non-negotiable: no write/exec may escape the resolved
working root. But the agent also needs to consult shared configs and sibling files to do real work,
which pulls the read scope wider than the write scope.

The open question (OQ-3) was the **read** scope: confine reads to the root too (tighter, safer), or
allow reads anywhere (more capable, but exposes files outside the root). This is a safety-posture
decision with a real, accepted residual risk, which is why it was human-gated. It is costly to reverse
because the entire `path-sandbox` boundary, the `tool-read` capability, and the security/failure
treatments in 08a/08b are built around the chosen asymmetry.

**Relevant REQ-IDs:** REQ-021, REQ-NFR-005, REQ-006, REQ-008, REQ-009, REQ-023
**Components affected:** `path-sandbox`, `tool-read`, `tool-writeedit`, `tool-applypatch`,
`tool-runcommand`

---

## Decision

> **Chosen:** asymmetric sandbox — **writes and command execution are strictly confined to the
> resolved working root** (escapes via traversal, absolute path, or symlink are rejected before the
> op by `path-sandbox`); **reads may access paths outside the root** (read-anywhere).

This optimizes for **capability without sacrificing the data-integrity guarantee that actually
matters**: the irreversible, destructive operations (writing files, running commands) cannot touch
anything outside the developer's chosen root, so the blast radius of a bad or adversarial model is
bounded; meanwhile the agent can still read shared configs/sibling files to understand the project.
The tradeoff consciously accepted is **read exposure** — the agent can read secrets/credentials in
sibling directories. This residual risk is accepted by human decision (OQ-3), bounded by the facts
that content read from outside the root can never be written back outside it (RULE-003) and every read
is recorded in the `transcript`.

*Human gate triggered:* yes — approved by user on 2026-06-09 (OQ-3: "read-anywhere,
write/exec-in-root").

---

## Consequences

### Positive

- **Destructive blast radius is bounded** — `path-sandbox` guarantees no write or command-exec
  escapes the root, so a bad/adversarial model cannot mutate or run code outside the developer's
  chosen tree (REQ-021, RULE-001, the data-integrity non-negotiable).
- **The agent stays capable** — `tool-read` can consult shared configs and sibling files outside the
  root, which real coding tasks need (REQ-006), without widening the dangerous write/exec surface.
- **Write-back is contained even for outside reads** — content read from outside cannot be written
  outside the root (RULE-003, write side enforced by `path-sandbox`), so reading widely cannot leak
  into writing widely.

### Negative

- **Read-exposure residual risk (accepted)** — the read-anywhere policy lets the agent read secrets
  or credentials in sibling directories (ARCH-RISK-003); this is an explicit accepted risk, not a
  mitigated-to-zero one.
- **Asymmetric model is subtle to implement correctly** — `path-sandbox` must apply confinement to
  the write/exec paths but deliberately *not* to reads, an asymmetry that is easy to get wrong and
  must be heavily negative-tested (symlink/traversal/absolute escapes on the write side).
- **Cross-platform path resolution is safety-critical** — Windows vs. POSIX path/symlink semantics
  could weaken confinement if real-path resolution is imperfect (ARCH-RISK-004), raising the test
  burden on `path-sandbox` + `command-runner`.

### Future obligations

- `08a-security-threat-model.md` must carry the accepted read-exposure residual risk and model the
  filesystem/shell trust boundary in full.
- `08b-failure-edge-cases.md` must specify `path-sandbox` behavior for traversal / absolute /
  symlink escape attempts on writes/execs (the project's most safety-critical negative tests).
- `06-technical-design.md` must specify `path-sandbox`'s real-path resolution and the read-vs-write
  asymmetry precisely so a Builder cannot accidentally confine reads or leak writes.

---

## Alternatives Considered

### Option A — Read-anywhere, write/exec confined to root *(chosen)*

Asymmetric sandbox. Chosen to bound the destructive blast radius while keeping the agent capable —
see Decision.

### Option B — Confine everything (reads, writes, exec) to the root

- **What it is:** the root is an absolute boundary for *all* filesystem access, including reads.
- **Why rejected:** too restrictive for real tasks — the agent often must read a shared config, a
  parent `tsconfig`/`.env`, or a sibling package to make a correct change; confining reads would
  cripple capability for a marginal security gain, and the human explicitly chose the wider read
  scope (OQ-3).
- **Would be right if:** the deployment ran against untrusted/multi-tenant trees where reading
  outside the root were itself a confidentiality breach — not the case for a single-developer local
  tool the developer already controls.

### Option C — Read and write anywhere (root used only as the default cwd)

- **What it is:** no confinement; the agent can write and execute anywhere the process can reach,
  with the root merely a convenience default.
- **Why rejected:** directly violates REQ-021 / RULE-001 and the data-integrity non-negotiable —
  unbounded write/exec on the developer's machine is exactly the destructive-action risk the project
  exists to contain.
- **Would be right if:** there were no data-integrity safety requirement at all — which is the
  opposite of this Tier-3 project's reason for existing.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-021 | drives this decision (write/exec root confinement; read-anywhere) |
| Requirement | REQ-NFR-005 | drives this decision (least authority / safety posture) |
| Requirement | REQ-006 | served (read-anywhere half enables `tool-read`) |
| Requirement | REQ-008 / REQ-023 | constrained (writes/patches confined to root) |
| Requirement | REQ-009 | constrained (command cwd confined to root) |
| Component | `path-sandbox` | owns this decision (the confinement guard) |
| Component | `tool-read` | affected (read-anywhere, the only effector outside the root) |
| Component | `tool-writeedit` / `tool-applypatch` | affected (writes gated by confinement) |
| Component | `tool-runcommand` | affected (exec cwd confined) |
| Downstream artifact | `08a-security-threat-model.md` | must carry the read-exposure residual risk + boundary model |
| Downstream artifact | `08b-failure-edge-cases.md` | must specify escape-rejection behavior + negative tests |
| Downstream artifact | `06-technical-design.md` | must specify the read-vs-write asymmetry in `path-sandbox` |
