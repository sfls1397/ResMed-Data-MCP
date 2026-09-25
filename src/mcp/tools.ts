import type { DatabaseSync } from "node:sqlite";
import { tableColumns, quoteIdent } from "../db/open.js";
import { digitalToPhysical } from "../edf/types.js";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorJson(message: string): string {
  return json({ error: message });
}

export const TOOL_DEFINITIONS = [
  {
    name: "list_nights",
    description:
      "List nightly CPAP summary rows (one per calendar night) from the ResMed AirSense, newest first. Every column ResMed reports is included — AHI, HI, AI, OAI, CAI, UAI, Leak_50/95/70/Max, Duration (usage minutes), MaskOn/MaskOff, pressure and humidifier settings, SpO2 if present, etc. Use list_signals to see exactly which columns exist on this device.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Inclusive start date, YYYY-MM-DD" },
        date_to: { type: "string", description: "Inclusive end date, YYYY-MM-DD" },
        limit: { type: "number", description: "Max rows to return, default 30, max 365" }
      }
    }
  },
  {
    name: "get_night",
    description: "Full nightly summary row for a single date, with every column ResMed reported for that night.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date, YYYY-MM-DD" }
      },
      required: ["date"]
    }
  },
  {
    name: "get_trend",
    description:
      "Time series plus min/max/avg/count for one nightly_summary column over a date range. Use list_signals or list_nights first to find the exact column name (e.g. AHI, Leak_95, Duration).",
    inputSchema: {
      type: "object",
      properties: {
        column: { type: "string", description: "Column name in nightly_summary, e.g. AHI" },
        date_from: { type: "string", description: "Inclusive start date, YYYY-MM-DD" },
        date_to: { type: "string", description: "Inclusive end date, YYYY-MM-DD" },
        limit: { type: "number", description: "Max data points, default 90, max 365" }
      },
      required: ["column"]
    }
  },
  {
    name: "list_signals",
    description:
      "List raw signal labels stored in the archive. Therapy questions should use get_therapy_nights, get_night_minutes, and get_night_detail instead of these raw labels.",
    inputSchema: {
      type: "object",
      properties: {
        file_type: { type: "string", enum: ["str_summary", "datalog"], description: "Filter by source file type" },
        label_contains: { type: "string", description: "Case-insensitive substring filter on signal label" }
      }
    }
  },
  {
    name: "get_signal_samples",
    description:
      "Raw recording samples for one signal in one file. Do not use this for therapy questions. Use get_therapy_nights for how a night sat against its pressure settings, get_night_minutes for the minute-by-minute night, and get_night_detail for each event.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Exact signal label, e.g. AHI or Leak.95" },
        remote_path: { type: "string", description: "Source file path, default /STR.edf" },
        limit: { type: "number", description: "Max records to return, default 60, max 2000" }
      },
      required: ["label"]
    }
  },
  {
    name: "query_raw",
    description:
      "Read-only SELECT for a question the other tools do not answer. Prefer get_therapy_nights, get_night_minutes, get_night_detail, list_nights, and get_trend. Useful tables: night_therapy, minute_stats, session_events, nightly_summary. Results are capped at 1000 rows.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement" }
      },
      required: ["sql"]
    }
  },
  {
    name: "get_night_detail",
    description:
      "One calendar night as sessions, whole-night signal stats, and decoded events. Each event includes pressure and leak during that minute, pressure over the next two minutes, and whether pressure rose. Use get_night_minutes for the minute-by-minute pressure, leak, flow limitation, breathing, snore, oxygen, and event counts.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Night date, YYYY-MM-DD. This is the DATALOG folder date." }
      },
      required: ["date"]
    }
  },
  {
    name: "get_night_minutes",
    description:
      "Minute-by-minute therapy rows for one night. Each minute has average pressure, leak, flow limitation, tidal volume, respiratory rate, snore, and SpO2 when it was measuring, plus counts of obstructive apneas, central apneas, hypopneas, and unspecified apneas. This is the view to use when asking how breathing and pressure changed through the night.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Night date, YYYY-MM-DD. This is the DATALOG folder date." }
      },
      required: ["date"]
    }
  },
  {
    name: "get_therapy_nights",
    description:
      "One row per night for setting decisions. Includes the mode, minimum pressure, maximum pressure, EPR, AHI, and leak from the nightly summary, plus how many minutes pressure sat within 0.5 of the minimum and of the maximum, and how many obstructive apneas fell in those minutes. Use this to compare nights and decide whether pressure should be higher, lower, or fixed. Use get_night_minutes for one night's minute-by-minute detail.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Inclusive start date, YYYY-MM-DD" },
        date_to: { type: "string", description: "Inclusive end date, YYYY-MM-DD" },
        limit: { type: "number", description: "Max nights, default 30, max 365" }
      }
    }
  },
  {
    name: "sync_status",
    description: "How fresh the data is: the latest sync run, device identification, and row counts by source file type.",
    inputSchema: { type: "object", properties: {} }
  }
] as const;

