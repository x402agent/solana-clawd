/**
 * src/tools/solana-agent.ts — DeepSeek-powered Solana + Perps Agentic Tooling
 *
 * High-level agentic functions powered by DeepSeek thinking mode.
 * Each function uses resolveOpenAIClient() from src/providers/deepseek.ts
 * and dispatches AI-selected tool calls over real on-chain data.
 *
 * Tool sets:
 *   • solanaPortfolioAnalysis()  — Helius portfolio read + DeepSeek analysis
 *   • jupiterSwapDecision()      — Jupiter quote + AI routing optimization
 *   • oreStrategyDecision()      — ORE v3 board state + AI deploy strategy
 *   • perpsMarketAnalysis()      — Funding rates + positions + AI signal
 *   • solanaAgentLoop()          — Full CLAWD loop tick using all tools
 *
 * Usage:
 *   import { solanaAgentLoop } from '@/tools/solana-agent'
 *   const result = await solanaAgentLoop({ wallet, rpc, dryRun: true })
 */

import { Connection } from '@solana/web3.js';
import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { resolveOpenAIClient, thinkingCall } from '../providers/deepseek.js';

// ── Tool definitions (JSON schema for DeepSeek function calling) ──────────────

/** Jupiter V6 quote + swap tools */
const JUPITER_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'jupiter_quote',
      description: 'Get a Jupiter swap quote for a token pair. Returns best route, price impact, and expected output.',
      parameters: {
        type: 'object',
        properties: {
          inputMint:      { type: 'string', description: 'Input token mint address' },
          outputMint:     { type: 'string', description: 'Output token mint address' },
          amountLamports: { type: 'number', description: 'Amount in lamports (1 SOL = 1e9)' },
          slippageBps:    { type: 'number', description: 'Max slippage in basis points (default 50 = 0.5%)' },
        },
        required: ['inputMint', 'outputMint', 'amountLamports'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jupiter_swap',
      description: 'Execute a Jupiter swap. Returns transaction signature or dry-run result.',
      parameters: {
        type: 'object',
        properties: {
          inputMint:      { type: 'string' },
          outputMint:     { type: 'string' },
          amountLamports: { type: 'number' },
          slippageBps:    { type: 'number', default: 50 },
          dryRun:         { type: 'boolean', description: 'If true, skip broadcast and return simulation' },
        },
        required: ['inputMint', 'outputMint', 'amountLamports'],
      },
    },
  },
];

/** Helius data tools */
const HELIUS_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'helius_portfolio',
      description: 'Get SOL balance, token holdings, and recent transactions for a wallet.',
      parameters: {
        type: 'object',
        properties: {
          wallet: { type: 'string', description: 'Base58 Solana wallet address' },
          limit:  { type: 'number', description: 'Number of recent transactions (default 20)' },
        },
        required: ['wallet'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'helius_token_metadata',
      description: 'Get token metadata (name, symbol, decimals, supply) for a mint address.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'helius_nfts',
      description: 'List NFTs owned by a wallet, including collection info and floor prices.',
      parameters: {
        type: 'object',
        properties: {
          wallet: { type: 'string' },
          page:   { type: 'number', default: 1 },
        },
        required: ['wallet'],
      },
    },
  },
];

