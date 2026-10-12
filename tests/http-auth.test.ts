import { it, expect } from 'vitest';
import { startHttpServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/open.js';
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
