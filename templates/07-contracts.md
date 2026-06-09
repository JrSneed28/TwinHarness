# Contracts — <project name>

> **Stage 7 — Contracts** (spec §15.7). Tiers T2, T3. Streams; surfaces product-affecting
> choices (pagination model, auth scheme) as explicit human decisions (§8) — note: auth is
> blast-radius and always goes to a human gate. Derives contracts from `04-architecture.md` and
> `03-domain-model.md`; anchors every contract to the REQ-IDs and slices that depend on it (§11).
> Each contract is a testable boundary — the test strategy (Stage 8) maps tests to these
> definitions.

## Summary

<3–6 sentences: how many interfaces are defined, the overall integration pattern (REST / RPC /
event-driven / module boundary / …), the auth scheme approved by the human, and any versioning
strategy chosen. This block is the default handoff currency — downstream stages read THIS, not
the whole document (§9).>

- **Interfaces defined:** <count and type — e.g., "4 HTTP endpoints, 2 internal module contracts, 3 event types">
- **Integration pattern:** <REST / gRPC / event bus / in-process module / …>
- **Auth scheme (human-approved):** <the auth model that received explicit sign-off — blast-radius gate>
- **Versioning strategy:** <URL versioning / header / semver package / …>

---

## Interface Index

<A single table listing every interface defined in this document. Gives the Critic and the
Builder a complete map before reading the detail sections. Each row anchors to REQ-IDs and the
slices that consume the interface.>

| ID | Name | Type | Owner component | Consumer(s) | REQ-IDs | Slice(s) |
|---|---|---|---|---|---|---|
| IF-001 | <name> | <HTTP / event / module / …> | `<component>` | `<component>`, `<component>` | REQ-<###> | S<n> |
| IF-002 | <…> | | | | | |

---

## API / Module Contracts

<For each interface in the index, define its full contract: inputs, outputs, error responses,
preconditions, postconditions, and any side effects. Typed and constrained — field types,
required vs. optional, valid ranges, max lengths. Every contract must anchor to the REQ-IDs it
serves and the slices that depend on it.

Use one subsection per interface (IF-NNN).>

### IF-001 — <interface name>

**Type:** <HTTP endpoint / gRPC method / module function / …>
**Owner:** `<component-name>`
**Consumers:** `<component-name>`, `<component-name>`
**Realizes:** REQ-<###>, REQ-<###>
**Required by slices:** S<n>, S<n>

#### Request / Input

```
<field>: <type> [required | optional] — <constraint: max length, valid values, format, …>
<field>: <type> [required] — <constraint>
```

#### Response / Output

```
<field>: <type> — <description>
<field>: <type> — <description>
```

**Preconditions:** <what must be true before this interface is called>
**Postconditions:** <what is guaranteed to be true after a successful call>
**Side effects:** <state changes, events emitted, external calls triggered — or "none">

#### Error responses

| Code / type | Condition | Response body / payload |
|---|---|---|
| <HTTP 400 / ErrorType> | <specific condition — missing field, invalid value, …> | <schema or "see Error Contracts §IF-001"> |
| <…> | | |

---

### IF-002 — <interface name>

**Type:** <…>
**Owner:** `<component-name>`
**Consumers:** `<component-name>`
**Realizes:** REQ-<###>
**Required by slices:** S<n>

#### Request / Input

```
<field>: <type> [required | optional] — <constraint>
```

#### Response / Output

```
<field>: <type> — <description>
```

**Preconditions:** <…>
**Postconditions:** <…>
**Side effects:** <…>

#### Error responses

| Code / type | Condition | Response body / payload |
|---|---|---|
| <…> | | |

---

## Data Schemas

<The canonical type definitions for every data object that crosses a component boundary. Each
schema anchors to the domain entity it represents (from `03-domain-model.md`) and the REQ-IDs
that require it. Typed and constrained — no untyped "object" or "any" fields.

Flag any field that carries sensitive data (PII, credentials, financial) so the Security stage
and the test strategy can handle it.>

### <SchemaName>

**Domain entity:** `<EntityName>` (from `03-domain-model.md`)
**Realizes:** REQ-<###>
**Used by interfaces:** IF-<NNN>, IF-<NNN>

```
<field>: <type> [required | optional] — <constraint> [SENSITIVE]
<field>: <type> [required] — <constraint>
<field>: <type> [optional, default: <value>] — <constraint>
```

**Validation rules:**
- <cross-field or business-logic constraint not expressible in the field definitions above>
- <…>

---

## Events

<For every event emitted or consumed across a component boundary, define the full event schema,
the producer, the consumer(s), the guaranteed delivery semantics, and the ordering constraints.
If this system has no events, state "No cross-boundary events in this system" and explain why.>

### <EventName>

**Producer:** `<component-name>`
**Consumer(s):** `<component-name>`, `<component-name>`
**Realizes:** REQ-<###>
**Required by slices:** S<n>

**Payload:**

```
<field>: <type> [required | optional] — <description>
<field>: <type> [required] — <description>
```

**Delivery semantics:** <at-most-once / at-least-once / exactly-once>
**Ordering guarantee:** <none / per-aggregate / global — enforced by: <mechanism>>
**Idempotency key:** <field name, or "none — consumer must be idempotent">

---

## Error Contracts

<The system-wide error taxonomy: every error type that crosses a component boundary, its
meaning, the conditions that produce it, and the guaranteed response shape. Errors that are
internal to a single component and never surfaced externally are out of scope here.

Anchor each error type to the interface(s) and REQ-IDs it affects.>

| Error ID | Name | HTTP status / type | Condition | Response shape | Interfaces | REQ-IDs |
|---|---|---|---|---|---|---|
| ERR-001 | <name> | <400 / NotFoundError / …> | <specific triggering condition> | `{ "error": "<code>", "message": "<…>" }` | IF-<NNN> | REQ-<###> |
| ERR-002 | <…> | | | | | |

**Error envelope (standard shape for all error responses):**

```
error:   string [required] — machine-readable error code (e.g., "VALIDATION_FAILED")
message: string [required] — human-readable description
detail:  object [optional] — structured context (field errors, conflict info, …)
```

---

## Versioning

<How interfaces evolve without breaking consumers. State the versioning strategy per interface
type, the backward-compatibility rules, and the deprecation process. If the system is pre-1.0
or internal-only and has no versioning requirements, state that explicitly.>

- **Strategy:** <URL path versioning (`/v1/`) / Accept header / package semver / …>
- **Backward-compatibility rule:** <additive changes only / no field removal / …>
- **Breaking-change process:** <new version number / deprecation period / migration guide / consumer
  notification>
- **Current version:** <v<n>>
- **Human-approved versioning decisions:** <any versioning choice that went to a human gate>

---

## Consumer / Producer Map

<A complete map of which component produces each interface / event and which component(s)
consume it. This table is the integration verification checklist — the Critic uses it to confirm
no interface is produced but never consumed, and no consumer depends on an interface that is not
defined.

Anchor each row to the REQ-IDs and slices that make the dependency real.>

| Interface / Event | Producer | Consumer(s) | REQ-IDs | Slice(s) | Notes |
|---|---|---|---|---|---|
| IF-001 — <name> | `<component>` | `<component>` | REQ-<###> | S<n> | <any ordering or lifecycle note> |
| IF-002 — <name> | `<component>` | `<component>` | REQ-<###> | S<n> | |
| <EventName> | `<component>` | `<component>` | REQ-<###> | S<n> | |

**Orphaned-interface check:** <confirm no interface appears in the index but is absent from this
map, or record any intentionally unconsumed interface with a rationale.>
