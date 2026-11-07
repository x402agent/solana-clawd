/**
 * ClawdRouter Model Registry
 * 55+ models across 9 providers, organized by tier and pricing
 * Solana-native routing for the solana-clawd ecosystem
 */

import type { ModelEntry, TierMapping, RequestTier } from '../types.js';

// ── Budget Models (under $0.001/request) ────────────────────────────

const BUDGET_MODELS: ModelEntry[] = [
  // NVIDIA free tier
  {
    id: 'nvidia/gpt-oss-120b',
    provider: 'nvidia', name: 'GPT-OSS 120B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 128_000, features: [], tier: 'budget',
    qualityScore: 55, speedMs: 800, enabled: true, free: true,
  },
  {
    id: 'nvidia/gpt-oss-20b',
    provider: 'nvidia', name: 'GPT-OSS 20B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 128_000, features: [], tier: 'budget',
    qualityScore: 40, speedMs: 400, enabled: true, free: true,
  },
  {
    id: 'nvidia/nemotron-ultra-253b',
    provider: 'nvidia', name: 'Nemotron Ultra 253B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['reasoning'], tier: 'budget',
    qualityScore: 72, speedMs: 1200, enabled: true, free: true,
  },
  {
    id: 'nvidia/nemotron-3-super-120b',
    provider: 'nvidia', name: 'Nemotron 3 Super 120B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['reasoning'], tier: 'budget',
    qualityScore: 65, speedMs: 900, enabled: true, free: true,
  },
  {
    id: 'nvidia/nemotron-super-49b',
    provider: 'nvidia', name: 'Nemotron Super 49B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['reasoning'], tier: 'budget',
    qualityScore: 58, speedMs: 600, enabled: true, free: true,
  },
  {
    id: 'nvidia/deepseek-v3.2',
    provider: 'nvidia', name: 'DeepSeek V3.2 (NVIDIA)',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['reasoning'], tier: 'budget',
    qualityScore: 70, speedMs: 700, enabled: true, free: true,
  },
  {
    id: 'nvidia/mistral-large-3-675b',
    provider: 'nvidia', name: 'Mistral Large 3 675B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['reasoning'], tier: 'budget',
    qualityScore: 68, speedMs: 1400, enabled: true, free: true,
  },
  {
    id: 'nvidia/qwen3-coder-480b',
    provider: 'nvidia', name: 'Qwen3 Coder 480B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['code'], tier: 'budget',
    qualityScore: 66, speedMs: 1100, enabled: true, free: true,
  },
  {
    id: 'nvidia/devstral-2-123b',
    provider: 'nvidia', name: 'Devstral 2 123B',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['code'], tier: 'budget',
    qualityScore: 64, speedMs: 850, enabled: true, free: true,
  },
  {
    id: 'nvidia/glm-4.7',
    provider: 'nvidia', name: 'GLM 4.7 (NVIDIA)',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['reasoning'], tier: 'budget',
    qualityScore: 62, speedMs: 750, enabled: true, free: true,
  },
  {
    id: 'nvidia/llama-4-maverick',
    provider: 'nvidia', name: 'Llama 4 Maverick',
    inputPricePerM: 0, outputPricePerM: 0,
    contextWindow: 131_000, features: ['reasoning'], tier: 'budget',
    qualityScore: 67, speedMs: 900, enabled: true, free: true,
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    provider: 'google', name: 'Gemini 3.1 Flash Lite',
    inputPricePerM: 0.25, outputPricePerM: 1.50,
    contextWindow: 1_000_000, features: ['tools'], tier: 'budget',
    qualityScore: 70, speedMs: 250, enabled: true, free: false,
  },

  // Low-cost paid models
  {
    id: 'openai/gpt-5-nano',
    provider: 'openai', name: 'GPT-5 Nano',
    inputPricePerM: 0.05, outputPricePerM: 0.40,
    contextWindow: 128_000, features: ['tools'], tier: 'budget',
    qualityScore: 60, speedMs: 250, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-4.1-nano',
    provider: 'openai', name: 'GPT-4.1 Nano',
    inputPricePerM: 0.10, outputPricePerM: 0.40,
    contextWindow: 128_000, features: ['tools'], tier: 'budget',
    qualityScore: 58, speedMs: 280, enabled: true, free: false,
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    provider: 'google', name: 'Gemini 2.5 Flash Lite',
    inputPricePerM: 0.10, outputPricePerM: 0.40,
    contextWindow: 1_000_000, features: ['tools'], tier: 'budget',
    qualityScore: 62, speedMs: 200, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-4o-mini',
    provider: 'openai', name: 'GPT-4o Mini',
    inputPricePerM: 0.15, outputPricePerM: 0.60,
    contextWindow: 128_000, features: ['tools'], tier: 'budget',
    qualityScore: 65, speedMs: 300, enabled: true, free: false,
  },
  {
    id: 'xai/grok-4-fast',
    provider: 'xai', name: 'Grok 4 Fast',
    inputPricePerM: 0.20, outputPricePerM: 0.50,
    contextWindow: 131_000, features: ['tools'], tier: 'budget',
    qualityScore: 64, speedMs: 350, enabled: true, free: false,
  },
  {
    id: 'xai/grok-4-fast-reasoning',
    provider: 'xai', name: 'Grok 4 Fast Reasoning',
    inputPricePerM: 0.20, outputPricePerM: 0.50,
    contextWindow: 131_000, features: ['reasoning', 'tools'], tier: 'budget',
    qualityScore: 70, speedMs: 500, enabled: true, free: false,
  },
  {
    id: 'xai/grok-4-1-fast',
    provider: 'xai', name: 'Grok 4.1 Fast',
    inputPricePerM: 0.20, outputPricePerM: 0.50,
    contextWindow: 131_000, features: ['tools'], tier: 'budget',
    qualityScore: 66, speedMs: 320, enabled: true, free: false,
  },
  {
    id: 'xai/grok-4-1-fast-reasoning',
    provider: 'xai', name: 'Grok 4.1 Fast Reasoning',
    inputPricePerM: 0.20, outputPricePerM: 0.50,
    contextWindow: 131_000, features: ['reasoning', 'tools'], tier: 'budget',
    qualityScore: 72, speedMs: 480, enabled: true, free: false,
  },
  {
    id: 'xai/grok-4-0709',
    provider: 'xai', name: 'Grok 4 0709',
    inputPricePerM: 0.20, outputPricePerM: 1.50,
    contextWindow: 131_000, features: ['reasoning', 'tools'], tier: 'budget',
    qualityScore: 74, speedMs: 600, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-5-mini',
    provider: 'openai', name: 'GPT-5 Mini',
    inputPricePerM: 0.25, outputPricePerM: 2.00,
    contextWindow: 200_000, features: ['tools'], tier: 'budget',
    qualityScore: 72, speedMs: 400, enabled: true, free: false,
  },
  // DeepSeek — cheapest frontier, Anthropic-compatible endpoint
  {
    id: 'deepseek/deepseek-v4-flash',
    provider: 'deepseek', name: 'DeepSeek V4 Flash',
    inputPricePerM: 0.27, outputPricePerM: 1.10,
    contextWindow: 128_000, features: ['tools', 'agentic'], tier: 'budget',
    qualityScore: 78, speedMs: 350, enabled: true, free: false,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    provider: 'deepseek', name: 'DeepSeek V4 Pro',
    inputPricePerM: 0.55, outputPricePerM: 2.19,
    contextWindow: 128_000, features: ['reasoning', 'tools', 'agentic'], tier: 'budget',
    qualityScore: 88, speedMs: 900, enabled: true, free: false,
  },
  // Legacy DeepSeek aliases (kept for compatibility)
  {
    id: 'deepseek/deepseek-chat',
    provider: 'deepseek', name: 'DeepSeek Chat (legacy)',
    inputPricePerM: 0.28, outputPricePerM: 0.42,
    contextWindow: 128_000, features: ['tools'], tier: 'budget',
    qualityScore: 68, speedMs: 450, enabled: true, free: false,
  },
  {
    id: 'deepseek/deepseek-reasoner',
    provider: 'deepseek', name: 'DeepSeek Reasoner (legacy)',
    inputPricePerM: 0.28, outputPricePerM: 0.42,
    contextWindow: 128_000, features: ['reasoning', 'tools'], tier: 'budget',
    qualityScore: 74, speedMs: 700, enabled: true, free: false,
  },
  {
    id: 'xai/grok-3-mini',
    provider: 'xai', name: 'Grok 3 Mini',
    inputPricePerM: 0.30, outputPricePerM: 0.50,
    contextWindow: 131_000, features: ['tools'], tier: 'budget',
    qualityScore: 60, speedMs: 350, enabled: true, free: false,
  },
  {
    id: 'minimax/minimax-m2.7',
    provider: 'minimax', name: 'MiniMax M2.7',
    inputPricePerM: 0.30, outputPricePerM: 1.20,
    contextWindow: 205_000, features: ['reasoning', 'agentic', 'tools'], tier: 'budget',
    qualityScore: 70, speedMs: 550, enabled: true, free: false,
  },
  {
    id: 'minimax/minimax-m2.5',
    provider: 'minimax', name: 'MiniMax M2.5',
    inputPricePerM: 0.30, outputPricePerM: 1.20,
    contextWindow: 205_000, features: ['reasoning', 'agentic', 'tools'], tier: 'budget',
    qualityScore: 68, speedMs: 500, enabled: true, free: false,
  },
  {
    id: 'google/gemini-2.5-flash',
    provider: 'google', name: 'Gemini 2.5 Flash',
    inputPricePerM: 0.30, outputPricePerM: 2.50,
    contextWindow: 1_000_000, features: ['vision', 'tools'], tier: 'budget',
    qualityScore: 75, speedMs: 300, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'openai', name: 'GPT-4.1 Mini',
    inputPricePerM: 0.40, outputPricePerM: 1.60,
    contextWindow: 128_000, features: ['tools'], tier: 'budget',
    qualityScore: 70, speedMs: 320, enabled: true, free: false,
  },
  {
    id: 'google/gemini-3-flash-preview',
    provider: 'google', name: 'Gemini 3 Flash Preview',
    inputPricePerM: 0.50, outputPricePerM: 3.00,
    contextWindow: 1_000_000, features: ['vision'], tier: 'budget',
    qualityScore: 76, speedMs: 350, enabled: true, free: false,
  },
  {
    id: 'nvidia/kimi-k2.5',
    provider: 'nvidia', name: 'Kimi K2.5 (NVIDIA)',
    inputPricePerM: 0.55, outputPricePerM: 2.50,
    contextWindow: 262_000, features: ['tools'], tier: 'budget',
    qualityScore: 73, speedMs: 450, enabled: true, free: false,
  },
  {
    id: 'moonshot/kimi-k2.5',
    provider: 'moonshot', name: 'Kimi K2.5',
    inputPricePerM: 0.60, outputPricePerM: 3.00,
    contextWindow: 262_000, features: ['reasoning', 'vision', 'agentic', 'tools'], tier: 'budget',
    qualityScore: 75, speedMs: 500, enabled: true, free: false,
  },
];

