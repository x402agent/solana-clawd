/**
 * sdk/src/dark-integration.ts
 *
 * Connects @openclawdsolana/dark-sdk and @openclawdsolana/dark-tee-agents
 * into the CLAWD runtime. Provides:
 *
 *   - DarkClawdClient — shielded wallets, private swaps, oracle pricing
 *   - DarkTeeAgent   — TEE-attested confidential inference with x402 payments + SAS
 *   - darkMcpTools   — read-only MCP tool stubs for the dark-sdk surface
 *
 * Sub-path imports avoid the broken DarkSwap React component
 * (jupiverse-kit does not export `Swap` — only the full index triggers it).
 *
 * Usage:
 *   import { DarkClawdClient, DarkTeeAgent } from './dark-integration.js';
 *
 *   const dark = await DarkClawdClient.create({ heliusApiKey: '...' });
 *   const bundle = DarkTeeAgent.spawn({ agentId: 'hermes-01', owner: walletAddress });
 */

/**
 * Optional provider boundary. These packages are not included in this checkout.
 * Resolve them only when this adapter is imported; the core runtime stays usable.
 * Runtime constructors come from the actual installed providers, never placeholders.
 */
async function importOptionalProvider(specifier: string) {
  try {
    return await import(specifier);
  } catch (cause) {
    const error = new Error(
      `DARK_INTEGRATION_UNAVAILABLE: ${specifier} could not be loaded. ` +
      'The original @openclawdsolana/dark-sdk and dark-tee-agents providers are optional and absent from this workspace. ' +
      'The dark-defi application is a separate project and does not implement this adapter.',
      { cause },
    );
    throw error;
  }
}

const { DarkProtocolClient } = await importOptionalProvider('@openclawdsolana/dark-sdk/dist/client.js');
const { DarkWallet } = await importOptionalProvider('@openclawdsolana/dark-sdk/dist/wallet.js');
const { PrivacyUtils } = await importOptionalProvider('@openclawdsolana/dark-sdk/dist/privacy.js');
const { PrivateSwapManager } = await importOptionalProvider('@openclawdsolana/dark-sdk/dist/swap.js');
const { PriceOracle } = await importOptionalProvider('@openclawdsolana/dark-sdk/dist/oracle.js');
const {
  ConfidentialAgent,
  ConfidentialInferenceClient,
  DarkAttestationService,
  DARK_SCHEMAS,
  PAYMENT_ASSETS,
  generateSigningKeypair,
  toBase58,
} = await importOptionalProvider('@openclawdsolana/dark-tee-agents');

// Provider-specific types cannot be statically validated until the optional
// providers are installed. Instance types are derived from their real loaders.
type DarkProtocolClient = InstanceType<typeof DarkProtocolClient>;
type DarkWallet = InstanceType<typeof DarkWallet>;
type PrivateSwapManager = InstanceType<typeof PrivateSwapManager>;
type PriceOracle = InstanceType<typeof PriceOracle>;
type ConfidentialAgent = InstanceType<typeof ConfidentialAgent>;

// ─── DarkClawdClient ──────────────────────────────────────────────────────────

export interface DarkClawdConfig {
  heliusApiKey: string;
  network?: 'mainnet' | 'devnet';
  jupiterApiKey?: string;
  redpillApiKey?: string;
  rpcUrl?: string;
}

export class DarkClawdClient {
  readonly protocol: DarkProtocolClient;
  private _swap?: PrivateSwapManager;
  private _oracle?: PriceOracle;

  private constructor(
    protocol: DarkProtocolClient,
    private readonly cfg: DarkClawdConfig,
  ) {
    this.protocol = protocol;
  }

  static async create(cfg: DarkClawdConfig): Promise<DarkClawdClient> {
    const sdkCfg = {
      heliusApiKey: cfg.heliusApiKey,
      network: cfg.network ?? 'mainnet',
      useSecureRpc: true,
      jupiterApiKey: cfg.jupiterApiKey,
      redpillApiKey: cfg.redpillApiKey,
      rpcUrl: cfg.rpcUrl,
    };
    const protocol = await DarkProtocolClient.create(sdkCfg);
    return new DarkClawdClient(protocol, cfg);
  }

  async generateWallet(): Promise<{ wallet: DarkWallet; mnemonic: string }> {
    return DarkWallet.generate(this.protocol);
  }

  async restoreWallet(mnemonic: string, accountIndex = 0): Promise<DarkWallet> {
    return DarkWallet.fromMnemonic(this.protocol, mnemonic, accountIndex);
  }

  async generateSaplingWallet(): Promise<{ wallet: unknown; mnemonic: string }> {
    const { SaplingUtils } = await importOptionalProvider('@openclawdsolana/dark-sdk/dist/sapling.js');
    return SaplingUtils.generateWallet();
  }

  get swap(): PrivateSwapManager {
    if (!this._swap) {
      this._swap = new PrivateSwapManager(this.protocol, { jupiterApiKey: this.cfg.jupiterApiKey });
    }
    return this._swap;
  }

  get oracle(): PriceOracle {
    if (!this._oracle) {
      const oracleCfg = {
        heliusApiKey: this.cfg.heliusApiKey,
        jupiterApiKey: this.cfg.jupiterApiKey,
      };
      this._oracle = new PriceOracle(oracleCfg);
    }
    return this._oracle;
  }

