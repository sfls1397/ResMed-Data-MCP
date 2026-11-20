#!/usr/bin/env node

import { loadHttpTokenForCli, loadOrCreateHttpAuthToken } from "./mcp/httpAuth.js";
import { getCliCommand } from "./processMode.js";
import { resolveConfig } from "./config.js";
import { getAppDir, getLockFilePath } from "./paths.js";
import { ensureAppDir } from "./config.js";
import { openDatabase, openDatabaseReadOnly } from "./db/open.js";
import { runIndexerDaemon, runSyncCycle } from "./indexer/daemon.js";
import { createSyncLock } from "./lock.js";
import { startHttpServer } from "./mcp/server.js";
import { packageVersion } from "./version.js";

process.umask(0o077);

async function main(): Promise<void> {
  const env = process.env;
  const command = getCliCommand();
  if (command === "http-token") {
    console.log(loadHttpTokenForCli());
    return;
  }
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

  console.error(`resmed-data-mcp serve v${packageVersion()} — DB: ${config.dbPath}`);
  openDatabase(config.dbPath).close();
  const db = openDatabaseReadOnly(config.dbPath);
  await startHttpServer({ db, host: config.serverHost, port: config.serverPort, token: loadOrCreateHttpAuthToken().token });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
