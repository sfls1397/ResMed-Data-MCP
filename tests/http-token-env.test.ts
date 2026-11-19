import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadHttpTokenForCli, loadOrCreateHttpAuthToken, readKeychainSecret, ENV_TOKEN_VAR } from '../src/mcp/httpAuth.js';

// Fake values only. The fake exec stands in for /usr/bin/security.
function fakeExec(keychainValue: string | null) {
  const calls: string[][] = [];
  const exec = ((file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === 'find-generic-password') {
      if (keychainValue === null) throw Object.assign(new Error('not found'), { status: 44 });
      return Buffer.from(keychainValue + '\n');
    }
    return Buffer.from('');
  }) as any;
  return { exec, calls };
}
const fixedBytes = (() => Buffer.alloc(32, 7)) as any;

it('reads the token from RESMED_DATA_MCP_TOKEN first, without touching the Keychain', () => {
  expect(ENV_TOKEN_VAR).toBe('RESMED_DATA_MCP_TOKEN');
  const { exec, calls } = fakeExec('');
  const r = loadOrCreateHttpAuthToken({ env: { RESMED_DATA_MCP_TOKEN: 'FAKE_ENV_TOKEN' }, execFileSync: exec, randomBytes: fixedBytes, log: () => {} });
  expect(r).toEqual({ token: 'FAKE_ENV_TOKEN', generated: false });
  expect(calls).toEqual([]);
});

it('prefers the variable over a Keychain value', () => {
  const { exec, calls } = fakeExec('FAKE_KEYCHAIN_TOKEN');
  const r = loadOrCreateHttpAuthToken({ env: { RESMED_DATA_MCP_TOKEN: 'FAKE_ENV_TOKEN' }, execFileSync: exec, log: () => {} });
  expect(r.token).toBe('FAKE_ENV_TOKEN');
  expect(calls).toEqual([]);
});

it('falls back to the Keychain when the variable is unset, empty or blank', () => {
  for (const env of [{}, { RESMED_DATA_MCP_TOKEN: '' }, { RESMED_DATA_MCP_TOKEN: '   ' }]) {
    const { exec, calls } = fakeExec('FAKE_KEYCHAIN_TOKEN');
    const r = loadOrCreateHttpAuthToken({ env, execFileSync: exec, log: () => {} });
    expect(r).toEqual({ token: 'FAKE_KEYCHAIN_TOKEN', generated: false });
    expect(calls).toEqual([['/usr/bin/security', 'find-generic-password', '-s', 'resmed-data-mcp-http', '-a', 'http-auth-token', '-w']]);
  }
});

it('still generates and stores a token as today when neither the variable nor the Keychain has one', () => {
  const { exec, calls } = fakeExec(null);
  const r = loadOrCreateHttpAuthToken({ env: {}, execFileSync: exec, randomBytes: fixedBytes, log: () => {} });
  expect(r).toEqual({ token: '07'.repeat(32), generated: true });
  expect(calls.map(c => c[1])).toEqual(['find-generic-password', '-i']);
});

it('http-token ignores RESMED_DATA_MCP_TOKEN in process.env and prints the Keychain token', () => {
  const saved = process.env[ENV_TOKEN_VAR];
  process.env[ENV_TOKEN_VAR] = 'FAKE_ENV_TOKEN';
  try {
    const { exec, calls } = fakeExec('FAKE_KEYCHAIN_TOKEN');
    expect(loadHttpTokenForCli({ execFileSync: exec, log: () => {} })).toBe('FAKE_KEYCHAIN_TOKEN');
    expect(calls.map(c => c[1])).toEqual(['find-generic-password']);
  } finally {
    if (saved === undefined) delete process.env[ENV_TOKEN_VAR]; else process.env[ENV_TOKEN_VAR] = saved;
  }
});

it('http-token still creates the Keychain token when it is missing, even with the variable set', () => {
  const saved = process.env[ENV_TOKEN_VAR];
  process.env[ENV_TOKEN_VAR] = 'FAKE_ENV_TOKEN';
  try {
    const { exec, calls } = fakeExec(null);
    expect(loadHttpTokenForCli({ execFileSync: exec, randomBytes: fixedBytes, log: () => {} })).toBe('07'.repeat(32));
    expect(calls.map(c => c[1])).toEqual(['find-generic-password', '-i']);
  } finally {
    if (saved === undefined) delete process.env[ENV_TOKEN_VAR]; else process.env[ENV_TOKEN_VAR] = saved;
  }
});

it('the http-token command uses the Keychain-only loader', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const branch = cli.slice(cli.indexOf('command === "http-token"'), cli.indexOf('return;', cli.indexOf('command === "http-token"')));
  expect(branch).toContain('loadHttpTokenForCli()');
  expect(branch).not.toContain('loadOrCreateHttpAuthToken(');
});

// A fake exec whose Keychain read fails the way a locked keychain or denied access does (not exit 44).
function failingReadExec(status: number | undefined) {
  const calls: string[][] = [];
  const exec = ((file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === 'find-generic-password') throw Object.assign(new Error('security failed'), status === undefined ? {} : { status });
    return Buffer.from('');
  }) as any;
  return { exec, calls };
}

it('readKeychainSecret returns null only for exit 44 and throws on any other read error', () => {
  expect(readKeychainSecret('s', 'a', failingReadExec(44).exec)).toBeNull();
  for (const status of [36, 51, 1, undefined]) {
    expect(() => readKeychainSecret('s', 'a', failingReadExec(status).exec)).toThrow(/Keychain read failed/);
  }
});

it('a Keychain read error never generates or overwrites a token (server start and http-token)', () => {
  for (const load of [
    (exec: any) => loadOrCreateHttpAuthToken({ env: {}, execFileSync: exec, randomBytes: fixedBytes, log: () => {} }),
    (exec: any) => loadHttpTokenForCli({ execFileSync: exec, randomBytes: fixedBytes, log: () => {} })
  ]) {
    const { exec, calls } = failingReadExec(36);
    expect(() => load(exec)).toThrow(/Keychain read failed/);
    expect(calls.map(c => c[1])).toEqual(['find-generic-password']);
  }
});

it('the read error message carries no credential values', () => {
  const { exec } = failingReadExec(36);
  try { readKeychainSecret('s', 'a', exec); } catch (e) { expect(String((e as Error).message)).not.toMatch(/FAKE|-w/); }
});

it('the Keychain read has a timeout, so a locked keychain waiting on a prompt fails instead of hanging', () => {
  let opts: any;
  const exec = ((_f: string, _a: string[], o: any) => { opts = o; throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }) as any;
  expect(() => readKeychainSecret('s', 'a', exec)).toThrow(/Keychain read failed/);
  expect(opts.timeout).toBe(15000);
});
