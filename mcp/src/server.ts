/**
 * solana-clawd MCP Server v3 — Orchestrated Command & Control
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                    MCP Server (server.ts)               │
 *   │  ┌──────────┐  ┌────────────┐  ┌──────────────┐      │
 *   │  │Plugin    │  │Federation  │  │Agent Task    │      │
 *   │  │Registry  │  │Bridge      │  │Router        │      │
 *   │  └────┬─────┘  └─────┬──────┘  └──────┬───────┘      │
 *   │       │              │                │              │
 *   │       ▼              ▼                ▼              │
 *   │  ┌──────────────────────────────────────────┐        │
 *   │  │           Orchestrator + SessionMeter    │        │
 *   │  │  + optional PTokenStreamFacilitator      │        │
 *   │  └──────────────────────────────────────────┘        │
 *   │       │              │                │              │
 *   │       ▼              ▼                ▼              │
 *   │  Core Tools   Levia-than    Market      x402        │
 *   │  (inline)    (plugin)     (inline)    (plugin)      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * This replaces the old monolithic server.ts (642 lines, 50+ tools
 * all registered in one function). Now:
 *   - Core tools stay inline (Solana, Helius, Pump, Chess, Memory)
 *   - Plugin tools load dynamically from PluginRegistry
 *   - Federation tools proxy to external MCP servers
 *   - Docs tools serve framework documentation
 *   - Task Router dispatches to agent subsystems
 *
 * Tool categories:
 *   solana      (11) — Public Solana market data, free
 *   helius      (8)  — Helius RPC/DAS/Webhooks
 *   x402        (9)  — Payment protocol + p-token metered billing
 *   leviathan   (9)  — OODA loop + autonomous agent control
 *   market      (5)  — Composite intelligence, premium
 *   pump        (8)  — Pump.fun bonding curve
 *   memory      (4)  — Persistent agent memory + autoDream
 *   agents      (6)  — Agent fleet + skill management
 *   chess       (7)  — Chess.com (autonomous agent chess)
 *   federation  (N)  — Federated MCP tools from external servers
 *   docs        (3)  — Documentation system (list/get/search)
 *   orchestrator (4) — Orchestrator management tools
 *   deep-clawd  (N)  — DeepSeek trading agent tools
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  Orchestrator,
  SessionMeter,
  getStreamFacilitator,
  type StreamFacilitatorHandle,
  type ToolDef,
  type ToolHandler,
} from "./orchestrator.js";
import {
  solanaTracker, coingeckoPrice, jupiterPrice, heliusRPC, heliusREST,
  HELIUS_KEY,
} from "./api.js";
import { X402_TOOLS, withMeter, enhanceX402WithFacilitator } from "./tools/x402-tools.js";
import { LEVIATHAN_TOOLS } from "./tools/leviathan-tools.js";
import { MARKET_TOOLS } from "./tools/market-tools.js";
import { DEEP_CLAWD_TOOLS } from "./tools/deep-clawd-tools.js";
import { createIntegrationTools } from "./tools/integration-tools.js";
import { getPluginRegistry, type PluginRegistry } from "./plugins/plugin-registry.js";
import { getFederationBridge, type FederationBridge } from "./federation/federation-bridge.js";
import { getAgentTaskRouter, type AgentTaskRouter } from "./federation/agent-task-router.js";
import { getDocsSystem, type DocsSystem } from "./docs/docs-system.js";

export const SERVER_VERSION = "3.0.0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CHESS_API = "https://api.chess.com/pub";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readFileText(abs: string): Promise<string | null> {
  try { return await fs.readFile(abs, "utf-8"); } catch { return null; }
}
function safePath(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  return resolved.startsWith(root) ? resolved : null;
}

// ─── In-memory stores (shared across tool handlers via closure) ───────────────

const _memory: Array<{ tier: string; content: string; timestamp: string }> = [];
const _tasks: Array<{ id: string; type: string; description: string; status: string; createdAt: string }> = [];
let _taskCounter = 0;

// ─── Register all tools ───────────────────────────────────────────────────────

async function buildOrchestrator(
  meter: SessionMeter,
  facilitator: StreamFacilitatorHandle | null,
): Promise<Orchestrator> {
  const orch = new Orchestrator();
  const docs = getDocsSystem();
  const bridge = getFederationBridge();
  const router = getAgentTaskRouter();

  const reg = (def: ToolDef, handler: ToolHandler) => orch.register(def, handler);
  const t = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v, null, 2);

  // ── Solana data (free, public APIs) ────────────────────────────────────────

  reg({ name: "sol_price", description: "Quick SOL price via CoinGecko (no API key needed)", inputSchema: { type: "object", properties: {} }, category: "solana" },
    async () => {
      const data = await coingeckoPrice("solana");
      const sol = (data as Record<string, Record<string, number>>)?.solana;
      return `SOL: $${sol.usd.toFixed(4)} (${sol.usd_24h_change > 0 ? "+" : ""}${sol.usd_24h_change?.toFixed(2)}% 24h)`;
    });

  reg({ name: "solana_price", description: "Live price for any Solana token by mint or symbol (SOL, BONK, JUP…)", inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] }, category: "solana" },
    async (a) => {
      const token = String(a.token ?? "SOL").trim();
      if (token.length >= 32) {
        try { const d = await jupiterPrice(token) as { data: Record<string, { price: string }> }; const e = d?.data?.[token]; if (e) return { mint: token, price_usd: parseFloat(e.price), source: "Jupiter" }; } catch { /* fallthrough */ }
      }
      const syms: Record<string, string> = { SOL: "solana", BONK: "bonk", JUP: "jupiter-exchange-solana", WIF: "dogwifcoin", PENGU: "pudgy-penguins" };
      const cgId = syms[token.toUpperCase()];
      if (cgId) { const d = await coingeckoPrice(cgId); const e = (d as Record<string, Record<string, number>>)[cgId]; return { symbol: token.toUpperCase(), price_usd: e?.usd, change_24h: e?.usd_24h_change, source: "CoinGecko" }; }
      const st = await solanaTracker(`/search?query=${encodeURIComponent(token)}&limit=1`) as { tokens?: Array<{ price?: number; mint?: string; symbol?: string }> };
      const t0 = st.tokens?.[0]; return t0 ? { symbol: t0.symbol, mint: t0.mint, price_usd: t0.price, source: "SolanaTracker" } : `No price for: ${token}`;
    });

  reg({ name: "solana_trending", description: "Top trending Solana tokens by volume/momentum", inputSchema: { type: "object", properties: { limit: { type: "number" } } }, category: "solana" },
    async (a) => solanaTracker(`/tokens/trending?limit=${Math.min(Number(a.limit ?? 10), 50)}`));

  reg({ name: "solana_token_info", description: "Token metadata, security analysis, and on-chain info for a mint", inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] }, category: "solana" },
    async (a) => {
      const mint = String(a.mint);
      const [tracker, price] = await Promise.allSettled([solanaTracker(`/tokens/${mint}`), jupiterPrice(mint)]);
      return { tracker: tracker.status === "fulfilled" ? tracker.value : null, price: price.status === "fulfilled" ? price.value : null };
    });

  reg({ name: "solana_wallet_pnl", description: "PnL, trade history, and performance for any public Solana wallet", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] }, category: "solana" },
    async (a) => solanaTracker(`/pnl/${a.wallet}`));

  reg({ name: "solana_search", description: "Search Solana tokens by name or symbol", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] }, category: "solana" },
    async (a) => solanaTracker(`/search?query=${encodeURIComponent(String(a.query))}&limit=${Number(a.limit ?? 10)}`));

  reg({ name: "solana_top_traders", description: "Top traders for a token — track smart money", inputSchema: { type: "object", properties: { mint: { type: "string" }, limit: { type: "number" } }, required: ["mint"] }, category: "solana" },
    async (a) => solanaTracker(`/tokens/${a.mint}/top-traders?limit=${Number(a.limit ?? 10)}`));

  reg({ name: "solana_wallet_tokens", description: "All token balances for a wallet (fully public)", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] }, category: "solana" },
    async (a) => heliusRPC("getTokenAccountsByOwner", [String(a.wallet), { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]));

  // ── Helius (requires HELIUS_API_KEY — free at helius.dev) ──────────────────

  reg({ name: "helius_account_info", description: "Detailed account info for any Solana address via Helius", inputSchema: { type: "object", properties: { pubkey: { type: "string" } }, required: ["pubkey"] }, category: "helius" },
    async (a) => heliusRPC("getAccountInfo", [String(a.pubkey), { encoding: "jsonParsed", commitment: "confirmed" }]));

  reg({ name: "helius_balance", description: "SOL balance (in SOL) for any wallet", inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] }, category: "helius" },
    async (a) => {
      const r = await heliusRPC("getBalance", [String(a.wallet), { commitment: "confirmed" }]) as { value: number };
      return { wallet: a.wallet, sol: r.value / 1e9, lamports: r.value };
    });

  reg({ name: "helius_transactions", description: "Enhanced, human-readable transaction history. Requires HELIUS_API_KEY.", inputSchema: { type: "object", properties: { address: { type: "string" }, limit: { type: "number" }, type: { type: "string" } }, required: ["address"] }, category: "helius" },
    async (a) => {
      const params = new URLSearchParams({ limit: String(Math.min(Number(a.limit ?? 10), 100)), ...(a.type ? { type: String(a.type) } : {}) });
      return heliusREST(`/v0/addresses/${encodeURIComponent(String(a.address))}/transactions?${params}`);
    });

  reg({ name: "helius_priority_fee", description: "Real-time priority fee estimate with all levels in microLamports", inputSchema: { type: "object", properties: { accountKeys: { type: "array", items: { type: "string" } } } }, category: "helius" },
    async (a) => {
      const accountKeys = (a.accountKeys as string[] | undefined) ?? [];
      const payload: Record<string, unknown> = { options: { includeAllPriorityFeeLevels: true, recommended: true } };
      if (accountKeys.length > 0) payload.accountKeys = accountKeys;
      const r = await heliusRPC("getPriorityFeeEstimate", [payload]) as { priorityFeeEstimate: number; priorityFeeLevels?: Record<string, number> };
      return { recommended_microLamports: r.priorityFeeEstimate, levels: r.priorityFeeLevels ?? {}, hint: "Use 'recommended' for Helius staked connections." };
    });

  reg({ name: "helius_das_asset", description: "DAS metadata for NFT or token mint. Requires HELIUS_API_KEY.", inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] }, category: "helius" },
    async (a) => heliusRPC("getAsset", [{ id: String(a.mint) }]));

  reg({ name: "helius_webhook_create", description: "Create a Helius webhook for real-time address notifications", inputSchema: { type: "object", properties: { webhookURL: { type: "string" }, accountAddresses: { type: "array", items: { type: "string" } }, transactionTypes: { type: "array", items: { type: "string" } }, webhookType: { type: "string", enum: ["enhanced", "raw", "discord"] } }, required: ["webhookURL", "accountAddresses", "transactionTypes"] }, category: "helius" },
    async (a) => heliusREST("/v0/webhooks", { method: "POST", body: { webhookURL: a.webhookURL, accountAddresses: a.accountAddresses, transactionTypes: a.transactionTypes, webhookType: a.webhookType ?? "enhanced" } }));

  reg({ name: "helius_webhook_list", description: "List all active Helius webhooks. Requires HELIUS_API_KEY.", inputSchema: { type: "object", properties: {} }, category: "helius" },
    async () => heliusREST("/v0/webhooks"));

  reg({ name: "helius_listener_setup", description: "Get TypeScript code for real-time Solana event listeners via Helius WebSocket", inputSchema: { type: "object", properties: { subscriptionType: { type: "string", enum: ["account", "transaction", "logs", "slot", "signature", "program", "webhook"] }, address: { type: "string" } }, required: ["subscriptionType"] }, category: "helius" },
    async (a) => {
      const addr = a.address ? String(a.address) : "YOUR_ADDRESS_HERE";
      return `## Helius ${a.subscriptionType} Listener\n\nDocs: https://docs.helius.dev\n\n\`\`\`typescript\nimport { HeliusListener } from "./src/helius/index.js";\nconst listener = new HeliusListener({ apiKey: process.env.HELIUS_API_KEY! });\nawait listener.connect();\nawait listener.subscribe${String(a.subscriptionType).charAt(0).toUpperCase() + String(a.subscriptionType).slice(1)}("${addr}", (data) => console.log(data));\n\`\`\``;
    });

  // ── x402 + p-token tools (with facilitator integration) ────────────────────
  const enhancedX402 = facilitator
    ? enhanceX402WithFacilitator(X402_TOOLS, meter, facilitator)
    : X402_TOOLS;
  orch.registerAll(withMeter(enhancedX402, meter));

  // ── Leviathan OODA control ────────────────────────────────────────────────
  orch.registerAll(LEVIATHAN_TOOLS);

  // ── Composite market intelligence ─────────────────────────────────────────
  orch.registerAll(MARKET_TOOLS);

  // ── Deep Clawd (DeepSeek trading agent) ──────────────────────────────────
  orch.registerAll(DEEP_CLAWD_TOOLS);

  // ── Local package and service integrations ───────────────────────────────
  orch.registerAll(createIntegrationTools(REPO_ROOT));

  // ── Memory + autoDream ────────────────────────────────────────────────────

  reg({ name: "memory_recall", description: "Recall facts from persistent agent memory by tier (KNOWN/LEARNED/INFERRED/all)", inputSchema: { type: "object", properties: { query: { type: "string" }, tier: { type: "string", enum: ["KNOWN", "LEARNED", "INFERRED", "all"] } }, required: ["query"] }, category: "memory" },
    async (a) => {
      const query = String(a.query ?? "").toLowerCase();
      const tier = String(a.tier ?? "all");
      const matches = _memory.filter(m => (tier === "all" || m.tier === tier) && m.content.toLowerCase().includes(query));
      return { query, tier, matches, total: matches.length };
    });

  reg({ name: "memory_write", description: "Write a fact to agent persistent memory", inputSchema: { type: "object", properties: { content: { type: "string" }, tier: { type: "string", enum: ["LEARNED", "INFERRED"] } }, required: ["content"] }, category: "memory" },
    async (a) => {
      const entry = { tier: String(a.tier ?? "INFERRED"), content: String(a.content), timestamp: new Date().toISOString() };
      _memory.push(entry);
      return { message: "Memory written", entry };
    });

  reg({ name: "dream_status", description: "autoDream memory consolidation config and gate status", inputSchema: { type: "object", properties: {} }, category: "memory" },
    async () => [`autoDream Memory Consolidation`, ``, `Min OODA cycles: ${process.env.DREAM_MIN_CYCLES ?? 5}`, `Min hours: ${process.env.DREAM_MIN_HOURS ?? 6}h`, `Enabled: ${process.env.DREAM_ENABLED !== "false" ? "yes" : "no"}`, ``, `How: groups INFERRED signals → promotes clusters to LEARNED`].join("\n"));

  reg({ name: "dream_run", description: "Generate a manual Dream memory consolidation prompt", inputSchema: { type: "object", properties: {} }, category: "memory" },
    async () => `# Manual Memory Consolidation\n\n1. memory_recall tier="INFERRED" — get all signals\n2. Group related signals by topic\n3. For clusters of 2+, memory_write tier="LEARNED"\n4. Write a summary conclusion to LEARNED`);

  // ── Agent fleet ───────────────────────────────────────────────────────────

  reg({ name: "agent_spawn", description: "Spawn a research, analysis, ooda, scanner, or dream agent task", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["research", "analysis", "ooda", "scanner", "dream"] }, description: { type: "string" }, prompt: { type: "string" } }, required: ["type", "description", "prompt"] }, category: "agents" },
    async (a) => {
      const task = { id: `task-${++_taskCounter}`, type: String(a.type), description: String(a.description), prompt: String(a.prompt), status: "running", createdAt: new Date().toISOString() };
      _tasks.push(task);
      return { message: `Agent spawned: ${task.id}`, task };
    });

  reg({ name: "agent_list", description: "List all active agent tasks", inputSchema: { type: "object", properties: {} }, category: "agents" },
    async () => ({ tasks: _tasks, count: _tasks.length }));

  reg({ name: "agent_stop", description: "Stop an agent task by ID", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] }, category: "agents" },
    async (a) => {
      const task = _tasks.find(t => t.id === String(a.taskId));
      if (!task) return `Task not found: ${a.taskId}`;
      task.status = "stopped";
      return { message: `Stopped ${a.taskId}`, task };
    });

  // ── Skills ────────────────────────────────────────────────────────────────

  reg({ name: "skill_list", description: "List available solana-clawd skills", inputSchema: { type: "object", properties: {} }, category: "agents" },
    async () => {
      let skills: string[] = [];
      try { const e = await fs.readdir(path.join(REPO_ROOT, "skills"), { withFileTypes: true }); skills = e.map(x => x.name); } catch { /* ok */ }
      return { skills, hint: "Use skill_read to see contents" };
    });

  reg({ name: "skill_read", description: "Read a skill file by name", inputSchema: { type: "object", properties: { skillName: { type: "string" } }, required: ["skillName"] }, category: "agents" },
    async (a) => {
      const name = String(a.skillName);
      for (const p of [path.join(REPO_ROOT, "skills", `${name}.md`), path.join(REPO_ROOT, "skills", name, "SKILL.md"), path.join(REPO_ROOT, "skills", name, "README.md")]) {
        const c = await readFileText(p); if (c) return c;
      }
      return `Skill not found: ${name}`;
    });

  // ── Session helpers ───────────────────────────────────────────────────────

  reg({ name: "prompt_suggestions", description: "Context-aware suggested next prompts for Solana research, agents, x402, and OODA", inputSchema: { type: "object", properties: {} }, category: "memory" },
    async () => [
      `## Suggested Next Prompts`,
      `### Solana`, `- "What's the current market regime?"`, `- "Scan trending tokens for alpha"`,
      `### OODA`, `- "Run ooda_observe then ooda_orient then ooda_decide"`, `- "Check leviathan_status and journal"`,
      `### x402 + P-Token`, `- "Show x402_status and p-token savings"`, `- "Open a metered session: x402_session_open"`,
      `### Market Intelligence`, `- "Run market_signal for a composite read"`, `- "Check market_regime"`,
      `### CLAWD`, `- "Check clawd_holder_check for wallet [address]"`, `- "Ping the facilitator: x402_facilitator_ping"`,
    ].join("\n"));

  // ── Pump.fun ──────────────────────────────────────────────────────────────

  reg({ name: "pump_token_scan", description: "Full Pump.fun token scan: bonding curve, signal score, flags", inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] }, category: "pump" },
    async (a) => {
      const mint = String(a.mint);
      const [trackerRes, priceRes] = await Promise.allSettled([solanaTracker(`/tokens/${mint}`) as Promise<Record<string, unknown>>, coingeckoPrice("solana") as Promise<Record<string, unknown>>]);
      const tracker = trackerRes.status === "fulfilled" ? trackerRes.value as Record<string, unknown> : null;
      const solPrice: number = priceRes.status === "fulfilled" ? ((priceRes.value as Record<string, Record<string, number>>)?.solana?.usd ?? 0) : 0;
      if (!tracker) return `No Pump.fun data for: ${mint}`;
      const isGraduated = Boolean(tracker.poolAddress || tracker.migratedToAMM);
      const prog = Number(tracker.bondingCurveProgress ?? 0);
      const mcapSOL = Number(tracker.marketCap ?? 0);
      let score = 50; const reasons: string[] = []; const risks: string[] = [];
      if (isGraduated) { score += 10; reasons.push("LP locked"); }
      if (tracker.creatorSold) { score -= 20; risks.push("Creator sold ⚠️"); }
      if (Number(tracker.top10HolderPercent ?? 0) > 50) { score -= 15; risks.push("Whale risk"); }
      if (prog >= 60 && prog <= 90) { score += 15; reasons.push(`Pre-grad ${prog.toFixed(1)}%`); }
      if (Number(tracker.volume24h ?? 0) > 1_000_000) { score += 10; reasons.push("Vol >$1M"); }
      score = Math.min(100, Math.max(0, score));
      const strength = score >= 75 ? "STRONG" : score >= 55 ? "MODERATE" : score >= 35 ? "WEAK" : "AVOID";
      const bar = "█".repeat(Math.min(10, Math.round(prog / 10))) + "░".repeat(10 - Math.min(10, Math.round(prog / 10)));
      return [`## ${tracker.symbol ?? "??"} — Pump.fun Scan`, `Status: ${isGraduated ? "🎓 Graduated" : "📈 Bonding curve"}`, `Progress: ${bar} ${prog.toFixed(1)}%`, `Market Cap: $${(mcapSOL * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}`, `Signal: **${strength}** (${score}/100)`, reasons.length ? `✅ ${reasons.join(" | ")}` : "", risks.length ? `⚠️ ${risks.join(" | ")}` : ""].filter(Boolean).join("\n");
    });

  reg({ name: "pump_graduation", description: "Graduation progress for a Pump.fun token", inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] }, category: "pump" },
    async (a) => {
      const tracker = await solanaTracker(`/tokens/${a.mint}`) as Record<string, unknown>;
      const prog = Number(tracker.bondingCurveProgress ?? 0);
      const bar = "█".repeat(Math.min(10, Math.round(prog / 10))) + "░".repeat(10 - Math.min(10, Math.round(prog / 10)));
      return `## Graduation — ${tracker.symbol}\nProgress: ${bar} ${prog.toFixed(2)}%\n${Boolean(tracker.poolAddress) ? "✅ Graduated → PumpSwap AMM" : `~${(85 - Number(tracker.realSolReserves ?? 0) / 1e9).toFixed(2)} SOL remaining`}`;
    });

  reg({ name: "pump_buy_quote", description: "Simulate a Pump.fun buy — fee breakdown for given SOL input", inputSchema: { type: "object", properties: { mint: { type: "string" }, sol_amount: { type: "number" }, creator_fee_bps: { type: "number" } }, required: ["mint", "sol_amount"] }, category: "pump" },
    async (a) => {
      const solIn = BigInt(Math.round(Number(a.sol_amount) * 1e9));
      const creatorBps = BigInt(Number(a.creator_fee_bps ?? 0));
      const BPS_D = 10_000n;
      const inputNet = ((solIn - 1n) * BPS_D) / (100n + creatorBps + BPS_D);
      const protocolFee = (inputNet * 100n + BPS_D - 1n) / BPS_D;
      return `Buy Quote\nInput: ${a.sol_amount} SOL\nNet into curve: ${(Number(inputNet) / 1e9).toFixed(6)} SOL\nProtocol fee (1%): ${(Number(protocolFee) / 1e9).toFixed(6)} SOL`;
    });

  reg({ name: "pump_sell_quote", description: "Simulate a Pump.fun sell — SOL output estimate and fees", inputSchema: { type: "object", properties: { mint: { type: "string" }, token_amount: { type: "number" }, creator_fee_bps: { type: "number" } }, required: ["mint", "token_amount"] }, category: "pump" },
    async (a) => {
      const tracker = await solanaTracker(`/tokens/${a.mint}`) as Record<string, unknown>;
      const price = Number(tracker?.price ?? 0);
      return `Sell Quote — ${tracker?.symbol}\nAmount: ${Number(a.token_amount).toLocaleString()} tokens\nEst value: ${price > 0 ? `$${(price * Number(a.token_amount)).toFixed(4)}` : "N/A"}\nProtocol fee: 1.00% | Creator: ${(Number(a.creator_fee_bps ?? 0) / 100).toFixed(2)}%`;
    });

  reg({ name: "pump_market_cap", description: "Market cap for a Pump.fun token in SOL and USD", inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] }, category: "pump" },
    async (a) => {
      const [trackerRes, solRes] = await Promise.allSettled([solanaTracker(`/tokens/${a.mint}`) as Promise<Record<string, unknown>>, coingeckoPrice("solana") as Promise<Record<string, unknown>>]);
      const tracker = trackerRes.status === "fulfilled" ? trackerRes.value as Record<string, unknown> : null;
      const solPrice = solRes.status === "fulfilled" ? ((solRes.value as Record<string, Record<string, number>>)?.solana?.usd ?? 0) : 0;
      if (!tracker) return "No data";
      return { symbol: tracker.symbol, marketCapSOL: tracker.marketCap, marketCapUSD: (Number(tracker.marketCap) * solPrice).toFixed(0), priceUSD: tracker.price };
    });

  reg({ name: "pump_top_tokens", description: "Top Pump.fun tokens by volume, market cap, or graduation", inputSchema: { type: "object", properties: { sort_by: { type: "string", enum: ["volume", "market_cap", "new", "graduating"] }, limit: { type: "number" } } }, category: "pump" },
    async (a) => { try { return await solanaTracker(`/tokens/pump?sort=${a.sort_by ?? "volume"}&limit=${Math.min(Number(a.limit ?? 10), 50)}`); } catch { return solanaTracker(`/tokens/trending?limit=${Math.min(Number(a.limit ?? 10), 50)}`); } });

  reg({ name: "pump_new_tokens", description: "Most recently launched Pump.fun tokens", inputSchema: { type: "object", properties: { limit: { type: "number" } } }, category: "pump" },
    async (a) => { try { const r = await fetch(`https://pump.fun/api/coins/new?limit=${Math.min(Number(a.limit ?? 20), 50)}`, { headers: { Accept: "application/json" } }); return r.ok ? r.json() : solanaTracker(`/tokens/latest?limit=${a.limit ?? 20}`); } catch { return solanaTracker(`/tokens/latest?limit=${a.limit ?? 20}`); } });

  reg({ name: "pump_cashback_info", description: "Pump.fun cashback mechanics and PDA structure", inputSchema: { type: "object", properties: { mint: { type: "string" } } }, category: "pump" },
    async (a) => {
      const docs = [`## Pump.fun Cashback`, `Redirects creator fee back to traders on isCashbackEnabled tokens.`, ``, `PDA: seeds=[utf8("user_volume_accumulator"), addressEncoder.encode(wallet)]`, `Claim: \`claim_cashback\` instruction`].join("\n");
      if (a.mint) { const tracker = await solanaTracker(`/tokens/${a.mint}`) as Record<string, unknown>; return `Cashback for ${tracker?.symbol}: ${tracker?.isCashbackCoin ? "✅ enabled" : "❌ standard fee"}\n\n${docs}`; }
      return docs;
    });

  // ── Chess.com ─────────────────────────────────────────────────────────────

  reg({ name: "chess_player", description: "Chess.com player profile and ratings across all time controls", inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] }, category: "chess" },
    async (a) => {
      const u = String(a.username).trim();
      const [pR, sR] = await Promise.all([fetch(`${CHESS_API}/player/${u}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }), fetch(`${CHESS_API}/player/${u}/stats`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) })]);
      if (!pR.ok) throw new Error(`Player "${u}" not found`);
      const player = await pR.json() as Record<string, unknown>;
      const stats = sR.ok ? await sR.json() as Record<string, unknown> : {};
      const ratings: Record<string, number> = {};
      for (const key of ["chess_daily", "chess_rapid", "chess_bullet", "chess_blitz"]) {
        const cat = stats[key] as { last?: { rating: number } } | undefined;
        if (cat?.last) ratings[key.replace("chess_", "")] = cat.last.rating;
      }
      return { username: player.username, title: player.title, ratings, lastOnline: player.last_online ? new Date((player.last_online as number) * 1000).toISOString() : "unknown" };
    });

  reg({ name: "chess_recent_games", description: "Recent Chess.com games with results and accuracy", inputSchema: { type: "object", properties: { username: { type: "string" }, limit: { type: "number" } }, required: ["username"] }, category: "chess" },
    async (a) => {
      const u = String(a.username).trim(); const limit = Math.min(Number(a.limit) || 10, 50);
      const archRes = await fetch(`${CHESS_API}/player/${u}/games/archives`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      const archives = (await archRes.json() as { archives: string[] }).archives;
      const gamesRes = await fetch(archives[archives.length - 1], { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const all = ((await gamesRes.json()) as { games: Array<Record<string, unknown>> }).games;
      return all.sort((x, y) => (y.end_time as number) - (x.end_time as number)).slice(0, limit).map(g => {
        const white = g.white as Record<string, unknown>;
        const black = g.black as Record<string, unknown>;
        const isWhite = String(white.username).toLowerCase() === u.toLowerCase();
        const me = isWhite ? white : black;
        const opponent = isWhite ? black : white;
        return { opponent: opponent.username, result: me.result, color: isWhite ? "white" : "black", rating: me.rating };
      });
    });

  reg({ name: "chess_current_games", description: "Ongoing Chess.com daily games — shows games where it's their turn", inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] }, category: "chess" },
    async (a) => {
      const u = String(a.username);
      const [g, m] = await Promise.all([fetch(`${CHESS_API}/player/${u}/games`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }), fetch(`${CHESS_API}/player/${u}/games/to-move`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) })]);
      return { username: u, ongoing: g.ok ? (await g.json() as { games: unknown[] }).games.length : 0, toMove: m.ok ? (await m.json() as { games: unknown[] }).games.length : 0 };
    });

  reg({ name: "chess_daily_puzzle", description: "Today's Chess.com daily puzzle with FEN and solution", inputSchema: { type: "object", properties: {} }, category: "chess" },
    async () => { const r = await fetch("https://api.chess.com/pub/puzzle", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); return r.json(); });

  reg({ name: "chess_random_puzzle", description: "Random Chess.com puzzle for agent practice", inputSchema: { type: "object", properties: {} }, category: "chess" },
    async () => { const r = await fetch("https://api.chess.com/pub/puzzle/random", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); return r.json(); });

  reg({ name: "chess_leaderboards", description: "Chess.com leaderboards — top players globally by time control", inputSchema: { type: "object", properties: { category: { type: "string" } } }, category: "chess" },
    async (a) => {
      const cat = String(a.category ?? "live_blitz");
      const r = await fetch("https://api.chess.com/pub/leaderboards", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      const d = await r.json() as Record<string, unknown[]>;
      return d[cat] ? { category: cat, players: d[cat].slice(0, 20) } : { error: `Unknown: ${cat}`, available: Object.keys(d) };
    });

  reg({ name: "chess_titled_players", description: "All Chess.com players with a specific title (GM, IM, FM, etc)", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, category: "chess" },
    async (a) => {
      const title = String(a.title ?? "GM").toUpperCase();
      const r = await fetch(`https://api.chess.com/pub/titled/${title}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Titled players → ${r.status}`);
      const d = await r.json() as { players: string[] };
      return { title, count: d.players.length, players: d.players.slice(0, 50) };
    });

  // ── Docs System tools ─────────────────────────────────────────────────────

  reg({
    name: "list_sections",
    description:
      "[Docs System] List all available documentation sections and their sources. " +
      "Use this FIRST to discover what documentation is available before using get_documentation.",
    inputSchema: { type: "object", properties: {} },
    category: "docs",
  },
    async () => docs.listSections());

  reg({
    name: "get_documentation",
    description:
      "[Docs System] Get documentation for a specific source or section. " +
      "Use list_sections first to discover available IDs. " +
      "Sources: readme, soul, architecture, brain, strategy, trade, percolator, leviathan, " +
      "ooda, ptoken-article, clawd-token, mcp-architecture, and more.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: {
          type: "string",
          description: "Source or section ID from list_sections",
        },
      },
      required: ["sourceId"],
    },
    category: "docs",
  },
    async (a) => docs.getDocumentation(String(a.sourceId)));

  reg({
    name: "search_docs",
    description:
      "[Docs System] Full-text search across all Solana Clawd documentation. " +
      "Returns scored results with snippets. Works on 20+ doc sources.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term or phrase" },
        topK: { type: "number", description: "Number of results (default 5)" },
      },
      required: ["query"],
    },
    category: "docs",
  },
    async (a) => docs.searchDocs(String(a.query), Number(a.topK ?? 5)));

  // ── Federation tools (federated MCP proxying) ─────────────────────────────
  const federatedTools = await bridge.generateFederatedTools();
  if (federatedTools.length > 0) {
    // Tag all federated tools with federation category
    for (const [def] of federatedTools) {
      def.category = "federation";
    }
    orch.registerAll(federatedTools);
  }

  reg({
    name: "federation_status",
    description:
      "[Federation] Show all federated MCP server connections, their health, " +
      "and the tools proxied through each route. Lists routes from Federation Bridge.",
    inputSchema: { type: "object", properties: {} },
    category: "federation",
  },
    async () => {
      const routes = bridge.getRoutes();
      const health = await bridge.healthCheckAll();
      return {
        routes: routes.map((r) => ({
          prefix: r.prefix,
          serverName: r.server.name,
          type: r.server.type,
          url: r.server.url ?? r.server.agentUrl ?? r.server.command,
          tags: r.server.tags ?? [],
        })),
        health,
        totalRoutes: routes.length,
      };
    });

  // ── Task Router tools ─────────────────────────────────────────────────────

  reg({
    name: "task_submit",
    description:
      "[Task Router] Submit a task to an agent type (leviathan, deep-clawd, ooda, x402, memory, orchestrator). " +
      "Returns immediately with a task ID. Check status with task_result.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["leviathan", "deep-clawd", "ooda", "x402", "memory", "orchestrator"],
          description: "Agent type to run the task",
        },
        action: {
          type: "string",
          description: "Action to perform (e.g. tick, status, orient, recall, analyze)",
        },
        description: { type: "string", description: "Human-readable task description" },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "critical"],
          description: "Task priority (default: normal)",
        },
        payload: { type: "object", description: "Additional payload for the task" },
        timeoutMs: { type: "number", description: "Timeout in ms (default: depends on agent type)" },
      },
      required: ["type", "action", "description"],
    },
    category: "orchestrator",
  },
    async (a) => {
      const id = router.submitTask({
        type: String(a.type) as any,
        description: String(a.description),
        priority: (a.priority as any) ?? "normal",
        payload: { action: String(a.action), ...((a.payload as Record<string, unknown>) ?? {}) },
        timeoutMs: Number(a.timeoutMs ?? 60_000),
      });
      return { taskId: id, status: "submitted", hint: "Use task_result to check completion" };
    });

  reg({
    name: "task_result",
    description:
      "[Task Router] Get the result of a previously submitted task by ID. " +
      "Returns status (pending/running/completed/failed/timeout) and output.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID from task_submit" },
      },
      required: ["taskId"],
    },
    category: "orchestrator",
  },
    async (a) => {
      const result = router.getResult(String(a.taskId));
      if (!result) return { error: `Task not found: ${a.taskId}` };
      return result;
    });

  reg({
    name: "task_list",
    description:
      "[Task Router] List all tasks, optionally filtered by type, status, or priority. " +
      "Returns tasks sorted by priority (critical first).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by agent type" },
        status: { type: "string", enum: ["pending", "running", "completed", "failed", "timeout"], description: "Filter by status" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    category: "orchestrator",
  },
    async (a) => {
      const entries = router.findTasks({
        type: a.type as any,
        status: a.status as any,
        limit: Number(a.limit ?? 20),
      });
      return { count: entries.length, tasks: entries };
    });

  reg({
    name: "capabilities",
    description:
      "[Task Router] List all agent capabilities: types, concurrency limits, supported actions, " +
      "and required environment variables. Use this to understand what agents can do.",
    inputSchema: { type: "object", properties: {} },
    category: "orchestrator",
  },
    async () => ({
      capabilities: router.getCapabilities(),
      activeConcurrency: {
        leviathan: router.getActiveConcurrency("leviathan"),
        "deep-clawd": router.getActiveConcurrency("deep-clawd"),
        ooda: router.getActiveConcurrency("ooda"),
        x402: router.getActiveConcurrency("x402"),
        memory: router.getActiveConcurrency("memory"),
      },
    }));

  // ── Plugin Registry tools ──────────────────────────────────────────────────

  reg({
    name: "plugin_status",
    description:
      "[Plugin Registry] Show all registered plugins, their enable/disable status, " +
      "tool counts, and any load errors. Use this to discover which subsystems are active.",
    inputSchema: { type: "object", properties: {} },
    category: "orchestrator",
  },
    async () => {
      const registry = getPluginRegistry();
      return { plugins: registry.status() };
    });

  reg({
    name: "plugin_reload",
    description:
      "[Plugin Registry] Reload a specific plugin (e.g. 'ooda', 'leviathan', 'x402-payment'). " +
      "Allows hot-reloading plugins during development without restarting the MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: {
          type: "string",
          description: "Plugin ID to reload (ooda, leviathan, x402-payment, deep-clawd, skills, programs)",
        },
      },
      required: ["pluginId"],
    },
    category: "orchestrator",
  },
    async (a) => {
      const registry = getPluginRegistry();
      const ok = await registry.reload(String(a.pluginId));
      return { reloaded: ok, pluginId: a.pluginId, hint: ok ? "Plugin reloaded" : "Plugin not found" };
    });

  // ── Deep Clawd bridge tools (for when the plugin can't be loaded) ─────────

  reg({
    name: "deep_clawd_status",
    description:
      "[Deep Clawd] Check DeepSeek trading agent status. Returns agent readiness, " +
      "API key presence, and routing mode (dFlow).",
    inputSchema: { type: "object", properties: {} },
    category: "deep-clawd",
  },
    async () => {
      const hasKey = !!process.env.DEEPSEEK_API_KEY;
      const mode = process.env.DFLOW_ROUTING_MODE ?? "auto";
      return {
        ready: hasKey,
        apiKeyConfigured: hasKey,
        dFlowRoutingMode: mode,
        agentType: "deep-clawd",
        hint: hasKey
          ? "Use task_submit with type='deep-clawd' to run DeepSeek ticks"
          : "Set DEEPSEEK_API_KEY to enable Deep Clawd agent",
      };
    });

  // ── Orchestrator health ────────────────────────────────────────────────────

  reg({
    name: "orchestrator_health",
    description:
      "[Orchestrator] Full orchestrator health check: tool counts, plugin status, " +
      "federation routes, billing status, and system overview.",
    inputSchema: { type: "object", properties: {} },
    category: "orchestrator",
  },
    async () => {
      const registry = getPluginRegistry();
      return {
        status: "healthy",
        tools: {
          total: orch.list().length,
          byCategory: orch.categories(),
        },
        billing: meter.summary(),
        plugins: registry.status(),
        federation: {
          routes: bridge.getRoutes().map((r) => r.prefix),
          health: await bridge.healthCheckAll().catch(() => ({})),
        },
        facilitatorAttached: !!facilitator,
        pTokenSavings: facilitator ? meter.getSavings() : { cuSaved: 0, transferCount: 0, usdcEquiv: "0" },
        version: SERVER_VERSION,
      };
    });

  await orch.init();
  return orch;
}

