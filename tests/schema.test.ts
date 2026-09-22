import { describe, expect, it } from "vitest";
import { sanitizeColumnName } from "../src/db/schema.js";

describe("sanitizeColumnName", () => {
  it("replaces non-identifier characters with underscores", () => {
    expect(sanitizeColumnName("S.C.StartPress")).toBe("S_C_StartPress");
    expect(sanitizeColumnName("Leak.95")).toBe("Leak_95");
  });

  it("prefixes labels that start with a digit", () => {
    expect(sanitizeColumnName("95thPercentile")).toBe("c_95thPercentile");
  });

  it("avoids case-insensitive collisions with reserved nightly_summary columns", () => {
    // SQLite compares column names case-insensitively: "Date" would collide with "date".
    expect(sanitizeColumnName("Date")).toBe("sig_Date");
    expect(sanitizeColumnName("UPDATED_AT")).toBe("sig_UPDATED_AT");
  });
});
