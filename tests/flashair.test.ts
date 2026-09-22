import { describe, expect, it } from "vitest";
import { decodeFatDateTime } from "../src/flashair/client.js";

describe("decodeFatDateTime", () => {
  it("decodes real values observed from a FlashAir listing", () => {
    // Captured from a live device: DATE=23862, TIME=26720.
    expect(decodeFatDateTime(23862, 26720)).toBe("2026-09-22T13:03:00");
  });

  it("returns null for the unknown sentinel", () => {
    expect(decodeFatDateTime(0, 0)).toBeNull();
  });

  it("returns null for an out-of-range month", () => {
    // month bits = 0 is invalid per the FAT spec.
    expect(decodeFatDateTime(0b0000000_0000_00001, 0)).toBeNull();
  });
});
