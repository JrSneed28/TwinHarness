# Security & Threat Model — <project name>

> **Stage S — Security & Threat Modeling** (spec §15.S). Tier 3 / any blast-radius project.
> GRADUATES from the folded Architecture §Security section when the project handles auth,
> money, sensitive data, or migrations. Human gate required on the security model and on
> any auth decision (§8) — this document does not proceed to the next stage without explicit
> human sign-off.

## Summary

<3–6 sentences: which assets are at risk, where the trust boundaries are, and what the
highest-priority mitigations are. This block is the default handoff currency — downstream
stages read THIS, not the whole document (§9).>

- **Highest-value asset:** <one phrase>
- **Highest-risk boundary:** <one phrase>
- **Auth model:** <one phrase — e.g., "API-key per tenant, validated at the Orchestrator boundary">
- **Gate status:** <Pending human sign-off / Approved vN>

---

## Assets

<Enumerate the assets this system must protect. Each asset needs: a name, what makes it
sensitive (confidentiality, integrity, availability — pick the primary concern), and which
component owns or stores it (using canonical labels from `04-architecture.md`). No generic
"user data" entries — name the specific data class and its storage location.>

| Asset | Sensitivity (C/I/A) | Owning component | Notes |
|-------|--------------------|-----------------:|-------|
| <asset name> | <C / I / A / C+I> | `<component-label>` | <…> |
| … | … | … | … |

---

## Trust Boundaries

<Map the trust boundaries in this system. A trust boundary is a line where a privilege,
identity, or trust level changes — e.g., the edge between the CLI (user-controlled) and
the Orchestrator (system-controlled), or between the system and an external API. For each
boundary: name it, state what crosses it (data, commands, tokens), and state the trust
differential (what the caller claims vs. what the callee must verify). Use component labels
from `04-architecture.md`.>

| Boundary ID | From | To | What crosses it | Trust differential |
|-------------|------|----|-----------------|--------------------|
| TB-001 | `<component-a>` | `<component-b>` | <…> | <caller claims X; callee must verify Y> |
| … | … | … | … | … |

---

## Data Flows

<Trace the data flows that cross trust boundaries. For each flow: source component, data
carried, boundary crossed, destination component, and whether the data is sensitive in
transit. This is the input to the Threats section — every threat below must trace back to
one of these flows or to a component in this map. Flows not appearing here cannot generate
grounded threats.>

| Flow ID | Source | Data carried | Boundary crossed | Destination | Sensitive in transit? |
|---------|--------|-------------|-----------------|-------------|----------------------|
| DF-001 | `<component-a>` | <…> | TB-<###> | `<component-b>` | Yes / No |
| … | … | … | … | … | … |

---

## Threats (grounded)

> **Anti-boilerplate rule:** every threat in this section MUST anchor to a specific
> component, trust boundary, or data flow in THIS system (using the IDs above). Generic
> checklist items — "injection attacks," "man-in-the-middle," "privilege escalation" —
> with no anchor to a real component or boundary in this project are discarded. A threat
> entry that cannot complete the sentence "...at `<component-label>` / boundary TB-<###>
> / flow DF-<###>" does not belong here.

<For each threat: state the threat in one sentence anchored to the specific component/boundary/
flow, the attack vector (how an adversary exploits it), the impact (which asset is harmed,
which sensitivity dimension — C/I/A), and the likelihood estimate (High/Medium/Low with a
one-phrase rationale). Map each threat to a mitigation in §Mitigations.>

| Threat ID | Threat (anchored) | Attack vector | Asset impacted | Impact (C/I/A) | Likelihood | Mitigation(s) |
|-----------|------------------|---------------|---------------|----------------|------------|---------------|
| THR-001 | <one sentence naming component/boundary/flow> | <…> | <asset name> | <C/I/A> | <H/M/L — rationale> | MIT-<###> |
| … | … | … | … | … | … | … |

---

## Authn/Authz

<Define the authentication and authorization model for this system. State: who the principals
are, how they authenticate, what they are authorized to do, and at which component the
check is enforced. If this system has no auth (e.g., single-user local tool), state that
explicitly and note what prevents unauthorized access at the deployment boundary. This section
is human-gated (§8) — auth decisions are blast-radius and cannot proceed without sign-off.>

### Authentication

<Who authenticates, how (mechanism), and at which component boundary (TB-ID).>

### Authorization

<What principals are authorized to do. State the model: RBAC, ABAC, capability-based, or
"single-principal, no authz layer." Map each authorization check to the component that
enforces it (canonical label from `04-architecture.md`).>

### Unauthenticated / Anonymous Access

<What, if anything, can be done without authentication? State explicitly — "nothing" is
a valid and preferred answer for most systems.>

---

## Abuse Cases

<Enumerate the ways an adversary or malicious user could misuse the system's intended
functionality — distinct from pure technical exploits. Each abuse case maps to a negative
test in `08-test-strategy.md` (or `08b-failure-edge-cases.md` §Negative-Tests Map).
Anchor each abuse case to the component or flow it exploits.>

| Abuse ID | Abuse case (anchored) | Component / flow | Negative test anchor |
|----------|-----------------------|-----------------|---------------------|
| ABU-001 | <one sentence> | `<component-label>` / DF-<###> | `test_REQ<###>_<abuse_slug>` |
| … | … | … | … |

---

## Mitigations (→ components/REQs)

<For each mitigation: state what it does, which component implements it, which threat(s) it
addresses (THR-ID), and which REQ-ID it satisfies or is governed by. A mitigation without
a threat anchor is noise. A mitigation without a component owner has no one to build it.>

| MIT-ID | Mitigation | Component | Addresses | REQ-ID |
|--------|-----------|-----------|-----------|--------|
| MIT-001 | <what it does> | `<component-label>` | THR-<###> | REQ-<###> |
| … | … | … | … | … |

---

## Residual Risks

<Threats and abuse cases that have no current mitigation, or whose mitigation is partial.
State: the residual risk, why it is accepted (cost, complexity, or out-of-scope for this
tier), and the condition under which it must be revisited (e.g., "if the system acquires
multi-tenant users, THR-003 must be fully mitigated before launch"). Accepted residual
risks are human-acknowledged at sign-off — they are not silently deferred.>

| Residual | Source (THR-ID / ABU-ID) | Why accepted | Revisit trigger |
|----------|--------------------------|--------------|-----------------|
| <description> | THR-<###> | <rationale> | <condition> |
| … | … | … | … |
