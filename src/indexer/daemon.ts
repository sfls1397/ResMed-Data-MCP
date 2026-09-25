import type { DatabaseSync } from "node:sqlite";
import { FlashAirClient } from "../flashair/client.js";
import { createSyncLock } from "../lock.js";
import { syncOnce } from "./backfill.js";
import type { SyncResult } from "./backfill.js";
import type { ResolvedConfig } from "../config.js";
import { clearNightlySentinels } from "../db/sentinels.js";
import { nightDateFromPath, rebuildAllDetailRollups } from "../db/sessions.js";

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
 * Detect incomplete derived data by the actual logical night dates, rather
 * than by the first eight characters after /DATALOG/. Older archives use a
 * year directory there, so the SQL substring collapses every night in a year
 * into one and can hide a partial migration.
 */
export function needsDetailRollup(db: DatabaseSync): { needed: boolean; datalogNightCount: number } {
  const paths = db
    .prepare(`SELECT DISTINCT remote_path FROM source_files WHERE file_type = 'datalog' AND remote_path LIKE '%/DATALOG/%'`)
    .all() as { remote_path: string }[];
  const datalogDates = new Set(
    paths.map((row) => nightDateFromPath(row.remote_path)).filter((date): date is string => date != null)
  );
  const dates = (table: string): Set<string> => new Set(
    (db.prepare(`SELECT DISTINCT night_date FROM ${table}`).all() as { night_date: string }[]).map((row) => row.night_date)
  );
  const sessionDates = dates("sessions");
  const signalDates = dates("night_signal_stats");
  const hourDates = dates("signal_hour_stats");
  const minuteDates = dates("minute_stats");
  const therapyDates = dates("night_therapy");
  const hasMissingSessions = [...datalogDates].some((date) => !sessionDates.has(date));
  // Nights that contain only annotations legitimately have no signal/hour
  // statistics, so compare those two derived tables only to each other.
  const hasMissingHours = [...signalDates].some((date) => !hourDates.has(date));
  const hasMissingTherapy = [...minuteDates].some((date) => !therapyDates.has(date));
  return { needed: hasMissingSessions || hasMissingHours || hasMissingTherapy, datalogNightCount: datalogDates.size };
}

/**
 * Always-on host: acquires indexer.lock, backfills/syncs on the configured
 * interval, never exits on its own (this is the process launchd's
 * KeepAlive+RunAtLoad LaunchAgent runs).
 */
export async function runIndexerDaemon(options: RunIndexerDaemonOptions): Promise<void> {
  const log = options.log || ((msg: string) => console.error(msg));
  const lock = createSyncLock({ lockFile: options.lockFile, log });
  let rollupChecked = false;

  const tick = async (): Promise<void> => {
    if (!lock.acquire()) {
      return;
    }
    try {
      // The rollup rebuilds night after night back to back, which starves any
      // other writer's busy_timeout. Run it under the same lock as a sync so a
      // concurrent backfill can't collide with it; if another process held the
      // lock at startup, the next tick that gets it does the check.
      if (!rollupChecked) {
        const rollupCheck = needsDetailRollup(options.db);
        if (rollupCheck.needed) {
          log(`Building nightly detail rollups for ${rollupCheck.datalogNightCount} nights`);
          rebuildAllDetailRollups(options.db, log);
        }
        rollupChecked = true;
      }
      await runSyncCycle(options.db, options.config, log);
    } finally {
      lock.release();
    }
  };

  clearNightlySentinels(options.db);

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