// ─── Server factory ────────────────────────────────────────────────────────────

export async function createServer(): Promise<Server> {
  const facilitator = await getStreamFacilitator();
  const meter = new SessionMeter(
    parseFloat(process.env.X402_MAX_SESSION_USD ?? "5"),
    facilitator ?? undefined,
  );

  // Warm up the plugin registry (discover all plugins)
  const registry = getPluginRegistry();
  await registry.discover().catch(() => {
    console.warn("[server] Plugin discovery failed — continuing with core tools only");
  });

  const orch = await buildOrchestrator(meter, facilitator);

  const server = new Server(
    { name: "solana-clawd", version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const text = (v: unknown) => ({
    content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
  });

  // ── Resources ───────────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "solana-clawd://readme", name: "README", description: "solana-clawd documentation", mimeType: "text/markdown" },
      { uri: "solana-clawd://soul", name: "SOUL.md", description: "Agent identity and operating principles", mimeType: "text/markdown" },
      { uri: "solana-clawd://skills", name: "Skills", description: "Available agent skills", mimeType: "application/json" },
      { uri: "solana-clawd://leviathan/state", name: "Leviathan State", description: "Live Leviathan autonomous agent state", mimeType: "application/json" },
      { uri: "solana-clawd://leviathan/shell", name: "Leviathan SHELL.md", description: "Agent working memory", mimeType: "text/markdown" },
      { uri: "solana-clawd://x402/config", name: "x402 Config", description: "Payment protocol and p-token configuration", mimeType: "application/json" },
      { uri: "solana-clawd://x402/billing", name: "Session Billing", description: "Current MCP session spend ledger", mimeType: "application/json" },
      { uri: "solana-clawd://clawd/token", name: "CLAWD Token", description: "CLAWD token info and discount tiers", mimeType: "application/json" },
      { uri: "solana-clawd://orchestrator/tools", name: "Tool Registry", description: "All registered tools by category", mimeType: "application/json" },
      { uri: "solana-clawd://docs/sections", name: "Doc Sections", description: "Available documentation sections", mimeType: "text/markdown" },
      { uri: "solana-clawd://federation/status", name: "Federation Status", description: "Federated MCP server connections and health", mimeType: "application/json" },
      { uri: "solana-clawd://plugins/status", name: "Plugin Status", description: "Plugin registry status and loaded tools", mimeType: "application/json" },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: "solana-clawd://source/{path}", name: "Source file", description: "Read a repository source file", mimeType: "text/plain" },
      { uriTemplate: "solana-clawd://docs/{sourceId}", name: "Documentation", description: "Documentation for a source or section", mimeType: "text/markdown" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req: { params: { uri: string } }) => {
    const { uri } = req.params;
    const c = (mimeType: string, text: string) => ({ contents: [{ uri, mimeType, text }] });
    const docs = getDocsSystem();

    if (uri === "solana-clawd://readme") return c("text/markdown", (await readFileText(path.join(REPO_ROOT, "README.md"))) ?? "README not found");
    if (uri === "solana-clawd://soul") return c("text/markdown", (await readFileText(path.join(REPO_ROOT, "SOUL.md"))) ?? "No SOUL.md — create one to give your agent identity");
    if (uri === "solana-clawd://skills") {
      let skills: string[] = [];
      try { const e = await fs.readdir(path.join(REPO_ROOT, "skills"), { withFileTypes: true }); skills = e.map(x => x.name); } catch { /**/ }
      return c("application/json", JSON.stringify({ skills }, null, 2));
    }
    if (uri === "solana-clawd://leviathan/state") {
      const stateFile = path.join(os.homedir(), ".openclawd", "leviathan", "state.json");
      const raw = await readFileText(stateFile);
      return c("application/json", raw ?? JSON.stringify({ running: false, hint: "Start Leviathan with: npm run leviathan" }, null, 2));
    }
    if (uri === "solana-clawd://leviathan/shell") {
      const shellFile = path.join(os.homedir(), ".openclawd", "leviathan", "SHELL.md");
      return c("text/markdown", (await readFileText(shellFile)) ?? "SHELL.md not found — Leviathan has not run yet");
    }
    if (uri === "solana-clawd://x402/config") {
      return c("application/json", JSON.stringify({
        enabled: !!process.env.X402_SVM_PRIVATE_KEY,
        network: process.env.X402_NETWORK ?? "solana",
        maxPerRequestUSD: parseFloat(process.env.X402_MAX_PER_REQUEST_USD ?? "0.10"),
        maxSessionUSD: parseFloat(process.env.X402_MAX_SESSION_USD ?? "5.00"),
        usePToken: process.env.USE_P_TOKEN !== "false",
        pTokenProgram: "ptok6rngomXrDbWf5v5Mkmu5CEbB51hzSCPDoj9DrvF",
        facilitator: process.env.PAYSH_RELAY_URL ?? "https://pay.solanaclawd.com/relay/v1",
        facilitatorAttached: !!facilitator,
        cuSavings: "98.3% (TransferChecked: 6,200 → 105 CU)",
      }, null, 2));
    }
    if (uri === "solana-clawd://x402/billing") {
      return c("application/json", JSON.stringify(meter.summary(), null, 2));
    }
    if (uri === "solana-clawd://clawd/token") {
      return c("application/json", JSON.stringify({
        mint: "8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump",
        symbol: "CLAWD",
        discounts: { Bronze: "1K CLAWD → 5%", Silver: "10K → 10%", Gold: "100K → 20%", Platinum: "1M → 30%" },
        usage: "Holders receive reduced x402 facilitator fees at pay.solanaclawd.com",
      }, null, 2));
    }
    if (uri === "solana-clawd://orchestrator/tools") {
      return c("application/json", JSON.stringify(orch.categories(), null, 2));
    }
    if (uri === "solana-clawd://docs/sections") {
      return c("text/markdown", docs.listSections());
    }
    if (uri === "solana-clawd://federation/status") {
      const bridge = getFederationBridge();
      const routes = bridge.getRoutes();
      const health = await bridge.healthCheckAll().catch(() => ({}));
      return c("application/json", JSON.stringify({ routes: routes.map(r => ({ prefix: r.prefix, name: r.server.name, type: r.server.type })), health }, null, 2));
    }
    if (uri === "solana-clawd://plugins/status") {
      const registry = getPluginRegistry();
      return c("application/json", JSON.stringify({ plugins: registry.status() }, null, 2));
    }
    if (uri.startsWith("solana-clawd://docs/")) {
      const sourceId = uri.slice("solana-clawd://docs/".length);
      try {
        const doc = await docs.getDocumentation(sourceId);
        return c("text/markdown", doc);
      } catch (e) {
        throw new Error(`Doc source not found: ${sourceId}`);
      }
    }
    if (uri.startsWith("solana-clawd://source/")) {
      const rel = uri.slice("solana-clawd://source/".length);
      const abs = safePath(REPO_ROOT, rel);
      if (!abs) throw new Error("Invalid path");
      const content = await readFileText(abs);
      if (!content) throw new Error(`Not found: ${rel}`);
      return c("text/plain", content);
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // ── Tools ────────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: orch.list().map(({ name, description, inputSchema, cost }) => ({
      name, description: cost ? `${description} [premium: $${(cost / 1e6).toFixed(4)}/call]` : description, inputSchema,
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      try {
        const result = await orch.dispatch(req.params.name, req.params.arguments ?? {}, meter);
        return text(result);
      } catch (err) {
        return { ...text(`Error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
      }
    },
  );

  // ── Prompts ──────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: "clawd_orchestrate", description: "Full Solana Clawd framework orchestration — command and control" },
      { name: "solana_overview", description: "Overview of solana-clawd capabilities" },
      { name: "ooda_loop", description: "Run a complete OODA cycle with market data" },
      { name: "leviathan_spawn", description: "Spawn and control a Leviathan OODA agent session" },
      { name: "x402_metered_demo", description: "Demonstrate p-token metered billing end-to-end" },
      { name: "market_scan", description: "Composite market scan: signal + regime + heat map" },
      { name: "pump_ooda", description: "OODA loop focused on Pump.fun bonding curve plays", arguments: [{ name: "mint", description: "Token mint to evaluate", required: false }] },
      { name: "trade_research", description: "Research a token for a trade decision", arguments: [{ name: "token", description: "Token symbol or mint", required: true }] },
      { name: "wallet_analysis", description: "Analyze a wallet's performance and holdings", arguments: [{ name: "wallet", description: "Solana wallet address", required: true }] },
      { name: "docs_explore", description: "Explore the full Solana Clawd documentation system" },
      { name: "federated_query", description: "Query federated MCP servers through the federation bridge" },
      { name: "task_orchestrate", description: "Orchestrate multi-agent tasks with the Task Router" },
    ],
  }));

  server.setRequestHandler(
    GetPromptRequestSchema,
    async (req: { params: { name: string; arguments?: Record<string, string> } }) => {
      const { name, arguments: args } = req.params;
      const msg = (txt: string) => ({ description: name, messages: [{ role: "user" as const, content: { type: "text" as const, text: txt } }] });

      switch (name) {
        case "clawd_orchestrate":
          return msg([
            `# Solana Clawd — Framework Orchestration`,
            ``,
            `You are the orchestration layer of the Solana Clawd framework v3. You have control over:`,
            ``,
            `## 1. Market Intelligence (start here)`,
            `- market_signal → composite signal across all sources`,
            `- market_regime → bull/bear/crab/pump/crash detection`,
            `- token_heat_map → breadth scan`,
            ``,
            `## 2. OODA Loop Control`,
            `- leviathan_status → check if Leviathan agent is running`,
            `- ooda_observe → pull live market signals`,
            `- ooda_orient → pattern match + regime analysis`,
            `- ooda_decide → structured decision (respects depth tier)`,
            `- ooda_act → record action to journal + SHELL.md`,
            ``,
            `## 3. Documentation System (NEW)`,
            `- list_sections → discover all documentation sources`,
            `- get_documentation → read any source or section`,
            `- search_docs → full-text search across 20+ sources`,
            ``,
            `## 4. Federation Bridge (NEW)`,
            `- federation__* → tools proxied from other MCP servers`,
            `- federation_status → check connected servers`,
            ``,
            `## 5. Task Router (NEW)`,
            `- task_submit → dispatch to leviathan / deep-clawd / ooda / memory`,
            `- task_result → check status of any task`,
            `- capabilities → see what agents can do`,
            ``,
            `## 6. Payment Infrastructure`,
            `- x402_status → full protocol + p-token stats`,
            `- x402_session_open → open metered billing session`,
            `- clawd_holder_check → CLAWD holder discount tier`,
            `- x402_facilitator_ping → check pay.solanaclawd.com health`,
            ``,
            `## 7. Agent Fleet`,
            `- leviathan_tick_request → trigger a Leviathan OODA tick`,
            `- agent_spawn → spawn research/scanner/dream agent`,
            `- memory_recall / memory_write → persistent memory`,
            ``,
            `## Suggested orchestration flow:`,
            `1. list_sections → explore docs`,
            `2. market_signal → assess current opportunity`,
            `3. leviathan_status → check agent state`,
            `4. ooda_observe → structured market pull`,
            `5. ooda_orient → pattern analysis`,
            `6. ooda_decide → pick best action`,
            `7. ooda_act → execute + record`,
            `8. memory_write → persist the learnings`,
          ].join("\n"));

        case "docs_explore":
          return msg([
            `# Documentation System Exploration`,
            ``,
            `The Solana Clawd MCP v3 includes a full documentation system inspired by the Official Solana MCP.`,
            ``,
            `## Step 1: list_sections`,
            `Call list_sections first to see all 20+ documentation sources across categories:`,
            `  core, trading, agents, payments, tokens, governance, mcp, llms`,
            ``,
            `## Step 2: get_documentation`,
            `Pick a section or specific source ID:`,
            `  get_documentation sourceId="core"`,
            `  get_documentation sourceId="readme"`,
            `  get_documentation sourceId="ptoken-article"`,
            ``,
            `## Step 3: search_docs`,
            `Full-text search across all sources:`,
            `  search_docs query="p-token" topK=5`,
            `  search_docs query="leviathan"`,
            ``,
            `The docs system covers the ENTIRE framework — not just code, but strategy, architecture,`,
            `tokenomics, agent runtimes, and payment protocol documentation.`,
          ].join("\n"));

        case "federated_query":
          return msg([
            `# Federated MCP Query`,
            ``,
            `The Federation Bridge proxies tools from other MCP servers.`,
            ``,
            `## Check what's available:`,
            `1. federation_status → see active routes`,
            ``,
            `## Call federated tools:`,
            `2. federation__solana_org__list_sections`,
            `3. federation__solana_org__get_documentation sourceId="cli"`,
            `4. federation__solana_org__Solana_Documentation_Search query="stake"`,
            ``,
            `Federated tools are named: federation__{prefix}__{tool_name}`,
            `The default prefix for the Official Solana MCP is "solana_org".`,
          ].join("\n"));

        case "task_orchestrate":
          return msg([
            `# Multi-Agent Task Orchestration`,
            ``,
            `The Agent Task Router dispatches work across agent subsystems.`,
            ``,
            `## Check capabilities:`,
            `1. capabilities → see all agent types and concurrency limits`,
            ``,
            `## Dispatch individual tasks:`,
            `2. task_submit type="leviathan" action="status" description="Check agent health"`,
            `3. task_submit type="deep-clawd" action="tick" description="Run DeepSeek tick"`,
            `4. task_result taskId="<id>" → check result`,
            ``,
            `## Orchestrate multiple agents (via "orchestrator" type):`,
            `5. task_submit type="orchestrator" action="compose" description="Multi-agent scan" ` +
            `   payload={ tasks: [{ type: "leviathan", action: "status" }, { type: "ooda", action: "tick" }] }`,
            ``,
            `The router handles priority, concurrency limits, and timeouts automatically.`,
          ].join("\n"));

        case "leviathan_spawn":
          return msg([
            `# Leviathan OODA Session`,
            ``,
            `1. leviathan_status → check if running and current depth`,
            `2. leviathan_shell_read → load current working memory`,
            `3. ooda_observe → pull live market signals`,
            `4. ooda_orient observations=<above output>`,
            `5. ooda_decide orientation=<above output> depth=<from status>`,
            `6. ooda_act action=<decision> result="pending"`,
            `7. leviathan_tick_request → trigger the actual Leviathan tick`,
            `8. After ~5s: leviathan_journal limit=1 → see what it did`,
            `9. memory_write the key finding`,
          ].join("\n"));

        case "x402_metered_demo":
          return msg([
            `# P-Token Metered Billing Demo`,
            ``,
            `Demonstrate the per-output-token x402 billing model:`,
            ``,
            `1. x402_status → confirm p-token enabled`,
            `2. x402_ptoken_stats → show CU savings to date`,
            `3. x402_session_open payerPubkey="DEMO_WALLET" maxTokens=100 mode="batched"`,
            `   → Note the sessionId returned`,
            `4. x402_session_meter sessionId=<id> tokens=25 → first checkpoint`,
            `5. x402_session_meter sessionId=<id> tokens=25 → second checkpoint`,
            `6. x402_session_close sessionId=<id>`,
            `   → Shows exact bill for 50 tokens consumed, unused 50 released`,
            `7. x402_billing_status → session spend ledger`,
            ``,
            `The economic innovation: $0.0001/token × 50 tokens = $0.005`,
            `P-token fee: ~105 CU × 5000 µlamports = $0.00001 (0.2% overhead)`,
            `vs SPL fee: 6,200 CU = $0.00059 (11.8% overhead — 59x more)`,
          ].join("\n"));

        case "market_scan":
          return msg([
            `# Composite Market Scan`,
            ``,
            `Run these in sequence:`,
            `1. market_signal → composite signal (free)`,
            `2. market_regime → regime detection (premium $0.0003)`,
            `3. token_heat_map → market breadth (free)`,
            `4. pump_top_tokens sort_by=graduating → graduation plays`,
            `5. pump_new_tokens → fresh launches`,
            ``,
            `Then for top 3 hits from market_signal:`,
            `- pump_token_scan → full signal score`,
            `- solana_token_info → security + metadata`,
            ``,
            `End with: memory_write INFERRED signal summary`,
          ].join("\n"));

        case "solana_overview":
          return msg(`You are solana-clawd v3, an autonomous Solana research, trading, and agent orchestration platform.\n\nCapabilities:\n- Market intelligence: market_signal, market_regime, token_heat_map\n- OODA loop: ooda_observe, ooda_orient, ooda_decide, ooda_act\n- Docs System: list_sections, get_documentation, search_docs (20+ sources)\n- Federation Bridge: federated MCP tools from external servers\n- Task Router: dispatch tasks to leviathan/deep-clawd/ooda/memory agents\n- Leviathan agent control: leviathan_status, leviathan_journal, leviathan_tick_request\n- x402 p-token billing: x402_session_open/meter/close, clawd_holder_check\n- Pump.fun: pump_token_scan, pump_graduation, pump_new_tokens\n- Solana data: solana_price, solana_trending, helius_transactions\n\nStart with: list_sections → market_signal → leviathan_status → ooda_observe`);

        case "ooda_loop":
          return msg(`Run a full OODA cycle:\n\n**OBSERVE**: ooda_observe (pulls sol_price + trending + leviathan context)\n**ORIENT**: ooda_orient observations=<above>\n**DECIDE**: ooda_decide orientation=<above>\n**ACT**: ooda_act action=<decision> result=<outcome>\n\nEnd with: memory_write the key INFERRED signal`);

        case "pump_ooda": {
          const mint = args?.mint;
          return msg(mint
            ? `Pump.fun OODA on ${mint}:\n1. pump_token_scan mint=${mint}\n2. pump_graduation mint=${mint}\n3. pump_market_cap mint=${mint}\n4. ooda_decide based on above\n5. memory_write the signal score and thesis`
            : `Pump.fun OODA:\n1. pump_new_tokens limit=20\n2. pump_top_tokens sort_by=graduating\n3. pump_token_scan on top 3\n4. memory_write best signal`);
        }

        case "trade_research": {
          const token = args?.token ?? "SOL";
          return msg(`Research ${token}:\n1. solana_price token=${token}\n2. solana_token_info\n3. solana_top_traders\n4. memory_recall query="${token.slice(0,8)}"\n\nOutput: KNOWN → LEARNED → INFERRED → DECISION (buy/wait/avoid) → ACTION`);
        }

        case "wallet_analysis": {
          const wallet = args?.wallet ?? "(no wallet)";
          return msg(`Analyze wallet ${wallet}:\n1. solana_wallet_pnl wallet=${wallet}\n2. solana_wallet_tokens wallet=${wallet}\n3. helius_transactions address=${wallet} limit=20\n4. clawd_holder_check wallet=${wallet}\n\nSummarize: PnL, holdings, trading style, CLAWD holder tier`);
        }

        default:
          throw new Error(`Unknown prompt: ${name}`);
      }
    },
  );

  return server;
}

export async function validateSrcRoot(): Promise<void> {
  try { await fs.access(REPO_ROOT); } catch { console.warn(`⚠ REPO_ROOT not found: ${REPO_ROOT}`); }
}
