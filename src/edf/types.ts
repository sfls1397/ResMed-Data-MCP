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
  startDateRaw: string;
  startTimeRaw: string;
  startTimestampIso: string | null;
  headerBytes: number;
  reserved: string;
  numDataRecords: number;
  durationOfDataRecordSeconds: number;
  numSignals: number;
}

export interface NumericSignalRecord {
  recordIndex: number;
  digitalSamples: number[];
}

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

export function digitalToPhysical(header: EdfCalibration, digitalValue: number): number {
  const digitalRange = header.digitalMax - header.digitalMin;
  if (digitalRange === 0) {
    return header.physicalMin;
  }
  const physicalRange = header.physicalMax - header.physicalMin;
  return header.physicalMin + ((digitalValue - header.digitalMin) * physicalRange) / digitalRange;
}
