import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open.js";
import type { FlashAirClient } from "../src/flashair/client.js";
import { syncOnce } from "../src/indexer/backfill.js";

function identification(software: string, dataVersion: number): string {
  return JSON.stringify({
    FlowGenerator: {
      IdentificationProfiles: {
        Product: { UniversalIdentifier: "device-1", SerialNumber: "123", ProductCode: "39420", ProductName: "AirSense11AutoSet" },
        Hardware: { HardwareIdentifier: "hw-1" },
        Software: { ApplicationIdentifier: software, ConfigurationIdentifier: `CF-${software}`, DataVersionIdentifier: dataVersion, RegionIdentifier: 0 }
      }
    }
  });
}

/** A card that only serves Identification.json; STR.edf and DATALOG fail and are recorded as sync errors. */
function cardWith(json: string): FlashAirClient {
  return {
    async getFile(remotePath: string) {
      if (remotePath === "/Identification.json") {
        return Buffer.from(json);
      }
      throw new Error("not on card");
    },
    async listDirectory() {
      throw new Error("not on card");
    }
  } as unknown as FlashAirClient;
}

describe("syncOnce device identification", () => {
  it("refreshes parsed identifiers after a firmware update", async () => {
    const db = openDatabase(":memory:");
    await syncOnce(db, cardWith(identification("SW-17", 17)), 1, () => {});
    const first = db.prepare("SELECT first_seen_at FROM devices").get() as { first_seen_at: string };

    await syncOnce(db, cardWith(identification("SW-18", 18)), 2, () => {});

    const rows = db.prepare("SELECT * FROM devices").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      software_application_id: "SW-18",
      configuration_id: "CF-SW-18",
      data_version_id: "18",
      first_seen_at: first.first_seen_at
    });
    db.close();
  });
});
