import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS, callTool } from "./tools.js";
import { packageVersion } from "../version.js";

export function createResmedServer(db: DatabaseSync): Server {
  const server = new Server(
    { name: "resmed-data-mcp", version: packageVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    let text: string;
    try {
      text = callTool(db, request.params.name, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      text = JSON.stringify({ error: `Tool error: ${message}` });
    }
    return { content: [{ type: "text", text }] };
  });

  return server;
}

export interface StartHttpServerOptions {
  db: DatabaseSync;
  host: string;
  port: number;
  log?: (msg: string) => void;
}

/**
 * Read-only MCP over Streamable HTTP, stateless (no session tracking — every
 * request is independent). This is what makes the server reachable
 * uniformly whether a client is on this machine or elsewhere on the LAN:
 * every client just points at http://<host>:<port>/mcp.
 *
 * Per the SDK's own stateless example, a fresh Server + transport pair is
 * created for every POST: a StreamableHTTPServerTransport is single-use in
 * stateless mode (sessionIdGenerator: undefined) — reusing one across
 * requests silently breaks after the first.
 */
export async function startHttpServer(options: StartHttpServerOptions): Promise<http.Server> {
  const log = options.log || ((msg: string) => console.error(msg));

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: packageVersion() }));
      return;
    }

    if (url.pathname === "/mcp" || url.pathname === "/") {
      void (async () => {
        const mcpServer = createResmedServer(options.db);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
          res.on("close", () => {
            void transport.close();
            void mcpServer.close();
          });
        } catch (err) {
          log(`MCP request error: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "internal error" }));
          }
        }
      })();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, options.host, resolve);
  });
  log(`ResMed Data MCP (v${packageVersion()}) listening on http://${options.host}:${options.port}/mcp`);
  return httpServer;
}

export { packageVersion };