// ── Mid-Range Models ($0.001–$0.01/request) ─────────────────────────

const MID_MODELS: ModelEntry[] = [
  {
    id: 'anthropic/claude-haiku-4.5',
    provider: 'anthropic', name: 'Claude Haiku 4.5',
    inputPricePerM: 1.00, outputPricePerM: 5.00,
    contextWindow: 200_000, features: ['vision', 'agentic', 'tools'], tier: 'mid',
    qualityScore: 78, speedMs: 300, enabled: true, free: false,
  },
  {
    id: 'zai/glm-5',
    provider: 'zai', name: 'GLM-5',
    inputPricePerM: 1.00, outputPricePerM: 3.20,
    contextWindow: 200_000, features: ['tools'], tier: 'mid',
    qualityScore: 72, speedMs: 500, enabled: true, free: false,
  },
  {
    id: 'openai/o1-mini',
    provider: 'openai', name: 'O1 Mini',
    inputPricePerM: 1.10, outputPricePerM: 4.40,
    contextWindow: 128_000, features: ['reasoning', 'tools'], tier: 'mid',
    qualityScore: 80, speedMs: 800, enabled: true, free: false,
  },
  {
    id: 'openai/o3-mini',
    provider: 'openai', name: 'O3 Mini',
    inputPricePerM: 1.10, outputPricePerM: 4.40,
    contextWindow: 128_000, features: ['reasoning', 'tools'], tier: 'mid',
    qualityScore: 82, speedMs: 750, enabled: true, free: false,
  },
  {
    id: 'openai/o4-mini',
    provider: 'openai', name: 'O4 Mini',
    inputPricePerM: 1.10, outputPricePerM: 4.40,
    contextWindow: 128_000, features: ['reasoning', 'tools'], tier: 'mid',
    qualityScore: 84, speedMs: 700, enabled: true, free: false,
  },
  {
    id: 'zai/glm-5-turbo',
    provider: 'zai', name: 'GLM-5 Turbo',
    inputPricePerM: 1.20, outputPricePerM: 4.00,
    contextWindow: 200_000, features: ['tools'], tier: 'mid',
    qualityScore: 74, speedMs: 400, enabled: true, free: false,
  },
  {
    id: 'google/gemini-2.5-pro',
    provider: 'google', name: 'Gemini 2.5 Pro',
    inputPricePerM: 1.25, outputPricePerM: 10.00,
    contextWindow: 1_000_000, features: ['reasoning', 'vision', 'tools'], tier: 'mid',
    qualityScore: 88, speedMs: 600, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-5.2',
    provider: 'openai', name: 'GPT-5.2',
    inputPricePerM: 1.75, outputPricePerM: 14.00,
    contextWindow: 400_000, features: ['reasoning', 'vision', 'agentic', 'tools'], tier: 'mid',
    qualityScore: 90, speedMs: 500, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-5.3',
    provider: 'openai', name: 'GPT-5.3',
    inputPricePerM: 1.75, outputPricePerM: 14.00,
    contextWindow: 128_000, features: ['reasoning', 'vision', 'agentic', 'tools'], tier: 'mid',
    qualityScore: 91, speedMs: 480, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-5.3-codex',
    provider: 'openai', name: 'GPT-5.3 Codex',
    inputPricePerM: 1.75, outputPricePerM: 14.00,
    contextWindow: 400_000, features: ['agentic', 'tools', 'code'], tier: 'mid',
    qualityScore: 92, speedMs: 450, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-4.1',
    provider: 'openai', name: 'GPT-4.1',
    inputPricePerM: 2.00, outputPricePerM: 8.00,
    contextWindow: 128_000, features: ['vision', 'tools'], tier: 'mid',
    qualityScore: 85, speedMs: 400, enabled: true, free: false,
  },
  {
    id: 'openai/o3',
    provider: 'openai', name: 'O3',
    inputPricePerM: 2.00, outputPricePerM: 8.00,
    contextWindow: 200_000, features: ['reasoning', 'tools'], tier: 'mid',
    qualityScore: 88, speedMs: 1200, enabled: true, free: false,
  },
  {
    id: 'google/gemini-3-pro-preview',
    provider: 'google', name: 'Gemini 3 Pro Preview',
    inputPricePerM: 2.00, outputPricePerM: 12.00,
    contextWindow: 1_000_000, features: ['reasoning', 'vision', 'tools'], tier: 'mid',
    qualityScore: 89, speedMs: 700, enabled: true, free: false,
  },
  {
    id: 'google/gemini-3.1-pro',
    provider: 'google', name: 'Gemini 3.1 Pro',
    inputPricePerM: 2.00, outputPricePerM: 12.00,
    contextWindow: 1_000_000, features: ['reasoning', 'vision', 'tools'], tier: 'mid',
    qualityScore: 90, speedMs: 650, enabled: true, free: false,
  },
  {
    id: 'xai/grok-2-vision',
    provider: 'xai', name: 'Grok 2 Vision',
    inputPricePerM: 2.00, outputPricePerM: 10.00,
    contextWindow: 131_000, features: ['vision', 'tools'], tier: 'mid',
    qualityScore: 80, speedMs: 500, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-4o',
    provider: 'openai', name: 'GPT-4o',
    inputPricePerM: 2.50, outputPricePerM: 10.00,
    contextWindow: 128_000, features: ['vision', 'agentic', 'tools'], tier: 'mid',
    qualityScore: 86, speedMs: 400, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-5.4',
    provider: 'openai', name: 'GPT-5.4',
    inputPricePerM: 2.50, outputPricePerM: 15.00,
    contextWindow: 400_000, features: ['reasoning', 'vision', 'agentic', 'tools'], tier: 'mid',
    qualityScore: 93, speedMs: 550, enabled: true, free: false,
  },
];

