import type { EdfHeader, EdfSignalHeader, ParsedEdf, ParsedEdfSignal } from "./types.js";

function readAscii(buf: Buffer, offset: number, length: number): string {
  return buf.toString("latin1", offset, offset + length).trim();
}

function readAsciiArray(buf: Buffer, offset: number, fieldLength: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(readAscii(buf, offset + i * fieldLength, fieldLength));
  }
  return out;
}

function parseNumber(text: string, fallback = 0): number {
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

const STARTDATE_KEYWORD_RE = /Startdate\s+(\d{2})-([A-Za-z]{3})-(\d{4})/;
const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12"
};

function normalizeTimeRaw(timeRaw: string): string | null {
  const tm = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(timeRaw);
  if (!tm) {
    return null;
  }
  const [, hh, mm, ss] = tm;
  return `${hh}:${mm}:${ss}`;
}

/**
 * Best-effort start timestamp. Prefers the EDF+ "Startdate DD-MMM-YYYY"
 * convention embedded in patient/recording id fields (full 4-digit year)
 * over the header's own "dd.mm.yy" field, which needs a 2-digit-year
 * heuristic (per the EDF spec: yy < 85 => 20yy, else 19yy).
 */
function resolveStartTimestamp(
  patientId: string,
  recordingId: string,
  dateRaw: string,
  timeRaw: string
): string | null {
  for (const field of [recordingId, patientId]) {
    const m = STARTDATE_KEYWORD_RE.exec(field);
    if (m) {
      const [, dd, mon, yyyy] = m;
      const mm = MONTHS[mon.toUpperCase()];
      if (mm) {
        const time = normalizeTimeRaw(timeRaw) ?? "00:00:00";
        return `${yyyy}-${mm}-${dd}T${time}`;
      }
    }
  }
  const dm = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(dateRaw);
  if (!dm) {
    return null;
  }
  const [, dd, mm, yy] = dm;
  const year = Number(yy) < 85 ? `20${yy}` : `19${yy}`;
  const time = normalizeTimeRaw(timeRaw) ?? "00:00:00";
  return `${year}-${mm}-${dd}T${time}`;
}

export function parseEdfHeader(buf: Buffer): EdfHeader {
  if (buf.length < 256) {
    throw new Error(`Buffer too small to be an EDF file: ${buf.length} bytes`);
  }
  const patientId = readAscii(buf, 8, 80);
  const recordingId = readAscii(buf, 88, 80);
  const startDateRaw = readAscii(buf, 168, 8);
  const startTimeRaw = readAscii(buf, 176, 8);

  return {
    version: readAscii(buf, 0, 8),
    patientId,
    recordingId,
    startDateRaw,
    startTimeRaw,
    startTimestampIso: resolveStartTimestamp(patientId, recordingId, startDateRaw, startTimeRaw),
    headerBytes: parseNumber(readAscii(buf, 184, 8)),
    reserved: readAscii(buf, 192, 44),
    numDataRecords: parseNumber(readAscii(buf, 236, 8), -1),
    durationOfDataRecordSeconds: parseNumber(readAscii(buf, 244, 8)),
    numSignals: parseNumber(readAscii(buf, 252, 4))
  };
}

/**
 * Parses a standard EDF / EDF+ file: the fixed 256-byte main header, the
 * column-major per-signal header block, then every data record.
 *
 * Numeric signals keep their raw digital (int16) samples — see
 * `digitalToPhysical` in ./types.ts to scale them. A signal labeled
 * "EDF Annotations" (the EDF+ convention) is not scaled; its raw bytes
 * (TAL-encoded) are kept as-is rather than guessed at, since annotation
 * decoding hasn't been validated against a real ResMed DATALOG file yet.
 */
