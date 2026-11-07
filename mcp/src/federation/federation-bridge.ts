/**
 * Federation Bridge — MCP-to-MCP and Agent-to-Agent Communication
 *
 * Innovation: Any MCP server can call tools on other MCP servers through
 * this bridge, creating a federated mesh of capabilities. This is the
 * pattern we learned from the Solana MCP official server's architecture:
 * it had discrete tools (list_sections, get_documentation, search) that
 * could be composed. We take this further — our bridge enables:
 *
 *   1. MCP Server Federation: Call tools on other MCP servers
 *      (e.g. solana-clawd → official Solana MCP → any other MCP server)
 *
 *   2. Agent-to-Agent (A2A): Dispatch tasks to Leviathan spawnlings,
 *      Deep Clawd agents, or any A2A-compatible agent
 *
 *   3. Cross-Process Bridge: Spawn subprocess MCP servers and
 *      federate tools across them (like the Leviathan CLI spawning)
 *
 *   4. Remote MCP: Connect to remote MCP over HTTP+SSE or Streamable HTTP
 *
 * Architecture:
 *   ┌──────────────┐     Federation Bridge     ┌──────────────┐
 *   │  Claude/MCP   │ ──────────────────────→  │  Official     │
 *   │  Client       │ ←──────────────────────  │  Solana MCP   │
 *   └──────────────┘                           └──────────────┘
 *         │                                           │
 *         │           ┌──────────────┐               │
 *         └─────────→ │  Leviathan   │ ←─────────────┘
 *                     │  Agent       │
 *                     └──────────────┘
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ToolDef, ToolHandler } from "../orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FederatedServerConfig {
  /** Unique name for this federated server */
  name: string;
  /** Connection mode */
  type: "stdio" | "http" | "sse" | "a2a";
  /** For stdio: command to spawn */
  command?: string;
  /** For stdio: args */
  args?: string[];
  /** For http/sse: URL base */
  url?: string;
  /** For http: API key if required */
  apiKey?: string;
  /** For a2a: Agent URL */
  agentUrl?: string;
  /** Max payload size for bridge calls */
  maxPayloadBytes?: number;
  /** Labels for discovery */
  tags?: string[];
  /** Health check endpoint */
  healthEndpoint?: string;
}

export interface FederatedToolResult {
  server: string;
  tool: string;
  output: unknown;
  latencyMs: number;
  error?: string;
}

export interface BridgeRoute {
  /** Route name (used as prefix in tool names like federation__solana__list_sections) */
  prefix: string;
  /** The federated server */
  server: FederatedServerConfig;
  /** Filters: only proxy tools matching these patterns */
  allowList?: RegExp[];
  /** Filters: exclude tools matching these patterns */
  denyList?: RegExp[];
}

// ─── Static Federation Targets ──────────────────────────────────────────────────

export const DEFAULT_FEDERATION_TARGETS: BridgeRoute[] = [
  {
    prefix: "solana_org",
    server: {
      name: "Official Solana MCP",
      type: "http",
      url: process.env.SOLANA_MCP_URL ?? "https://solana-mcp-862256168030.us-central1.run.app",
      apiKey: process.env.SOLANA_MCP_API_KEY,
      tags: ["solana", "docs", "expert"],
    },
    allowList: [/list_sections/, /get_documentation/, /Solana_Documentation_Search/, /Solana_Expert__Ask_For_Help/],
  },
];

// ─── Federation Bridge ─────────────────────────────────────────────────────────

export class FederationBridge {
  private routes: BridgeRoute[] = [];
  private cachedToolList: Map<string, Array<{ name: string; description: string }>> = new Map();

  constructor(customRoutes?: BridgeRoute[]) {
    this.routes = customRoutes ?? (process.env.MCP_FEDERATION_ENABLED === "false" ? [] : DEFAULT_FEDERATION_TARGETS);
  }

  // ─── Tool listing for a route ─────────────────────────────────────────────

