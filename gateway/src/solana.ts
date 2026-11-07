import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  type ParsedAccountData,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const HELIUS_RPC = process.env.HELIUS_RPC_URL ?? '';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? '';
const HELIUS_PARSE_URL = process.env.HELIUS_PARSE_URL ?? '';
const GATEKEEPER_RPC = process.env.GATEKEEPER_RPC_URL ?? '';
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY ?? '';
const PUBLIC_KEY = process.env.SOLANA_PUBLIC_KEY ?? '';

// ---------------------------------------------------------------------------
// Connection — prefer Gatekeeper (beta), fallback to standard Helius
// ---------------------------------------------------------------------------
const rpcUrl = GATEKEEPER_RPC || HELIUS_RPC || process.env.SOLANA_RPC_URL;
if (!rpcUrl) throw new Error('No Solana RPC URL configured (SOLANA_RPC_URL, HELIUS_RPC_URL or GATEKEEPER_RPC_URL)');

export const connection = new Connection(rpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: process.env.HELIUS_ATLAS_WSS_URL || process.env.HELIUS_WSS_URL,
});

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
export function getKeypair(): Keypair | null {
  if (!PRIVATE_KEY) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  } catch {
    return null;
  }
}

export function getPublicKey(): PublicKey | null {
  const kp = getKeypair();
  if (kp) return kp.publicKey;
  if (PUBLIC_KEY) return new PublicKey(PUBLIC_KEY);
  return null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export async function getBalance(address?: string): Promise<{ sol: number; lamports: number }> {
  const pubkey = address ? new PublicKey(address) : getPublicKey();
  if (!pubkey) throw new Error('No wallet address configured');
  const lamports = await connection.getBalance(pubkey);
  return { sol: lamports / LAMPORTS_PER_SOL, lamports };
}

export async function getTokenAccounts(owner?: string): Promise<Array<{
  mint: string;
  amount: string;
  decimals: number;
  uiAmount: number;
}>> {
  const pubkey = owner ? new PublicKey(owner) : getPublicKey();
  if (!pubkey) throw new Error('No wallet address configured');

  const resp = await connection.getParsedTokenAccountsByOwner(pubkey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });

  return resp.value
    .map(({ account }) => {
      const data = account.data as ParsedAccountData;
      const info = data.parsed?.info;
      return {
        mint: info?.mint as string,
        amount: info?.tokenAmount?.amount as string,
        decimals: info?.tokenAmount?.decimals as number,
        uiAmount: info?.tokenAmount?.uiAmount as number,
      };
    })
    .filter(t => t.uiAmount > 0);
}

export async function getRecentTransactions(address?: string, limit = 10): Promise<Array<{
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}>> {
  const pubkey = address ? new PublicKey(address) : getPublicKey();
  if (!pubkey) throw new Error('No wallet address configured');

  const sigs = await connection.getSignaturesForAddress(pubkey, { limit });
  return sigs.map(s => ({
    signature: s.signature,
    slot: s.slot,
    blockTime: s.blockTime ?? null,
    err: s.err,
  }));
}

export async function getSlot(): Promise<number> {
  return connection.getSlot();
}

export async function getBlockHeight(): Promise<number> {
  return connection.getBlockHeight();
}

// ---------------------------------------------------------------------------
// Helius enhanced APIs
// ---------------------------------------------------------------------------
export async function heliusParseTransactions(signatures: string[]): Promise<unknown[]> {
  if (!HELIUS_PARSE_URL) return [];
  const resp = await fetch(HELIUS_PARSE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: signatures }),
  });
  if (!resp.ok) throw new Error(`Helius parse failed: ${resp.status}`);
  return resp.json() as Promise<unknown[]>;
}

export async function heliusGetAssetsByOwner(owner?: string): Promise<unknown> {
  if (!HELIUS_API_KEY && !HELIUS_RPC) return { error: 'No Helius API key' };
  const pubkey = owner ?? getPublicKey()?.toBase58();
  if (!pubkey) throw new Error('No wallet address');

  const url = HELIUS_RPC || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'assets',
      method: 'getAssetsByOwner',
      params: { ownerAddress: pubkey, page: 1, limit: 50 },
    }),
  });
  if (!resp.ok) throw new Error(`Helius getAssetsByOwner failed: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Summary for Telegram
// ---------------------------------------------------------------------------
export async function walletSummary(address?: string): Promise<string> {
  const pubkey = address ?? getPublicKey()?.toBase58() ?? 'unknown';
  const [bal, tokens] = await Promise.all([
    getBalance(address).catch(() => ({ sol: 0, lamports: 0 })),
    getTokenAccounts(address).catch(() => []),
  ]);

  const lines = [
    `🔑 *Wallet:* \`${pubkey}\``,
    `💰 *SOL Balance:* ${bal.sol.toFixed(4)} SOL`,
    '',
    `📦 *Token Accounts:* ${tokens.length}`,
  ];

  for (const t of tokens.slice(0, 10)) {
    lines.push(`  • \`${t.mint.slice(0, 8)}…\` — ${t.uiAmount}`);
  }
  if (tokens.length > 10) lines.push(`  …and ${tokens.length - 10} more`);

  return lines.join('\n');
}
