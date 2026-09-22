export interface FlashAirEntry {
  /** Directory the listing was requested for, e.g. "/DATALOG". */
  dir: string;
  /** File or subdirectory name, e.g. "STR.edf" or "20260921". */
  name: string;
  /** Size in bytes. 0 for directories. */
  size: number;
  /** Raw FAT attribute byte. Bit 0x10 marks a directory. */
  attribute: number;
  /** Decoded last-modified time from the FAT date/time fields, if decodable. */
  modifiedAt: string | null;
  /** Full path, e.g. "/DATALOG/20260921" or "/STR.edf". */
  path: string;
}

export function isDirectory(entry: FlashAirEntry): boolean {
  return (entry.attribute & 0x10) !== 0;
}
