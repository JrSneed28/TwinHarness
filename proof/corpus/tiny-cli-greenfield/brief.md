# Brief: `wordcount` — a tiny CLI (greenfield)

## Summary
Build a small command-line tool, `wordcount`, that reports the number of lines,
words, and bytes in a text file — a minimal `wc` clone. Greenfield: there is no
existing code to adopt.

## Tier hint
T1 — a single small module with one pure counting function and a thin CLI shell.
No authentication, authorization, money, migrations, or data-integrity surface,
so no blast-radius flag applies.

## Functional requirements
- Accept exactly one positional argument: the path to a UTF-8/ASCII text file.
- Print three integers — lines, words, bytes — separated by single spaces,
  followed by the file path, matching the `wc` ordering.
- A "word" is a maximal run of non-whitespace characters; "lines" is the count of
  `\n` characters; "bytes" is the file's byte length.
- On a missing/extra argument, print `usage: wordcount <file>` to stderr and exit
  with a non-zero status.
- On a non-existent file, print a readable error to stderr and exit non-zero.

## Non-functional
- Zero runtime dependencies.
- The counting logic is a pure function (input string → counts) so it is unit
  testable without touching the filesystem.

## Acceptance criteria
See `meta.json` — the counting function matches `wc` for ASCII input, the error
paths exit non-zero, and at least one unit test covers the counter.
