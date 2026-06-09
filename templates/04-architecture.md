# System Architecture — <project name>

> **Stage 4 — System Architecture** (spec §14.4). Mostly streams; human gate on the **one or two
> genuinely irreversible style decisions** surfaced as explicit choices (§8) — everything else
> proceeds without blocking approval. Reads Summaries from `01-requirements.md`, `02-scope.md`,
> and `03-domain-model.md` by default; fetches full artifacts only when a detail cannot be
> resolved from the Summary (§9). Recommends sane defaults where the user has no preference.
> Security and Failure Modes are **folded sections** here by default; they graduate to their own
> Tier-3 stages (`08a-security-threat-model.md` and `08b-failure-edge-cases.md`) for
> security- or reliability-critical projects (§13, spec §15.S, §15.F).

## Summary

<3–6 sentences: the architectural style chosen, the major components and how they collaborate,
and the one or two irreversible decisions the human approved. This block is the default handoff
currency — downstream stages read THIS, not the whole document (§9).>

- **Architectural style:** <e.g., layered monolith / event-driven / microservices / CLI pipeline>
- **Key components:** <two or three component names and their core responsibility in one phrase each>
- **Irreversible decision(s) confirmed by human:** <the choice(s) that received explicit sign-off>

---

## Inputs Used

<List the upstream artifacts this architecture was derived from, and which sections / summaries
were read. This makes the derivation chain explicit and supports the Critic's coherence check.>

| Artifact | Version | Sections consumed |
|---|---|---|
| `01-requirements.md` | v<n> | Summary, Functional Requirements, Non-Functional Requirements |
| `02-scope.md` | v<n> | Summary, MVP Scope |
| `03-domain-model.md` | v<n> | Summary, Core Entities, Domain Rules |

---

## Architecture Summary

<One or two paragraphs describing the overall structure and the rationale for it. Name the
architectural style and explain why it fits this project's requirements and scope. Call out the
one or two hard decisions explicitly — these are the ones that went to a human gate (§8).
Reference the REQ-IDs that drove the structure where the mapping is non-obvious.>

---

## Major Components

<The top-level building blocks of the system. For each component, give a short name, state its
single responsibility, list the REQ-IDs it is responsible for satisfying, and note the
"components touched" label that downstream slice planning (Stage 9) will use to detect overlap
and decide whether two slices can build in parallel (§16). Keep the list to real, load-bearing
components — avoid decomposing trivially.>

### <ComponentName>

- **Responsibility:** <one sentence — what this component owns and nothing else>
- **Realizes:** REQ-<###>, REQ-<###>
- **Components-touched label:** `<component-name>` *(used by Stage 9 to detect slice overlap)*
- **Notes:** <any constraint, tech choice, or pattern this component follows>

### <ComponentName>

- **Responsibility:** <…>
- **Realizes:** REQ-<###>
- **Components-touched label:** `<component-name>`
- **Notes:** <…>

---

## Responsibilities

<A concise matrix mapping each component to the cross-cutting concerns it owns. Useful when
multiple components interact with the same subsystem (auth, logging, error handling). Fill in
only the rows that are non-obvious.>

| Component | Owns | Does NOT own |
|---|---|---|
| <ComponentName> | <auth, validation, …> | <persistence, rendering, …> |
| <…> | | |

---

## System Boundaries

<What is inside this system vs. what is external. For each boundary, name the external actor or
system, describe the interaction point (API call, file, message queue, user input, …), and note
the trust level. This feeds directly into the Security section below and into the Critic's
boundary check.>

- **<External system / actor>** — interaction: <how> — trust: <trusted / untrusted / partially trusted>
- <…>

---

## Data Flow

<How data moves through the system for the primary use case(s). Describe the path from input
to output, naming the components data passes through and the form it takes at each hop (raw
request → validated model → stored record → response DTO, etc.). One flow per major use case;
skip trivial CRUD flows that are obvious from the component list.>

### <Primary use case / flow name>

1. <Actor / external system> sends <what> to <ComponentName>
2. <ComponentName> transforms / validates and passes <what> to <ComponentName>
3. <…>
4. <ComponentName> returns <what> to <Actor>

---

## Runtime Flow

<How the system behaves at runtime: startup sequence, request lifecycle, background tasks,
scheduled jobs, shutdown behavior. Focus on ordering dependencies and concurrency concerns.
Reference the domain state models where runtime transitions map to domain state changes.>

