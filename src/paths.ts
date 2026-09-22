import os from "node:os";
import path from "node:path";

export const APP_DIR_NAME = ".resmed-data-mcp";
export const CONFIG_FILE_NAME = "config.json";
export const DB_FILE_NAME = "data.sqlite";
export const LOCK_FILE_NAME = "indexer.lock";

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

/**
 * Directory that holds config.json, data.sqlite, and indexer.lock.
 * Always under the user home directory in production. config.json cannot
 * override this path (treated as data, not instructions).
 *
 * `RESMED_DATA_HOME` is a test/dev override only.
 */
export function getAppDir(options: PathOptions = {}): string {
  const env = options.env || process.env;
  if (env.RESMED_DATA_HOME && env.RESMED_DATA_HOME.trim()) {
    return path.resolve(env.RESMED_DATA_HOME);
  }
  const homedir = options.homedir || (() => os.homedir());
  const home = env.HOME || homedir();
  return path.join(home, APP_DIR_NAME);
}

export function getConfigPath(options: PathOptions = {}): string {
  return path.join(getAppDir(options), CONFIG_FILE_NAME);
}

export function getDbPath(options: PathOptions = {}): string {
  return path.join(getAppDir(options), DB_FILE_NAME);
}

export function getLockFilePath(options: PathOptions = {}): string {
  return path.join(getAppDir(options), LOCK_FILE_NAME);
}