function clampLimit(limit: unknown, def: number, max: number): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : def;
  return Math.min(Math.max(n, 1), max);
}

export function runListNights(db: DatabaseSync, args: { date_from?: string; date_to?: string; limit?: number }): string {
  const limit = clampLimit(args.limit, 30, 365);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (args.date_from) {
    conditions.push("date >= ?");
    params.push(args.date_from);
  }
  if (args.date_to) {
    conditions.push("date <= ?");
    params.push(args.date_to);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM nightly_summary ${where} ORDER BY date DESC LIMIT ?`)
    .all(...params, limit);
  return json({ count: rows.length, nights: rows });
}

export function runGetNight(db: DatabaseSync, args: { date?: string }): string {
  if (!args.date) {
    return errorJson("date is required (YYYY-MM-DD)");
  }
  const row = db.prepare(`SELECT * FROM nightly_summary WHERE date = ?`).get(args.date);
  if (!row) {
    return errorJson(`No nightly_summary row for ${args.date}`);
  }
  return json(row);
}

export function runGetTrend(
  db: DatabaseSync,
  args: { column?: string; date_from?: string; date_to?: string; limit?: number }
): string {
  if (!args.column) {
    return errorJson("column is required");
  }
  const validColumns = tableColumns(db, "nightly_summary");
  if (!validColumns.has(args.column)) {
    return errorJson(
      `Unknown nightly_summary column: ${args.column}. Call list_nights or list_signals to see valid columns.`
    );
  }
  const limit = clampLimit(args.limit, 90, 365);
  const conditions: string[] = [`${quoteIdent(args.column)} IS NOT NULL`];
  const params: (string | number)[] = [];
  if (args.date_from) {
    conditions.push("date >= ?");
    params.push(args.date_from);
  }
  if (args.date_to) {
    conditions.push("date <= ?");
    params.push(args.date_to);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const col = quoteIdent(args.column);
  const stats = db
    .prepare(`SELECT MIN(${col}) as min, MAX(${col}) as max, AVG(${col}) as avg, COUNT(*) as count FROM nightly_summary ${where}`)
    .get(...params);
  const series = db
    .prepare(`SELECT date, ${col} as value FROM nightly_summary ${where} ORDER BY date DESC LIMIT ?`)
    .all(...params, limit);
  return json({ column: args.column, stats, series });
}

export function runListSignals(
  db: DatabaseSync,
  args: { file_type?: string; label_contains?: string }
): string {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (args.file_type) {
    conditions.push("sf.file_type = ?");
    params.push(args.file_type);
  }
  if (args.label_contains) {
    conditions.push("es.label LIKE ? ESCAPE '\\'");
    params.push(`%${args.label_contains.replace(/[%_\\]/g, "\\$&")}%`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT es.label, es.physical_dimension, sf.file_type, COUNT(DISTINCT sf.remote_path) as file_count,
              MIN(sf.remote_path) as example_remote_path, es.samples_per_record, es.is_annotations
       FROM edf_signals es
       JOIN source_files sf ON sf.id = es.source_file_id
       ${where}
       GROUP BY es.label, sf.file_type
       ORDER BY sf.file_type, es.label`
    )
    .all(...params);
  return json({ count: rows.length, signals: rows });
}

