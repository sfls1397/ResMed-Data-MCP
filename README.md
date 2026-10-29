# ResMed-Data-MCP

Archives raw data from a ResMed AirSense CPAP's SD card — read over Wi-Fi via
a Toshiba FlashAir card — into a local SQLite database on a Mac, and
serves it read-only to any MCP client (Claude, Codex, and others) over the
LAN via bearer-token-authenticated Streamable HTTP.

This is a personal quantified-self data plane, not a clinical tool: it
archives every field the device reports (AHI, leak rate, pressure, usage
hours, and everything else in the nightly summary, plus raw signal detail as
it becomes available) without computing or interpreting anything. Synthesis
— trends, "how did I sleep", correlations — is left to whatever AI client
queries it.

## How it works

The AirSense writes to its SD card in the [EDF](https://www.edfplus.info/)
format: `STR.edf` is a rolling ~365-day nightly summary (one data record per
night, one signal per column — AHI, leak, pressure, usage minutes, etc.),
and `DATALOG/<YYYYMMDD>/` holds per-night detail files at higher resolution
once the device has flushed them. A generic EDF/EDF+ parser
([`src/edf/parse.ts`](src/edf/parse.ts)) reads both without any ResMed-specific
field list — it just reads whatever signals the header declares, so it also
works on future firmware and other ResMed models without changes.

## Architecture

| Process | Role |
| --- | --- |
| **Indexer** (`resmed-data-mcp indexer`) | Always-on host. Polls the FlashAir on an interval (default 5m), downloads STR.edf and any new/changed DATALOG files, parses them, and writes to SQLite. |
| **MCP server** (`resmed-data-mcp serve`, default) | Always-on read-only MCP server over Streamable HTTP, bearer token required. Opens the same SQLite file read-only (WAL mode lets it read while the indexer writes). |

Both run as separate LaunchAgents (see `examples/`) so a slow FlashAir sync
never blocks queries and a client bug never touches the data. The MCP server
listens on `0.0.0.0:8420` by default, so it's reachable identically whether
a client is on the same Mac or elsewhere on the LAN — every client just
points at `http://<host>:8420/mcp` and sends `Authorization: Bearer <token>`
(see [Security](#security)).

## Data model

- **`nightly_summary`** — one row per calendar night, one column per signal
  STR.edf reports (columns are discovered from the device automatically, not
  hardcoded — so `AHI`, `Leak_95`, `Duration`, `S_C_Press`, etc. all show up
  as real, queryable REAL columns). This is the ergonomic table for "how did
  I sleep" questions.
- **`edf_signals` / `edf_signal_records`** — the fully generic archive:
  every signal, from every file ever seen (STR.edf and every DATALOG detail
  file), with raw digital samples preserved as-is plus enough calibration
  metadata to decode them. This is what "as much raw data as possible" means
  in practice — `nightly_summary` is a convenience view over a subset of it.
- **`source_files`, `sync_runs`, `devices`** — provenance and operational
  history: what file came from where, when, and whether syncing is healthy.

Event files (the EDF+ annotation channel in `DATALOG` `_EVE` / `_CSL` files) are decoded into `session_events`. Each apnea or hypopnea row includes the pressure and leak at that minute and whether pressure rose over the next two minutes. `minute_stats` is one row per minute of pressure, leak, flow limitation, tidal volume, respiratory rate, snore, oxygen, and event counts. `night_therapy` rolls those minutes up against the night's minimum and maximum pressure.

No vector database: this data is fully structured and numeric (nightly
metrics, calibrated signal samples), which SQL aggregation handles better
than similarity search. If a future signal turns out to carry free text
worth searching semantically, that's a reason to reconsider, not a default.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_nights` | Nightly summary rows in a date range, newest first. |
| `get_night` | Full summary row for one date. |
| `get_trend` | Time series + min/max/avg for one `nightly_summary` column. |
| `get_therapy_nights` | One row per night: settings, AHI, leak, minutes spent at the pressure floor and ceiling, and obstructive events in those minutes. |
| `get_night_minutes` | Minute-by-minute pressure, leak, flow limitation, breathing, snore, oxygen, and event counts for one night. |
| `get_night_detail` | Sessions for one night, plus each event with pressure, leak, and whether pressure rose afterward. |
| `list_signals` | Discover every raw signal label across all ingested files. |
| `get_signal_samples` | Raw samples for one signal in one file. Not the therapy view. |
| `query_raw` | Arbitrary read-only SELECT against the full schema. |
| `sync_status` | Last sync run, device info, row counts — how fresh is this. |

The connection backing the MCP server is opened SQLite-read-only, so
`query_raw` can't write regardless of what SQL text it's given — that's
enforced by the database, not just by string validation.

## Install

```bash
npm install -g resmed-data-mcp
```

Requires **Node.js 22.5+** (uses the built-in `node:sqlite` module — no
native dependencies, no `npm rebuild` across machines/architectures).

### Develop from source

```bash
git clone https://github.com/sfls1397/ResMed-Data-MCP.git
cd ResMed-Data-MCP
npm install   # runs `tsc` via the prepare script
```

### Configure

Copy `examples/config.json.example` to `~/.resmed-data-mcp/config.json` and
set `flashAirBaseUrl` to your FlashAir's address (find it with your router's
DHCP client list, or the FlashAir's own config page). Everything else has a
sane default. Configure the address once; later package upgrades reuse the existing local file:

| Key | Default | Notes |
| --- | --- | --- |
| `flashAirBaseUrl` | `http://flashair.local` | Generic placeholder; configure your actual card address locally |
| `pollInterval` | `5m` | Clamped to 30s–1h |
| `serverHost` | `0.0.0.0` | Bind address for the MCP server |
| `serverPort` | `8420` | |

Env vars override the file: `RESMED_DATA_FLASHAIR_URL`,
`RESMED_DATA_POLL_INTERVAL`, `RESMED_DATA_SERVER_HOST`,
`RESMED_DATA_SERVER_PORT`, `RESMED_DATA_DB_PATH`. `RESMED_DATA_HOME`
relocates the whole `~/.resmed-data-mcp/` directory (test/dev only).

### Backfill once, then install the LaunchAgents

```bash
resmed-data-mcp backfill     # one-shot: pulls everything currently on the card
resmed-data-mcp http-token   # creates the HTTP bearer token on first use and prints it
```

Copy `examples/com.resmed-data-mcp.indexer.plist` and
`examples/com.resmed-data-mcp.server.plist` into `~/Library/LaunchAgents/`,
replacing `REPLACE_ME_WITH_NPM_BIN_DIR` and
`REPLACE_ME` (your macOS username) with real values, then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.resmed-data-mcp.indexer.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.resmed-data-mcp.server.plist
```

### Point clients at it

See `examples/mcp-client.json`. Any MCP client that supports an HTTP server
entry with headers connects the same way whether it runs on the Mac that hosts
the server or another machine on the same LAN:

```json
{
  "mcpServers": {
    "resmed-data": {
      "url": "http://<host>:8420/mcp",
      "headers": { "Authorization": "Bearer <token from resmed-data-mcp http-token>" }
    }
  }
}
```

## Paths

All under `~/.resmed-data-mcp/` (config cannot override this directory):

| Path | Purpose |
| --- | --- |
| `~/.resmed-data-mcp/config.json` | Settings (see above) |
| `~/.resmed-data-mcp/data.sqlite` | The database (WAL mode) |
| `~/.resmed-data-mcp/indexer.lock` | Sync-cycle lock, so an overlapping poll never runs concurrently with itself |

## Security

Every HTTP request, including `/health`, needs `Authorization: Bearer <token>`;
anything else gets `401`. The token is a random secret created on first use and
kept in the login Keychain (service `resmed-data-mcp-http`, account
`http-auth-token`), never in config or logs. `resmed-data-mcp http-token`
prints it. It is still meant for a trusted home LAN: don't expose port 8420 to
the internet (no port forwarding, no tunnel). The MCP server's database
connection is read-only at the SQLite level, so even a buggy or malicious
client can't write through it.

## License

MIT


## Privacy gates and synthetic fixtures

EDF test buffers are constructed in code with generic patient headers and
fixed samples. SQL fixtures use in-memory databases and synthetic therapy
values; no patient export, card image, or local SQLite database is tracked.
Keep actual device addresses and patient data in local settings and storage.

Install Gitleaks 8.30.1 and enable the staged gate once per clone:

```bash
git config core.hooksPath .githooks
gitleaks git --log-opts=--all --config .gitleaks.toml --redact=100 --no-banner .
npm run build && npm run scan:package
```

Before a pull request is merged, `python3 .security/local-gate.py <PR number>`
runs Gitleaks, the production `npm audit`, offline Semgrep and the tests on the
exact PR head and records the result as the `local-gate` status. Push and
pull-request CI also scans full fetched history and package contents.
The prepublishOnly lifecycle rebuilds and scans the exact npm file list.
After a history rewrite, discard old clones and re-clone; merging old history
can restore removed data. Releases use GitHub Release → npm OIDC.
