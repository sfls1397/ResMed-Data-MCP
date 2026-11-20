import crypto from "node:crypto";
import { writeKeychainSecret } from "../keychainWrite.js";
import { execFileSync as defaultExecFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "resmed-data-mcp-http";
export const KEYCHAIN_ACCOUNT = "http-auth-token";
export const ENV_TOKEN_VAR = "RESMED_DATA_MCP_TOKEN";

type Exec = typeof defaultExecFileSync;

const SECURITY_ITEM_NOT_FOUND = 44;

export function readKeychainSecret(service: string, account: string, exec: Exec = defaultExecFileSync): string | null {
  let out: string | Buffer;
  try {
    out = exec("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000
    });
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === SECURITY_ITEM_NOT_FOUND) return null;
    throw new Error("Keychain read failed; not generating a new token. Unlock the login Keychain and retry.");
  }
  const token = out.toString("utf8").trim();
  return token.length > 0 ? token : null;
}

export function loadOrCreateHttpAuthToken(
  options: {
    log?: (m: string) => void;
    forceNew?: boolean;
    execFileSync?: Exec;
    randomBytes?: typeof crypto.randomBytes;
    env?: NodeJS.ProcessEnv;
  } = {}
): { token: string; generated: boolean } {
  const log = options.log || ((m: string) => console.error(m));
  const exec = options.execFileSync || defaultExecFileSync;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  if (!options.forceNew) {
    const fromEnv = (options.env || process.env)[ENV_TOKEN_VAR]?.trim();
    if (fromEnv) return { token: fromEnv, generated: false };
    const existing = readKeychainSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, exec);
    if (existing) return { token: existing, generated: false };
  }
  const token = randomBytes(32).toString("hex");
  writeKeychainSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token, exec);
  log("Generated a new ResMed Data MCP HTTP auth token and stored it in the Keychain.");
  log("Print it with: resmed-data-mcp http-token");
  return { token, generated: true };
}

export function loadHttpTokenForCli(
  options: Omit<NonNullable<Parameters<typeof loadOrCreateHttpAuthToken>[0]>, "env"> = {}
): string {
  return loadOrCreateHttpAuthToken({ ...options, env: {} }).token;
}

export function verifyAuthHeader(headerValue: string | string[] | undefined, expectedToken: string): boolean {
  if (typeof headerValue !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
