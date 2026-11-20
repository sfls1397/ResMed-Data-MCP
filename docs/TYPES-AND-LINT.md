# Types and strict lint

Build steps 3 and 4 of the development process plan (D16, D19), copied from the Toolbox's `docs/TYPES-AND-LINT.md` and its `.security/lint.py`. Whole kinds of mistakes fail in seconds, before any test runs, and no new code comment lands. Lauren Tan: "lint rules, type systems, compilers" come first, and "start with a lint rule to prevent new occurrences of anti-patterns and then clean up those old patterns as well". Comments "go stale easily", so they are banned by a lint rule. The rule landed first and the cleanup followed: no code comment is left, and the reasons that sat in them live in [DESIGN-NOTES.md](DESIGN-NOTES.md) or in test names.

## What runs

| Tool | Checks | Pinned in |
|---|---|---|
| TypeScript's checker (`tsc -p .lint/tsconfig.json`) | `src`, `tests`, `scripts`, `bin` and the lint scripts: strict mode plus unused locals, missing returns, switch fallthrough, missing `override`, unreachable code, unused labels. `tests` were not type checked before. JavaScript files are checked too, but only for names that do not resolve, imports that do not resolve, and duplicate declarations | `.lint/package-lock.json`, options in `.lint/tsconfig.json` |
| ESLint with typescript-eslint | Bugs: duplicate keys, unreachable code, self assignment, bad regular expressions, unsafe negation, and with types floating or misused promises, `await` on a non promise, throwing a non error, unbound methods | `.lint/package-lock.json`, rules in `.lint/eslint.config.mjs`; run with `--no-inline-config`, so a comment cannot turn a rule off |
| Ruff | Python bugs in `.security`: undefined names, unused imports, bad escapes, dead conditions | `.cursor/install-lint.sh` (version and checksum), rules in `.lint/ruff.toml`; run with `--ignore-noqa` |
| Pyright | Python types: wrong calls, unknown module attributes, Python 3.10 features on the Mini's Python 3.9 | `.lint/package-lock.json`, rules in `pyrightconfig.json` |
| Import check | No file outside `tests` loads a test or fixture, a worktree, another repository, or a relative path that leaves the repository | `.security/lint.py` (Python syntax tree) and `.lint/ts-reader.mjs` (TypeScript syntax tree) |
| Suppression check | No comment turns a checker off: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`, `# pyright:`, `# type: ignore` | `.security/lint.py` |
| Comment ban | No new code comment in TypeScript, JavaScript, Python or shell, and no new Python docstring nothing reads ([below](#the-comment-ban)) | `.security/lint.py`; shell is read by shfmt, pinned in `.cursor/install-lint.sh` |
| ShellCheck | Shell scripts, already in the gate with no findings allowed | `.cursor/install-shellcheck.sh` (unchanged) |

`python3 .security/lint.py gate` is the gate's step "Types and strict lint", run right after `npm ci` and before `npm test`, because the type checker reads the real dependencies. The gate's first line records each tool's pinned version. `.githooks/pre-commit` runs `python3 .security/lint.py staged` on the staged text with ESLint (the rules that need no types), Ruff, Pyright, and the import, suppression and comment checks, in about two seconds on the Mac mini. `tsc` and the type aware ESLint rules need the whole tree, so they run in the gate only.

Install or update the tools with `bash .cursor/install-lint.sh`. They live in `~/.local/share/repo-lint/resmed-data-mcp`, not in `~/.local/bin`, so this repository's pins can never replace another repository's `tsc`, `eslint` or `ruff`. `lint.py` finds them by path, never through `PATH`. The lint tools have their own `.lint/package.json` and lockfile, so the product's dependencies and published package are unchanged, and `.security/scan.py` audits them at the high threshold including development dependencies. `.lint/node_modules` is a link to the install that `lint.py` makes itself and Git ignores.

## The ratchet

Each finding is keyed by its tool, rule, file and a hash of its line's text, so moving code does not change it. `.lint/baseline.json` holds no findings: the 261 comment lines it first held are cleaned out and every other tool finds nothing. It only shrinks, and a baseline that gains an entry fails:

- A change fails on a finding absent from both the baseline and the PR base, including indirect breakage in untouched files. Editing a finding's line changes its key. A renamed file keeps its old findings.
- A finding already on the PR base is a warning, even in a touched file: a merge resolution must not be blamed for main's existing finding. Counts matter: one existing occurrence does not excuse a second.
- A baseline that gains an entry fails. The one way in is a new check's first entries: `python3 .security/lint.py baseline` writes them only for a tool the baseline's `tools` list does not hold yet. When code is fixed the gate warns that entries are stale; `python3 .security/lint.py prune` drops them and never adds one.
- With no PR base (the `deploy` run), findings outside the baseline are warnings. The PR gate passes the base itself: the merge base of `origin/main` and the head, as `LOCAL_GATE_BASE`.
- A change to a lint config, to `.lint/ts-reader.mjs`, or to the kept error codes and filters in `lint.py` needs `.lint/policy-review.json` with the exact `before` and `after` fingerprints (`policy_digest(base)` and `policy_digest()` in `lint.py`) and a specific reason of at least 40 characters. This note never replaces the fresh PR reviewer.

`python3 .security/lint.py counts` prints the findings per tool; `counts --folders` prints comment lines per folder and the biggest files.

## Counts before and after

Measured on main at 7011f2b with each tool first run at its widest setting, then after the rules below were chosen.

| Tool | Widest run over today's code | After choosing rules (held by the baseline) |
|---|---|---|
| tsc | 69 errors with every strictness flag | 0 |
| ESLint | 1,385 with every core rule and typescript-eslint strict and stylistic type checked sets | 0 |
| Ruff | 1,424 with every rule | 0 |
| Pyright | 18 in standard mode, 337 in strict mode | 0 |
| Imports | no rule widened | 0 |
| Suppressions | none exist | 0 |
| Comments | not run before | 261 (the baseline, since cleaned to 0) |

## Rules dropped, and why

False alarms must be zero, so a check that flags correct code is tuned or dropped. Each tool was first run with its widest rule set and every rule's hits were read.

**tsc.** Off because they flag correct code: `noUncheckedIndexedAccess` (41 of the 69 hits, array reads whose index is known to be in range by construction), `exactOptionalPropertyTypes` (2 hits, one is the MCP SDK's own `sessionIdGenerator: undefined` for stateless mode), `noPropertyAccessFromIndexSignature` (25 hits, only a spelling of `process.env.NAME`), `noUnusedParameters` (an unused callback argument is correct, ESLint's rule for it was dropped for the same reason). On JavaScript files only the exact codes for unresolved names, unresolved imports and duplicate declarations count: `scripts/scan-package.js` passes the Buffer from `execFileSync` to `JSON.parse`, which works at runtime and fails the type check.

**ESLint.** The style rules (about 1,100 of the hits) are dropped wholesale: `no-magic-numbers`, `one-var`, `sort-keys`, `func-style`, `no-ternary`, `id-length`, `max-*`, `sort-imports`, `camelcase`, `curly`, `no-console` and the rest of the style families. Bug rules dropped after reading their hits: `no-undef` (tsc owns undefined names), `no-unused-vars` (tsc's unused locals owns it), `no-await-in-loop` (deliberate sequencing in the FlashAir and backfill loops), `no-promise-executor-return` (`new Promise((r) => setTimeout(r, n))`), `no-useless-assignment` (a running offset), `preserve-caught-error`, `no-eq-null` and `eqeqeq`. From typescript-eslint: `no-unsafe-*` (`JSON.parse` returns `any` and the code checks its shape), `no-unnecessary-condition` (defensive checks on rows read from SQLite), `no-non-null-assertion`, `no-confusing-void-expression`, `require-await` (async handlers the SDK requires), `no-deprecated` (the SDK's `Server` class is used deliberately), `no-unnecessary-type-assertion`, `prefer-nullish-coalescing`, `restrict-template-expressions`, `use-unknown-in-catch-callback-variable`, `no-empty-function`, `array-type`, `prefer-regexp-exec` and `prefer-optional-chain`. The kept set had no hits in today's code, and a probe confirmed each family fires on a floating promise and a duplicate key.

**Ruff** (1,424 with every rule): the Toolbox's selection is kept as is. Dropped because they flag correct code: quotes and line length (831 and 132 hits), annotations, docstrings, `print`, `unittest` assertion style, exception message style, `subprocess` rules (Semgrep owns security, and every call checks the exit code itself), and the refactor and convention families.

**Pyright** (18 standard, 337 strict): the standard hits are all one pattern on correct code: `spec.loader.exec_module` after `spec_from_file_location`, `Popen` pipes that are never `None`, and the tests assigning to a module attribute. Strict mode reports hundreds of unknown types because the code has no annotations. The Toolbox's filters are kept: only module attribute errors, wrong call arguments and Python 3.10 features count. Pyright skips folders that start with a dot, which hides `.security` where all this repository's Python lives, so `lint.py` reads those files through a copy with the dot renamed and fails if Pyright analyzes fewer files than it was given.

## The comment ban

**What fails.** Each line of a new comment is one finding, `comments no-comment`: `//` and `/* */` (including JSDoc) in TypeScript and JavaScript, `#` in Python and shell, whether on its own line or after code. A Python docstring nothing reads is `comments no-docstring`, per line. The ratchet applies, so editing a line that holds an old comment makes it new: remove the comment while you are there.

**How it reads code, so text is never a false alarm.** TypeScript and JavaScript through typescript-estree (the parser behind ESLint), Python through `tokenize` and `ast`, shell through shfmt's bash parser. Strings, template strings, regular expressions, heredocs and `$#` are never comments. A file the parser cannot read fails as `comments unreadable-script` or `unreadable-shell`. Only `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.py`, `.sh` and `.bash` files are read, plus files with no suffix whose first line is a Python, sh, bash, dash or ksh shebang. JSON, Markdown, YAML and plist are never read.

**Allowed.**
- A shebang on line 1.
- A comment line holding a link to an upstream issue, pull request, bug or RFC (GitHub, GitLab and Codeberg except Peter's own repositories, bugzilla hosts, crbug and the Chromium and Google trackers, rfc-editor.org and the IETF datatracker).
- License text: the file's leading comment block when a line holds `SPDX-License-Identifier:`, `Copyright`, `Licensed under`, `Permission is hereby granted` or `All rights reserved`.
- Comments a tool needs in order to work: Python's encoding line, ShellCheck's `shell=`, `source=` and `source-path=` directives, TypeScript's `/// <reference ... />` and `// @ts-check`, and Vitest's `@vitest-environment` docblock. Nothing that turns a checker off qualifies: those are the suppression check's findings, counted once.
- A Python docstring the program reads: a module docstring in a file that uses `__doc__`, and a function or class docstring read as `name.__doc__` (`.security/lint.py` prints its own).

## Comments before the cleanup

Cleaned out in one pass; the table is the count that was removed. Measured on main at 7011f2b with this check: 261 comment lines in 39 files (TypeScript 200, Python 51 of which 23 are docstrings, shell 9, JavaScript 1). A handful of lines name a PR, a date or an incident; none names Peter. `python3 .security/lint.py counts --folders` prints this table.

| Folder | Files | Lines |
|---|---|---|
| `src/db` | 5 | 47 |
| `src/mcp` | 2 | 35 |
| `src` (top level) | 6 | 32 |
| `src/indexer` | 2 | 27 |
| `src/edf` | 3 | 25 |
| `src/flashair` | 2 | 22 |
| `.security` | 7 | 51 |
| `tests` | 6 | 12 |
| `.cursor` | 3 | 5 |
| `.githooks` | 2 | 4 |
| `scripts` | 1 | 1 |
| **All** | **39** | **261** |

The most: `src/mcp/httpAuth.ts` 24, `src/db/ingest.ts` 21, `src/indexer/daemon.ts` 21, `src/edf/parse.ts` 17, `src/flashair/client.ts` 16, `.security/local-gate.py` 15.

## The cleanup plan (done)

One job removed all 261 lines in one PR instead of the three parts below. The method held: no comment is deleted until its "why" lives where it belongs (D19): a better name, a test named for the failure it prevents, or the doc or commit message that owns it. One job per part, on a mid tier model, each part after the one before merges. Run `python3 .security/lint.py prune --resolved-only` after each part so the baseline loses only what is resolved, and prove no behavior changed with identical syntax trees (compare the parsed trees of each changed file before and after, ignoring comments) plus the recorded gate.

| Part | Files | Lines | Why this order |
|---|---|---|---|
| 1 | `src/db`, `src/edf` and the six top level files in `src` that hold comments | 104 | The core data code, the largest share, reviewed together |
| 2 | `src/mcp`, `src/indexer`, `src/flashair` | 84 | The remaining product code |
| 3 | `.security`, `tests`, `scripts`, `.githooks`, `.cursor` | 73 | The gate's own code last, kept apart so its review stays small; shell and Python are read by shfmt and `ast` |

## Changing a pin or a rule

Edit `.lint/package.json` and regenerate `.lint/package-lock.json`, or the Ruff and shfmt versions and checksums in `.cursor/install-lint.sh`, then run the installer and `python3 .security/lint.py counts`. A pin or rule that finds new findings in today's code needs those fixed in the same PR, since the baseline never grows. Compare the counts before and after a config edit and verify the intended diagnostic changed: an accepted but misspelled rule key can leave the wrong behavior in force.
