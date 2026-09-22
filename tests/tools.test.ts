import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "../src/db/open.js";
import { openDatabase } from "../src/db/open.js";
import { runQueryRaw, runGetTrend, runListNights } from "../src/mcp/tools.js";

function freshDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  db.exec(`ALTER TABLE nightly_summary ADD COLUMN AHI REAL`);
  db.prepare(`INSERT INTO nightly_summary (date, updated_at, AHI) VALUES (?, ?, ?)`).run(
    "2026-09-20",
    "2026-09-20T00:00:00Z",
    3.4
  );
  db.prepare(`INSERT INTO nightly_summary (date, updated_at, AHI) VALUES (?, ?, ?)`).run(
    "2026-09-21",
    "2026-09-21T00:00:00Z",
    5.3
  );
  return db;
}

describe("runQueryRaw", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it("allows a plain SELECT", () => {
    const result = JSON.parse(runQueryRaw(db, { sql: "SELECT date FROM nightly_summary ORDER BY date" }));
    expect(result.count).toBe(2);
  });

  it("rejects statements that aren't SELECT", () => {
    const result = JSON.parse(runQueryRaw(db, { sql: "DELETE FROM nightly_summary" }));
    expect(result.error).toMatch(/SELECT/);
  });

  it("rejects a SELECT smuggling a second statement", () => {
    const result = JSON.parse(runQueryRaw(db, { sql: "SELECT 1; DROP TABLE nightly_summary" }));
    expect(result.error).toMatch(/single statement/);
  });

  it("rejects write keywords even inside a nested query", () => {
    const result = JSON.parse(
      runQueryRaw(db, { sql: "SELECT * FROM nightly_summary WHERE date = (SELECT date FROM nightly_summary) OR 1=1 -- INSERT" })
    );
    expect(result.error).toBeDefined();
  });

  it("rejects a missing sql argument", () => {
    const result = JSON.parse(runQueryRaw(db, {}));
    expect(result.error).toBe("sql is required");
  });
});

describe("runGetTrend", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it("rejects an unknown column instead of interpolating it into SQL", () => {
    const result = JSON.parse(runGetTrend(db, { column: "AHI; DROP TABLE nightly_summary" }));
    expect(result.error).toMatch(/Unknown nightly_summary column/);
  });

  it("computes stats for a real column", () => {
    const result = JSON.parse(runGetTrend(db, { column: "AHI" }));
    expect(result.stats.count).toBe(2);
    expect(result.stats.max).toBe(5.3);
  });
});

describe("runListNights", () => {
  it("orders newest first and respects limit", () => {
    const db = freshDb();
    const result = JSON.parse(runListNights(db, { limit: 1 }));
    expect(result.count).toBe(1);
    expect(result.nights[0].date).toBe("2026-09-21");
  });
});