- **Startup:** <initialization order, config loading, dependency wiring>
- **Request / event lifecycle:** <entry point → processing → response / side-effect>
- **Background / async work:** <jobs, queues, polling, event loops>
- **Shutdown:** <graceful drain, cleanup, persistence flush>

---

## External Dependencies

<Third-party services, libraries, databases, message brokers, or platform APIs this system
relies on. For each, note what it is used for, whether it is in the critical path, and any
constraints it imposes (rate limits, auth requirements, data residency).>

| Dependency | Purpose | Critical path? | Constraints |
|---|---|---|---|
| <name> | <what it does for us> | yes / no | <rate limit, auth, …> |
| <…> | | | |

---

## Deployment Shape

<How and where the system runs. Name the deployment target (local CLI, container, serverless
function, managed service, …), the runtime environment, and any infrastructure the system
depends on being present. Keep this at the shape level — detailed infra config belongs in
technical design (Stage 6).>

- **Target:** <where it runs>
- **Runtime:** <language runtime, container base, …>
- **Infrastructure:** <database, object storage, message bus, CDN, …>
- **Scaling model:** <single instance / horizontal / serverless / …>

---

## Security

> **Folded section.** For Tier-1 and Tier-2 projects this section is sufficient. For Tier-3 or
> any project with authentication, money, sensitive data, or migrations, this section graduates
> to a dedicated stage: `08a-security-threat-model.md` (spec §15.S). When that file exists, this
> section becomes a pointer to it and a one-paragraph summary of the trust model.

<Identify the trust boundaries listed in System Boundaries above and state, at one level above
implementation, how each is defended. Cover: authn/authz model; data in transit and at rest;
any blast-radius surface (§5). Every item here must be anchored to a real boundary or component
in this system — generic checklist items without an anchor are not useful.>

- **Trust boundaries defended:** <list with one-line mitigation per boundary>
- **Authn/authz model:** <how identity is established and permissions enforced>
- **Data sensitivity:** <what sensitive data exists and how it is protected>
- **Blast-radius flags:** <auth / money / data-integrity / migrations — yes/no per category>

*If this project is Tier-3 or carries blast-radius flags, the full threat model lives in
`08a-security-threat-model.md`.*

---

## Failure Modes

> **Folded section.** For Tier-1 and Tier-2 projects this section is sufficient. For Tier-3 or
> reliability-critical projects, this section graduates to a dedicated stage:
> `08b-failure-edge-cases.md` (spec §15.F). When that file exists, this section becomes a
> pointer to it.

<For each major component and external dependency, state the expected failure behavior: what
happens when it is unavailable, slow, or returns bad data. Anchor each failure mode to the
component it affects. Anti-boilerplate rule: each entry must name a specific component or
boundary — "handle errors gracefully" is not a valid entry here.>

| Component / dependency | Failure scenario | Expected behavior | REQ-ID |
|---|---|---|---|
| <ComponentName> | <unavailable / timeout / bad data> | <fail-closed / retry / degrade / escalate> | REQ-<###> |
| <…> | | | |

*If this project is Tier-3 or reliability-critical, the full failure catalog lives in
`08b-failure-edge-cases.md`.*

---

## Architecture Risks

<Risks specific to this architecture: decisions that might prove wrong, external dependencies
that could fail, scaling assumptions that might not hold, or areas where the design is thin.
Anchor each risk to the component or decision it affects.>

- **ARCH-RISK-001** — <risk description> — affects: <component / decision> — mitigation: <…>
- **ARCH-RISK-002** — <…>

---

## Verification Notes

<Checklist for the Critic in architecture mode (spec §14.4). The Critic checks coherence only —
that this architecture is internally consistent with upstream artifacts — not that it is
correct. These notes record what the Critic will verify and any pre-existing deviations to
acknowledge.>

- [ ] Every MVP REQ-ID from `01-requirements.md` is supported by at least one named component.
- [ ] The component set fits within the MVP scope defined in `02-scope.md`.
- [ ] Every Core Entity from `03-domain-model.md` is handled by at least one named component.
- [ ] Component responsibilities are non-overlapping and boundaries are clean.
- [ ] Domain Rules from `03-domain-model.md` are enforced by a named component or boundary.
- [ ] Architecture Risks are noted for any area the Critic flags as thin.
- [ ] Security and Failure Modes sections are present (or pointer to Tier-3 files exists).
- [ ] Irreversible decisions are identified and their human-gate sign-off is recorded in Summary.
