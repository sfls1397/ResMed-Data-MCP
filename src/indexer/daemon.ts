import type { DatabaseSync } from "node:sqlite";
import { FlashAirClient } from "../flashair/client.js";
import { createSyncLock } from "../lock.js";
import { syncOnce } from "./backfill.js";
import type { SyncResult } from "./backfill.js";
import type { ResolvedConfig } from "../config.js";

export interface RunIndexerDaemonOptions {
  db: DatabaseSync;
  config: ResolvedConfig;
  lockFile: string;
  log?: (msg: string) => void;
  /** Test hook: run exactly one cycle instead of looping forever. */
  once?: boolean;
}

function startSyncRun(db: DatabaseSync): number {
  const info = db
    .prepare(`INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')`)
    .run(new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function finishSyncRun(
  db: DatabaseSync,
  syncRunId: number,
  status: "ok" | "error",
  filesScanned: number,
  filesIngested: number,
  errorMessage: string | null
): void {
  db.prepare(
    `UPDATE sync_runs SET finished_at = ?, status = ?, files_scanned = ?, files_ingested = ?, error_message = ? WHERE id = ?`
  ).run(new Date().toISOString(), status, filesScanned, filesIngested, errorMessage, syncRunId);
}

export async function runSyncCycle(
  db: DatabaseSync,
  config: ResolvedConfig,
  log: (msg: string) => void
): Promise<SyncResult> {
  const syncRunId = startSyncRun(db);
  const client = new FlashAirClient({ baseUrl: config.flashAirBaseUrl });
  try {
    const result = await syncOnce(db, client, syncRunId, log);
    const status = result.errors.length > 0 ? "error" : "ok";
    finishSyncRun(
      db,
      syncRunId,
      status,
      result.filesScanned,
      result.filesIngested,
      result.errors.length > 0 ? result.errors.slice(0, 20).join("; ") : null
    );
    log(
      `Sync cycle done: scanned=${result.filesScanned} ingested=${result.filesIngested} skipped=${result.filesSkipped} errors=${result.errors.length}`
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishSyncRun(db, syncRunId, "error", 0, 0, message);
    log(`Sync cycle failed: ${message}`);
    return { filesScanned: 0, filesIngested: 0, filesSkipped: 0, errors: [message] };
  }
}

/**
 * Always-on host: acquires indexer.lock, backfills/syncs on the configured
 * interval, never exits on its own (this is the process launchd's
 * KeepAlive+RunAtLoad LaunchAgent runs).
 */
export async function runIndexerDaemon(options: RunIndexerDaemonOptions): Promise<void> {
  const log = options.log || ((msg: string) => console.error(msg));
  const lock = createSyncLock({ lockFile: options.lockFile, log });

  const tick = async (): Promise<void> => {
    if (!lock.acquire()) {
      return;
    }
    try {
      await runSyncCycle(options.db, options.config, log);
    } finally {
      lock.release();
    }
  };

  await tick();
  if (options.once) {
    return;
  }

  log(`Indexer running. Poll interval: ${options.config.pollIntervalHuman}`);
  // Intentionally not unref'd: this timer is what keeps the process alive
  // between cycles. The process exits only when killed (launchd's
  // KeepAlive then restarts it).
  setInterval(() => {
    void tick();
  }, options.config.pollIntervalMs);
}
