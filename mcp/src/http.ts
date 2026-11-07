#!/usr/bin/env node
/** Streamable HTTP and legacy SSE entrypoint. MCP_PORT takes precedence over PORT. */
import express from "express";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, SERVER_VERSION } from "./server.js";

export function createHttpApp(apiKey = process.env.MCP_API_KEY) {
  const app = express();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sseTransports = new Map<string, SSEServerTransport>();
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    next();
  });
  // Browser preflights carry no bearer token.
  app.options("*", (_req, res) => { res.sendStatus(204); });
  app.use((req, res, next) => {
    if (!apiKey || req.path === "/health") return next();
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({
    status: "ok", server: "solana-clawd", version: SERVER_VERSION,
    auth: apiKey ? "enabled" : "open",
    docs: "https://github.com/x402agent/solana-clawd",
  }));

  app.post("/mcp", async (req, res, next) => {
    try {
      const sid = req.get("mcp-session-id");
      let transport = sid ? transports.get(sid) : undefined;
      if (sid && !transport) {
        res.status(404).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
        return;
      }
      if (!transport) {
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Initialize a session first" } });
          return;
        }
        const server = await createServer();
        const fresh = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => { transports.set(sessionId, fresh); },
        });
        await server.connect(fresh);
        fresh.onclose = () => { if (fresh.sessionId) transports.delete(fresh.sessionId); };
        transport = fresh;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) { next(error); }
  });

  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", async (req, res, next) => {
      try {
        const sid = req.get("mcp-session-id");
        const transport = sid ? transports.get(sid) : undefined;
        if (!transport) { res.status(sid ? 404 : 400).json({ error: "Invalid session" }); return; }
        await transport.handleRequest(req, res);
      } catch (error) { next(error); }
    });
  }

  app.get("/sse", async (_req, res, next) => {
    try {
      const server = await createServer();
      const transport = new SSEServerTransport("/messages", res);
      sseTransports.set(transport.sessionId, transport);
      transport.onclose = () => { sseTransports.delete(transport.sessionId); };
      await server.connect(transport);
    } catch (error) { next(error); }
  });
  app.post("/messages", async (req, res, next) => {
    try {
      const transport = sseTransports.get(String(req.query.sessionId));
      if (!transport) { res.status(400).json({ error: "Unknown session" }); return; }
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) { next(error); }
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  });

  return { app, close: async () => {
    await Promise.all([...transports.values(), ...sseTransports.values()].map((transport) => transport.close()));
    transports.clear();
    sseTransports.clear();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MCP_PORT || process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_PORT must be a port between 1 and 65535");
  const { app, close } = createHttpApp();
  const listener = app.listen(port, process.env.MCP_HOST || "0.0.0.0", () => console.log(`solana-clawd MCP listening on :${port} (/mcp, /sse, /health)`));
  listener.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  const shutdown = async () => { await close(); listener.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