// ── Premium Models ($0.01+/request) ─────────────────────────────────

const PREMIUM_MODELS: ModelEntry[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    provider: 'anthropic', name: 'Claude Sonnet 4.6',
    inputPricePerM: 3.00, outputPricePerM: 15.00,
    contextWindow: 200_000, features: ['reasoning', 'vision', 'agentic', 'tools', 'solana'], tier: 'premium',
    qualityScore: 94, speedMs: 500, enabled: true, free: false,
  },
  {
    id: 'xai/grok-3',
    provider: 'xai', name: 'Grok 3',
    inputPricePerM: 3.00, outputPricePerM: 15.00,
    contextWindow: 131_000, features: ['reasoning', 'tools'], tier: 'premium',
    qualityScore: 88, speedMs: 700, enabled: true, free: false,
  },
  {
    id: 'anthropic/claude-opus-4.6',
    provider: 'anthropic', name: 'Claude Opus 4.6',
    inputPricePerM: 5.00, outputPricePerM: 25.00,
    contextWindow: 200_000, features: ['reasoning', 'vision', 'agentic', 'tools', 'solana'], tier: 'premium',
    qualityScore: 97, speedMs: 800, enabled: true, free: false,
  },
  {
    id: 'openai/o1',
    provider: 'openai', name: 'O1',
    inputPricePerM: 15.00, outputPricePerM: 60.00,
    contextWindow: 200_000, features: ['reasoning', 'tools'], tier: 'premium',
    qualityScore: 95, speedMs: 2000, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-5.2-pro',
    provider: 'openai', name: 'GPT-5.2 Pro',
    inputPricePerM: 21.00, outputPricePerM: 168.00,
    contextWindow: 400_000, features: ['reasoning', 'tools'], tier: 'premium',
    qualityScore: 96, speedMs: 1500, enabled: true, free: false,
  },
  {
    id: 'openai/gpt-5.4-pro',
    provider: 'openai', name: 'GPT-5.4 Pro',
    inputPricePerM: 30.00, outputPricePerM: 180.00,
    contextWindow: 400_000, features: ['reasoning', 'tools'], tier: 'premium',
    qualityScore: 98, speedMs: 1800, enabled: true, free: false,
  },
];

