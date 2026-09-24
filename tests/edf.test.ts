import { describe, expect, it } from "vitest";
import { parseEdf } from "../src/edf/parse.js";
import { digitalToPhysical } from "../src/edf/types.js";

function pad(text: string, length: number): string {
  if (text.length > length) {
    throw new Error(`"${text}" exceeds field length ${length}`);
  }
  return text.padEnd(length, " ");
}

/** Builds a minimal, spec-compliant EDF buffer: 2 numeric signals, 2 data records. */
function buildSyntheticEdf(): Buffer {
  const ns = 2;
  const headerBytes = 256 + ns * 256;

  const main = Buffer.concat([
    Buffer.from(pad("0", 8), "latin1"),
    Buffer.from(pad("TEST_PATIENT", 80), "latin1"),
    Buffer.from(pad("Startdate 15-JUN-2024 test", 80), "latin1"),
    Buffer.from(pad("15.06.24", 8), "latin1"),
    Buffer.from(pad("08.30.00", 8), "latin1"),
    Buffer.from(pad(String(headerBytes), 8), "latin1"),
    Buffer.from(pad("EDF+C", 44), "latin1"),
    Buffer.from(pad("2", 8), "latin1"),
    Buffer.from(pad("1", 8), "latin1"),
    Buffer.from(pad(String(ns), 4), "latin1")
  ]);

  const labels = [pad("SigA", 16), pad("SigB", 16)].join("");
  const transducers = [pad("", 80), pad("", 80)].join("");
  const dims = [pad("unit", 8), pad("unit", 8)].join("");
  const physMins = [pad("0", 8), pad("-50", 8)].join("");
  const physMaxs = [pad("100", 8), pad("50", 8)].join("");
  const digMins = [pad("0", 8), pad("-500", 8)].join("");
  const digMaxs = [pad("1000", 8), pad("500", 8)].join("");
  const prefilter = [pad("", 80), pad("", 80)].join("");
  const samplesPerRecord = [pad("1", 8), pad("2", 8)].join("");
  const reserved = [pad("", 32), pad("", 32)].join("");

  const signalHeaders = Buffer.from(
    labels + transducers + dims + physMins + physMaxs + digMins + digMaxs + prefilter + samplesPerRecord + reserved,
    "latin1"
  );

  // Record 0: SigA=[500] (digital), SigB=[100, -100]; Record 1: SigA=[1000], SigB=[500, -500]
  const record0 = Buffer.alloc(2 * 2 + 2); // SigA:1 sample, SigB:2 samples => 3 int16 = 6 bytes
  record0.writeInt16LE(500, 0);
  record0.writeInt16LE(100, 2);
  record0.writeInt16LE(-100, 4);
  const record1 = Buffer.alloc(6);
  record1.writeInt16LE(1000, 0);
  record1.writeInt16LE(500, 2);
  record1.writeInt16LE(-500, 4);

  return Buffer.concat([main, signalHeaders, record0, record1]);
}

describe("parseEdf", () => {
  const buf = buildSyntheticEdf();
  const parsed = parseEdf(buf);

  it("parses the main header", () => {
    expect(parsed.header.numSignals).toBe(2);
    expect(parsed.header.numDataRecords).toBe(2);
    expect(parsed.header.durationOfDataRecordSeconds).toBe(1);
    expect(parsed.header.startTimestampIso).toBe("2024-06-15T08:30:00");
  });

  it("parses signal headers in column-major order", () => {
    expect(parsed.signals[0].header.label).toBe("SigA");
    expect(parsed.signals[0].header.samplesPerRecord).toBe(1);
    expect(parsed.signals[1].header.label).toBe("SigB");
    expect(parsed.signals[1].header.samplesPerRecord).toBe(2);
  });

  it("reads digital samples for every record", () => {
    expect(parsed.signals[0].numericRecords).toEqual([
      { recordIndex: 0, digitalSamples: [500] },
      { recordIndex: 1, digitalSamples: [1000] }
    ]);
    expect(parsed.signals[1].numericRecords).toEqual([
      { recordIndex: 0, digitalSamples: [100, -100] },
      { recordIndex: 1, digitalSamples: [500, -500] }
    ]);
  });

  it("scales digital to physical correctly", () => {
    // SigA: digital 0..1000 -> physical 0..100, so 500 -> 50.
    expect(digitalToPhysical(parsed.signals[0].header, 500)).toBeCloseTo(50);
    // SigB: digital -500..500 -> physical -50..50, so 100 -> 10.
    expect(digitalToPhysical(parsed.signals[1].header, 100)).toBeCloseTo(10);
  });

  it("rejects a file with a truncated data record", () => {
    expect(() => parseEdf(buf.subarray(0, -1))).toThrow(/truncated/);
  });
});
