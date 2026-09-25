import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseEdf } from "../edf/parse.js";
import { digitalToPhysical } from "../edf/types.js";
import type { ParsedEdf } from "../edf/types.js";
import { ensureColumn, quoteIdent } from "./open.js";
import { sanitizeColumnName } from "./schema.js";
import { nightlyMeasuredValue } from "./sentinels.js";
import { nightDateFromPath, rebuildNightDetail } from "./sessions.js";

export type SourceFileType = "str_summary" | "datalog";
// Version 2 re-ingests files written by the original implementation, which
// could retain a new content hash after a failed transaction.
export const CURRENT_INGEST_VERSION = 2;

export interface IngestFileInput {
  remotePath: string;
  fileType: SourceFileType;
  rawBytes: Buffer;
  flashairModifiedAt: string | null;
  syncRunId: number;
}

export interface IngestFileResult {
  sourceFileId: number;
  changed: boolean;
  recordsWritten: number;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Days-since-Unix-epoch (as used by the "Date" signal in STR.edf) -> "YYYY-MM-DD". */
export function epochDaysToDateString(days: number): string | null {
  if (!Number.isFinite(days) || days <= 0 || days > 100000) {
    return null;
  }
  const ms = Math.round(days) * 86400000;
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

/**
 * Ingests one downloaded EDF file (STR.edf or a DATALOG detail file) into
 * the generic edf_signals / edf_signal_records tables, and — for STR.edf —
 * also flattens every numeric signal into a wide `nightly_summary` row per
 * date, keyed off the file's own "Date" signal.
 *
 * Skips re-parsing when the file's content hash matches what's already
 * stored (STR.edf is re-downloaded whole every sync cycle but usually
 * hasn't changed since the last one).
 */
export function ingestEdfFile(db: DatabaseSync, input: IngestFileInput): IngestFileResult {
  const contentSha256 = sha256Hex(input.rawBytes);
  const now = new Date().toISOString();

  const existing = db
    .prepare(`SELECT id, content_sha256, ingest_version FROM source_files WHERE remote_path = ?`)
    .get(input.remotePath) as { id: number; content_sha256: string; ingest_version: number } | undefined;

  if (existing && existing.content_sha256 === contentSha256 && existing.ingest_version === CURRENT_INGEST_VERSION) {
    db.prepare(
      `UPDATE source_files SET last_ingested_at = ?, last_sync_run_id = ?, flashair_modified_at = ? WHERE id = ?`
    ).run(now, input.syncRunId, input.flashairModifiedAt, existing.id);
    return { sourceFileId: existing.id, changed: false, recordsWritten: 0 };
  }

  let parsed: ParsedEdf;
  try {
    parsed = parseEdf(input.rawBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${input.remotePath} as EDF: ${message}`);
  }

  if (input.fileType === "str_summary") {
    validateNightlySummaryColumns(parsed);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const previousSummaryColumns = existing && input.fileType === "str_summary"
      ? getPreviousSummaryColumns(db, existing.id)
      : [];
    const sourceFileId = upsertSourceFile(db, input, contentSha256, parsed, now, existing?.id);
    if (existing) {
      db.prepare(`DELETE FROM edf_signals WHERE source_file_id = ?`).run(sourceFileId);
    }

    const signalIds: number[] = [];
    for (const signal of parsed.signals) {
      const info = db
        .prepare(
          `INSERT INTO edf_signals
             (source_file_id, signal_index, label, transducer_type, physical_dimension,
              physical_min, physical_max, digital_min, digital_max, prefiltering,
              samples_per_record, is_annotations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sourceFileId,
          signal.header.index,
          signal.header.label,
          signal.header.transducerType,
          signal.header.physicalDimension,
          signal.header.physicalMin,
          signal.header.physicalMax,
          signal.header.digitalMin,
          signal.header.digitalMax,
          signal.header.prefiltering,
          signal.header.samplesPerRecord,
          signal.header.isAnnotations ? 1 : 0
        );
      signalIds.push(Number(info.lastInsertRowid));
    }

    const recordStmt = db.prepare(
      `INSERT INTO edf_signal_records
         (signal_id, record_index, sample_count, digital_samples_blob, first_physical_value, raw_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    let recordsWritten = 0;
    let dateSignalIndex = -1;
    parsed.signals.forEach((s, i) => {
      if (s.header.label === "Date") {
        dateSignalIndex = i;
      }
    });

    const recordDates = new Map<number, string>();
    if (dateSignalIndex >= 0 && parsed.signals[dateSignalIndex].numericRecords) {
      for (const rec of parsed.signals[dateSignalIndex].numericRecords!) {
        const physical = digitalToPhysical(parsed.signals[dateSignalIndex].header, rec.digitalSamples[0]);
        const dateStr = epochDaysToDateString(physical);
        if (dateStr) {
          recordDates.set(rec.recordIndex, dateStr);
        }
      }
    }

    parsed.signals.forEach((signal, i) => {
      const signalId = signalIds[i];
      if (signal.numericRecords) {
        for (const rec of signal.numericRecords) {
          const blob = Buffer.alloc(rec.digitalSamples.length * 2);
          rec.digitalSamples.forEach((v, idx) => blob.writeInt16LE(v, idx * 2));
          const firstPhysical =
            rec.digitalSamples.length > 0 ? digitalToPhysical(signal.header, rec.digitalSamples[0]) : null;
          recordStmt.run(signalId, rec.recordIndex, rec.digitalSamples.length, blob, firstPhysical, null);
          recordsWritten += 1;
        }
      } else if (signal.annotationRecords) {
        for (const rec of signal.annotationRecords) {
          recordStmt.run(signalId, rec.recordIndex, 0, null, null, rec.rawBytes);
          recordsWritten += 1;
        }
      }
    });

    if (input.fileType === "str_summary" && recordDates.size > 0) {
      writeNightlySummary(db, sourceFileId, parsed, recordDates, previousSummaryColumns, now);
    }

    db.exec("COMMIT");
    if (input.fileType === "datalog") {
      const night = nightDateFromPath(input.remotePath);
      if (night) {
        rebuildNightDetail(db, night);
      }
    }
    return { sourceFileId, changed: true, recordsWritten };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function validateNightlySummaryColumns(parsed: ParsedEdf): void {
  const labelsByColumn = new Map<string, string>();
  for (const signal of parsed.signals) {
    if (!signal.numericRecords || signal.header.label === "Date") {
      continue;
    }
    const column = sanitizeColumnName(signal.header.label);
    const normalized = column.toLowerCase();
    const existingLabel = labelsByColumn.get(normalized);
    if (existingLabel) {
      throw new Error(
        `Signals "${existingLabel}" and "${signal.header.label}" both map to nightly_summary column "${column}"`
      );
    }
    labelsByColumn.set(normalized, signal.header.label);
  }
}

function getPreviousSummaryColumns(db: DatabaseSync, sourceFileId: number): string[] {
  const rows = db
    .prepare(`SELECT label FROM edf_signals WHERE source_file_id = ? AND is_annotations = 0 AND label <> 'Date'`)
    .all(sourceFileId) as { label: string }[];
  return [...new Set(rows.map((row) => sanitizeColumnName(row.label)))];
}

function upsertSourceFile(
  db: DatabaseSync,
  input: IngestFileInput,
  contentSha256: string,
  parsed: ParsedEdf,
  now: string,
  existingId: number | undefined
): number {
  if (existingId) {
    db.prepare(
      `UPDATE source_files SET
         file_type = ?, size_bytes = ?, flashair_modified_at = ?, content_sha256 = ?,
         edf_version = ?, edf_patient_id = ?, edf_recording_id = ?, edf_start_timestamp = ?,
         edf_num_signals = ?, edf_num_data_records = ?, edf_duration_seconds = ?, ingest_version = ?,
         last_ingested_at = ?, last_sync_run_id = ?
       WHERE id = ?`
    ).run(
      input.fileType,
      input.rawBytes.length,
      input.flashairModifiedAt,
      contentSha256,
      parsed.header.version,
      parsed.header.patientId,
      parsed.header.recordingId,
      parsed.header.startTimestampIso,
      parsed.header.numSignals,
      parsed.header.numDataRecords,
      parsed.header.durationOfDataRecordSeconds,
      CURRENT_INGEST_VERSION,
      now,
      input.syncRunId,
      existingId
    );
    return existingId;
  }

  const info = db
    .prepare(
      `INSERT INTO source_files
         (remote_path, file_type, size_bytes, flashair_modified_at, content_sha256,
          edf_version, edf_patient_id, edf_recording_id, edf_start_timestamp,
          edf_num_signals, edf_num_data_records, edf_duration_seconds, ingest_version,
          first_ingested_at, last_ingested_at, last_sync_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.remotePath,
      input.fileType,
      input.rawBytes.length,
      input.flashairModifiedAt,
      contentSha256,
      parsed.header.version,
      parsed.header.patientId,
      parsed.header.recordingId,
      parsed.header.startTimestampIso,
      parsed.header.numSignals,
      parsed.header.numDataRecords,
      parsed.header.durationOfDataRecordSeconds,
      CURRENT_INGEST_VERSION,
      now,
      now,
      input.syncRunId
    );
  return Number(info.lastInsertRowid);
}

function writeNightlySummary(
  db: DatabaseSync,
  sourceFileId: number,
  parsed: ParsedEdf,
  recordDates: Map<number, string>,
  previousColumns: string[],
  now: string
): void {
  // Exclude the "Date" signal itself: it's already the nightly_summary
  // primary key (`date`), and SQLite treats column names case-insensitively,
  // so "Date" would collide with "date" in ALTER TABLE / CREATE TABLE.
  const numericSignals = parsed.signals.filter((s) => s.numericRecords && s.header.label !== "Date");
  const columns = numericSignals.map((s) => sanitizeColumnName(s.header.label));
  for (const col of columns) {
    ensureColumn(db, "nightly_summary", col, "REAL");
  }

  for (const [recordIndex, date] of recordDates) {
    const values: Record<string, number | null> = {};
    for (const col of previousColumns) {
      values[col] = null;
    }
    for (const signal of numericSignals) {
      const rec = signal.numericRecords!.find((r) => r.recordIndex === recordIndex);
      const col = sanitizeColumnName(signal.header.label);
      const physical = rec && rec.digitalSamples.length > 0 ? digitalToPhysical(signal.header, rec.digitalSamples[0]) : null;
      values[col] = physical == null ? null : nightlyMeasuredValue(col, physical);
    }

    const cols = ["date", "source_file_id", "record_index", "updated_at", ...Object.keys(values)];
    const placeholders = cols.map(() => "?").join(", ");
    const updateAssignments = cols
      .filter((c) => c !== "date")
      .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
      .join(", ");
    const sql = `INSERT INTO nightly_summary (${cols.map(quoteIdent).join(", ")})
                 VALUES (${placeholders})
                 ON CONFLICT(date) DO UPDATE SET ${updateAssignments}`;
    db.prepare(sql).run(date, sourceFileId, recordIndex, now, ...Object.values(values));
  }
}
