import type { DatabaseSync } from "node:sqlite";
import { FlashAirClient } from "../flashair/client.js";
import { isDirectory } from "../flashair/types.js";
import { ingestEdfFile } from "../db/ingest.js";
import { CURRENT_INGEST_VERSION } from "../db/ingest.js";

export interface SyncResult {
  filesScanned: number;
  filesIngested: number;
  filesSkipped: number;
  errors: string[];
}

interface DeviceIdentification {
  FlowGenerator?: {
    IdentificationProfiles?: {
      Product?: {
        UniversalIdentifier?: string;
        SerialNumber?: string;
        ProductCode?: string;
        ProductName?: string;
      };
      Hardware?: { HardwareIdentifier?: string };
      Software?: {
        ApplicationIdentifier?: string;
        ConfigurationIdentifier?: string;
        DataVersionIdentifier?: number;
        RegionIdentifier?: number;
      };
    };
  };
}

async function syncDeviceIdentification(
  db: DatabaseSync,
  client: FlashAirClient,
  log: (msg: string) => void
): Promise<void> {
  try {
    const raw = await client.getFile("/Identification.json");
    const parsed = JSON.parse(raw.toString("utf8")) as DeviceIdentification;
    const profile = parsed.FlowGenerator?.IdentificationProfiles;
    const product = profile?.Product;
    if (!product?.UniversalIdentifier) {
      return;
    }
    const now = new Date().toISOString();
    // Firmware updates change the software/config/data-version identifiers on
    // the same device, so refresh every parsed column, not just raw_json.
    db.prepare(
      `INSERT INTO devices
         (universal_identifier, serial_number, product_name, product_code, hardware_identifier,
          software_application_id, configuration_id, data_version_id, region_identifier,
          raw_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(universal_identifier) DO UPDATE SET
         serial_number = excluded.serial_number,
         product_name = excluded.product_name,
         product_code = excluded.product_code,
         hardware_identifier = excluded.hardware_identifier,
         software_application_id = excluded.software_application_id,
         configuration_id = excluded.configuration_id,
         data_version_id = excluded.data_version_id,
         region_identifier = excluded.region_identifier,
         raw_json = excluded.raw_json,
         last_seen_at = excluded.last_seen_at`
    ).run(
      product.UniversalIdentifier,
      product.SerialNumber ?? null,
      product.ProductName ?? null,
      product.ProductCode ?? null,
      profile?.Hardware?.HardwareIdentifier ?? null,
      profile?.Software?.ApplicationIdentifier ?? null,
      profile?.Software?.ConfigurationIdentifier ?? null,
      profile?.Software?.DataVersionIdentifier != null ? String(profile.Software.DataVersionIdentifier) : null,
      profile?.Software?.RegionIdentifier != null ? String(profile.Software.RegionIdentifier) : null,
      raw.toString("utf8"),
      now,
      now
    );
  } catch (err) {
    log(`Could not sync device identification: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Skip re-downloading a DATALOG file whose metadata and ingest format match what's stored. */
function isUnchanged(
  db: DatabaseSync,
  remotePath: string,
  sizeBytes: number,
  modifiedAt: string | null
): boolean {
  const row = db
    .prepare(`SELECT size_bytes, flashair_modified_at, ingest_version FROM source_files WHERE remote_path = ?`)
    .get(remotePath) as { size_bytes: number; flashair_modified_at: string | null; ingest_version: number } | undefined;
  if (!row) {
    return false;
  }
  return row.size_bytes === sizeBytes && row.flashair_modified_at === modifiedAt && row.ingest_version === CURRENT_INGEST_VERSION;
}

export async function syncOnce(
  db: DatabaseSync,
  client: FlashAirClient,
  syncRunId: number,
  log: (msg: string) => void = (m) => console.error(m)
): Promise<SyncResult> {
  const result: SyncResult = { filesScanned: 0, filesIngested: 0, filesSkipped: 0, errors: [] };

  await syncDeviceIdentification(db, client, log);

  // STR.edf: small, appended-to daily. Always re-download; ingestEdfFile skips
  // re-parsing itself via content hash when nothing actually changed.
  try {
    result.filesScanned += 1;
    const bytes = await client.getFile("/STR.edf");
    const entries = await client.listDirectory("/").catch(() => []);
    const strEntry = entries.find((e) => e.name === "STR.edf");
    const ingestResult = ingestEdfFile(db, {
      remotePath: "/STR.edf",
      fileType: "str_summary",
      rawBytes: bytes,
      flashairModifiedAt: strEntry?.modifiedAt ?? null,
      syncRunId
    });
    if (ingestResult.changed) {
      result.filesIngested += 1;
      log(`Ingested /STR.edf (${bytes.length} bytes)`);
    } else {
      result.filesSkipped += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`/STR.edf: ${message}`);
    log(`Error syncing /STR.edf: ${message}`);
  }

  // DATALOG/<date>/<file> — walk every date folder, skip files already ingested unchanged.
  try {
    const dateDirs = (await client.listDirectory("/DATALOG")).filter(isDirectory);
    for (const dateDir of dateDirs) {
      let files;
      try {
        files = (await client.listDirectory(dateDir.path)).filter((e) => !isDirectory(e));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${dateDir.path}: ${message}`);
        continue;
      }
      for (const file of files) {
        result.filesScanned += 1;
        if (!file.name.toLowerCase().endsWith(".edf")) {
          result.filesSkipped += 1;
          continue;
        }
        if (isUnchanged(db, file.path, file.size, file.modifiedAt)) {
          result.filesSkipped += 1;
          continue;
        }
        try {
          const bytes = await client.getFile(file.path);
          const ingestResult = ingestEdfFile(db, {
            remotePath: file.path,
            fileType: "datalog",
            rawBytes: bytes,
            flashairModifiedAt: file.modifiedAt,
            syncRunId
          });
          if (ingestResult.changed) {
            result.filesIngested += 1;
            log(`Ingested ${file.path} (${bytes.length} bytes)`);
          } else {
            result.filesSkipped += 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`${file.path}: ${message}`);
          log(`Error syncing ${file.path}: ${message}`);
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`/DATALOG: ${message}`);
    log(`Error listing /DATALOG: ${message}`);
  }

  return result;
}