/** ORE v3 mining tools */
const ORE_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'ore_board_status',
      description: 'Read the ORE v3 Board PDA — current round ID, mining window (endSlot), and whether mining is open.',
      parameters: {
        type: 'object',
        properties: {
          rpc: { type: 'string', description: 'Solana RPC URL' },
        },
        required: ['rpc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ore_round_analysis',
      description: 'Read the ORE v3 Round PDA — all 25 squares with deployed lamports, miner counts, and computed EV per square.',
      parameters: {
        type: 'object',
        properties: {
          rpc:     { type: 'string' },
          roundId: { type: 'number', description: 'Round ID (from board status)' },
        },
        required: ['rpc', 'roundId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ore_deploy',
      description: 'Deploy SOL to one or more ORE squares in the current mining round.',
      parameters: {
        type: 'object',
        properties: {
          squares:     { type: 'array', items: { type: 'number', minimum: 0, maximum: 24 } },
          amountSol:   { type: 'number', description: 'Total SOL to deploy' },
          keypairPath: { type: 'string' },
          rpc:         { type: 'string' },
          dryRun:      { type: 'boolean', default: false },
        },
        required: ['squares', 'amountSol', 'keypairPath', 'rpc'],
      },
    },
  },
];

/** Perpetuals tools (Phoenix / Percolator) */
const PERPS_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'perps_markets',
      description: 'List all available perp markets with current mark price, funding rate, and open interest.',
      parameters: {
        type: 'object',
        properties: {
          protocol: { type: 'string', enum: ['phoenix', 'percolator'] },
          rpc:      { type: 'string' },
        },
        required: ['protocol', 'rpc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'perps_funding_rate',
      description: 'Get the current and predicted funding rate for a specific market.',
      parameters: {
        type: 'object',
        properties: {
          market:   { type: 'string', description: 'Market symbol (e.g. SOL-PERP)' },
          protocol: { type: 'string', enum: ['phoenix', 'percolator'] },
          rpc:      { type: 'string' },
        },
        required: ['market', 'protocol', 'rpc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'perps_positions',
      description: 'List open perpetual positions for a wallet.',
      parameters: {
        type: 'object',
        properties: {
          wallet:   { type: 'string' },
          protocol: { type: 'string', enum: ['phoenix', 'percolator'] },
          rpc:      { type: 'string' },
        },
        required: ['wallet', 'protocol', 'rpc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'perps_open_position',
      description: 'Open a leveraged perp position. Returns tx signature or dry-run simulation.',
      parameters: {
        type: 'object',
        properties: {
          market:      { type: 'string' },
          side:        { type: 'string', enum: ['long', 'short'] },
          sizeSol:     { type: 'number' },
          leverage:    { type: 'number', minimum: 1, maximum: 10 },
          limitPrice:  { type: 'number' },
          protocol:    { type: 'string', enum: ['phoenix', 'percolator'] },
          keypairPath: { type: 'string' },
          rpc:         { type: 'string' },
          dryRun:      { type: 'boolean', default: false },
        },
        required: ['market', 'side', 'sizeSol', 'protocol', 'keypairPath', 'rpc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'perps_close_position',
      description: 'Close an existing perp position by position ID.',
      parameters: {
        type: 'object',
        properties: {
          positionId:  { type: 'string' },
          protocol:    { type: 'string', enum: ['phoenix', 'percolator'] },
          keypairPath: { type: 'string' },
          rpc:         { type: 'string' },
          dryRun:      { type: 'boolean', default: false },
        },
        required: ['positionId', 'protocol', 'keypairPath', 'rpc'],
      },
    },
  },
];

/** Hold / no-op */
const HOLD_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'hold',
    description: 'Take no action this tick. Use when no clear opportunity exists or risk is too high.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
      },
      required: ['reason'],
    },
  },
};

const ALL_SOLANA_TOOLS: ChatCompletionTool[] = [
  ...JUPITER_TOOLS,
  ...HELIUS_TOOLS,
  ...ORE_TOOLS,
  ...PERPS_TOOLS,
  HOLD_TOOL,
];

// ── Tool context + result ─────────────────────────────────────────────────────

export interface ToolContext {
  rpc: string;
  wallet?: string;
  keypairPath?: string;
  heliusApiKey?: string;
  dryRun?: boolean;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── Per-group tool handlers (keeps execTool complexity low) ───────────────────

async function handleJupiter(name: string, input: Record<string, unknown>, dryRun: boolean): Promise<ToolResult> {
  const inputMint  = input.inputMint as string;
  const outputMint = input.outputMint as string;
  const amountLamports = input.amountLamports as number;
  const slippageBps    = (input.slippageBps as number | undefined) ?? 50;
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;

  if (name === 'jupiter_quote') {
    const res = await fetch(quoteUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { success: false, error: `Jupiter quote ${res.status}` };
    return { success: true, data: await res.json() };
  }

  // jupiter_swap
  if (dryRun) {
    const res = await fetch(quoteUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { success: false, error: `Jupiter quote ${res.status}` };
    const quote = await res.json();
    return { success: true, data: { dryRun: true, quote, note: 'swap not broadcast in dry-run mode' } };
  }
  return { success: false, error: 'Live swaps require keypair integration — use dry-run for now' };
}

async function heliusPortfolio(wallet: string, apiKey: string, limit: number): Promise<ToolResult> {
  const [solRes, txRes] = await Promise.all([
    fetch(`https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${apiKey}`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=${limit}`, { signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!solRes.ok || !txRes.ok) return { success: false, error: `Helius portfolio balances=${solRes.status} transactions=${txRes.status}` };
  const balances = await solRes.json();
  const txs = await txRes.json();
  return { success: true, data: { balances, recentTxs: Array.isArray(txs) ? txs.slice(0, 5) : txs } };
}

async function handleHelius(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const apiKey = ctx.heliusApiKey;
  if (!apiKey) return { success: false, error: 'HELIUS_API_KEY not set' };

  if (name === 'helius_token_metadata') {
    const mint = input.mint as string;
    const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [mint] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { success: false, error: `Helius ${res.status}` };
    return { success: true, data: await res.json() };
  }

  const wallet = (input.wallet as string | undefined) ?? ctx.wallet;
  if (!wallet) return { success: false, error: 'wallet required' };

  if (name === 'helius_portfolio') {
    return heliusPortfolio(wallet, apiKey, (input.limit as number | undefined) ?? 20);
  }

  // helius_nfts
  const page = (input.page as number | undefined) ?? 1;
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'nfts', method: 'getAssetsByOwner',
      params: { ownerAddress: wallet, page, limit: 20, displayOptions: { showCollectionMetadata: true } },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { success: false, error: `Helius DAS ${res.status}` };
  return { success: true, data: await res.json() };
}

async function handleOre(name: string, input: Record<string, unknown>, rpc: string, dryRun: boolean): Promise<ToolResult> {
  if (name === 'ore_board_status') {
    try {
      const target = new URL('../../agents/ore-miner/dist/rpc.js', import.meta.url).href;
      const { getBoard } = await import(target);
      return { success: true, data: await getBoard(new Connection(rpc)) };
    } catch (e) {
      return { success: false, error: `ore_board_status: ${String(e).slice(0, 100)}` };
    }
  }

  if (name === 'ore_round_analysis') {
    try {
      const target = new URL('../../agents/ore-miner/dist/rpc.js', import.meta.url).href;
      const { getRound } = await import(target);
      return { success: true, data: await getRound(new Connection(rpc), BigInt(input.roundId as number)) };
    } catch (e) {
      return { success: false, error: `ore_round_analysis: ${String(e).slice(0, 100)}` };
    }
  }

  // ore_deploy
  if (dryRun) {
    return { success: true, data: { dryRun: true, squares: input.squares, amountSol: input.amountSol, note: 'dry-run — no tx broadcast' } };
  }
  return { success: false, error: 'Live ORE deploy requires ore-cli integration — use ore-miner agent' };
}

async function handlePerps(name: string, input: Record<string, unknown>, ctx: ToolContext, dryRun: boolean): Promise<ToolResult> {
  const protocol = input.protocol as string;

  if (name === 'perps_open_position') {
    if (dryRun) {
      return { success: true, data: { dryRun: true, market: input.market, side: input.side, sizeSol: input.sizeSol, leverage: input.leverage ?? 1, note: 'dry-run' } };
    }
    return { success: false, error: 'Live perps orders require keypair integration' };
  }

  if (name === 'perps_close_position') {
    if (dryRun) {
      return { success: true, data: { dryRun: true, positionId: input.positionId, note: 'dry-run' } };
    }
    return { success: false, error: 'Live perps close requires keypair integration' };
  }

  try {
    if (protocol === 'phoenix') {
      return phoenixQuery(name, input.market as string, (input.wallet as string | undefined) ?? ctx.wallet);
    }
    if (protocol !== 'percolator') return { success: false, error: `Unsupported perps protocol: ${protocol}` };
    return percolatorQuery(name, input.market as string, (input.wallet as string | undefined) ?? ctx.wallet);
  } catch (e) {
    return { success: false, error: `${name}: ${String(e).slice(0, 100)}` };
  }
}

async function phoenixQuery(name: string, market: string, wallet?: string): Promise<ToolResult> {
  const target = new URL('../../leviathan/dist/agent/vulcan.js', import.meta.url).href;
  const { VulcanClient } = await import(target) as {
    VulcanClient: {
      markets: () => Promise<unknown>;
      fundingRate: (m: string) => Promise<unknown>;
      positions: (w?: string) => Promise<unknown>;
    }
  };
  if (name === 'perps_markets')      return { success: true, data: await VulcanClient.markets() };
  if (name === 'perps_funding_rate') return { success: true, data: await VulcanClient.fundingRate(market) };
  return { success: true, data: await VulcanClient.positions(wallet) };
}

async function percolatorQuery(name: string, market: string, wallet?: string): Promise<ToolResult> {
  const target = new URL('../../leviathan/dist/agent/percolator.js', import.meta.url).href;
  const { Percolator } = await import(target) as {
    Percolator: {
      listMarkets: () => Promise<unknown>;
      fundingRate: (m: string) => Promise<unknown>;
      getPosition: (w: string) => Promise<unknown>;
    }
  };
  if (name === 'perps_positions') {
    if (!wallet) return { success: false, error: 'wallet required' };
    return { success: true, data: await Percolator.getPosition(wallet) };
  }
  if (name === 'perps_funding_rate') return { success: true, data: await Percolator.fundingRate(market) };
  return { success: true, data: await Percolator.listMarkets() };
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

export async function execTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rpc    = (input.rpc as string | undefined) ?? ctx.rpc;
  // Tool arguments cannot override a host-selected dry run. Default to simulation.
  const dryRun = ctx.dryRun !== false || input.dryRun === true;

  try {
    if (name === 'jupiter_quote' || name === 'jupiter_swap')               return handleJupiter(name, input, dryRun);
    if (name === 'helius_portfolio' || name === 'helius_token_metadata' || name === 'helius_nfts') return handleHelius(name, input, ctx);
    if (name === 'ore_board_status' || name === 'ore_round_analysis' || name === 'ore_deploy')     return handleOre(name, input, rpc, dryRun);
    if (name.startsWith('perps_'))                                         return handlePerps(name, input, ctx, dryRun);
    if (name === 'hold') return { success: true, data: { action: 'hold', reason: input.reason ?? 'no action' } };
    return { success: false, error: `unknown tool: ${name}` };
  } catch (e) {
    return { success: false, error: String(e).slice(0, 200) };
  }
}

// ── High-level agentic functions ──────────────────────────────────────────────

export interface AgentLoopOptions {
  rpc: string;
  wallet?: string;
  keypairPath?: string;
  heliusApiKey?: string;
  dryRun?: boolean;
  maxToolCalls?: number;
  systemContext?: string;
}

export interface AgentLoopResult {
  action: string;
  toolsCalled: string[];
  reasoning: string | null;
  result: unknown;
  provider: string;
  model: string;
}

type ChatMsg = Parameters<ReturnType<typeof resolveOpenAIClient>['client']['chat']['completions']['create']>[0]['messages'][number];

/** Run one turn of the AI tool loop, returning tool name + result (or null if done). */
async function runOneTurn(
  client: ReturnType<typeof resolveOpenAIClient>['client'],
  model: string,
  messages: ChatMsg[],
  useThinking: boolean,
  ctx: ToolContext,
): Promise<{ toolName: string; result: unknown; reasoning: string | null; done: boolean } | null> {
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2048,
    messages,
    tools: ALL_SOLANA_TOOLS,
    tool_choice: 'auto',
    ...(useThinking ? { extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } } : {}),
  } as import('openai/resources/chat/completions.js').ChatCompletionCreateParamsNonStreaming);

  const msg = response.choices[0]?.message;
  const reasoning = (msg as unknown as { reasoning_content?: string } | undefined)?.reasoning_content ?? null;
  const toolCall = msg?.tool_calls?.[0];

  if (!toolCall) {
    return { toolName: 'hold', result: msg?.content ?? 'no action', reasoning, done: true };
  }

  const fn = (toolCall as unknown as { function: { name: string; arguments: string } }).function;
  const toolResult = await execTool(fn.name, JSON.parse(fn.arguments) as Record<string, unknown>, ctx);

  messages.push({ role: 'assistant', content: msg.content, tool_calls: [toolCall] });
  messages.push({
    role: 'tool', tool_call_id: toolCall.id,
    content: JSON.stringify(toolResult, (_key, value) => typeof value === 'bigint' ? value.toString() : value),
  });

  const TERMINAL = new Set(['jupiter_swap', 'ore_deploy', 'perps_open_position', 'perps_close_position', 'hold']);

  return {
    toolName: fn.name,
    result: toolResult.data ?? toolResult.error,
    reasoning,
    done: TERMINAL.has(fn.name),
  };
}

/**
 * Run one CLAWD loop tick over the full Solana + perps tool surface.
 * DeepSeek V4 Pro (thinking mode) reasons over all available data
 * and picks the best action — then the harness executes it.
 */
export async function solanaAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { client, model, provider } = resolveOpenAIClient();
  const {
    rpc,
    wallet,
    keypairPath,
    heliusApiKey = process.env.HELIUS_API_KEY,
    dryRun = true,
    maxToolCalls = 5,
    systemContext = '',
  } = opts;

  const ctx: ToolContext = { rpc, wallet, keypairPath, heliusApiKey, dryRun };
  const useThinking = provider.name === 'deepseek' && (model.includes('pro') || model.includes('reasoner'));

  const systemPrompt = [
    'You are an autonomous Solana trading agent running one CLAWD loop tick.',
    'You have access to tools for Jupiter swaps, Helius portfolio data, ORE mining, and perpetuals trading.',
    'Analyze the available data and choose exactly one action per tick.',
    'Prefer information-gathering before acting on-chain.',
    dryRun ? 'DRY-RUN MODE: All on-chain actions are simulated — no real transactions.' : 'LIVE MODE: Actions are real. Be conservative.',
    systemContext,
  ].filter(Boolean).join('\n');

  const messages: ChatMsg[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        `RPC: ${rpc}`,
        wallet ? `Wallet: ${wallet}` : 'Wallet: not set',
        `Dry-run: ${dryRun}`,
        '',
        'Choose your first action. Gather information before trading. Call one tool at a time.',
      ].join('\n'),
    },
  ];

  const toolsCalled: string[] = [];
  let lastAction = 'hold';
  let lastResult: unknown = null;
  let lastReasoning: string | null = null;

  for (let i = 0; i < maxToolCalls; i++) {
    const turn = await runOneTurn(client, model, messages, useThinking, ctx);
    if (!turn) break;

    if (turn.reasoning) lastReasoning = turn.reasoning;
    toolsCalled.push(turn.toolName);
    lastAction = turn.toolName;
    lastResult = turn.result;

    if (turn.done) break;

    // runOneTurn appends the provider's tool call and matching tool result.
  }

  return { action: lastAction, toolsCalled, reasoning: lastReasoning, result: lastResult, provider: provider.name, model };
}

/**
 * Analyze Solana portfolio and return a structured investment brief.
 * Uses DeepSeek thinking mode for deep reasoning over holdings.
 */
export async function solanaPortfolioAnalysis(wallet: string, ctx: ToolContext): Promise<{
  summary: string;
  reasoning: string | null;
  recommendations: string[];
}> {
  const portfolioResult = await execTool('helius_portfolio', { wallet }, ctx);

  const { content, reasoning } = await thinkingCall({
    system: [
      'You are a Solana portfolio analyst. Given wallet data, provide a concise analysis.',
      'Return JSON with shape: { summary: string, recommendations: string[] }',
      'Focus on: token allocation, recent activity patterns, DeFi positions, ORE mining status.',
      'Keep recommendations actionable and specific to Solana DeFi.',
    ].join('\n'),
    userMessage: `Wallet: ${wallet}\n\nPortfolio data:\n${JSON.stringify(portfolioResult.data, null, 2)}`,
    maxTokens: 1024,
    effort: 'high',
  });

  try {
    const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
      summary?: string;
      recommendations?: string[];
    };
    return {
      summary: parsed.summary ?? content.slice(0, 200),
      reasoning,
      recommendations: parsed.recommendations ?? [],
    };
  } catch {
    return { summary: content.slice(0, 300), reasoning, recommendations: [] };
  }
}

/**
 * Get an AI-powered perps market analysis with funding rate signals.
 * Returns trade recommendation based on current funding + momentum.
 */
export async function perpsMarketAnalysis(
  market: string,
  protocol: 'phoenix' | 'percolator',
  ctx: ToolContext,
): Promise<{
  market: string;
  signal: 'long' | 'short' | 'hold';
  confidence: number;
  reasoning: string | null;
  fundingRate: unknown;
}> {
  const [fundingResult, marketsResult] = await Promise.all([
    execTool('perps_funding_rate', { market, protocol }, ctx),
    execTool('perps_markets', { protocol }, ctx),
  ]);

  const { content, reasoning } = await thinkingCall({
    system: [
      'You are a perpetuals trading analyst on Solana.',
      'Given market data and funding rates, output a trade signal.',
      'Return JSON: { signal: "long"|"short"|"hold", confidence: 0-1, rationale: string }',
      'High positive funding = shorts are paid = favor long. High negative funding = longs paid = favor short.',
      'Confidence < 0.5 → always output hold.',
    ].join('\n'),
    userMessage: [
      `Market: ${market} (${protocol})`,
      `Funding rate: ${JSON.stringify(fundingResult.data)}`,
      `All markets: ${JSON.stringify(marketsResult.data).slice(0, 800)}`,
    ].join('\n'),
    maxTokens: 512,
    effort: 'high',
  });

  try {
    const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
      signal?: string;
      confidence?: number;
    };
    return {
      market,
      signal: (parsed.signal === 'long' || parsed.signal === 'short') ? parsed.signal : 'hold',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning,
      fundingRate: fundingResult.data,
    };
  } catch {
    return { market, signal: 'hold', confidence: 0, reasoning, fundingRate: fundingResult.data };
  }
}

// ── Exports for external consumers ───────────────────────────────────────────

export { ALL_SOLANA_TOOLS, JUPITER_TOOLS, HELIUS_TOOLS, ORE_TOOLS, PERPS_TOOLS };

