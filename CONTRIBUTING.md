# Contributing

## Dev setup

```bash
npm install        # install devDependencies (TypeScript, Vitest)
npm run build      # compile src/ → dist/ (tsc)
npm test           # run the full Vitest suite
npm run typecheck  # type-check without emitting
```

Node ≥ 18 is required (see `engines` in `package.json`).

---

## The committed-`dist/` invariant

TwinHarness installs as a Claude Code plugin via marketplace copy: the plugin
cache receives a copy of this repository **with no build step**. Therefore
`dist/` is committed to the repo and must never be gitignored.

**Workflow rule:** after editing any file under `src/`, run `npm run build` and
commit the updated `dist/` in the **same commit** as the source change. CI
enforces this with:

```bash
git diff --exit-code dist/
```

A PR that changes `src/` without a corresponding `dist/` update will fail CI.

---

## Plugin-packaging invariants

The file `tests/plugin-manifest.test.ts` mechanically enforces the packaging
contract. These facts must remain true:

| Invariant | Value |
|-----------|-------|
| Agent count | 7 (files in `agents/*.md`) |
| Command count | 4 (files in `commands/*.md`) |
| Skill count | 1 (`skills/twinharness/SKILL.md`) |
| CLI invocation in every component | `"${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` |
| `plugin.json` version | must equal `package.json` version |

Every skill, command, and agent file must contain the string
`"${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` because `th` is not on the installed
user's PATH; Claude Code substitutes `CLAUDE_PLUGIN_ROOT` at runtime.

Run `npm test` before pushing — the manifest tests catch packaging regressions
before they reach users.

---

## Branch and PR conventions

- Keep PRs small and focused on a single concern.
- Run `npm test` and `npm run typecheck` before opening a PR.
- Update `dist/` whenever `src/` changes (see above).
- Use descriptive PR titles: `fix:`, `feat:`, `chore:`, `docs:` prefixes are
  welcome but not required.
- If a PR adds or removes an agent, command, or skill, update the count
  assertions in `tests/plugin-manifest.test.ts` accordingly.

---

## Where things live

| Path | Contents |
|------|----------|
| `src/` | TypeScript source for the `th` CLI |
| `dist/` | Compiled CLI output — committed, do not gitignore |
| `skills/` | Prompt files for Claude Code skills |
| `agents/` | Agent prompt files (7 total) |
| `commands/` | Slash-command prompt files (4 total) |
| `templates/` | Artifact skeleton templates |
| `hooks/` | Gate wiring (`hooks.json`, Stop and PreToolUse hooks) |
| `.claude-plugin/` | `plugin.json` and `marketplace.json` manifests |
| `tests/` | Vitest test suite |