// ── Full Registry ───────────────────────────────────────────────────

export const MODEL_REGISTRY: ModelEntry[] = [
  ...BUDGET_MODELS,
  ...MID_MODELS,
  ...PREMIUM_MODELS,
];

// ── Tier → Model Mapping ────────────────────────────────────────────

export const TIER_MAPPING: Record<RequestTier, TierMapping> = {
  SIMPLE: {
    eco: 'nvidia/gpt-oss-120b',          // free model for simple requests
    auto: 'google/gemini-2.5-flash',
    premium: 'nvidia/kimi-k2.5',
  },
  MEDIUM: {
    eco: 'deepseek/deepseek-v4-flash',   // fast + cheap for agentic tasks
    auto: 'nvidia/kimi-k2.5',
    premium: 'openai/gpt-5.3-codex',
  },
  COMPLEX: {
    eco: 'google/gemini-2.5-flash-lite',
    auto: 'google/gemini-3.1-pro',
    premium: 'anthropic/claude-opus-4.6',
  },
  REASONING: {
    eco: 'deepseek/deepseek-v4-pro',     // thinking mode at eco price
    auto: 'xai/grok-4-1-fast-reasoning',
    premium: 'anthropic/claude-sonnet-4.6',
  },
};

// ── Helper functions ────────────────────────────────────────────────