export function parseEdf(buf: Buffer): ParsedEdf {
  const header = parseEdfHeader(buf);
  const ns = header.numSignals;
  if (ns <= 0 || ns > 4096) {
    throw new Error(`Implausible signal count in EDF header: ${ns}`);
  }

  const minimumHeaderBytes = 256 + ns * 256;
  if (!Number.isSafeInteger(header.headerBytes) || header.headerBytes < minimumHeaderBytes || header.headerBytes > buf.length) {
    throw new Error(`Invalid EDF header length: ${header.headerBytes}`);
  }

  let offset = 256;
  const labels = readAsciiArray(buf, offset, 16, ns);
  offset += 16 * ns;
  const transducerTypes = readAsciiArray(buf, offset, 80, ns);
  offset += 80 * ns;
  const physicalDimensions = readAsciiArray(buf, offset, 8, ns);
  offset += 8 * ns;
  const physicalMins = readAsciiArray(buf, offset, 8, ns).map((v) => parseNumber(v));
  offset += 8 * ns;
  const physicalMaxs = readAsciiArray(buf, offset, 8, ns).map((v) => parseNumber(v));
  offset += 8 * ns;
  const digitalMins = readAsciiArray(buf, offset, 8, ns).map((v) => parseNumber(v));
  offset += 8 * ns;
  const digitalMaxs = readAsciiArray(buf, offset, 8, ns).map((v) => parseNumber(v));
  offset += 8 * ns;
  const prefilterings = readAsciiArray(buf, offset, 80, ns);
  offset += 80 * ns;
  const samplesPerRecords = readAsciiArray(buf, offset, 8, ns).map((v) => parseNumber(v));
  offset += 8 * ns;
  offset += 32 * ns; // per-signal reserved block

  const signalHeaders: EdfSignalHeader[] = [];
  for (let i = 0; i < ns; i++) {
    if (!Number.isSafeInteger(samplesPerRecords[i]) || samplesPerRecords[i] <= 0) {
      throw new Error(`Invalid samples-per-record value for signal ${i}: ${samplesPerRecords[i]}`);
    }
    signalHeaders.push({
      index: i,
      label: labels[i],
      transducerType: transducerTypes[i],
      physicalDimension: physicalDimensions[i],
      physicalMin: physicalMins[i],
      physicalMax: physicalMaxs[i],
      digitalMin: digitalMins[i],
      digitalMax: digitalMaxs[i],
      prefiltering: prefilterings[i],
      samplesPerRecord: samplesPerRecords[i],
      isAnnotations: labels[i] === "EDF Annotations"
    });
  }

  offset = header.headerBytes;
  const recordSizeBytes = signalHeaders.reduce((sum, s) => sum + s.samplesPerRecord * 2, 0);
  const bytesAvailable = buf.length - offset;
  if (!Number.isSafeInteger(recordSizeBytes) || recordSizeBytes <= 0 || bytesAvailable % recordSizeBytes !== 0) {
    throw new Error("EDF data records are truncated or have an invalid record size");
  }
  const recordsAvailable = recordSizeBytes > 0 ? Math.floor(bytesAvailable / recordSizeBytes) : 0;
  if (header.numDataRecords >= 0 && recordsAvailable < header.numDataRecords) {
    throw new Error(`EDF data is truncated: header declares ${header.numDataRecords} records but only ${recordsAvailable} are present`);
  }
  const resolvedNumDataRecords =
    header.numDataRecords >= 0 ? Math.min(header.numDataRecords, recordsAvailable) : recordsAvailable;

  const signals: ParsedEdfSignal[] = signalHeaders.map((sh) => ({
    header: sh,
    numericRecords: sh.isAnnotations ? null : [],
    annotationRecords: sh.isAnnotations ? [] : null
  }));

  let cursor = offset;
  for (let r = 0; r < resolvedNumDataRecords; r++) {
    for (let i = 0; i < ns; i++) {
      const sh = signalHeaders[i];
      const byteLen = sh.samplesPerRecord * 2;
      if (sh.isAnnotations) {
        signals[i].annotationRecords!.push({
          recordIndex: r,
          rawBytes: Buffer.from(buf.subarray(cursor, cursor + byteLen))
        });
      } else {
        const samples: number[] = new Array(sh.samplesPerRecord);
        for (let s = 0; s < sh.samplesPerRecord; s++) {
          samples[s] = buf.readInt16LE(cursor + s * 2);
        }
        signals[i].numericRecords!.push({ recordIndex: r, digitalSamples: samples });
      }
      cursor += byteLen;
    }
  }

  return { header: { ...header, numDataRecords: resolvedNumDataRecords }, signals };
}
