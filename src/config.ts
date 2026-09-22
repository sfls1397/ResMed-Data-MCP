import fs from "node:fs";
import { getConfigPath, getDbPath } from "./paths.js";

/** Product default. Matches "every 5 minutes" as discussed with the user. */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Documented floor: 30 seconds. Below this the FlashAir just can't keep up. */
export const MIN_POLL_INTERVAL_MS = 30 * 1000;

/** Documented ceiling: 1 hour. This is nightly data; there's no case for longer. */
export const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000;

export const DEFAULT_FLASHAIR_BASE_URL = "http://192.168.68.50";
export const DEFAULT_SERVER_HOST = "0.0.0.0";
export const DEFAULT_SERVER_PORT = 8420;

const KNOWN_CONFIG_KEYS = new Set([
  "pollInterval",
  "pollIntervalMs",
  "flashAirBaseUrl",
  "dbPath",
  "serverHost",
  "serverPort"
]);
const MAX_DURATION_STRING_LENGTH = 32;

function defaultWarn(message: string): void {
  console.error(message);
}

export function parseDuration(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DURATION_STRING_LENGTH) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isSafeInteger(n) ? n : null;
  }
  const match = /^(\d+)(ms|s|m|h)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60 * 1000 : 60 * 60 * 1000;
  const result = n * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

export function formatIntervalMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return String(ms);
  }
  const rounded = Math.round(ms);
  if (rounded % (60 * 60 * 1000) === 0) {
    return `${rounded / (60 * 60 * 1000)}h`;
  }
  if (rounded % (60 * 1000) === 0) {
    return `${rounded / (60 * 1000)}m`;
  }
  if (rounded % 1000 === 0) {
    return `${rounded / 1000}s`;
  }
  return `${rounded}ms`;
}

export interface ClampResult {
  ms: number;
  human: string;
  clamped: boolean;
  invalid: boolean;
  requestedMs: number | null;
}

export function clampPollInterval(
  raw: unknown,
  bounds: { defaultMs?: number; minMs?: number; maxMs?: number } = {}
): ClampResult {
  const defaultMs = bounds.defaultMs ?? DEFAULT_POLL_INTERVAL_MS;
  const minMs = bounds.minMs ?? MIN_POLL_INTERVAL_MS;
  const maxMs = bounds.maxMs ?? MAX_POLL_INTERVAL_MS;
  const requestedMs = parseDuration(raw);

  if (requestedMs === null) {
    return { ms: defaultMs, human: formatIntervalMs(defaultMs), clamped: false, invalid: true, requestedMs: null };
  }

  const clampedMs = Math.min(maxMs, Math.max(minMs, requestedMs));
  return {
    ms: clampedMs,
    human: formatIntervalMs(clampedMs),
    clamped: clampedMs !== requestedMs,
    invalid: false,
    requestedMs
  };
}

export interface LoadedConfigFile {
  data: Record<string, unknown>;
  missing: boolean;
  invalid: boolean;
  path: string;
}

export function loadConfigFile(
  options: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    readFile?: (p: string) => string;
    exists?: (p: string) => boolean;
    warn?: (msg: string) => void;
  } = {}
): LoadedConfigFile {
  const warn = options.warn || defaultWarn;
  const configPath = options.configPath || getConfigPath({ env: options.env });
  const exists = options.exists || ((p) => fs.existsSync(p));
  const readFile = options.readFile || ((p) => fs.readFileSync(p, "utf8"));

  if (!exists(configPath)) {
    return { data: {}, missing: true, invalid: false, path: configPath };
  }

  try {
    const raw = readFile(configPath);
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn("Invalid config.json: expected a JSON object. Using defaults.");
      return { data: {}, missing: false, invalid: true, path: configPath };
    }
    const data = parsed as Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        warn(`Ignoring unknown config key: ${key}`);
      }
    }
    return { data, missing: false, invalid: false, path: configPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "parse error";
    warn(`Invalid config.json (${message}). Using defaults.`);
    return { data: {}, missing: false, invalid: true, path: configPath };
  }
}

export interface ResolvedConfig {
  pollIntervalMs: number;
  pollIntervalHuman: string;
  flashAirBaseUrl: string;
  dbPath: string;
  serverHost: string;
  serverPort: number;
}

/**
 * Precedence (highest wins): env var > config.json > product default.
 * pollInterval is clamped to [30s, 1h].
 */
export function resolveConfig(
  options: { env?: NodeJS.ProcessEnv; warn?: (msg: string) => void } = {}
): ResolvedConfig {
  const env = options.env || process.env;
  const warn = options.warn || defaultWarn;
  const file = loadConfigFile({ env, warn });
  const data = file.data;

  const envInterval = env.RESMED_DATA_POLL_INTERVAL;
  const rawInterval =
    envInterval !== undefined && envInterval !== ""
      ? envInterval
      : (data.pollInterval ?? data.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const clamped = clampPollInterval(rawInterval);
  if (clamped.invalid) {
    warn(`Invalid pollInterval ${JSON.stringify(rawInterval)}; using default ${clamped.human}`);
  } else if (clamped.clamped) {
    warn(`pollInterval ${JSON.stringify(rawInterval)} clamped to ${clamped.human}`);
  }

  const flashAirBaseUrl = (
    env.RESMED_DATA_FLASHAIR_URL ||
    (typeof data.flashAirBaseUrl === "string" ? data.flashAirBaseUrl : undefined) ||
    DEFAULT_FLASHAIR_BASE_URL
  ).replace(/\/+$/, "");

  const dbPath =
    env.RESMED_DATA_DB_PATH ||
    (typeof data.dbPath === "string" ? data.dbPath : undefined) ||
    getDbPath({ env });

  const serverHost =
    env.RESMED_DATA_SERVER_HOST ||
    (typeof data.serverHost === "string" ? data.serverHost : undefined) ||
    DEFAULT_SERVER_HOST;

  const rawPort = env.RESMED_DATA_SERVER_PORT || data.serverPort;
  const parsedPort = typeof rawPort === "number" ? rawPort : Number(rawPort);
  const serverPort = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_SERVER_PORT;

  return {
    pollIntervalMs: clamped.ms,
    pollIntervalHuman: clamped.human,
    flashAirBaseUrl,
    dbPath,
    serverHost,
    serverPort
  };
}

export function ensureAppDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
