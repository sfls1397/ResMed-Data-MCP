export interface EdfSignalHeader {
  index: number;
  label: string;
  transducerType: string;
  physicalDimension: string;
  physicalMin: number;
  physicalMax: number;
  digitalMin: number;
  digitalMax: number;
  prefiltering: string;
  samplesPerRecord: number;
  isAnnotations: boolean;
}

export interface EdfHeader {
  version: string;
  patientId: string;
  recordingId: string;
  /** Raw "dd.mm.yy" as stored. */
  startDateRaw: string;
  /** Raw "hh.mm.ss" as stored. */
  startTimeRaw: string;
  /** Best-effort normalized start timestamp, ISO 8601, if decodable. */
  startTimestampIso: string | null;
  headerBytes: number;
  /** EDF+ continuity marker from the reserved field, e.g. "EDF+C", or "". */
  reserved: string;
  numDataRecords: number;
  durationOfDataRecordSeconds: number;
  numSignals: number;
}

/** One data record for one numeric signal: raw digital (int16) samples. */
export interface NumericSignalRecord {
  recordIndex: number;
  digitalSamples: number[];
}

/** One data record for an "EDF Annotations" signal: undecoded raw bytes (TAL format). */
export interface AnnotationSignalRecord {
  recordIndex: number;
  rawBytes: Buffer;
}

export interface ParsedEdfSignal {
  header: EdfSignalHeader;
  numericRecords: NumericSignalRecord[] | null;
  annotationRecords: AnnotationSignalRecord[] | null;
}

export interface ParsedEdf {
  header: EdfHeader;
  signals: ParsedEdfSignal[];
}

export interface EdfCalibration {
  physicalMin: number;
  physicalMax: number;
  digitalMin: number;
  digitalMax: number;
}

/** Digital -> physical value using the signal's calibration, per the EDF spec. */
export function digitalToPhysical(header: EdfCalibration, digitalValue: number): number {
  const digitalRange = header.digitalMax - header.digitalMin;
  if (digitalRange === 0) {
    return header.physicalMin;
  }
  const physicalRange = header.physicalMax - header.physicalMin;
  return header.physicalMin + ((digitalValue - header.digitalMin) * physicalRange) / digitalRange;
}
