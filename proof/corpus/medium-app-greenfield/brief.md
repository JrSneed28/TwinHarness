# Brief: `tasktracker` — a medium app (greenfield)

## Summary
Build a small but realistic task-tracker HTTP service: CRUD over tasks, persisted
to a local JSON-backed store, with input validation, status filtering, a health
endpoint, and end-to-end tests of the lifecycle. Greenfield: built from scratch.

## Tier hint
T3 — multiple cooperating subsystems (HTTP layer, validation, a persistence store
with atomic writes, filtering, health) and an end-to-end test surface. This is the
heaviest brief in the corpus; per PS-Q3 it is intentionally UNCAPPED for maximum
realism, so a full live run carries the full token cost.

## Functional requirements
- HTTP endpoints: `POST /tasks` (create), `GET /tasks` (list, with optional
  `?status=open|done` filter), `GET /tasks/:id`, `PATCH /tasks/:id` (update title
  or status), `DELETE /tasks/:id`.
- A task is `{ id, title, status: "open"|"done", createdAt, updatedAt }`.
- Persistence: a local JSON-backed store written atomically (temp file + rename)
  so a crashed write never corrupts the store.
- Validation: malformed payloads (missing title, unknown status) return `4xx`
  with a structured `{ error, detail }` body — never a stack trace.
- `GET /healthz`: report `{ ok: true, tasks: <count> }`.

## Non-functional
- Deterministic persistence semantics (atomic writes; idempotent on resume).
- Integration + end-to-end tests cover the create→list→update→delete lifecycle
  and the status filter.

## Acceptance criteria
See `meta.json` — CRUD + atomic persistence + validation + status filter + health
+ e2e lifecycle coverage.
