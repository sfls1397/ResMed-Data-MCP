export interface FlashAirEntry {
  dir: string;
  name: string;
  size: number;
  attribute: number;
  modifiedAt: string | null;
  path: string;
}

export function isDirectory(entry: FlashAirEntry): boolean {
  return (entry.attribute & 0x10) !== 0;
}
