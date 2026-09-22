import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { SCHEMA_STATEMENTS } from "./schema.js";

// A static `import { DatabaseSync } from "node:sqlite"` breaks under
// vite/vitest today: node:sqlite is new enough that vite's own builtin-module
// list doesn't recognize it yet, and it tries (and fails) to resolve it as a
// package. Routing through Node's own require sidesteps that entirely and
// behaves identically under plain Node.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};
export type DatabaseSync = DatabaseSyncType;

export function openDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
  return db;
}

/** Read-only handle for the MCP server: same file, WAL lets it read while the indexer writes. */
export function openDatabaseReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return db;
}

export function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function ensureColumn(db: DatabaseSync, table: string, column: string, sqlType: string): void {
  const existing = tableColumns(db, table);
  if (!existing.has(column)) {
    db.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${sqlType}`);
  }
}
