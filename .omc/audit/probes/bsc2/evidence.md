# BSC-2 Probe Evidence — Assertion Opacity

## Scenario

`th coverage check` marks a REQ-ID as **tested** based solely on the presence of
a REQ-ID token in a recognized test file. It never inspects the test body for
meaningful assertions. An assertion-empty test (one that passes trivially) satisfies
the gate identically to a test that actually exercises the requirement.

## Minimal Project Structure

```
docs/01-requirements.md   — defines REQ-001
docs/09-implementation-plan.md — slice referencing REQ-001
src/greeter.js            — implementation referencing REQ-001
tests/greeter.test.js     — assertion-EMPTY test referencing REQ-001
```

## Assertion-Empty Test Body

```js
// REQ-001: test greeting feature
test('REQ-001 greet user', () => {
  // This test has no meaningful assertion — it just passes trivially
  expect(true).toBe(true);
});
```

## Decisive Command + Output

```
(cd /tmp/thprobe-bsc2-VuGtlu && node A:/TwinHarness/dist/cli.js coverage check)
```

Output:
```
{"ts":"2026-06-21T21:16:51.104Z","cmd":"coverage check","total":1,"covered":1,"gaps":0,"filter":"MVP filter: none — checking all REQ-IDs"}
coverage complete: 1/1 REQ-IDs mapped to >=1 slice and >=1 test
MVP filter: none — checking all REQ-IDs
```

Exit code: 0 (GREEN)

## Isolated Ungrounded Symbol

> **"a REQ-ID token inside a recognized test file" = `tested`**

The `collectTestReqIds` function (src/core/coverage.ts:117-124) scans test files
for REQ-ID tokens via regex (`REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*`). If the token appears
anywhere in a recognized test file (matched by `isRecognizedTestFile`), the REQ-ID
is counted as tested. There is no inspection of whether the test body contains
assertions that exercise the requirement's specified behavior. A comment, a
variable name, or `expect(true).toBe(true)` all satisfy the gate equally.

## Reproduced

**YES** — BSC-2 reproduces cleanly with a single trivial test file.
