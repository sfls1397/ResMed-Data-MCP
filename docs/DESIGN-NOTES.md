# Why the code is shaped this way

This repository bans code comments (docs/TYPES-AND-LINT.md), so the reasons that used to sit beside the code live here or in the name of the test that guards them. Each entry names the file it is about. Where a test guards the behavior, the test is named; read its title before changing the code.

## Database

- `src/db/open.ts` loads `node:sqlite` through `createRequire(import.meta.url)("node:sqlite")`, never a static `import`. Vite and Vitest do not list `node:sqlite` as a built in module yet, so a static import fails to resolve it as a package. Node's own require behaves the same under plain Node.
- `src/db/open.ts` sets a 30 second `busy_timeout` because the indexer, a manual backfill and the server's startup schema check can all write; they wait out a short transaction instead of failing with "database is locked". Guarded by the test "waits for another writer instead of failing immediately".
- `src/db/open.ts` adds columns with `ensureColumn` so an existing database upgrades in place when the ingest format changes.
- `src/db/open.ts` opens the server's handle read only: the database is in WAL mode, so the server reads while the indexer writes.
- `src/db/ingest.ts` `CURRENT_INGEST_VERSION` 2 re-ingests files written by the original implementation, which could keep a new content hash after a failed transaction. Guarded by the test "re-ingests rows created by the prior ingest format even when the file hash matches".
- `src/db/ingest.ts` skips re-parsing a file whose content hash matches what is stored. STR.edf is downloaded whole every sync cycle and usually has not changed.
- `src/db/ingest.ts` writes a night's source rows and its derived rollup in one transaction, so a failed rollup leaves the prior source and rollup intact for the retry. Guarded by "rolls back metadata and data together when a changed summary is invalid".
- `src/db/ingest.ts` treats STR.edf as the authority for AHI and pressure settings, so after STR.edf changes it refreshes the therapy rows already derived from DATALOG files. Guarded by "refreshes a previously-derived therapy row when STR.edf changes".
- `src/db/ingest.ts` leaves the "Date" signal out of the wide `nightly_summary` columns: it is already the primary key `date`, and SQLite compares column names case insensitively. Guarded for other labels by "avoids case-insensitive collisions with reserved nightly_summary columns".
- `src/db/sessions.ts` rebuilds one night atomically, so MCP readers see the old complete rollup or the new one, never the intermediate DELETE state.
- `src/db/sessions.ts` assigns a DATALOG file to a night by its folder: a `YYYYMMDD` folder is the night. Older OSCAR copies use a year folder, so the night comes from the filename clock, and a time before noon belongs to the previous night. A session just after midnight on January 1 belongs to the prior year's last night, so the rebuild also reads the next year's folder. Guarded by "includes just-after-midnight New Year's files in the prior therapy night" and, for the migration check, "does not collapse every older year-directory night into one migration check".
- `src/db/sentinels.ts`: ResMed writes -1 for "not measured" on SpO2 and duration, and -0.1 for AHI when the night had no session; high resolution oximetry uses the same -1 filler. Guarded by "stores not-measured SpO2 and no-session duration as null" and "decodes event text and drops unmeasured oxygen samples".

## Indexer

- `src/indexer/daemon.ts` runs the detail rollup check under `indexer.lock`. The rollup rebuilds night after night and would starve any other writer's busy timeout, so it takes the same lock as a sync; if another process held the lock at startup, the next tick that gets it does the check. Guarded by "waits for indexer.lock before rebuilding detail rollups".
- `src/indexer/daemon.ts` compares the signal and hour statistics tables only to each other, because a night with only annotations legitimately has no such statistics.
- `src/indexer/daemon.ts` does not `unref` its timer: the timer keeps the process alive between cycles, and the process exits only when launchd's KeepAlive restarts it.
- `src/cli.ts` makes `backfill` take the indexer's lock, so a manual backfill never writes alongside a running sync or rollup. A lock that is already held exits 1 with a message. Guarded by "does not let a second timer tick acquire a lock it already holds" for the lock itself.
- `src/cli.ts` makes `serve` open the database once read write before the read only open, so the file and base schema exist even when the indexer has not run yet.
- `src/cli.ts` sets `umask 0o077`: config, history and sidecar files are owner only.
- `src/indexer/backfill.ts` refreshes every parsed device column on a conflict, not only `raw_json`, because a firmware update changes the software, configuration and data version identifiers on the same device. Guarded by "refreshes parsed identifiers after a firmware update".
- `src/indexer/backfill.ts` always downloads STR.edf (small, appended to daily); `ingestEdfFile` skips the parse by content hash. DATALOG files already ingested unchanged are skipped by metadata and ingest format.
- `src/lock.ts` takes over a dead PID's lock only, and never displaces a live holder, so an overlapping sync cycle (a slow FlashAir download past the next poll tick) never runs beside itself.

