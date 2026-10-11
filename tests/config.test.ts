import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { clampPollInterval, formatIntervalMs, parseDuration, resolveConfig, DEFAULT_FLASHAIR_BASE_URL } from "../src/config.js";

describe("parseDuration", () => {
  it("parses bare numbers as milliseconds", () => {
    expect(parseDuration("5000")).toBe(5000);
    expect(parseDuration(5000)).toBe(5000);
  });

  it("parses human duration strings", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(5 * 60_000);
    expect(parseDuration("1h")).toBe(60 * 60_000);
  });

  it("rejects garbage", () => {
    expect(parseDuration("banana")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe("clampPollInterval", () => {
  it("uses the default for invalid input", () => {
    const result = clampPollInterval("nonsense");
    expect(result.invalid).toBe(true);
    expect(result.ms).toBe(5 * 60_000);
  });

  it("clamps below the floor", () => {
    const result = clampPollInterval("1s");
    expect(result.clamped).toBe(true);
    expect(result.ms).toBe(30_000);
  });

  it("clamps above the ceiling", () => {
    const result = clampPollInterval("2h");
    expect(result.clamped).toBe(true);
    expect(result.ms).toBe(60 * 60_000);
  });

  it("passes through a valid value unclamped", () => {
    const result = clampPollInterval("5m");
    expect(result.clamped).toBe(false);
    expect(result.invalid).toBe(false);
    expect(result.ms).toBe(5 * 60_000);
  });
});

describe("formatIntervalMs", () => {
  it("prefers the largest whole unit", () => {
    expect(formatIntervalMs(60 * 60_000)).toBe("1h");
    expect(formatIntervalMs(5 * 60_000)).toBe("5m");
    expect(formatIntervalMs(30_000)).toBe("30s");
    expect(formatIntervalMs(1500)).toBe("1500ms");
  });
});


describe("local FlashAir configuration", () => {
  it("uses a generic default and preserves a configured card across package upgrades", () => {
    const file = vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ flashAirBaseUrl: "http://192.0.2.25/" }));
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    try {
      expect(DEFAULT_FLASHAIR_BASE_URL).toBe("http://flashair.local");
      expect(resolveConfig({ env: { RESMED_DATA_HOME: "/tmp/resmed-config-fixture" } }).flashAirBaseUrl).toBe("http://192.0.2.25");
      expect(resolveConfig({ env: { RESMED_DATA_HOME: "/tmp/resmed-config-fixture", RESMED_DATA_FLASHAIR_URL: "http://192.0.2.30/" } }).flashAirBaseUrl).toBe("http://192.0.2.30");
    } finally {
      file.mockRestore();
      exists.mockRestore();
    }
  });
});
