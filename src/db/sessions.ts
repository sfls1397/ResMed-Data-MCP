import type { DatabaseSync } from "./open.js";
import { tableColumns } from "./open.js";
import { parseAnnotations } from "../edf/annotations.js";
import { digitalToPhysical } from "../edf/types.js";
import { isUnmeasuredSample } from "./sentinels.js";

const SESSION_GAP_MS = 2 * 60 * 1000;
const DETAIL_KINDS = ["BRP", "PLD", "SA2", "EVE", "CSL"] as const;
type DetailKind = (typeof DETAIL_KINDS)[number];

interface DetailFile {
  id: number;
  remotePath: string;
  kind: DetailKind;
  stampMs: number;
  sessionStart: string;
}

/** Night a DATALOG file belongs to. YYYYMMDD folders are the night. Year folders (older OSCAR copies) use the filename clock, and a time before noon belongs to the previous night. */
export function nightDateFromPath(remotePath: string): string | null {
  const folder = remotePath.match(/DATALOG\/(\d{4})(\d{2})(\d{2})\//);
  if (folder) {
    return `${folder[1]}-${folder[2]}-${folder[3]}`;
  }
  const stamp = remotePath.match(/DATALOG\/\d{4}\/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/);
  if (!stamp) {
    return null;
  }
  const date = new Date(Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Number(stamp[4]), Number(stamp[5]), Number(stamp[6])));
  if (Number(stamp[4]) < 12) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date.toISOString().slice(0, 10);
}

