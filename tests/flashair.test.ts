import { describe, expect, it } from "vitest";
import { decodeFatDateTime, FlashAirClient, FlashAirError } from "../src/flashair/client.js";

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

  it("keeps the timeout active while downloading the response body", async () => {
    const client = new FlashAirClient({
      baseUrl: "http://flashair.test",
      timeoutMs: 5,
      fetchFn: async (_url, init) => ({
        ok: true,
        arrayBuffer: () => new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("body download aborted")));
        })
      } as Response)
    });

    await expect(client.getFile("/STR.edf")).rejects.toBeInstanceOf(FlashAirError);
  });
});
