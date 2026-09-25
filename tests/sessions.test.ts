import { describe, expect, it } from "vitest";
import { ensureColumn, openDatabase } from "../src/db/open.js";
import { rebuildNightDetail } from "../src/db/sessions.js";
import { runGetNightDetail, runGetNightMinutes, runGetTherapyNights } from "../src/mcp/tools.js";

describe("rebuildNightDetail", () => {
  it("groups files a few seconds apart into one session and rolls up samples", () => {
    const db = openDatabase(":memory:");
    const insertFile = db.prepare(
      `INSERT INTO source_files
         (remote_path, file_type, ingest_version, first_ingested_at, last_ingested_at)
       VALUES (?, 'datalog', 2, '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z')`
    );
    const brp = Number(insertFile.run("/DATALOG/20260923/20260924_014950_BRP.edf").lastInsertRowid);
    const csl = Number(insertFile.run("/DATALOG/20260923/20260924_014945_CSL.edf").lastInsertRowid);
    const later = Number(insertFile.run("/DATALOG/20260923/20260924_031200_BRP.edf").lastInsertRowid);

    const insertSignal = db.prepare(
      `INSERT INTO edf_signals
         (source_file_id, signal_index, label, physical_dimension, physical_min, physical_max,
          digital_min, digital_max, samples_per_record, is_annotations)
       VALUES (?, 0, 'Flow.40ms', 'L/s', 0, 100, 0, 100, 2, 0)`
    );
    const signalId = Number(insertSignal.run(brp).lastInsertRowid);
    insertSignal.run(later);
    db.prepare(
      `INSERT INTO edf_signal_records (signal_id, record_index, sample_count, digital_samples_blob)
       VALUES (?, 0, 2, ?)`
    ).run(signalId, Buffer.from([0, 0, 50, 0]));

    expect(rebuildNightDetail(db, "2026-09-23")).toBe(2);
    const detail = JSON.parse(runGetNightDetail(db, { date: "2026-09-23" }));
    expect(detail.session_count).toBe(2);
    expect(detail.sessions[0].csl_file_id).toBe(csl);
    expect(detail.sessions[0].brp_file_id).toBe(brp);
    expect(detail.signals).toEqual([
      expect.objectContaining({ label: "Flow.40ms", sample_count: 2, min_value: 0, max_value: 50, avg_value: 25 })
    ]);
    expect(detail.hours).toEqual([
      expect.objectContaining({ label: "Flow.40ms", hour_index: 0, sample_count: 2, avg_value: 25 })
    ]);
  });

  it("decodes event text and drops unmeasured oxygen samples", () => {
    const db = openDatabase(":memory:");
    const fileId = Number(
      db.prepare(
        `INSERT INTO source_files
           (remote_path, file_type, edf_start_timestamp, ingest_version, first_ingested_at, last_ingested_at)
         VALUES ('/DATALOG/20260923/20260924_014950_EVE.edf', 'datalog', '2026-09-23T22:00:00', 2, 't', 't')`
      ).run().lastInsertRowid
    );
    const signalId = Number(
      db.prepare(
        `INSERT INTO edf_signals
           (source_file_id, signal_index, label, samples_per_record, is_annotations)
         VALUES (?, 0, 'EDF Annotations', 1, 1)`
      ).run(fileId).lastInsertRowid
    );
    const raw = Buffer.from("+0\x14\x14\x00+3310\x1523\x14Obstructive Apnea\x14\x00", "latin1");
    db.prepare(`INSERT INTO edf_signal_records (signal_id, record_index, sample_count, raw_bytes) VALUES (?, 0, 0, ?)`).run(signalId, raw);

    const spo = Number(
      db.prepare(
        `INSERT INTO source_files
           (remote_path, file_type, edf_start_timestamp, edf_duration_seconds, ingest_version, first_ingested_at, last_ingested_at)
         VALUES ('/DATALOG/20260923/20260924_014950_SA2.edf', 'datalog', '2026-09-23T22:00:00', 1, 2, 't', 't')`
      ).run().lastInsertRowid
    );
    const spoSignal = Number(
      db.prepare(
        `INSERT INTO edf_signals
           (source_file_id, signal_index, label, physical_dimension, physical_min, physical_max, digital_min, digital_max, samples_per_record, is_annotations)
         VALUES (?, 0, 'SpO2.1s', '%', -1, 100, -1, 100, 2, 0)`
      ).run(spo).lastInsertRowid
    );
    db.prepare(`INSERT INTO edf_signal_records (signal_id, record_index, sample_count, digital_samples_blob) VALUES (?, 0, 2, ?)`).run(
      spoSignal,
      Buffer.from([0xff, 0xff, 97, 0])
    );

    expect(rebuildNightDetail(db, "2026-09-23")).toBe(1);
    const detail = JSON.parse(runGetNightDetail(db, { date: "2026-09-23" }));
    expect(detail.events).toEqual([
      expect.objectContaining({ file_kind: "EVE", label: "Obstructive Apnea", onset_seconds: 3310, duration_seconds: 23 })
    ]);
    expect(detail.signals).toEqual([
      expect.objectContaining({ label: "SpO2.1s", sample_count: 1, min_value: 97, max_value: 97 })
    ]);
  });

  it("builds minute rows and a therapy summary against the night's pressure range", () => {
    const db = openDatabase(":memory:");
    for (const [column, type] of [
      ["Mode", "REAL"],
      ["S_A_MinPress", "REAL"],
      ["S_A_MaxPress", "REAL"],
      ["S_EPR_Level", "REAL"],
      ["AHI", "REAL"],
      ["Leak_95", "REAL"]
    ] as const) {
      ensureColumn(db, "nightly_summary", column, type);
    }
    db.prepare(
      `INSERT INTO nightly_summary (date, updated_at, Mode, S_A_MinPress, S_A_MaxPress, S_EPR_Level, AHI, Leak_95)
       VALUES ('2026-09-23', 't', 1, 8, 11, 3, 3.1, 0.2)`
    ).run();
    const pld = Number(
      db.prepare(
        `INSERT INTO source_files
           (remote_path, file_type, edf_start_timestamp, edf_duration_seconds, ingest_version, first_ingested_at, last_ingested_at)
         VALUES ('/DATALOG/20260923/20260924_014950_PLD.edf', 'datalog', '2026-09-24T01:49:50', 60, 2, 't', 't')`
      ).run().lastInsertRowid
    );
    const press = Number(
      db.prepare(
        `INSERT INTO edf_signals
           (source_file_id, signal_index, label, physical_min, physical_max, digital_min, digital_max, samples_per_record, is_annotations)
         VALUES (?, 0, 'Press.2s', 0, 20, 0, 20, 1, 0)`
      ).run(pld).lastInsertRowid
    );
    db.prepare(`INSERT INTO edf_signal_records (signal_id, record_index, sample_count, digital_samples_blob) VALUES (?, 0, 1, ?)`).run(
      press,
      Buffer.from([11, 0])
    );
    const eve = Number(
      db.prepare(
        `INSERT INTO source_files
           (remote_path, file_type, edf_start_timestamp, ingest_version, first_ingested_at, last_ingested_at)
         VALUES ('/DATALOG/20260923/20260924_014945_EVE.edf', 'datalog', '2026-09-24T01:49:50', 2, 't', 't')`
      ).run().lastInsertRowid
    );
    const ann = Number(
      db.prepare(
        `INSERT INTO edf_signals (source_file_id, signal_index, label, samples_per_record, is_annotations)
         VALUES (?, 0, 'EDF Annotations', 1, 1)`
      ).run(eve).lastInsertRowid
    );
    db.prepare(`INSERT INTO edf_signal_records (signal_id, record_index, sample_count, raw_bytes) VALUES (?, 0, 0, ?)`).run(
      ann,
      Buffer.from("+0\x14\x14\x00+10\x1512\x14Obstructive Apnea\x14\x00", "latin1")
    );

    expect(rebuildNightDetail(db, "2026-09-23")).toBe(1);
    const minutes = JSON.parse(runGetNightMinutes(db, { date: "2026-09-23" }));
    expect(minutes.minutes).toEqual([
      expect.objectContaining({ press_avg: 11, obstructive_count: 1, minute_index: 0 })
    ]);
    const therapy = JSON.parse(runGetTherapyNights(db, {}));
    expect(therapy.nights).toEqual([
      expect.objectContaining({
        night_date: "2026-09-23",
        min_press: 8,
        max_press: 11,
        minutes_at_max: 1,
        minutes_at_min: 0,
        obstructive_at_max: 1,
        ahi: 3.1
      })
    ]);
    db.close();
  });
});
