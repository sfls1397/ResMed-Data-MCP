import { it, expect } from 'vitest';
import { loadOrCreateHttpAuthToken, ENV_TOKEN_VAR } from '../src/mcp/httpAuth.js';

// Fake values only. The fake exec stands in for /usr/bin/security.
function fakeExec(keychainValue: string | null) {
  const calls: string[][] = [];
  const exec = ((file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === 'find-generic-password') {
      if (keychainValue === null) throw new Error('not found');
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