  generatePrivacyPrimitives() {
    return {
      commitment: PrivacyUtils.generateCommitment(),
      nullifier: PrivacyUtils.generateNullifier(),
      viewingKey: PrivacyUtils.generateViewingKey(),
    };
  }

  async shieldSol(wallet: DarkWallet, lamports: bigint): Promise<string> {
    const { PublicKey } = await import('@solana/web3.js');
    return wallet.shieldTokens(lamports, PublicKey.default);
  }
}

// ─── DarkTeeAgent ─────────────────────────────────────────────────────────────

export interface DarkTeeAgentSpawnParams {
  agentId: string;
  owner: string;
  model?: string;
  policy?: string;
  network?: 'solana-mainnet' | 'solana-devnet';
  inferencePrice?: bigint;
}

export interface TeeAgentBundle {
  agent: ConfidentialAgent;
  keypair: ReturnType<typeof generateSigningKeypair>;
  address: string;
}

function spawnTeeAgent(params: DarkTeeAgentSpawnParams): TeeAgentBundle {
  const keypair = generateSigningKeypair();
  const address = toBase58(keypair.publicKey);
  const agentCfg = {
    agentId: params.agentId,
    owner: params.owner,
    model: params.model ?? 'phala/deepseek-r1-70b-tee',
    policy: params.policy,
    network: params.network ?? 'solana-devnet',
  };
  const agent = ConfidentialAgent.spawn(agentCfg);
  return { agent, keypair, address };
}

function teePaymentRequirements(
  agent: ConfidentialAgent,
  payTo: string,
  atomicPrice = 10_000n,
) {
  return agent.paymentRequirements({
    payTo,
    asset: PAYMENT_ASSETS.USDC,
    atomicPrice,
    resource: `clawd-tee-inference/${agent.config.agentId}`,
  });
}

async function localInfer(
  bundle: TeeAgentBundle,
  prompt: string,
  atomicPrice = 10_000n,
): Promise<{ text: string; receiptNonce: string }> {
  const { agent, address } = bundle;
  const requirements = teePaymentRequirements(agent, address, atomicPrice);
  const { LocalSignerPayer } = await importOptionalProvider('@openclawdsolana/dark-tee-agents');
  const localPayer = new LocalSignerPayer(bundle.keypair, true);
  const provider = agent.localProvider(
    (req: { prompt: string }) => `[clawd-tee] ${req.prompt}`,
    requirements,
  );
  const client = new ConfidentialInferenceClient({
    enclave: agent.quote,
    payer: localPayer,
    verify: { allowedProviders: ['local-dev'] },
  });
  const { result } = await client.infer(
    { prompt },
    provider,
    requirements.accepts[0]!,
  );
  return {
    text: result.text,
    receiptNonce: agent.attestationNonce.toString(),
  };
}

async function anchorOnChain(params: {
  agent: ConfidentialAgent;
  heliusApiKey: string;
  network?: 'mainnet' | 'devnet';
  payer: { address: string };
  authority: { address: string };
}) {
  const { agent, heliusApiKey, network = 'devnet', payer, authority } = params;
  const sas = DarkAttestationService.fromNetwork(network, heliusApiKey);
  const { credential } = await sas.createCredential({
    payer, authority, authorizedSigners: [authority.address],
  });
  const { schema } = await sas.createSchema({
    payer, authority, credential, def: DARK_SCHEMAS.agentIdentity,
  });
  await sas.attest({
    payer, authority, credential, schema,
    nonce: agent.attestationNonce,
    data: agent.identityData() as unknown as Record<string, unknown>,
    expiryUnixSeconds: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  });
  return { credential, schema };
}

export const DarkTeeAgent = {
  spawn: spawnTeeAgent,
  paymentRequirements: teePaymentRequirements,
  localInfer,
  anchorOnChain,
};

// ─── MCP tool stubs ───────────────────────────────────────────────────────────

export type DarkMcpToolResult = { ok: boolean; data?: unknown; error?: string };

export const darkMcpTools = {
  async getTokenPrice(mint: string, heliusApiKey: string): Promise<DarkMcpToolResult> {
    try {
      const oracle = new PriceOracle({ heliusApiKey });
      const price = await oracle.getPrice(mint);
      return { ok: true, data: price };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  async generateSaplingAddresses(count = 5): Promise<DarkMcpToolResult> {
    try {
      const { SaplingUtils } = await importOptionalProvider('@openclawdsolana/dark-sdk/dist/sapling.js');
      const { wallet } = await SaplingUtils.generateWallet();
      return {
        ok: true,
        data: {
          defaultAddress: wallet.getDefaultAddress().toBase58(),
          diversified: wallet.generateDiversifiedAddresses(count).map((a: { toBase58(): string }) => a.toBase58()),
        },
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  async spawnTeeAgent(agentId: string, owner: string): Promise<DarkMcpToolResult> {
    try {
      const bundle = DarkTeeAgent.spawn({ agentId, owner });
      return {
        ok: true,
        data: {
          agentId,
          address: bundle.address,
          quote: bundle.agent.quote,
          identityData: bundle.agent.identityData(),
          attestationNonce: bundle.agent.attestationNonce.toString(),
        },
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  async sealedInfer(agentId: string, owner: string, prompt: string): Promise<DarkMcpToolResult> {
    try {
      const bundle = DarkTeeAgent.spawn({ agentId, owner });
      const result = await DarkTeeAgent.localInfer(bundle, prompt);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
};

export { PrivacyUtils, PAYMENT_ASSETS, DARK_SCHEMAS, generateSigningKeypair, toBase58 };