export function getModel(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find(m => m.id === id);
}

export function getEnabledModels(excludeList: string[] = []): ModelEntry[] {
  return MODEL_REGISTRY.filter(m =>
    m.enabled && !excludeList.some(ex => m.id.includes(ex))
  );
}

export function getFreeModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.free && m.enabled);
}

export function getModelsByProvider(provider: string): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.provider === provider && m.enabled);
}

export function getModelsByFeature(feature: string): ModelEntry[] {
  return MODEL_REGISTRY.filter(m =>
    m.features.includes(feature as any) && m.enabled
  );
}

export function estimateCostPerRequest(model: ModelEntry, inputTokens = 500, outputTokens = 500): number {
  return (model.inputPricePerM * inputTokens + model.outputPricePerM * outputTokens) / 1_000_000;
}

export function resolveModelAlias(alias: string): string | null {
  const ALIASES: Record<string, string> = {
    'auto': 'clawdrouter/auto',
    'free': 'nvidia/nemotron-ultra-253b',
    'nemotron': 'nvidia/nemotron-ultra-253b',
    // DeepSeek — primary provider
    'deepseek': 'deepseek/deepseek-v4-flash',
    'deepseek-flash': 'deepseek/deepseek-v4-flash',
    'deepseek-pro': 'deepseek/deepseek-v4-pro',
    'deepseek-think': 'deepseek/deepseek-v4-pro',
    'deepseek-free': 'nvidia/deepseek-v3.2',
    'devstral': 'nvidia/devstral-2-123b',
    'grok-4': 'xai/grok-4-1-fast',
    'grok': 'xai/grok-4-1-fast-reasoning',
    'claude': 'anthropic/claude-sonnet-4.6',
    'opus': 'anthropic/claude-opus-4.6',
    'sonnet': 'anthropic/claude-sonnet-4.6',
    'haiku': 'anthropic/claude-haiku-4.5',
    'gpt5': 'openai/gpt-5.3',
    'gpt-5': 'openai/gpt-5.3',
    'o3': 'openai/o3',
    'o4': 'openai/o4-mini',
    'gemini': 'google/gemini-2.5-pro',
    'flash': 'google/gemini-2.5-flash',
    'kimi': 'moonshot/kimi-k2.5',
    'br-sonnet': 'anthropic/claude-sonnet-4.6',
    'br-opus': 'anthropic/claude-opus-4.6',
  };

  return ALIASES[alias.toLowerCase()] ?? null;
}

