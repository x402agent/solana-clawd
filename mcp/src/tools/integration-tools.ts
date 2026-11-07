import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDef, ToolHandler } from "../orchestrator.js";

interface PackageStatus {
  name: string;
  path: string;
  exists: boolean;
  packageName?: string;
  version?: string;
  scripts?: Record<string, string>;
  hasDist?: boolean;
  hasNodeModules?: boolean;
  hasCargoToml?: boolean;
  hasAnchorToml?: boolean;
  hasCargoTarget?: boolean;
}

const PACKAGE_PATHS = [
  "agent-kit",
  "agent-kit/packages/agent-kit",
  "agent-kit/packages/agent-registry",
  "gateway",
  "sdk",
  "x402",
  "leviathan",
  "deep-clawd",
  "agents",
  "formal_verification",
  "packages/agentwallet",
  "packages/clawd",
  "packages/clawd-perps",
  "packages/clawd-protocol",
  "packages/clawd-sdk",
  "packages/clawd-wallet",
  "packages/cli-standalone",
  "Perps/clawd-agents-perps",
];

async function readJson<T = Record<string, unknown>>(abs: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(abs, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json();
}

async function getPackageStatus(repoRoot: string): Promise<PackageStatus[]> {
  return Promise.all(PACKAGE_PATHS.map(async (pkgPath) => {
    const abs = path.join(repoRoot, pkgPath);
    const packageJson = await readJson<{ name?: string; version?: string; scripts?: Record<string, string> }>(
      path.join(abs, "package.json"),
    );
    return {
      name: pkgPath,
      path: abs,
      exists: await exists(abs),
      packageName: packageJson?.name,
      version: packageJson?.version,
      scripts: packageJson?.scripts,
      hasDist: await exists(path.join(abs, "dist")),
      hasNodeModules: await exists(path.join(abs, "node_modules")),
      hasCargoToml: await exists(path.join(abs, "Cargo.toml")),
      hasAnchorToml: await exists(path.join(abs, "Anchor.toml")),
      hasCargoTarget: await exists(path.join(abs, "target")),
    };
  }));
}

async function loadAgentKit(repoRoot: string): Promise<any> {
  const entry = path.join(repoRoot, "agent-kit", "packages", "agent-kit", "dist", "index.js");
  if (!(await exists(entry))) {
    throw new Error("agent-kit dist not found. Run: cd agent-kit && pnpm build");
  }
  return import(pathToFileURL(entry).href);
}

export function createIntegrationTools(repoRoot: string): Array<[ToolDef, ToolHandler]> {
  const gatewayUrl = () => (process.env.GATEWAY_URL ?? process.env.CLAWD_GATEWAY_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

  return [
    [
      {
        name: "integration_status",
        description: "[Integration] Verify MCP visibility into agent-kit, gateway, sdk, x402, agents, Leviathan, Deep Clawd, packages/*, perps, and service packages",
        inputSchema: { type: "object", properties: {} },
        category: "orchestrator",
      },
      async () => {
        const packages = await getPackageStatus(repoRoot);
        const gatewayHealth = await fetchJson(`${gatewayUrl()}/health`, 5_000).catch((err) => ({
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          url: `${gatewayUrl()}/health`,
        }));
        return {
          repoRoot,
          packages,
          gateway: gatewayHealth,
          env: {
            GATEWAY_URL: gatewayUrl(),
            SOLANA_CLAWD_AGENTS_DIR: process.env.SOLANA_CLAWD_AGENTS_DIR ?? path.join(repoRoot, "agents"),
            HELIUS_API_KEY: Boolean(process.env.HELIUS_API_KEY),
            BIRDEYE_API_KEY: Boolean(process.env.BIRDEYE_API_KEY),
            X402_SVM_PRIVATE_KEY: Boolean(process.env.X402_SVM_PRIVATE_KEY),
            FACILITATOR_SECRET_KEY: Boolean(process.env.FACILITATOR_SECRET_KEY),
          },
        };
      },
    ],
    [
      {
        name: "agentkit_list_agents",
        description: "[Agent Kit] List Solana Clawd agents through the local @solana-clawd/agent-kit package",
        inputSchema: { type: "object", properties: {} },
        category: "agents",
      },
      async () => {
        const { SolanaClawdAgentKit } = await loadAgentKit(repoRoot);
        const kit = new SolanaClawdAgentKit({ agentsDir: path.join(repoRoot, "agents") });
        const agents = kit.listAgents();
        return {
          count: agents.length,
          agents: agents.map((agent: any) => ({
            identifier: agent.identifier,
            title: agent.meta?.title,
            category: agent.meta?.category,
            tags: agent.meta?.tags ?? [],
            capabilities: agent.solana?.capabilities ?? [],
          })),
        };
      },
    ],
    [
      {
        name: "agentkit_runtime_profile",
        description: "[Agent Kit] Build a runtime profile for a local agent identifier, including catalog entry, templates, and manifest data",
        inputSchema: {
          type: "object",
          properties: { identifier: { type: "string" } },
          required: ["identifier"],
        },
        category: "agents",
      },
      async (args) => {
        const { SolanaClawdAgentKit } = await loadAgentKit(repoRoot);
        const kit = new SolanaClawdAgentKit({ agentsDir: path.join(repoRoot, "agents") });
        return kit.createRuntimeProfile(String(args.identifier));
      },
    ],
    [
      {
        name: "gateway_health",
        description: "[Gateway] Check the connected Solana Clawd gateway health endpoint",
        inputSchema: { type: "object", properties: {} },
        category: "orchestrator",
      },
      async () => fetchJson(`${gatewayUrl()}/health`, 5_000),
    ],
    [
      {
        name: "gateway_registry",
        description: "[Gateway] Read the public agent registry exposed by the connected gateway",
        inputSchema: { type: "object", properties: {} },
        category: "agents",
      },
      async () => fetchJson(`${gatewayUrl()}/registry`, 10_000),
    ],
    [
      {
        name: "gateway_skill_catalog",
        description: "[Gateway] Read the Skill Hub catalog exposed by the connected gateway",
        inputSchema: { type: "object", properties: {} },
        category: "agents",
      },
      async () => fetchJson(`${gatewayUrl()}/api/skills/catalog`, 10_000),
    ],
  ];
}
