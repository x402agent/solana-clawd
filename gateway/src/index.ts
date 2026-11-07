#!/usr/bin/env node
/**
 * CLAWD Gateway — Telegram bot + HTTP API with Solana/Helius/Birdeye access.
 *
 * Start:  npm --prefix gateway start
 * Env:    Use the root stack supervisor to load ../.env, or export configuration
 */
import 'dotenv/config';
import express from 'express';
import { TelegramBot, sendMessage } from './telegram.js';
import {
  getBalance,
  getTokenAccounts,
  getRecentTransactions,
  getSlot,
  getBlockHeight,
  walletSummary,
  heliusGetAssetsByOwner,
  getPublicKey,
} from './solana.js';
import {
  BirdeyeWS,
  getTokenPrice,
  getTokenOverview,
  searchTokens,
} from './birdeye.js';
import { supabase } from './supabase.js';
import agentRegistryRouter from './agentRegistry.js';
import gaslessMintRouter from './gaslessMint.js';
import skillHubRouter from './skillHub.js';

// ---------------------------------------------------------------------------
// HTTP Gateway (Express)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
const PORT = parseInt(process.env.GATEWAY_PORT ?? '8080', 10);

// Free agent registry + identity endpoints (no auth required)
app.use('/', agentRegistryRouter);
// Gasless Metaplex minting endpoints
app.use('/', gaslessMintRouter);
// Skill Hub — formally verified skill registry
app.use('/', skillHubRouter);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    wallet: getPublicKey()?.toBase58() ?? null,
    birdeye: birdeye.isConnected(),
    supabase: !!process.env.SUPABASE_URL,
    uptime: process.uptime(),
  });
});

app.get('/api/supabase/health', async (_req, res) => {
  try {
    const { error } = await supabase.from('_health_check_dummy').select('*').limit(0);
    // A "relation does not exist" error still means Supabase is reachable
    const reachable = !error || error.code === '42P01' || error.code === 'PGRST116';
    res.json({ supabase: reachable ? 'connected' : 'error', detail: error?.message ?? 'ok' });
  } catch (e: unknown) {
    res.status(500).json({ supabase: 'unreachable', detail: (e as Error).message });
  }
});