## FlashAir and EDF

- `src/flashair/client.ts` decodes FAT packed date and time as the listing returns them: date bits 15 to 9 are the year minus 1980, bits 8 to 5 the month, bits 4 to 0 the day; time bits 15 to 11 are the hour, bits 10 to 5 the minute, bits 4 to 0 the seconds divided by 2. A zero date and time is the card's "unknown" value and decodes to null. Guarded by the `decodeFatDateTime` tests.
- `src/flashair/client.ts` uses an inactivity deadline that resets whenever response bytes arrive, so a slow transfer finishes and a stalled socket is cut off. Guarded by "keeps the timeout active while downloading the response body" and "keeps a slow download alive while bytes are still arriving".
- `src/edf/parse.ts` keeps the raw digital int16 samples of numeric signals; scale them with `digitalToPhysical`. An "EDF Annotations" signal is not scaled and keeps its raw TAL bytes.
- `src/edf/parse.ts` prefers the "Startdate DD-MMM-YYYY" convention in the patient or recording id (a full four digit year) over the header's own `dd.mm.yy`, which needs a two digit year rule: below 85 is 20yy, else 19yy.

## HTTP server and secrets

- `src/mcp/server.ts` serves MCP over Streamable HTTP in stateless mode, so a client on this machine or on the LAN just points at `http://<host>:<port>/mcp`. It creates a fresh Server and transport for every POST, because a stateless `StreamableHTTPServerTransport` is single use and reusing one silently breaks after the first request.
- `src/mcp/httpAuth.ts` reads the bearer token from `RESMED_DATA_MCP_TOKEN` first (set and non empty), so the server can start through `infisical-run`; the macOS Keychain item is the fallback. A token is never in a config file, the repo or logs after the one time print. Guarded by the `http-token-env` tests.
- `src/mcp/httpAuth.ts` returns null only when `security find-generic-password` exits 44 (no such item). Any other failure throws, so a read error is never taken for "no token yet" and an existing item is never overwritten. The read has a 15 second timeout so a locked keychain waiting on a prompt fails. The `http-token` command ignores the injected variable and always uses the Keychain item. Guarded by "readKeychainSecret returns null only for exit 44 and throws on any other read error" and the tests beside it.
- `src/mcp/httpAuth.ts` compares the bearer token in constant time.
- `src/keychainWrite.ts` passes the credential on `security -i`'s stdin, never in argv, and rejects a command of 4095 bytes or more before writing, because Apple's interactive command buffer is 4096 bytes and would truncate it.

## Gates

- `.security/scan.py` rewrites one TypeScript regex spelling in the scan's disposable copy: Semgrep 1.180.0 misparses `/<!--\s*SDT:[^>]*-->/g` as an HTML comment. The pattern and flags stay identical, and runtime bytes are never modified. This repository has no `src/core/sonos.ts`, so the step does nothing here.
- `.security/metadata.py`, `.security/local-gate.py`, `.security/merge-pr.py` and `.githooks/pre-push` scan only the history of what is checked (the gate's `HEAD`, or each tip a push sends), never `rev-list --all`, which takes in every other branch and linked worktree. A scratch debug commit in another job's worktree failed Toolbox PR 544's push and PR 533's gate (Nov 12), (the gate's own scan is Toolbox PR 554, Nov 12). Guarded by `test_history_ignores_another_jobs_scratch_worktree`, `test_pre_push_checks_only_the_pushed_commits` and `test_gate_and_merge_scan_only_the_checked_head`.
- `.security/local-gate.py PR_NUMBER` runs from the reviewed PR checkout and records its result on that exact head; `python3 .security/local-gate.py deploy` is the pre-deploy run on the checked-out commit.
- `.security/merge-pr.py` counts only the owner's newest `local-gate` status on the exact SHA, and merges with a matching head condition so GitHub refuses a changed PR head. Guarded by `test_merge_requires_recorded_local_gate`.
- `.security/metadata.py` reads raw commit headers with `git cat-file --batch`, because a mailmap cannot hide an identity. Guarded by `test_history_reads_raw_author_even_with_mailmap`.
