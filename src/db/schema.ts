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
