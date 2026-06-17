# Brief: `slugify` — adopt + extend a small library (brownfield)

## Summary
An existing, working `slugify` library lives under `seed/`. Adopt it (characterize
first, do not rewrite its public API) and extend it with a companion
`deslugify(slug)` that reverses simple slugs, without regressing the existing
behavior. Brownfield: there is real existing code to understand and preserve.

## Tier hint
T2 — a small, well-scoped change layered onto an existing module. No blast-radius
flag applies. The brownfield discipline (characterization Slice 0, reuse-first
drift, overlay rather than rewrite) is the point of this brief.

## Existing code (in `seed/`)
- `src/slugify.js` — the working `slugify(text)` implementation.
- `test/slugify.test.js` — its existing tests (must keep passing).
- `package.json`, `README.md` — package metadata and docs.

## Functional requirements
- Do NOT change the existing `slugify` public signature or behavior.
- Add `deslugify(slug: string): string` that turns `hello-world` back into
  `hello world` (hyphens → spaces). It need not be a perfect inverse for
  lossy inputs — only the simple, documented round-trip.
- Keep all existing `slugify` tests green.
- Add tests for `deslugify` and the `slugify → deslugify` round-trip on simple
  inputs.
- Update `README.md` to document `deslugify` next to `slugify`.

## Acceptance criteria
See `meta.json` — adopt the existing API, add `deslugify`, no regression, new
round-trip tests, README updated.
