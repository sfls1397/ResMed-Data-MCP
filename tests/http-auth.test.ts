import { it, expect } from 'vitest';
import { startHttpServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/open.js';
import { ENV_TOKEN_VAR, PREVIOUS_TOKEN_ENV, takePreviousHttpAuthToken } from "../src/mcp/httpAuth.js";
it('requires bearer auth before handling any HTTP route', async () => {
  const db = openDatabase(':memory:');
  const server = await startHttpServer({db, host:'127.0.0.1', port:0, token:'TEST_ONLY_TOKEN', log:()=>{}});
  try {
    const address = server.address() as {port:number};
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(base+'/mcp')).status).toBe(401);
    expect((await fetch(base+'/health', {headers:{Authorization:'Bearer WRONG'}})).status).toBe(401);
    expect((await fetch(base+'/health', {headers:{Authorization:'Bearer TEST_ONLY_TOKEN'}})).status).toBe(200);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); db.close(); }
});

it.each([
  { phase: "overlap", token: "fixture-new", current: "fixture-new", previous: "fixture-old", statuses: [200, 200] },
  { phase: "rollback", token: "fixture-old", current: "fixture-old", previous: undefined, statuses: [200, 401] },
  { phase: "retirement", token: "fixture-new", current: "fixture-new", previous: undefined, statuses: [401, 200] },
  { phase: "Keychain fallback", token: "fixture-old", current: undefined, previous: "fixture-new", statuses: [200, 401] },
  { phase: "wrong primary", token: "fixture-old", current: "fixture-other", previous: "fixture-new", statuses: [200, 401] },
])("enforces the $phase token slots on HTTP requests", async ({ token, current, previous, statuses }) => {
  const env = { [ENV_TOKEN_VAR]: current, [PREVIOUS_TOKEN_ENV]: previous };
  const previousToken = takePreviousHttpAuthToken(token, env);
  expect(Object.hasOwn(env, PREVIOUS_TOKEN_ENV)).toBe(false);
  const db = openDatabase(":memory:");
  const fixture = await startHttpServer({ db, host: "127.0.0.1", port: 0, token, previousToken, log: () => {} });
  try {
    const { port } = fixture.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const health = async (candidate: string) => {
      const response = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${candidate}` } });
      await response.arrayBuffer();
      return response.status;
    };
    expect(await Promise.all([health("fixture-old"), health("fixture-new")])).toEqual(statuses);
    expect(await health("fixture-bad")).toBe(401);
    const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer fixture-bad" } });
    expect(denied.status).toBe(401);
    await denied.arrayBuffer();
  } finally {
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    db.close();
  }
});
