/**
 * gateway/src/gaslessMint.ts — Gasless Metaplex MPL Core agent minting.
 *
 * Users provide their pubkey; the platform fee-payer wallet pays all SOL
 * transaction fees. The minted Core asset is owned by the user's pubkey.
 *
 * Routes:
 *   POST /api/mint/agent        — mint one of the 3 preset agents
 *   POST /api/mint/agent/custom — mint a custom agent with user-supplied metadata
 *   GET  /api/mint/status/:sig  — check mint transaction status
 */

import { Router, Request, Response } from 'express';

const router = Router();

// ---------------------------------------------------------------------------
// Rate limiting — simple in-memory (IP → timestamps)
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT = 5; // mints per IP per hour
const rateLimits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const times = (rateLimits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) return true;
  times.push(now);
  rateLimits.set(ip, times);
  return false;
}

// ---------------------------------------------------------------------------
// Agent preset metadata
// ---------------------------------------------------------------------------
const BASE_URL = process.env.GATEWAY_BASE_URL ?? 'https://x402.wtf';

const PRESET_AGENTS: Record<number, { name: string; uri: string; symbol: string }> = {
  1: { name: 'The Analyst', symbol: 'ANALYST', uri: `${BASE_URL}/metadata/agent1.json` },
  2: { name: 'The Satirist', symbol: 'SATIRIST', uri: `${BASE_URL}/metadata/agent2.json` },
  3: { name: 'Clawd', symbol: 'CLAWD', uri: `${BASE_URL}/metadata/agent3.json` },
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function isValidPubkey(pk: string): boolean {
  // Solana pubkeys are base58, 32–44 chars
  return typeof pk === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pk);
}

function isValidHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core minting logic — dynamically imports Metaplex to avoid hard dep at boot
// ---------------------------------------------------------------------------
async function mintCoreAsset(opts: {
  ownerPubkey: string;
  name: string;
  uri: string;
  network: 'mainnet' | 'devnet';
}): Promise<{ assetAddress: string; signature: string; explorerUrl: string }> {
  const feePayer = process.env.FEE_PAYER_SECRET_KEY ?? process.env.SOLANA_PRIVATE_KEY;
  if (!feePayer) {
    throw new Error('FEE_PAYER_SECRET_KEY is not configured on this server');
  }

  // Dynamic import so the gateway boots even without Metaplex installed
  const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
  const { create, mplCore } = await import('@metaplex-foundation/mpl-core');
  const {
    keypairIdentity,
    generateSigner,
    publicKey: umiPublicKey,
  } = await import('@metaplex-foundation/umi');
  const bs58 = await import('bs58');

  const rpcUrl = opts.network === 'devnet'
    ? (process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com')
    : (process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com');

  const umi = createUmi(rpcUrl).use(mplCore());

  // Decode fee payer — accepts base58 or JSON array
  let secretBytes: Uint8Array;
  if (feePayer.startsWith('[')) {
    secretBytes = Uint8Array.from(JSON.parse(feePayer) as number[]);
  } else {
    secretBytes = bs58.default.decode(feePayer);
  }
  const feePayerKp = umi.eddsa.createKeypairFromSecretKey(secretBytes);
  umi.use(keypairIdentity(feePayerKp));

  const asset = generateSigner(umi);

  const { signature } = await create(umi, {
    asset,
    name: opts.name,
    uri: opts.uri,
    owner: umiPublicKey(opts.ownerPubkey),
  }).sendAndConfirm(umi, { send: { commitment: 'confirmed' } });

  const cluster = opts.network === 'devnet' ? '?cluster=devnet' : '';
  return {
    assetAddress: asset.publicKey.toString(),
    signature: Buffer.from(signature).toString('base64'),
    explorerUrl: `https://explorer.solana.com/address/${asset.publicKey}${cluster}`,
  };
}

async function mintRegisteredAgent(opts: {
  ownerPubkey: string;
  name: string;
  uri: string;
  description: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  network: 'mainnet' | 'devnet';
}): Promise<{
  assetAddress: string;
  signature: string;
  agentWallet: string;
  registrationUri?: string;
  explorerUrl: string;
}> {
  const feePayer = process.env.FEE_PAYER_SECRET_KEY ?? process.env.SOLANA_PRIVATE_KEY;
  if (!feePayer) {
    throw new Error('FEE_PAYER_SECRET_KEY is not configured on this server');
  }

  const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
  const { findAssetSignerPda, mplCore } = await import('@metaplex-foundation/mpl-core');
  const {
    keypairIdentity,
    publicKey: umiPublicKey,
  } = await import('@metaplex-foundation/umi');
  const {
    mintAndSubmitAgent,
    mplAgentIdentity,
  } = await import('@metaplex-foundation/mpl-agent-registry');
  const bs58 = await import('bs58');

  const rpcUrl = opts.network === 'devnet'
    ? (process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com')
    : (process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com');

  const umi = createUmi(rpcUrl).use(mplCore()).use(mplAgentIdentity());

  let secretBytes: Uint8Array;
  if (feePayer.startsWith('[')) {
    secretBytes = Uint8Array.from(JSON.parse(feePayer) as number[]);
  } else {
    secretBytes = bs58.default.decode(feePayer);
  }
  const feePayerKp = umi.eddsa.createKeypairFromSecretKey(secretBytes);
  umi.use(keypairIdentity(feePayerKp));

  const network = opts.network === 'devnet' ? 'solana-devnet' : 'solana-mainnet';
  const result = await mintAndSubmitAgent(umi, {}, {
    wallet: umiPublicKey(opts.ownerPubkey),
    network,
    name: opts.name,
    uri: opts.uri,
    agentMetadata: {
      type: 'agent',
      name: opts.name,
      description: opts.description,
      services: opts.services,
      registrations: [],
      supportedTrust: ['reputation', 'crypto-economic'],
    } as {
      type: 'agent';
      name: string;
      description: string;
      services: Array<{ name: string; endpoint: string; version?: string }>;
      registrations: never[];
      supportedTrust: string[];
    },
  });

  const assetAddress = result.assetAddress.toString();
  const agentWallet = findAssetSignerPda(umi, { asset: umiPublicKey(assetAddress) })[0].toString();
  const signature = result.signature instanceof Uint8Array
    ? bs58.default.encode(result.signature)
    : Array.isArray(result.signature)
      ? bs58.default.encode(Uint8Array.from(result.signature as number[]))
      : String(result.signature);

  const cluster = opts.network === 'devnet' ? '?cluster=devnet' : '';
  return {
    assetAddress,
    signature,
    agentWallet,
    registrationUri: `https://api.metaplex.com/v1/agents/${assetAddress}?network=${network}`,
    explorerUrl: `https://explorer.solana.com/address/${assetAddress}${cluster}`,
  };
}

// ---------------------------------------------------------------------------
// POST /api/mint/agent — gasless preset agent mint
// ---------------------------------------------------------------------------
router.post('/api/mint/agent', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      detail: 'Maximum 5 gasless mints per IP per hour.',
      retry_after: 3600,
    });
  }

  const { agentId, ownerPubkey, network = 'mainnet' } = req.body as {
    agentId: unknown;
    ownerPubkey: unknown;
    network?: string;
  };

  if (agentId !== 1 && agentId !== 2 && agentId !== 3) {
    return res.status(400).json({ error: 'agentId must be 1, 2, or 3' });
  }
  if (!ownerPubkey || !isValidPubkey(String(ownerPubkey))) {
    return res.status(400).json({ error: 'ownerPubkey must be a valid Solana base58 public key' });
  }
  if (network !== 'mainnet' && network !== 'devnet') {
    return res.status(400).json({ error: 'network must be "mainnet" or "devnet"' });
  }

  const preset = PRESET_AGENTS[agentId as 1 | 2 | 3]!;

  try {
    const result = await mintCoreAsset({
      ownerPubkey: String(ownerPubkey),
      name: preset.name,
      uri: preset.uri,
      network: network as 'mainnet' | 'devnet',
    });

    res.status(201).json({
      success: true,
      agent: {
        id: agentId,
        name: preset.name,
        symbol: preset.symbol,
        metadata_uri: preset.uri,
      },
      mint: {
        asset_address: result.assetAddress,
        signature: result.signature,
        owner: ownerPubkey,
        fee_payer: 'platform (gasless)',
        network,
        explorer: result.explorerUrl,
      },
      next_steps: [
        `View your agent: curl ${BASE_URL}/api/mint/asset/${result.assetAddress}`,
        `Register on-chain SAS: curl ${BASE_URL}/sas/agent${agentId}.json`,
        `Shell document: curl ${BASE_URL}/shell/agent${agentId}.md`,
        `Launch a token: see ${BASE_URL}/identity for Genesis token launch instructions`,
      ],
    });
  } catch (e: unknown) {
    const msg = (e as Error).message ?? 'Unknown error';
    const status = msg.includes('not configured') ? 503 : 500;
    res.status(status).json({ error: 'Mint failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/mint/agent/custom — gasless custom agent mint
// ---------------------------------------------------------------------------
router.post('/api/mint/agent/custom', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after: 3600 });
  }

  const { name, metadataUri, ownerPubkey, network = 'devnet' } = req.body as {
    name: unknown;
    metadataUri: unknown;
    ownerPubkey: unknown;
    network?: string;
  };

  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 32) {
    return res.status(400).json({ error: 'name must be 1–32 characters' });
  }
  if (!metadataUri || !isValidHttpsUrl(String(metadataUri))) {
    return res.status(400).json({ error: 'metadataUri must be a valid https:// URL' });
  }
  if (!ownerPubkey || !isValidPubkey(String(ownerPubkey))) {
    return res.status(400).json({ error: 'ownerPubkey must be a valid Solana base58 public key' });
  }
  if (network !== 'mainnet' && network !== 'devnet') {
    return res.status(400).json({ error: 'network must be "mainnet" or "devnet"' });
  }
  // Custom mints on mainnet require explicit confirmation
  if (network === 'mainnet' && !req.body.confirm_mainnet) {
    return res.status(400).json({
      error: 'Mainnet custom mint requires confirm_mainnet: true in the request body',
      detail: 'Custom mainnet mints are permanent. Set confirm_mainnet: true to proceed.',
    });
  }

  try {
    const result = await mintCoreAsset({
      ownerPubkey: String(ownerPubkey),
      name: String(name),
      uri: String(metadataUri),
      network: network as 'mainnet' | 'devnet',
    });

    res.status(201).json({
      success: true,
      agent: {
        name: String(name),
        metadata_uri: String(metadataUri),
      },
      mint: {
        asset_address: result.assetAddress,
        signature: result.signature,
        owner: ownerPubkey,
        fee_payer: 'platform (gasless)',
        network,
        explorer: result.explorerUrl,
      },
    });
  } catch (e: unknown) {
    const msg = (e as Error).message ?? 'Unknown error';
    const status = msg.includes('not configured') ? 503 : 500;
    res.status(status).json({ error: 'Mint failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/mint/agent/registered — gasless Metaplex Agent Registry mint
// ---------------------------------------------------------------------------
router.post('/api/mint/agent/registered', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after: 3600 });
  }

  const {
    name,
    metadataUri,
    description,
    ownerPubkey,
    network = 'devnet',
    services = [],
    confirm_mainnet,
  } = req.body as {
    name: unknown;
    metadataUri: unknown;
    description: unknown;
    ownerPubkey: unknown;
    network?: string;
    services?: unknown;
    confirm_mainnet?: unknown;
  };

  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 32) {
    return res.status(400).json({ error: 'name must be 1-32 characters' });
  }
  if (!description || typeof description !== 'string' || description.length < 1 || description.length > 500) {
    return res.status(400).json({ error: 'description must be 1-500 characters' });
  }
  if (!metadataUri || !isValidHttpsUrl(String(metadataUri))) {
    return res.status(400).json({ error: 'metadataUri must be a valid https:// URL' });
  }
  if (!ownerPubkey || !isValidPubkey(String(ownerPubkey))) {
    return res.status(400).json({ error: 'ownerPubkey must be a valid Solana base58 public key' });
  }
  if (network !== 'mainnet' && network !== 'devnet') {
    return res.status(400).json({ error: 'network must be "mainnet" or "devnet"' });
  }
  if (network === 'mainnet' && confirm_mainnet !== true) {
    return res.status(400).json({
      error: 'Mainnet registered mint requires confirm_mainnet: true',
      detail: 'Mainnet agent mints are permanent and spend server fee-payer SOL.',
    });
  }

  const parsedServices = Array.isArray(services)
    ? services
        .filter((svc): svc is { name: string; endpoint: string; version?: string } =>
          !!svc &&
          typeof svc === 'object' &&
          typeof (svc as { name?: unknown }).name === 'string' &&
          typeof (svc as { endpoint?: unknown }).endpoint === 'string' &&
          isValidHttpsUrl((svc as { endpoint: string }).endpoint),
        )
        .slice(0, 10)
    : [];

  try {
    const result = await mintRegisteredAgent({
      ownerPubkey: String(ownerPubkey),
      name,
      uri: String(metadataUri),
      description,
      services: parsedServices,
      network: network as 'mainnet' | 'devnet',
    });

    res.status(201).json({
      success: true,
      standard: 'Metaplex Agent Registry',
      agent: {
        name,
        metadata_uri: String(metadataUri),
        registration_uri: result.registrationUri,
      },
      mint: {
        asset_address: result.assetAddress,
        signature: result.signature,
        owner: ownerPubkey,
        agent_wallet: result.agentWallet,
        fee_payer: 'platform (gasless)',
        rpc: network === 'mainnet' ? 'server Helius RPC' : 'server devnet RPC',
        network,
        explorer: result.explorerUrl,
      },
    });
  } catch (e: unknown) {
    const msg = (e as Error).message ?? 'Unknown error';
    const status = msg.includes('not configured') ? 503 : 500;
    res.status(status).json({ error: 'Registered agent mint failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/mint/asset/:address — check a Core asset on-chain
// ---------------------------------------------------------------------------
router.get('/api/mint/asset/:address', async (req: Request, res: Response) => {
  const { address } = req.params as Record<string, string>;
  if (!isValidPubkey(address)) {
    return res.status(400).json({ error: 'Invalid asset address' });
  }

  try {
    const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
    const { fetchAsset, mplCore } = await import('@metaplex-foundation/mpl-core');
    const { publicKey: umiPublicKey } = await import('@metaplex-foundation/umi');

    const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
    const umi = createUmi(rpcUrl).use(mplCore());

    const asset = await fetchAsset(umi, umiPublicKey(address));

    res.set({ 'Cache-Control': 'public, max-age=30' }).json({
      address,
      name: asset.name,
      uri: asset.uri,
      owner: asset.owner.toString(),
      update_authority: asset.updateAuthority,
      explorer: `https://explorer.solana.com/address/${address}`,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message ?? 'Unknown error';
    res.status(404).json({ error: 'Asset not found or fetch failed', detail: msg });
  }
});

export default router;