app.get('/api/balance/:address?', async (req, res) => {
  try {
    const addr = (req.params as Record<string, string>).address || undefined;
    const bal = await getBalance(addr);
    res.json(bal);
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/tokens/:address?', async (req, res) => {
  try {
    const addr = (req.params as Record<string, string>).address || undefined;
    const tokens = await getTokenAccounts(addr);
    res.json(tokens);
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/transactions/:address?', async (req, res) => {
  try {
    const addr = (req.params as Record<string, string>).address || undefined;
    const limit = parseInt(req.query.limit as string) || 10;
    const txs = await getRecentTransactions(addr, limit);
    res.json(txs);
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/slot', async (_req, res) => {
  try {
    res.json({ slot: await getSlot() });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/assets/:address?', async (req, res) => {
  try {
    const addr = (req.params as Record<string, string>).address || undefined;
    const data = await heliusGetAssetsByOwner(addr);
    res.json(data);
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/price/:address', async (req, res) => {
  try {
    res.json(await getTokenPrice(req.params.address));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/token/:address', async (req, res) => {
  try {
    res.json(await getTokenOverview(req.params.address));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q) return res.status(400).json({ error: 'Missing ?q= param' });
    res.json(await searchTokens(q));
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Birdeye WebSocket — shared instance
// ---------------------------------------------------------------------------
const birdeye = new BirdeyeWS();

// Alert buffer per chat — latest Birdeye events forwarded to Telegram
const alertChats = new Set<number>();

birdeye.on('PRICE_DATA', (data: Record<string, unknown>) => {
  const text = `📈 *Price Update*\n` +
    `Symbol: ${data.symbol}\n` +
    `O: ${data.o} H: ${data.h} L: ${data.l} C: ${data.c}\n` +
    `Vol: ${data.v}`;
  for (const chatId of alertChats) {
    sendMessage(chatId, text).catch(() => {});
  }
});

birdeye.on('TOKEN_NEW_LISTING_DATA', (data: Record<string, unknown>) => {
  const text = `🆕 *New Token Listed*\n` +
    `Name: ${data.name} (${data.symbol})\n` +
    `Address: \`${data.address}\`\n` +
    `Liquidity: $${data.liquidity}`;
  for (const chatId of alertChats) {
    sendMessage(chatId, text).catch(() => {});
  }
});

birdeye.on('NEW_PAIR_DATA', (data: Record<string, unknown>) => {
  const base = data.base as Record<string, unknown> | undefined;
  const text = `🔗 *New Pair*\n` +
    `${base?.symbol ?? '?'} — Source: ${data.source}\n` +
    `Address: \`${data.address}\``;
  for (const chatId of alertChats) {
    sendMessage(chatId, text).catch(() => {});
  }
});

birdeye.on('TXS_LARGE_TRADE_DATA', (data: Record<string, unknown>) => {
  const from = data.from as Record<string, unknown> | undefined;
  const to = data.to as Record<string, unknown> | undefined;
  const text = `🐋 *Large Trade*\n` +
    `$${Number(data.volumeUSD).toFixed(2)} USD\n` +
    `${from?.symbol} → ${to?.symbol}\n` +
    `TX: \`${(data.txHash as string)?.slice(0, 16)}…\``;
  for (const chatId of alertChats) {
    sendMessage(chatId, text).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Telegram Bot — command handlers
// ---------------------------------------------------------------------------
const bot = new TelegramBot();

bot.command('start', async (msg) => {
  await sendMessage(msg.chat.id, [
    '🐾 *CLAWD Gateway Bot*',
    '',
    'Solana agent with Helius + Birdeye integration.',
    '',
    '*Commands:*',
    '/wallet — Show wallet balance & tokens',
    '/balance [address] — SOL balance',
    '/tokens [address] — Token holdings',
    '/txs [address] — Recent transactions',
    '/price <mint> — Token price (Birdeye)',
    '/search <query> — Search tokens',
    '/slot — Current Solana slot',
    '/assets [address] — Helius DAS assets',
    '',
    '*Birdeye Alerts:*',
    '/alerts on — Enable real-time alerts here',
    '/alerts off — Disable alerts',
    '/watch <mint> — Watch token price',
    '/whales <min_usd> — Watch large trades',
    '/newpairs — Watch new pair listings',
    '/newlistings — Watch new token listings',
    '',
    '/status — Gateway status',
  ].join('\n'));
});

bot.command('wallet', async (msg) => {
  try {
    const summary = await walletSummary();
    await sendMessage(msg.chat.id, summary);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

bot.command('balance', async (msg, args) => {
  try {
    const bal = await getBalance(args || undefined);
    const addr = args || getPublicKey()?.toBase58() || 'default';
    await sendMessage(msg.chat.id, `💰 \`${addr}\`\n*${bal.sol.toFixed(4)} SOL*`);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

bot.command('tokens', async (msg, args) => {
  try {
    const tokens = await getTokenAccounts(args || undefined);
    if (tokens.length === 0) {
      await sendMessage(msg.chat.id, '📦 No token accounts found.');
      return;
    }
    const lines = tokens.slice(0, 15).map(
      t => `• \`${t.mint.slice(0, 12)}…\` — ${t.uiAmount}`,
    );
    if (tokens.length > 15) lines.push(`…and ${tokens.length - 15} more`);
    await sendMessage(msg.chat.id, `📦 *Token Accounts (${tokens.length}):*\n${lines.join('\n')}`);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

bot.command('txs', async (msg, args) => {
  try {
    const txs = await getRecentTransactions(args || undefined, 5);
    if (txs.length === 0) {
      await sendMessage(msg.chat.id, 'No recent transactions found.');
      return;
    }
    const lines = txs.map(t => {
      const time = t.blockTime ? new Date(t.blockTime * 1000).toISOString().slice(0, 19) : '?';
      const status = t.err ? '❌' : '✅';
      return `${status} \`${t.signature.slice(0, 16)}…\` — ${time}`;
    });
    await sendMessage(msg.chat.id, `📜 *Recent Transactions:*\n${lines.join('\n')}`);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

bot.command('price', async (msg, args) => {
  if (!args) {
    await sendMessage(msg.chat.id, 'Usage: /price <token_mint_address>');
    return;
  }
  try {
    const data = (await getTokenPrice(args)) as { data?: { value?: number } };
    const price = data?.data?.value;
    await sendMessage(msg.chat.id, price != null
      ? `💲 Price: *$${price}*\nMint: \`${args}\``
      : `No price data for \`${args}\``);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

bot.command('search', async (msg, args) => {
  if (!args) {
    await sendMessage(msg.chat.id, 'Usage: /search <token name or symbol>');
    return;
  }
  try {
    const data = (await searchTokens(args)) as { data?: { items?: Array<{ name: string; symbol: string; address: string }> } };
    const items = data?.data?.items ?? [];
    if (items.length === 0) {
      await sendMessage(msg.chat.id, `No results for "${args}".`);
      return;
    }
    const lines = items.slice(0, 10).map(
      (t) => `• *${t.symbol}* — ${t.name}\n  \`${t.address}\``,
    );
    await sendMessage(msg.chat.id, `🔍 *Search results for "${args}":*\n\n${lines.join('\n\n')}`);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

bot.command('slot', async (msg) => {
  try {
    const [slot, height] = await Promise.all([getSlot(), getBlockHeight()]);
    await sendMessage(msg.chat.id, `⛓ *Slot:* ${slot.toLocaleString()}\n📏 *Block Height:* ${height.toLocaleString()}`);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

bot.command('assets', async (msg, args) => {
  try {
    const data = (await heliusGetAssetsByOwner(args || undefined)) as {
      result?: { items?: Array<{ content?: { metadata?: { name?: string } }; id?: string }> };
    };
    const items = data?.result?.items ?? [];
    if (items.length === 0) {
      await sendMessage(msg.chat.id, '📦 No assets found (Helius DAS).');
      return;
    }
    const lines = items.slice(0, 15).map(
      a => `• ${a.content?.metadata?.name ?? 'Unknown'} — \`${a.id?.slice(0, 12)}…\``,
    );
    await sendMessage(msg.chat.id, `🗂 *Assets (${items.length}):*\n${lines.join('\n')}`);
  } catch (e: unknown) {
    await sendMessage(msg.chat.id, `❌ ${(e as Error).message}`);
  }
});

// ---------------------------------------------------------------------------
// Birdeye alert commands
// ---------------------------------------------------------------------------
bot.command('alerts', async (msg, args) => {
  const on = args.toLowerCase() === 'on';
  if (on) {
    alertChats.add(msg.chat.id);
    await sendMessage(msg.chat.id, '🔔 Birdeye alerts *enabled* for this chat.');
  } else {
    alertChats.delete(msg.chat.id);
    await sendMessage(msg.chat.id, '🔕 Birdeye alerts *disabled*.');
  }
});

bot.command('watch', async (msg, args) => {
  if (!args) {
    await sendMessage(msg.chat.id, 'Usage: /watch <token_mint_address>');
    return;
  }
  alertChats.add(msg.chat.id);
  birdeye.subscribePrice(args);
  await sendMessage(msg.chat.id, `👀 Watching price for \`${args}\`\nAlerts will appear in this chat.`);
});

bot.command('whales', async (msg, args) => {
  const minUsd = parseInt(args) || 10000;
  alertChats.add(msg.chat.id);
  birdeye.subscribeLargeTrades(minUsd);
  await sendMessage(msg.chat.id, `🐋 Watching large trades ≥ $${minUsd.toLocaleString()}`);
});

bot.command('newpairs', async (msg) => {
  alertChats.add(msg.chat.id);
  birdeye.subscribeNewPairs(100);
  await sendMessage(msg.chat.id, '🔗 Watching new pair listings (min $100 liquidity)');
});

bot.command('newlistings', async (msg, args) => {
  alertChats.add(msg.chat.id);
  const sources = args ? args.split(',').map(s => s.trim()) : undefined;
  birdeye.subscribeNewListings(1000, sources);
  await sendMessage(msg.chat.id, '🆕 Watching new token listings (min $1k liquidity)');
});

bot.command('status', async (msg) => {
  const pubkey = getPublicKey()?.toBase58() ?? 'not configured';
  let bal = 'N/A';
  try {
    const b = await getBalance();
    bal = `${b.sol.toFixed(4)} SOL`;
  } catch {}

  await sendMessage(msg.chat.id, [
    '🤖 *CLAWD Gateway Status*',
    '',
    `Wallet: \`${pubkey}\``,
    `Balance: ${bal}`,
    `Birdeye WS: ${birdeye.isConnected() ? '🟢 Connected' : '🔴 Disconnected'}`,
    `Alerts active: ${alertChats.size} chat(s)`,
    `RPC: ${process.env.GATEKEEPER_RPC_URL ? 'Gatekeeper (beta)' : 'Helius'}`,
    `Uptime: ${Math.floor(process.uptime())}s`,
  ].join('\n'));
});

// Default handler — echo back for now
bot.onMessage(async (msg, text) => {
  await sendMessage(msg.chat.id, `I received: "${text}"\n\nUse /start to see available commands.`);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Start HTTP gateway
  app.listen(PORT, process.env.GATEWAY_HOST || '0.0.0.0', () => {
    console.log(`[Gateway] HTTP API listening on :${PORT}`);
  });

  // Background integrations are opt-in so local stack startup only starts HTTP.
  if (process.env.GATEWAY_BACKGROUND_ENABLED === 'true') {
    birdeye.connect();
    await bot.start();
  }
}

main().catch((err) => {
  console.error('[Gateway] Fatal:', err);
  process.exit(1);
});
