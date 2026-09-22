import { type FlashAirEntry } from "./types.js";

/**
 * Decode FAT-packed date/time fields, as returned by FlashAir's
 * WLANSD_FILELIST listing, into an ISO 8601 string. Returns null for the
 * documented "unknown" sentinel (0/0).
 *
 * DATE: bits 15-9 year-1980, bits 8-5 month, bits 4-0 day.
 * TIME: bits 15-11 hour, bits 10-5 minute, bits 4-0 (seconds / 2).
 */
export function decodeFatDateTime(date: number, time: number): string | null {
  if (!Number.isInteger(date) || !Number.isInteger(time) || date === 0) {
    return null;
  }
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >> 11) & 0x1f;
  const minute = (time >> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function parseFileListLine(line: string, requestedDir: string): FlashAirEntry | null {
  const parts = line.split(",");
  if (parts.length < 6) {
    return null;
  }
  const [dir, name, sizeStr, attrStr, dateStr, timeStr] = parts;
  const size = Number(sizeStr);
  const attribute = Number(attrStr);
  if (!name || !Number.isFinite(size) || !Number.isFinite(attribute)) {
    return null;
  }
  const effectiveDir = dir || requestedDir;
  const path = `${effectiveDir.replace(/\/+$/, "")}/${name}`;
  return {
    dir: effectiveDir,
    name,
    size,
    attribute,
    modifiedAt: decodeFatDateTime(Number(dateStr), Number(timeStr)),
    path
  };
}

export interface FlashAirClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class FlashAirError extends Error {}

export class FlashAirClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: FlashAirClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn || fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request(pathAndQuery: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.baseUrl}${pathAndQuery}`, {
        signal: controller.signal
      });
      if (!response.ok) {
        throw new FlashAirError(`FlashAir returned HTTP ${response.status} for ${pathAndQuery}`);
      }
      return response;
    } catch (err) {
      if (err instanceof FlashAirError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new FlashAirError(`FlashAir request failed for ${pathAndQuery}: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** List a directory via command.cgi?op=100. `dir` must start with "/". */
  async listDirectory(dir: string): Promise<FlashAirEntry[]> {
    const normalizedDir = dir.startsWith("/") ? dir : `/${dir}`;
    const response = await this.request(`/command.cgi?op=100&DIR=${encodeURIComponent(normalizedDir)}`);
    const text = await response.text();
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines[0] !== "WLANSD_FILELIST") {
      throw new FlashAirError(`Unexpected listing response for ${normalizedDir}: ${lines[0] || "(empty)"}`);
    }
    const entries: FlashAirEntry[] = [];
    for (const line of lines.slice(1)) {
      const entry = parseFileListLine(line, normalizedDir);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }

  /** Download a file's full contents by its absolute card path. */
  async getFile(filePath: string): Promise<Buffer> {
    const normalized = filePath.startsWith("/") ? filePath : `/${filePath}`;
    const response = await this.request(normalized);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

}
