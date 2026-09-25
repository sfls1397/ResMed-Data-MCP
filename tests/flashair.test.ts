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
      maxAttempts: 1,
      fetchFn: async (_url, init) => ({
        ok: true,
        arrayBuffer: () => new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("body download aborted")));
        })
      } as Response)
    });

    await expect(client.getFile("/STR.edf")).rejects.toBeInstanceOf(FlashAirError);
  });

  it("keeps a slow download alive while bytes are still arriving", async () => {
    const client = new FlashAirClient({
      baseUrl: "http://flashair.test",
      timeoutMs: 40,
      maxAttempts: 1,
      fetchFn: async () => {
        let count = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (count >= 3) {
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
            count += 1;
            controller.enqueue(new Uint8Array([count]));
          }
        });
        return { ok: true, body: stream } as Response;
      }
    });

    await expect(client.getFile("/DATALOG/night_BRP.edf")).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("retries a stalled download before giving up", async () => {
    let calls = 0;
    const client = new FlashAirClient({
      baseUrl: "http://flashair.test",
      timeoutMs: 5,
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchFn: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            arrayBuffer: () => new Promise((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
            })
          } as Response;
        }
        return {
          ok: true,
          arrayBuffer: async () => Uint8Array.from([9]).buffer
        } as Response;
      }
    });

    await expect(client.getFile("/STR.edf")).resolves.toEqual(Buffer.from([9]));
    expect(calls).toBe(2);
  });
});
