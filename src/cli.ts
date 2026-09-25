#!/usr/bin/env node

import { getCliCommand } from "./processMode.js";
import { resolveConfig } from "./config.js";
import { getAppDir, getLockFilePath } from "./paths.js";
import { ensureAppDir } from "./config.js";
import { openDatabase, openDatabaseReadOnly } from "./db/open.js";
import { runIndexerDaemon, runSyncCycle } from "./indexer/daemon.js";
import { createSyncLock } from "./lock.js";
import { startHttpServer } from "./mcp/server.js";
import { packageVersion } from "./version.js";

async function main(): Promise<void> {
  const env = process.env;
  const command = getCliCommand();
  const appDir = getAppDir({ env });
  ensureAppDir(appDir);
  const config = resolveConfig({ env });

  if (command === "indexer") {
    console.error(`resmed-data-mcp indexer v${packageVersion()} — FlashAir: ${config.flashAirBaseUrl}`);
    const db = openDatabase(config.dbPath);
    await runIndexerDaemon({ db, config, lockFile: getLockFilePath({ env }) });
    return;
  }

  if (command === "backfill") {
    console.error(`resmed-data-mcp backfill v${packageVersion()} — FlashAir: ${config.flashAirBaseUrl}`);
    // Share the indexer's lock so a manual backfill never writes alongside a
    // running indexer's sync or detail rollup.
    const lock = createSyncLock({ lockFile: getLockFilePath({ env }) });
    if (!lock.acquire()) {
      console.error("The indexer is already syncing; it will pick up the card's files. Try again later.");
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(config.dbPath);
    try {
      const result = await runSyncCycle(db, config, (msg) => console.error(msg));
      if (result.errors.length > 0) {
        process.exitCode = 1;
      }
    } finally {
      db.close();
      lock.release();
    }
    return;
  }

  // serve (default)
  console.error(`resmed-data-mcp serve v${packageVersion()} — DB: ${config.dbPath}`);
  // Ensure the DB file and base schema exist even if the indexer hasn't run
  // yet, so read-only open below never fails on a missing file.
  openDatabase(config.dbPath).close();
  const db = openDatabaseReadOnly(config.dbPath);
  await startHttpServer({ db, host: config.serverHost, port: config.serverPort });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
