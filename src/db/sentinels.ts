import type { DatabaseSync } from "./open.js";
import { quoteIdent, tableColumns } from "./open.js";

/** ResMed writes -1 for "not measured" on SpO2 and duration, and -0.1 for AHI when the night had no session. */
export function nightlyMeasuredValue(column: string, value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (column.startsWith("SpO2") && value === -1) {
    return null;
  }
  if (column === "Duration" && value === -1) {
    return null;
  }
  if (column === "AHI" && Math.abs(value + 0.1) < 1e-6) {
    return null;
  }
  if (column === "Mode" && value === -1) {
    return null;
  }
  return value;
}

/** High-resolution oximetry uses the same -1 filler when the sensor is not measuring. */
export function isUnmeasuredSample(label: string, value: number): boolean {
  return (label.startsWith("SpO2") || label.startsWith("Pulse")) && value === -1;
}

export function clearNightlySentinels(db: DatabaseSync): void {
  const columns = tableColumns(db, "nightly_summary");
  for (const column of columns) {
    if (!column.startsWith("SpO2")) {
      continue;
    }
    const name = quoteIdent(column);
    db.prepare(`UPDATE nightly_summary SET ${name} = NULL WHERE ${name} = -1`).run();
  }
  if (columns.has("Duration")) {
    db.prepare(`UPDATE nightly_summary SET "Duration" = NULL WHERE "Duration" = -1`).run();
  }
  if (columns.has("AHI")) {
    db.prepare(`UPDATE nightly_summary SET "AHI" = NULL WHERE ABS("AHI" + 0.1) < 0.000001`).run();
  }
  if (columns.has("Mode")) {
    db.prepare(`UPDATE nightly_summary SET "Mode" = NULL WHERE "Mode" = -1`).run();
  }
}
