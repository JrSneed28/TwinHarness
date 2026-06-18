# Contributing

## Dev setup

```bash
npm install        # install devDependencies (TypeScript, Vitest)
npm run build      # compile src/ → dist/ (tsc)
npm test           # run the full Vitest suite
npm run typecheck  # type-check without emitting
```

Node ≥ 20 is required (see `engines` in `package.json`).

`npm install` also wires a **pre-commit hook** (zero-dependency — no husky): its
`prepare` script runs `git config core.hooksPath .githooks`, pointing Git at the
checked-in [`.githooks/`](.githooks/) directory. The hook rejects a commit that
changes `src/` without a staged `dist/` (the committed-`dist/` invariant below)
and runs `npm run typecheck`. Bypass in an emergency with `git commit --no-verify`.

---

## One-shot verification gate

Before opening a PR, run the single gate that mirrors CI end-to-end:

```bash
npm run verify   # typecheck → build → test → assert dist/ is in sync
```

It runs `npm run typecheck && npm run build && npm test && git diff --exit-code dist/`.
If it passes, CI will too. `npm run dist-sync-check` runs just the
`git diff --exit-code dist/` step on its own.

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
| Agent count | 16 (files in `agents/*.md`) |
| Command count | 16 (files in `commands/*.md`) |
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
- Run `npm run verify` before opening a PR (the one-shot gate above).
- Update `dist/` whenever `src/` changes (see above).
- Use descriptive PR titles: `fix:`, `feat:`, `chore:`, `docs:` prefixes are
  welcome but not required.
- If a PR adds or removes an agent, command, or skill, update the count
  assertions in `tests/plugin-manifest.test.ts` accordingly.

### Issue & PR templates

GitHub auto-populates these from [`.github/`](.github/):

- **Bug report** ([`.github/ISSUE_TEMPLATE/bug.md`](.github/ISSUE_TEMPLATE/bug.md)) —
  asks for `th version`, Claude Code version, Node version, repro steps, and
  expected vs. actual behavior.
- **Feature request** ([`.github/ISSUE_TEMPLATE/feature.md`](.github/ISSUE_TEMPLATE/feature.md)) —
  summary, motivation, proposed solution.
- **Pull request** ([`.github/pull_request_template.md`](.github/pull_request_template.md)) —
  summary, type, testing, and a checklist (including that `npm run verify`
  passes and `dist/` was rebuilt if `src/` changed).

---

## Where things live

| Path | Contents |
|------|----------|
| `src/` | TypeScript source for the `th` CLI |
| `dist/` | Compiled CLI output — committed, do not gitignore |
| `skills/` | Prompt files for Claude Code skills |
| `agents/` | Agent prompt files (16 total) |
| `commands/` | Slash-command prompt files (16 total) |
| `templates/` | Artifact skeleton templates |
| `hooks/` | Gate wiring (`hooks.json`, Stop and PreToolUse hooks) |
| `.claude-plugin/` | `plugin.json` and `marketplace.json` manifests |
| `tests/` | Vitest test suite |