function parseDetailFile(row: { id: number; remote_path: string }): DetailFile | null {
  const kindMatch = row.remote_path.match(/_([A-Za-z0-9]+)\.edf$/);
  const stampMatch = row.remote_path.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/);
  if (!kindMatch || !stampMatch) {
    return null;
  }
  const kind = kindMatch[1].toUpperCase();
  if (!DETAIL_KINDS.includes(kind as DetailKind)) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = stampMatch;
  return {
    id: row.id,
    remotePath: row.remote_path,
    kind: kind as DetailKind,
    stampMs: Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`),
    sessionStart: `${year}-${month}-${day}T${hour}:${minute}:${second}`
  };
}

function clusterSessions(files: DetailFile[]): DetailFile[][] {
  const sorted = [...files].sort((a, b) => a.stampMs - b.stampMs || a.kind.localeCompare(b.kind));
  const groups: DetailFile[][] = [];
  for (const file of sorted) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (!current || !previous || file.stampMs - previous.stampMs > SESSION_GAP_MS) {
      groups.push([file]);
    } else {
      current.push(file);
    }
  }
  return groups;
}

interface RunningStat {
  unit: string | null;
  count: number;
  sum: number;
  min: number;
  max: number;
  sessions: Set<number>;
}

interface HourStat {
  hourStart: string;
  unit: string | null;
  count: number;
  sum: number;
  min: number;
  max: number;
}

const MINUTE_FIELDS = {
  "Press.2s": "press",
  "Leak.2s": "leak",
  "FlowLim.2s": "flowLim",
  "TidVol.2s": "tidVol",
  "RespRate.2s": "respRate",
  "Snore.2s": "snore",
  "SpO2.1s": "spo2"
} as const;

type MinuteField = (typeof MINUTE_FIELDS)[keyof typeof MINUTE_FIELDS];

interface MinuteBucket {
  sessionStart: string;
  minuteIndex: number;
  minuteStart: string;
  startMs: number;
  fields: Record<MinuteField, { count: number; sum: number }>;
  obstructive: number;
  central: number;
  hypopnea: number;
  apnea: number;
}

function blankMinute(sessionStart: string, minuteIndex: number, minuteStart: string, startMs: number): MinuteBucket {
  return {
    sessionStart,
    minuteIndex,
    minuteStart,
    startMs,
    fields: {
      press: { count: 0, sum: 0 },
      leak: { count: 0, sum: 0 },
      flowLim: { count: 0, sum: 0 },
      tidVol: { count: 0, sum: 0 },
      respRate: { count: 0, sum: 0 },
      snore: { count: 0, sum: 0 },
      spo2: { count: 0, sum: 0 }
    },
    obstructive: 0,
    central: 0,
    hypopnea: 0,
    apnea: 0
  };
}

function fieldAvg(field: { count: number; sum: number }): number | null {
  return field.count > 0 ? field.sum / field.count : null;
}

function blankStat(hourStart: string, unit: string | null): HourStat {
  return { hourStart, unit, count: 0, sum: 0, min: Infinity, max: -Infinity };
}

function addValue(stat: { count: number; sum: number; min: number; max: number }, value: number): void {
  stat.count += 1;
  stat.sum += value;
  stat.min = Math.min(stat.min, value);
  stat.max = Math.max(stat.max, value);
}

function addSeconds(start: string | null, seconds: number): string | null {
  if (!start) {
    return null;
  }
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(start);
  const base = Date.parse(hasZone ? start : `${start}Z`);
  if (!Number.isFinite(base)) {
    return null;
  }
  return new Date(base + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Group one night's DATALOG files into sessions and replace that night's signal stats. */
export function rebuildNightDetail(db: DatabaseSync, nightDate: string): number {
  const compact = nightDate.replace(/-/g, "");
  const rows = db
    .prepare(
      `SELECT id, remote_path FROM source_files
       WHERE file_type = 'datalog' AND (remote_path LIKE ? OR remote_path LIKE ?)`
    )
    .all(`%/DATALOG/${compact}/%`, `%/DATALOG/${nightDate.slice(0, 4)}/%`) as { id: number; remote_path: string }[];
  const files = rows.flatMap((row) => {
    const parsed = parseDetailFile(row);
    return parsed && nightDateFromPath(row.remote_path) === nightDate ? [parsed] : [];
  });

  db.prepare(`DELETE FROM sessions WHERE night_date = ?`).run(nightDate);
  db.prepare(`DELETE FROM night_signal_stats WHERE night_date = ?`).run(nightDate);
  db.prepare(`DELETE FROM signal_hour_stats WHERE night_date = ?`).run(nightDate);
  db.prepare(`DELETE FROM minute_stats WHERE night_date = ?`).run(nightDate);
  db.prepare(`DELETE FROM night_therapy WHERE night_date = ?`).run(nightDate);
  db.prepare(`DELETE FROM session_events WHERE night_date = ?`).run(nightDate);
  if (files.length === 0) {
    return 0;
  }

  const insertSession = db.prepare(
    `INSERT INTO sessions
       (night_date, session_start, brp_file_id, pld_file_id, sa2_file_id, eve_file_id, csl_file_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const sessionIds: number[] = [];
  const fileToSession = new Map<number, number>();
  const sessionStartById = new Map<number, string>();
  for (const group of clusterSessions(files)) {
    const byKind = new Map<DetailKind, number>();
    for (const file of group) {
      if (!byKind.has(file.kind)) {
        byKind.set(file.kind, file.id);
      }
    }
    const info = insertSession.run(
      nightDate,
      group[0].sessionStart,
      byKind.get("BRP") ?? null,
      byKind.get("PLD") ?? null,
      byKind.get("SA2") ?? null,
      byKind.get("EVE") ?? null,
      byKind.get("CSL") ?? null
    );
    const sessionId = Number(info.lastInsertRowid);
    sessionIds.push(sessionId);
    sessionStartById.set(sessionId, group[0].sessionStart);
    for (const file of group) {
      fileToSession.set(file.id, sessionId);
    }
  }

  const fileIds = files.map((file) => file.id);
  const placeholders = fileIds.map(() => "?").join(", ");
  const signals = db
    .prepare(
      `SELECT es.id, es.source_file_id, es.label, es.physical_dimension, es.physical_min, es.physical_max,
              es.digital_min, es.digital_max, es.samples_per_record,
              sf.edf_start_timestamp, sf.edf_duration_seconds
       FROM edf_signals es
       JOIN source_files sf ON sf.id = es.source_file_id
       WHERE es.source_file_id IN (${placeholders})
         AND es.is_annotations = 0
         AND es.label <> 'Crc16'`
    )
    .all(...fileIds) as Array<{
    id: number;
    source_file_id: number;
    label: string;
    physical_dimension: string | null;
    physical_min: number;
    physical_max: number;
    digital_min: number;
    digital_max: number;
    samples_per_record: number;
    edf_start_timestamp: string | null;
    edf_duration_seconds: number | null;
  }>;

  const stats = new Map<string, RunningStat>();
  const hours = new Map<string, HourStat>();
  const minutes = new Map<string, MinuteBucket>();
  const recordStmt = db.prepare(
    `SELECT record_index, digital_samples_blob FROM edf_signal_records
     WHERE signal_id = ? AND digital_samples_blob IS NOT NULL ORDER BY record_index`
  );
  for (const signal of signals) {
    const sessionId = fileToSession.get(signal.source_file_id);
    if (sessionId == null) {
      continue;
    }
    const sessionStart = sessionStartById.get(sessionId) ?? "";
    const clockStart = signal.edf_start_timestamp || sessionStart;
    let stat = stats.get(signal.label);
    if (!stat) {
      stat = { unit: signal.physical_dimension, count: 0, sum: 0, min: Infinity, max: -Infinity, sessions: new Set() };
      stats.set(signal.label, stat);
    }
    const calibration = {
      physicalMin: signal.physical_min,
      physicalMax: signal.physical_max,
      digitalMin: signal.digital_min,
      digitalMax: signal.digital_max
    };
    const recordDuration = signal.edf_duration_seconds && signal.edf_duration_seconds > 0 ? signal.edf_duration_seconds : 0;
    const samplesPerRecord = signal.samples_per_record > 0 ? signal.samples_per_record : 1;
    const records = recordStmt.all(signal.id) as { record_index: number; digital_samples_blob: Buffer }[];
    for (const record of records) {
      const bytes = Buffer.isBuffer(record.digital_samples_blob) ? record.digital_samples_blob : Buffer.from(record.digital_samples_blob);
      for (let offset = 0, sampleIndex = 0; offset + 1 < bytes.length; offset += 2, sampleIndex += 1) {
        const value = digitalToPhysical(calibration, bytes.readInt16LE(offset));
        if (!Number.isFinite(value) || isUnmeasuredSample(signal.label, value)) {
          continue;
        }
        addValue(stat, value);
        const elapsed = recordDuration > 0 ? record.record_index * recordDuration + (sampleIndex * recordDuration) / samplesPerRecord : 0;
        const hourIndex = Math.floor(elapsed / 3600);
        const hourKey = `${sessionStart}\t${hourIndex}\t${signal.label}`;
        let hour = hours.get(hourKey);
        if (!hour) {
          hour = blankStat(addSeconds(clockStart, hourIndex * 3600) ?? sessionStart, signal.physical_dimension);
          hours.set(hourKey, hour);
        }
        addValue(hour, value);
        const minuteField = MINUTE_FIELDS[signal.label as keyof typeof MINUTE_FIELDS];
        if (minuteField) {
          const minuteIndex = Math.floor(elapsed / 60);
          const minuteKey = `${sessionStart}\t${minuteIndex}`;
          let minute = minutes.get(minuteKey);
          if (!minute) {
            const minuteStart = addSeconds(clockStart, minuteIndex * 60) ?? sessionStart;
            minute = blankMinute(sessionStart, minuteIndex, minuteStart, Date.parse(minuteStart.endsWith("Z") ? minuteStart : `${minuteStart}Z`));
            minutes.set(minuteKey, minute);
          }
          minute.fields[minuteField].count += 1;
          minute.fields[minuteField].sum += value;
        }
      }
    }
    if (stat.count > 0) {
      stat.sessions.add(sessionId);
    }
  }

  const insertStat = db.prepare(
    `INSERT INTO night_signal_stats
       (night_date, label, unit, sample_count, min_value, max_value, avg_value, session_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [label, stat] of stats) {
    if (stat.count === 0) {
      continue;
    }
    insertStat.run(
      nightDate,
      label,
      stat.unit,
      stat.count,
      stat.min,
      stat.max,
      stat.sum / stat.count,
      stat.sessions.size
    );
  }

  const insertHour = db.prepare(
    `INSERT INTO signal_hour_stats
       (night_date, session_start, hour_index, hour_start, label, unit, sample_count, min_value, max_value, avg_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [key, hour] of hours) {
    if (hour.count === 0) {
      continue;
    }
    const [sessionStart, hourIndexText, label] = key.split("\t");
    const hourIndex = Number(hourIndexText);
    insertHour.run(
      nightDate,
      sessionStart,
      hourIndex,
      hour.hourStart,
      label,
      hour.unit,
      hour.count,
      hour.min,
      hour.max,
      hour.sum / hour.count
    );
  }

  const pendingEvents: Array<{
    sourceFileId: number;
    kind: string;
    onsetSeconds: number;
    durationSeconds: number | null;
    label: string;
    eventTime: string | null;
    sessionStart: string | null;
    eventMs: number | null;
  }> = [];
  const annotationRows = db
    .prepare(
      `SELECT es.source_file_id, sf.remote_path, sf.edf_start_timestamp, r.raw_bytes
       FROM edf_signal_records r
       JOIN edf_signals es ON es.id = r.signal_id
       JOIN source_files sf ON sf.id = es.source_file_id
       WHERE es.is_annotations = 1 AND es.source_file_id IN (${placeholders}) AND r.raw_bytes IS NOT NULL`
    )
    .all(...fileIds) as Array<{
    source_file_id: number;
    remote_path: string;
    edf_start_timestamp: string | null;
    raw_bytes: Uint8Array;
  }>;
  for (const row of annotationRows) {
    const kind = row.remote_path.match(/_([A-Za-z0-9]+)\.edf$/)?.[1]?.toUpperCase() ?? "";
    const sessionId = fileToSession.get(row.source_file_id);
    const sessionStart = sessionId == null ? null : sessionStartById.get(sessionId) ?? null;
    for (const event of parseAnnotations(row.raw_bytes)) {
      const eventTime = addSeconds(row.edf_start_timestamp, event.onsetSeconds);
      pendingEvents.push({
        sourceFileId: row.source_file_id,
        kind,
        onsetSeconds: event.onsetSeconds,
        durationSeconds: event.durationSeconds,
        label: event.text,
        eventTime,
        sessionStart,
        eventMs: eventTime ? Date.parse(eventTime) : null
      });
    }
  }

  const minutesBySession = new Map<string, MinuteBucket[]>();
  for (const minute of minutes.values()) {
    const list = minutesBySession.get(minute.sessionStart) ?? [];
    list.push(minute);
    minutesBySession.set(minute.sessionStart, list);
  }
  for (const list of minutesBySession.values()) {
    list.sort((a, b) => a.minuteIndex - b.minuteIndex);
  }

  const insertMinute = db.prepare(
    `INSERT INTO minute_stats
       (night_date, session_start, minute_index, minute_start, press_avg, leak_avg, flow_lim_avg,
        tid_vol_avg, resp_rate_avg, snore_avg, spo2_avg, obstructive_count, central_count, hypopnea_count, apnea_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEvent = db.prepare(
    `INSERT INTO session_events
       (night_date, source_file_id, file_kind, onset_seconds, duration_seconds, label, event_time,
        press_at_event, leak_at_event, press_2min_later, pressure_rose)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const event of pendingEvents) {
    const list = event.sessionStart ? minutesBySession.get(event.sessionStart) ?? [] : [];
    const minute = event.eventMs == null ? undefined : list.find((item) => event.eventMs! >= item.startMs && event.eventMs! < item.startMs + 60_000);
    if (minute) {
      if (event.label === "Obstructive Apnea") minute.obstructive += 1;
      else if (event.label === "Central Apnea") minute.central += 1;
      else if (event.label === "Hypopnea") minute.hypopnea += 1;
      else if (event.label === "Apnea") minute.apnea += 1;
    }
    const later = minute == null ? [] : list.filter((item) => item.minuteIndex === minute.minuteIndex + 1 || item.minuteIndex === minute.minuteIndex + 2);
    const laterPress = later.map((item) => fieldAvg(item.fields.press)).filter((value): value is number => value != null);
    const pressAt = minute ? fieldAvg(minute.fields.press) : null;
    const leakAt = minute ? fieldAvg(minute.fields.leak) : null;
    const pressLater = laterPress.length > 0 ? laterPress.reduce((sum, value) => sum + value, 0) / laterPress.length : null;
    const pressureRose = pressAt != null && pressLater != null ? (pressLater > pressAt + 0.3 ? 1 : 0) : null;
    insertEvent.run(
      nightDate,
      event.sourceFileId,
      event.kind,
      event.onsetSeconds,
      event.durationSeconds,
      event.label,
      event.eventTime,
      pressAt,
      leakAt,
      pressLater,
      pressureRose
    );
  }

  for (const minute of minutes.values()) {
    insertMinute.run(
      nightDate,
      minute.sessionStart,
      minute.minuteIndex,
      minute.minuteStart,
      fieldAvg(minute.fields.press),
      fieldAvg(minute.fields.leak),
      fieldAvg(minute.fields.flowLim),
      fieldAvg(minute.fields.tidVol),
      fieldAvg(minute.fields.respRate),
      fieldAvg(minute.fields.snore),
      fieldAvg(minute.fields.spo2),
      minute.obstructive,
      minute.central,
      minute.hypopnea,
      minute.apnea
    );
  }

  writeNightTherapy(db, nightDate, [...minutes.values()]);
  return sessionIds.length;
}

const AT_PRESSURE_CM = 0.5;

function writeNightTherapy(db: DatabaseSync, nightDate: string, minutes: MinuteBucket[]): void {
  if (minutes.length === 0) {
    return;
  }
  const columns = tableColumns(db, "nightly_summary");
  const wanted = ["Mode", "S_A_MinPress", "S_A_MaxPress", "S_EPR_Level", "AHI", "Leak_95"] as const;
  const present = wanted.filter((column) => columns.has(column));
  const settings = present.length === 0
    ? {}
    : db.prepare(`SELECT ${present.join(", ")} FROM nightly_summary WHERE date = ?`).get(nightDate) as Record<string, number | null> | undefined;
  const minPress = settings?.S_A_MinPress ?? null;
  const maxPress = settings?.S_A_MaxPress ?? null;
  let pressSum = 0;
  let pressCount = 0;
  let atMin = 0;
  let atMax = 0;
  let obstructive = 0;
  let central = 0;
  let hypopnea = 0;
  let obstructiveAtMin = 0;
  let obstructiveAtMax = 0;
  let sawPress = false;
  for (const minute of minutes) {
    const press = fieldAvg(minute.fields.press);
    obstructive += minute.obstructive;
    central += minute.central;
    hypopnea += minute.hypopnea;
    if (press == null) {
      continue;
    }
    sawPress = true;
    pressSum += press;
    pressCount += 1;
    if (minPress != null && Math.abs(press - minPress) <= AT_PRESSURE_CM) {
      atMin += 1;
      obstructiveAtMin += minute.obstructive;
    }
    if (maxPress != null && Math.abs(press - maxPress) <= AT_PRESSURE_CM) {
      atMax += 1;
      obstructiveAtMax += minute.obstructive;
    }
  }
  db.prepare(
    `INSERT INTO night_therapy
       (night_date, mode, min_press, max_press, epr_level, ahi, leak_95, minute_count,
        minutes_at_min, minutes_at_max, obstructive_count, central_count, hypopnea_count,
        obstructive_at_min, obstructive_at_max, press_avg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nightDate,
    settings?.Mode ?? null,
    minPress,
    maxPress,
    settings?.S_EPR_Level ?? null,
    settings?.AHI ?? null,
    settings?.Leak_95 ?? null,
    minutes.length,
    sawPress && minPress != null ? atMin : null,
    sawPress && maxPress != null ? atMax : null,
    obstructive,
    central,
    hypopnea,
    sawPress && minPress != null ? obstructiveAtMin : null,
    sawPress && maxPress != null ? obstructiveAtMax : null,
    pressCount > 0 ? pressSum / pressCount : null
  );
}

/** Rebuild every night that has DATALOG files. Returns the number of sessions written. */
export function rebuildAllDetailRollups(db: DatabaseSync, log: (msg: string) => void = () => {}): number {
  const nights = db
    .prepare(
      `SELECT DISTINCT remote_path FROM source_files WHERE file_type = 'datalog' AND remote_path LIKE '%/DATALOG/%'`
    )
    .all() as { remote_path: string }[];
  const dates = [...new Set(nights.map((row) => nightDateFromPath(row.remote_path)).filter((date): date is string => date != null))];
  dates.sort();
  let sessions = 0;
  dates.forEach((date, index) => {
    sessions += rebuildNightDetail(db, date);
    if ((index + 1) % 50 === 0 || index === dates.length - 1) {
      log(`Detail rollup ${index + 1}/${dates.length} nights, ${sessions} sessions`);
    }
  });
  return sessions;
}
