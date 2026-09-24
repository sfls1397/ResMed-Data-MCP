import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncLock } from "../src/lock.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSyncLock", () => {
  it("does not let a second timer tick acquire a lock it already holds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resmed-lock-test-"));
    tempDirs.push(dir);
    const lock = createSyncLock({ lockFile: path.join(dir, "indexer.lock"), log: () => {} });

    expect(lock.acquire()).toBe(true);
    expect(lock.acquire()).toBe(false);
    lock.release();
    expect(lock.acquire()).toBe(true);
    lock.release();
  });
});
