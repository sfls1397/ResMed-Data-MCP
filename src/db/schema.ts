export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    universal_identifier TEXT UNIQUE,
    serial_number TEXT,
    product_name TEXT,
    product_code TEXT,
    hardware_identifier TEXT,
    software_application_id TEXT,
    configuration_id TEXT,
    data_version_id TEXT,
    region_identifier TEXT,
    raw_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    files_scanned INTEGER NOT NULL DEFAULT 0,
    files_ingested INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS source_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remote_path TEXT NOT NULL UNIQUE,
    file_type TEXT NOT NULL,
    size_bytes INTEGER,
    flashair_modified_at TEXT,
    content_sha256 TEXT,
    edf_version TEXT,
    edf_patient_id TEXT,
    edf_recording_id TEXT,
    edf_start_timestamp TEXT,
    edf_num_signals INTEGER,
    edf_num_data_records INTEGER,
    edf_duration_seconds REAL,
    ingest_version INTEGER NOT NULL DEFAULT 1,
    first_ingested_at TEXT NOT NULL,
    last_ingested_at TEXT NOT NULL,
    last_sync_run_id INTEGER REFERENCES sync_runs(id)
  )`,

  `CREATE TABLE IF NOT EXISTS edf_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    signal_index INTEGER NOT NULL,
    label TEXT NOT NULL,
    transducer_type TEXT,
    physical_dimension TEXT,
    physical_min REAL,
    physical_max REAL,
    digital_min REAL,
    digital_max REAL,
    prefiltering TEXT,
    samples_per_record INTEGER NOT NULL,
    is_annotations INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source_file_id, signal_index)
  )`,

  `CREATE TABLE IF NOT EXISTS edf_signal_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER NOT NULL REFERENCES edf_signals(id) ON DELETE CASCADE,
    record_index INTEGER NOT NULL,
    sample_count INTEGER NOT NULL,
    digital_samples_blob BLOB,
    first_physical_value REAL,
    raw_bytes BLOB,
    UNIQUE(signal_id, record_index)
  )`,

  `CREATE TABLE IF NOT EXISTS nightly_summary (
    date TEXT PRIMARY KEY,
    source_file_id INTEGER REFERENCES source_files(id),
    record_index INTEGER,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    night_date TEXT NOT NULL,
    session_start TEXT NOT NULL,
    brp_file_id INTEGER REFERENCES source_files(id),
    pld_file_id INTEGER REFERENCES source_files(id),
    sa2_file_id INTEGER REFERENCES source_files(id),
    eve_file_id INTEGER REFERENCES source_files(id),
    csl_file_id INTEGER REFERENCES source_files(id),
    UNIQUE(night_date, session_start)
  )`,

  `CREATE TABLE IF NOT EXISTS night_signal_stats (
    night_date TEXT NOT NULL,
    label TEXT NOT NULL,
    unit TEXT,
    sample_count INTEGER NOT NULL,
    min_value REAL,
    max_value REAL,
    avg_value REAL,
    session_count INTEGER NOT NULL,
    PRIMARY KEY (night_date, label)
  )`,

  `CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    night_date TEXT NOT NULL,
    source_file_id INTEGER NOT NULL REFERENCES source_files(id),
    file_kind TEXT NOT NULL,
    onset_seconds REAL NOT NULL,
    duration_seconds REAL,
    label TEXT NOT NULL,
    event_time TEXT,
    press_at_event REAL,
    leak_at_event REAL,
    press_2min_later REAL,
    pressure_rose INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS minute_stats (
    night_date TEXT NOT NULL,
    session_start TEXT NOT NULL,
    minute_index INTEGER NOT NULL,
    minute_start TEXT NOT NULL,
    press_avg REAL,
    leak_avg REAL,
    flow_lim_avg REAL,
    tid_vol_avg REAL,
    resp_rate_avg REAL,
    snore_avg REAL,
    spo2_avg REAL,
    obstructive_count INTEGER NOT NULL DEFAULT 0,
    central_count INTEGER NOT NULL DEFAULT 0,
    hypopnea_count INTEGER NOT NULL DEFAULT 0,
    apnea_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (night_date, session_start, minute_index)
  )`,

  `CREATE TABLE IF NOT EXISTS signal_hour_stats (
    night_date TEXT NOT NULL,
    session_start TEXT NOT NULL,
    hour_index INTEGER NOT NULL,
    hour_start TEXT NOT NULL,
    label TEXT NOT NULL,
    unit TEXT,
    sample_count INTEGER NOT NULL,
    min_value REAL,
    max_value REAL,
    avg_value REAL,
    PRIMARY KEY (night_date, session_start, hour_index, label)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_night ON sessions(night_date)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_night ON session_events(night_date)`,
  `CREATE TABLE IF NOT EXISTS night_therapy (
    night_date TEXT PRIMARY KEY,
    mode REAL,
    min_press REAL,
    max_press REAL,
    epr_level REAL,
    ahi REAL,
    leak_95 REAL,
    minute_count INTEGER NOT NULL,
    minutes_at_min INTEGER,
    minutes_at_max INTEGER,
    obstructive_count INTEGER NOT NULL,
    central_count INTEGER NOT NULL,
    hypopnea_count INTEGER NOT NULL,
    obstructive_at_min INTEGER,
    obstructive_at_max INTEGER,
    press_avg REAL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_minute_stats_night ON minute_stats(night_date)`,
  `CREATE INDEX IF NOT EXISTS idx_edf_signals_source_label ON edf_signals(source_file_id, label)`,
  `CREATE INDEX IF NOT EXISTS idx_signal_records_signal ON edf_signal_records(signal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_source_files_type ON source_files(file_type)`
];

/** Turns an EDF signal label like "S.C.StartPress" or "Leak.95" into a safe SQLite column name. */
/** Fixed nightly_summary columns. SQLite compares column names case-insensitively, so a
 *  sanitized signal label that only differs by case from one of these would collide. */
const RESERVED_NIGHTLY_SUMMARY_COLUMNS = new Set(["date", "source_file_id", "record_index", "updated_at"]);

export function sanitizeColumnName(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const withLeadingLetter = /^[0-9]/.test(cleaned) ? `c_${cleaned}` : cleaned;
  const name = withLeadingLetter || "unnamed";
  return RESERVED_NIGHTLY_SUMMARY_COLUMNS.has(name.toLowerCase()) ? `sig_${name}` : name;
}