  async discoverRouteTools(route: BridgeRoute): Promise<Array<{ name: string; description: string }>> {
    const cacheKey = route.prefix;
    const cached = this.cachedToolList.get(cacheKey);
    if (cached) return cached;

    let tools: Array<{ name: string; description: string }> = [];

    try {
      switch (route.server.type) {
        case "http":
          tools = await this._discoverHttp(route);
          break;
        case "stdio":
          tools = await this._discoverStdio(route);
          break;
        case "sse":
          tools = await this._discoverSse(route);
          break;
        case "a2a":
          tools = await this._discoverA2A(route);
          break;
      }
    } catch (err) {
      console.warn(`[federation] Failed to discover ${route.prefix}: ${err}`);
      return [];
    }

    // Apply filters
    if (route.allowList && route.allowList.length > 0) {
      tools = tools.filter((t) => route.allowList!.some((r) => r.test(t.name)));
    }
    if (route.denyList && route.denyList.length > 0) {
      tools = tools.filter((t) => !route.denyList!.some((r) => r.test(t.name)));
    }

    this.cachedToolList.set(cacheKey, tools);
    return tools;
  }

  // ─── Call a tool on a federated server ────────────────────────────────────

  async callTool(
    route: BridgeRoute,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<FederatedToolResult> {
    const start = Date.now();
    try {
      let output: unknown;

      switch (route.server.type) {
        case "http":
          output = await this._callHttp(route, toolName, args, timeoutMs);
          break;
        case "stdio":
          output = await this._callStdio(route, toolName, args, timeoutMs);
          break;
        case "sse":
          output = await this._callSse(route, toolName, args, timeoutMs);
          break;
        case "a2a":
          output = await this._callA2A(route, toolName, args, timeoutMs);
          break;
        default:
          throw new Error(`Unsupported federation type: ${route.server.type}`);
      }

      return {
        server: route.server.name,
        tool: toolName,
        output,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        server: route.server.name,
        tool: toolName,
        output: null,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── Generate federated ToolDefs for all routes ──────────────────────────

  async generateFederatedTools(): Promise<Array<[ToolDef, ToolHandler]>> {
    const tools: Array<[ToolDef, ToolHandler]> = [];

    for (const route of this.routes) {
      const routeTools = await this.discoverRouteTools(route);
      for (const t of routeTools) {
        const federatedName = `federation__${route.prefix}__${t.name}`;

        tools.push([
          {
            name: federatedName,
            description: `[Federated: ${route.server.name}] ${t.description} — proxied through MCP federation bridge`,
            inputSchema: { type: "object", properties: {}, required: [] },
            category: "market",
          },
          // Handler: proxies the call to the federated server
          async (args) => {
            const result = await this.callTool(route, t.name, args);
            if (result.error) throw new Error(`[${route.prefix}] ${result.error}`);
            return result.output;
          },
        ]);
      }
    }

    return tools;
  }

  // ─── Route management ────────────────────────────────────────────────────

  addRoute(route: BridgeRoute): void {
    this.routes.push(route);
  }

  removeRoute(prefix: string): void {
    this.routes = this.routes.filter((r) => r.prefix !== prefix);
    this.cachedToolList.delete(prefix);
  }

  getRoutes(): BridgeRoute[] {
    return [...this.routes];
  }

  // ─── Internal: HTTP Streamable MCP ────────────────────────────────────────

  private async _discoverHttp(route: BridgeRoute): Promise<Array<{ name: string; description: string }>> {
    const url = `${route.server.url}/mcp`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(route.server.apiKey ? { Authorization: `Bearer ${route.server.apiKey}` } : {}),
      },
      body: JSON.stringify({ method: "tools/list", params: {}, id: 1, jsonrpc: "2.0" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { result?: { tools: Array<{ name: string; description: string }> } };
    return data.result?.tools ?? [];
  }

  private async _callHttp(
    route: BridgeRoute,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const url = `${route.server.url}/mcp`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(route.server.apiKey ? { Authorization: `Bearer ${route.server.apiKey}` } : {}),
      },
      body: JSON.stringify({
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: 1,
        jsonrpc: "2.0",
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
    const content = data.result?.content;
    if (!content) return null;
    return content.map((c) => c.text).join("\n");
  }

  // ─── Internal: STDIO MCP ──────────────────────────────────────────────────

  private async _discoverStdio(route: BridgeRoute): Promise<Array<{ name: string; description: string }>> {
    const result = await this._stdioCall(route, { method: "tools/list", params: {} });
    return (result as { result?: { tools: Array<{ name: string; description: string }> } }).result?.tools ?? [];
  }

  private async _callStdio(
    route: BridgeRoute,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const result = await this._stdioCall(
      route,
      { method: "tools/call", params: { name: toolName, arguments: args } },
      timeoutMs,
    );
    return (result as { result?: { content?: Array<{ text: string }> } })?.result?.content
      ?.map((c: { text: string }) => c.text)
      .join("\n");
  }

  private async _stdioCall(
    route: BridgeRoute,
    request: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(route.server.command!, route.server.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
      });

      let stdout = "";
      let stderr = "";

      child.stdout!.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (stderr) console.warn(`[federation:stdio] ${route.prefix} stderr:`, stderr.slice(0, 200));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`STDIO parse error (exit ${code}): ${stdout.slice(0, 200)}`));
        }
      });

      child.on("error", reject);
      child.stdin!.write(JSON.stringify(request) + "\n");
      child.stdin!.end();
    });
  }

  // ─── Internal: SSE MCP ────────────────────────────────────────────────────

  private async _discoverSse(route: BridgeRoute): Promise<Array<{ name: string; description: string }>> {
    throw new Error("SSE federation not yet implemented");
  }

  private async _callSse(
    route: BridgeRoute,
    _toolName: string,
    _args: Record<string, unknown>,
    _timeoutMs: number,
  ): Promise<unknown> {
    throw new Error("SSE federation not yet implemented");
  }

  // ─── Internal: A2A ─────────────────────────────────────────────────────────

  private async _discoverA2A(route: BridgeRoute): Promise<Array<{ name: string; description: string }>> {
    try {
      const res = await fetch(`${route.server.agentUrl}/.well-known/agent.json`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const agent = (await res.json()) as { name?: string; skills?: Array<{ id: string; name: string; description: string }> };
      return (agent.skills ?? []).map((s) => ({
        name: `a2a__${s.id}`,
        description: s.description ?? `A2A skill: ${s.name}`,
      }));
    } catch {
      return [];
    }
  }

  private async _callA2A(
    route: BridgeRoute,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    // Strip a2a__ prefix to get the actual skill ID
    const skillId = toolName.startsWith("a2a__") ? toolName.slice(5) : toolName;
    const res = await fetch(`${route.server.agentUrl}/a2a/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: skillId, message: args.message ?? args.query ?? JSON.stringify(args) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`A2A ${res.status}`);
    return res.json();
  }

  // ─── Health check ─────────────────────────────────────────────────────────

  async healthCheck(route: BridgeRoute): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const endpoint = route.server.healthEndpoint ?? `${route.server.url}/health`;
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
      return { healthy: res.ok, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Check all routes */
  async healthCheckAll(): Promise<Record<string, { healthy: boolean; latencyMs: number; error?: string }>> {
    const results: Record<string, { healthy: boolean; latencyMs: number; error?: string }> = {};
    for (const route of this.routes) {
      results[route.prefix] = await this.healthCheck(route);
    }
    return results;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────────

let _bridgeInstance: FederationBridge | null = null;

export function getFederationBridge(): FederationBridge {
  if (!_bridgeInstance) _bridgeInstance = new FederationBridge();
  return _bridgeInstance;
}
