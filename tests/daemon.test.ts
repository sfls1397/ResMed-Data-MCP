import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open.js";
import { needsDetailRollup, runIndexerDaemon } from "../src/indexer/daemon.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("needsDetailRollup", () => {
  it("does not collapse every older year-directory night into one migration check", () => {
    const db = openDatabase(":memory:");
    const insertFile = db.prepare(
      `INSERT INTO source_files (remote_path, file_type, ingest_version, first_ingested_at, last_ingested_at)
       VALUES (?, 'datalog', 2, 't', 't')`
    );
    insertFile.run("/DATALOG/2026/20260924_010000_BRP.edf");
    insertFile.run("/DATALOG/2026/20260925_010000_BRP.edf");
    db.prepare(`INSERT INTO sessions (night_date, session_start) VALUES ('2026-09-23', '2026-09-24T01:00:00')`).run();

    expect(needsDetailRollup(db)).toEqual({ needed: true, datalogNightCount: 2 });

    db.prepare(`INSERT INTO sessions (night_date, session_start) VALUES ('2026-09-24', '2026-09-25T01:00:00')`).run();
    expect(needsDetailRollup(db)).toEqual({ needed: false, datalogNightCount: 2 });
    db.close();
  });
});

describe("runIndexerDaemon", () => {
  it("waits for indexer.lock before rebuilding detail rollups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resmed-daemon-test-"));
    tempDirs.push(dir);
    const lockFile = path.join(dir, "indexer.lock");
    // A live process (a manual backfill) holds the lock.
    fs.writeFileSync(lockFile, `${process.ppid}:${Date.now()}`);
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO source_files (remote_path, file_type, ingest_version, first_ingested_at, last_ingested_at)
       VALUES ('/DATALOG/20260923/20260924_010000_BRP.edf', 'datalog', 2, 't', 't')`
    ).run();

    await runIndexerDaemon({
      db,
      lockFile,
      once: true,
      log: () => {},
      config: {
        pollIntervalMs: 60_000,
        pollIntervalHuman: "1m",
        flashAirBaseUrl: "http://127.0.0.1:1",
        dbPath: ":memory:",
        serverHost: "127.0.0.1",
        serverPort: 0
      }
    });

    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toMatchObject({ n: 0 });
    db.close();
  });
});

describe("openDatabase", () => {
  it("waits for another writer instead of failing immediately", () => {
    const db = openDatabase(":memory:");
    expect(db.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 30_000 });
    db.close();
  });
});