export function runGetSignalSamples(
  db: DatabaseSync,
  args: { label?: string; remote_path?: string; limit?: number }
): string {
  if (!args.label) {
    return errorJson("label is required");
  }
  const remotePath = args.remote_path || "/STR.edf";
  const limit = clampLimit(args.limit, 60, 2000);

  const signal = db
    .prepare(
      `SELECT es.id, es.label, es.physical_dimension, es.physical_min, es.physical_max,
              es.digital_min, es.digital_max, es.samples_per_record, es.is_annotations
       FROM edf_signals es
       JOIN source_files sf ON sf.id = es.source_file_id
       WHERE sf.remote_path = ? AND es.label = ?`
    )
    .get(remotePath, args.label) as
    | {
        id: number;
        label: string;
        physical_dimension: string;
        physical_min: number;
        physical_max: number;
        digital_min: number;
        digital_max: number;
        samples_per_record: number;
        is_annotations: number;
      }
    | undefined;

  if (!signal) {
    return errorJson(`No signal "${args.label}" found in ${remotePath}. Call list_signals to see what's available.`);
  }

  if (signal.is_annotations) {
    const rows = db
      .prepare(`SELECT record_index, raw_bytes FROM edf_signal_records WHERE signal_id = ? ORDER BY record_index LIMIT ?`)
      .all(signal.id, limit) as { record_index: number; raw_bytes: Uint8Array | null }[];
    return json({
      label: signal.label,
      type: "annotations",
      note: "EDF+ annotation (TAL) bytes are not decoded yet; byte_length is shown so you know data is present.",
      records: rows.map((r) => ({ record_index: r.record_index, byte_length: r.raw_bytes?.length ?? 0 }))
    });
  }

  const rows = db
    .prepare(
      `SELECT record_index, digital_samples_blob FROM edf_signal_records WHERE signal_id = ? ORDER BY record_index LIMIT ?`
    )
    .all(signal.id, limit) as { record_index: number; digital_samples_blob: Uint8Array | null }[];

  const header = {
    physicalMin: signal.physical_min,
    physicalMax: signal.physical_max,
    digitalMin: signal.digital_min,
    digitalMax: signal.digital_max
  };
  const records = rows.map((r) => {
    const blob = r.digital_samples_blob ? Buffer.from(r.digital_samples_blob) : Buffer.alloc(0);
    const values: number[] = [];
    for (let i = 0; i + 1 < blob.length; i += 2) {
      values.push(digitalToPhysical(header, blob.readInt16LE(i)));
    }
    return { record_index: r.record_index, values };
  });

  return json({
    label: signal.label,
    unit: signal.physical_dimension,
    samples_per_record: signal.samples_per_record,
    type: "numeric",
    records
  });
}

const FORBIDDEN_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|CREATE|REPLACE|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i;

