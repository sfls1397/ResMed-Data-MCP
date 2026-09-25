import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "../src/db/open.js";
import { openDatabase } from "../src/db/open.js";
import { ingestEdfFile } from "../src/db/ingest.js";

function pad(value: string | number, length: number): string {
  return String(value).padEnd(length, " ");
}

function buildSummary(labels: string[], values: number[]): Buffer {
  const signalCount = labels.length;
  const header = [
    pad("0", 8), pad("patient", 80), pad("recording", 80), pad("22.09.26", 8), pad("00.00.00", 8),
    pad(256 + signalCount * 256, 8), pad("", 44), pad(1, 8), pad(1, 8), pad(signalCount, 4)
  ].join("");
  const fields: [number, Array<string | number>][] = [
    [16, labels], [80, labels.map(() => "")], [8, labels.map(() => "")], [8, labels.map(() => 0)],
    [8, labels.map(() => 32767)], [8, labels.map(() => 0)], [8, labels.map(() => 32767)],
    [80, labels.map(() => "")], [8, labels.map(() => 1)], [32, labels.map(() => "")]
  ];
  const signalHeaders = fields.map(([width, items]) => items.map((item) => pad(item, width)).join("")).join("");
  const data = Buffer.alloc(signalCount * 2);
  values.forEach((value, index) => data.writeInt16LE(value, index * 2));
  return Buffer.concat([Buffer.from(header + signalHeaders, "latin1"), data]);
}

function freshDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO sync_runs (started_at) VALUES (?)").run("2026-09-22T00:00:00Z");
  return db;
}

function input(rawBytes: Buffer) {
  return { remotePath: "/STR.edf", fileType: "str_summary" as const, rawBytes, flashairModifiedAt: null, syncRunId: 1 };
}

describe("ingestEdfFile", () => {
  it("rolls back metadata and data together when a changed summary is invalid", () => {
    const db = freshDb();
    const first = buildSummary(["Date", "AHI"], [20_000, 5]);
    ingestEdfFile(db, input(first));

    const colliding = buildSummary(["Date", "AHI", "ahi"], [20_000, 6, 7]);
    expect(() => ingestEdfFile(db, input(colliding))).toThrow(/both map to nightly_summary column/);
    expect(() => ingestEdfFile(db, input(colliding))).toThrow(/both map to nightly_summary column/);
    expect(db.prepare("SELECT edf_num_signals FROM source_files").get()).toMatchObject({ edf_num_signals: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM edf_signals").get()).toMatchObject({ count: 2 });
    db.close();
  });

  it("clears values for a signal absent from a replacement summary", () => {
    const db = freshDb();
    ingestEdfFile(db, input(buildSummary(["Date", "AHI"], [20_000, 5])));
    const result = ingestEdfFile(db, input(buildSummary(["Date", "Leak"], [20_000, 10])));

    expect(result.recordsWritten).toBe(2);
    expect(db.prepare("SELECT AHI, Leak FROM nightly_summary").get()).toMatchObject({ AHI: null, Leak: 10 });
    db.close();
  });

  it("stores not-measured SpO2 and no-session duration as null", () => {
    const db = freshDb();
    ingestEdfFile(db, input(buildSummary(["Date", "Duration", "SpO2_50", "Mode"], [20_000, -1, -1, -1])));
    expect(db.prepare("SELECT Duration, SpO2_50, Mode FROM nightly_summary").get()).toMatchObject({
      Duration: null,
      SpO2_50: null,
      Mode: null
    });
    db.close();
  });

  it("re-ingests rows created by the prior ingest format even when the file hash matches", () => {
    const db = freshDb();
    const summary = buildSummary(["Date", "AHI"], [20_000, 5]);
    ingestEdfFile(db, input(summary));
    db.prepare("UPDATE source_files SET ingest_version = 1").run();

    expect(ingestEdfFile(db, input(summary))).toMatchObject({ changed: true, recordsWritten: 2 });
    expect(db.prepare("SELECT ingest_version FROM source_files").get()).toMatchObject({ ingest_version: 2 });
    db.close();
  });
});