export function formatModelTable(): string {
  const lines: string[] = [''];
  lines.push('  📊 ClawdRouter Model Registry');
  lines.push('  ═══════════════════════════════════════════════════════════════');
  lines.push('');

  const sections = [
    { title: '🆓 Free Models', models: MODEL_REGISTRY.filter(m => m.free) },
    { title: '💰 Budget Models', models: BUDGET_MODELS.filter(m => !m.free) },
    { title: '⚡ Mid-Range Models', models: MID_MODELS },
    { title: '👑 Premium Models', models: PREMIUM_MODELS },
  ];

  for (const { title, models } of sections) {
    lines.push(`  ${title} (${models.length})`);
    lines.push('  ───────────────────────────────────────────────────────────────');
    for (const m of models) {
      const cost = m.free ? 'FREE' : `$${m.inputPricePerM}/$${m.outputPricePerM}`;
      const features = m.features.length > 0 ? ` [${m.features.join(', ')}]` : '';
      lines.push(`  ${m.id.padEnd(35)} ${cost.padEnd(15)} ${(m.contextWindow / 1000).toFixed(0)}K${features}`);
    }
    lines.push('');
  }

  lines.push(`  Total: ${MODEL_REGISTRY.length} models across ${new Set(MODEL_REGISTRY.map(m => m.provider)).size} providers`);
  return lines.join('\n');
}