export function runQueryRaw(db: DatabaseSync, args: { sql?: string }): string {
  if (!args.sql || typeof args.sql !== "string") {
    return errorJson("sql is required");
  }
  const trimmed = args.sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(trimmed)) {
    return errorJson("Only a single SELECT statement is allowed");
  }
  if (trimmed.includes(";")) {
    return errorJson("Only a single statement is allowed");
  }
  if (FORBIDDEN_SQL_RE.test(trimmed)) {
    return errorJson("Only read-only SELECT queries are allowed");
  }
  try {
    const rows = db.prepare(trimmed).all();
    const truncated = rows.length > 1000;
    return json({ count: rows.length, truncated, rows: truncated ? rows.slice(0, 1000) : rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(`Query failed: ${message}`);
  }
}

export function runGetNightDetail(db: DatabaseSync, args: { date?: string }): string {
  if (!args.date) {
    return errorJson("date is required");
  }
  const sessions = db
    .prepare(
      `SELECT s.session_start, s.brp_file_id, s.pld_file_id, s.sa2_file_id, s.eve_file_id, s.csl_file_id
       FROM sessions s WHERE s.night_date = ? ORDER BY s.session_start`
    )
    .all(args.date);
  const signals = db
    .prepare(
      `SELECT label, unit, sample_count, min_value, max_value, avg_value, session_count
       FROM night_signal_stats WHERE night_date = ? ORDER BY label`
    )
    .all(args.date);
  const hours = db
    .prepare(
      `SELECT session_start, hour_index, hour_start, label, unit, sample_count, min_value, max_value, avg_value
       FROM signal_hour_stats WHERE night_date = ? ORDER BY session_start, hour_index, label`
    )
    .all(args.date);
  const events = db
    .prepare(
      `SELECT file_kind, onset_seconds, duration_seconds, label, event_time,
              press_at_event, leak_at_event, press_2min_later, pressure_rose
       FROM session_events WHERE night_date = ? ORDER BY event_time, onset_seconds, label`
    )
    .all(args.date);
  return json({
    date: args.date,
    session_count: sessions.length,
    has_breath_waveform: sessions.some((row) => (row as { brp_file_id: number | null }).brp_file_id != null),
    has_oximetry: sessions.some((row) => (row as { sa2_file_id: number | null }).sa2_file_id != null),
    sessions,
    signals,
    hours,
    events
  });
}

export function runGetNightMinutes(db: DatabaseSync, args: { date?: string }): string {
  if (!args.date) {
    return errorJson("date is required");
  }
  const minutes = db
    .prepare(
      `SELECT session_start, minute_index, minute_start, press_avg, leak_avg, flow_lim_avg, tid_vol_avg,
              resp_rate_avg, snore_avg, spo2_avg, obstructive_count, central_count, hypopnea_count, apnea_count
       FROM minute_stats WHERE night_date = ? ORDER BY session_start, minute_index`
    )
    .all(args.date);
  return json({ date: args.date, count: minutes.length, minutes });
}

export function runGetTherapyNights(db: DatabaseSync, args: { date_from?: string; date_to?: string; limit?: number }): string {
  const limit = clampLimit(args.limit, 30, 365);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (args.date_from) {
    conditions.push("night_date >= ?");
    params.push(args.date_from);
  }
  if (args.date_to) {
    conditions.push("night_date <= ?");
    params.push(args.date_to);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const nights = db
    .prepare(`SELECT * FROM night_therapy ${where} ORDER BY night_date DESC LIMIT ?`)
    .all(...params, limit);
  return json({ count: nights.length, nights });
}

export function runSyncStatus(db: DatabaseSync): string {
  const lastRun = db.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`).get();
  const device = db.prepare(`SELECT * FROM devices ORDER BY id DESC LIMIT 1`).get();
  const fileCounts = db
    .prepare(`SELECT file_type, COUNT(*) as count FROM source_files GROUP BY file_type`)
    .all();
  const nightRange = db
    .prepare(`SELECT MIN(date) as earliest, MAX(date) as latest, COUNT(*) as count FROM nightly_summary`)
    .get();
  return json({ last_sync_run: lastRun, device, source_file_counts: fileCounts, nightly_summary: nightRange });
}

export function callTool(db: DatabaseSync, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_nights":
      return runListNights(db, args);
    case "get_night":
      return runGetNight(db, args as { date?: string });
    case "get_trend":
      return runGetTrend(db, args);
    case "list_signals":
      return runListSignals(db, args);
    case "get_signal_samples":
      return runGetSignalSamples(db, args);
    case "query_raw":
      return runQueryRaw(db, args as { sql?: string });
    case "get_night_detail":
      return runGetNightDetail(db, args as { date?: string });
    case "get_night_minutes":
      return runGetNightMinutes(db, args as { date?: string });
    case "get_therapy_nights":
      return runGetTherapyNights(db, args);
    case "sync_status":
      return runSyncStatus(db);
    default:
      return errorJson(`Unknown tool: ${name}`);
  }
}
