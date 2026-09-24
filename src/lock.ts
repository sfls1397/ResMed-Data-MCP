import fs from "node:fs";
import path from "node:path";

export interface LockData {
  pid: number;
  timestamp: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLockData(text: string): LockData | null {
  const [pidStr, timestampStr] = text.split(":");
  const pid = parseInt(pidStr, 10);
  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return { pid, timestamp: Number.isInteger(timestamp) ? timestamp : 0 };
}

function formatLockData(pid: number, timestamp: number): string {
  return `${pid}:${timestamp}`;
}

export interface SyncLock {
  acquire(): boolean;
  release(): void;
}

/**
 * Exclusive indexer.lock so an overlapping sync cycle (a slow FlashAir
 * download running past the next poll tick) never runs concurrently with
 * itself. Dead-PID takeover only; a live holder is never displaced.
 */
export function createSyncLock(options: {
  lockFile: string;
  pid?: number;
  log?: (msg: string) => void;
}): SyncLock {
  const lockFile = options.lockFile;
  const pid = options.pid ?? process.pid;
  const log = options.log || ((msg: string) => console.error(msg));
  let held = false;

  function acquire(): boolean {
    if (held) {
      log("Sync already in progress in this process. Skipping this cycle.");
      return false;
    }
    try {
      const lockDir = path.dirname(lockFile);
      fs.mkdirSync(lockDir, { recursive: true });

      if (fs.existsSync(lockFile)) {
        const existing = fs.readFileSync(lockFile, "utf8");
        const parsed = parseLockData(existing);
        if (parsed && parsed.pid !== pid && isProcessAlive(parsed.pid)) {
          log(`Sync already in progress (PID ${parsed.pid}). Skipping this cycle.`);
          return false;
        }
        if (parsed) {
          log(`Removing stale lock file (PID ${parsed.pid} not running)`);
        }
        fs.rmSync(lockFile, { force: true });
      }

      fs.writeFileSync(lockFile, formatLockData(pid, Date.now()), { flag: "wx" });
      held = true;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        log("Another process acquired the lock during the race. Skipping this cycle.");
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`Lock file error: ${message}`);
      return false;
    }
  }

  function release(): void {
    if (!held) {
      return;
    }
    try {
      if (!fs.existsSync(lockFile)) {
        return;
      }
      const parsed = parseLockData(fs.readFileSync(lockFile, "utf8"));
      if (parsed && parsed.pid === pid) {
        fs.rmSync(lockFile, { force: true });
      }
      held = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Error releasing lock: ${message}`);
    }
  }

  return { acquire, release };
}
