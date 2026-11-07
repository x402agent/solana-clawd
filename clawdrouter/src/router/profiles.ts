/**
 * ClawdRouter — Routing Profiles
 * ECO / AUTO / PREMIUM strategies for model selection
 */

import type {
  RoutingProfile,
  RequestTier,
  ModelEntry,
  ScoredRequest,
} from '../types.js';
import { TIER_MAPPING, getModel, getEnabledModels, estimateCostPerRequest } from '../models/registry.js';

// ── Route a scored request to a specific model ──────────────────────

export function routeRequest(
  scored: ScoredRequest,
  profile: RoutingProfile,
  excludedModels: string[] = [],
): { model: ModelEntry; fallback: boolean } {
  const tier = scored.tier;
  const mapping = TIER_MAPPING[tier];
  const targetModelId = mapping[profile];
  const targetModel = getModel(targetModelId);

  // Check if target model is available and not excluded
  if (targetModel && targetModel.enabled && !isExcluded(targetModel.id, excludedModels)) {
    return { model: targetModel, fallback: false };
  }

  // Fallback: find best available model in the same tier
  const fallbackModel = findFallback(tier, profile, excludedModels);
  return { model: fallbackModel, fallback: true };
}

// ── Fallback Model Selection ────────────────────────────────────────

function findFallback(
  tier: RequestTier,
  profile: RoutingProfile,
  excludedModels: string[],
): ModelEntry {
  const available = getEnabledModels().filter(model => !isExcluded(model.id, excludedModels));

  // Sort by profile preference
  const sorted = [...available].sort((a, b) => {
    switch (profile) {
      case 'eco':
        // Cheapest first
        return estimateCostPerRequest(a) - estimateCostPerRequest(b);
      case 'premium':
        // Highest quality first
        return b.qualityScore - a.qualityScore;
      case 'auto':
      default:
        // Balance: quality / cost ratio
        const costA = estimateCostPerRequest(a) || 0.0001; // avoid div by zero
        const costB = estimateCostPerRequest(b) || 0.0001;
        return (b.qualityScore / costB) - (a.qualityScore / costA);
    }
  });

  // Filter by tier requirements
  const tierFiltered = sorted.filter(m => modelFitsTier(m, tier));

  if (tierFiltered.length > 0) return tierFiltered[0]!;

  throw new Error(`No enabled, non-excluded model can handle ${tier} requests`);
}

// ── Tier Fitness Check ──────────────────────────────────────────────

function modelFitsTier(model: ModelEntry, tier: RequestTier): boolean {
  switch (tier) {
    case 'SIMPLE':
      // Any model works for simple requests, prefer budget
      return model.tier === 'budget' || model.tier === 'mid';

    case 'MEDIUM':
      // Mid-range or better
      return model.qualityScore >= 60;

    case 'COMPLEX':
      // Needs high quality
      return model.qualityScore >= 75;

    case 'REASONING':
      // Must support reasoning
      return model.features.includes('reasoning') && model.qualityScore >= 70;

    default:
      return true;
  }
}

function isExcluded(modelId: string, excludedModels: string[]): boolean {
  return excludedModels.some(ex =>
    modelId.toLowerCase().includes(ex.toLowerCase())
  );
}

// ── Profile Descriptions ────────────────────────────────────────────

export const PROFILE_INFO: Record<RoutingProfile, {
  name: string;
  emoji: string;
  description: string;
  savings: string;
  bestFor: string;
}> = {
  eco: {
    name: 'ECO',
    emoji: '🌿',
    description: 'Cheapest possible model for each tier',
    savings: '95-100%',
    bestFor: 'Maximum savings, batch processing',
  },
  auto: {
    name: 'AUTO',
    emoji: '⚡',
    description: 'Balanced quality/cost (default)',
    savings: '74-100%',
    bestFor: 'General use, coding, analysis',
  },
  premium: {
    name: 'PREMIUM',
    emoji: '👑',
    description: 'Highest quality models only',
    savings: '0%',
    bestFor: 'Mission-critical, complex reasoning',
  },
};

export function formatProfileTable(): string {
  const lines: string[] = [''];
  lines.push('  📊 Routing Profiles');
  lines.push('  ═════════════════════════════════════════════════════');
  lines.push('');

  for (const [key, info] of Object.entries(PROFILE_INFO)) {
    lines.push(`  ${info.emoji} ${info.name.padEnd(10)} ${info.description}`);
    lines.push(`     Savings: ${info.savings.padEnd(10)} Best for: ${info.bestFor}`);
    lines.push('');
  }

  lines.push('  Tier Routing:');
  lines.push('  ─────────────────────────────────────────────────────');
  lines.push('  Tier       ECO                          AUTO                          PREMIUM');
  lines.push('  ─────────────────────────────────────────────────────────────────────────────');

  for (const [tier, mapping] of Object.entries(TIER_MAPPING)) {
    const eco = mapping.eco.split('/')[1] ?? mapping.eco;
    const auto = mapping.auto.split('/')[1] ?? mapping.auto;
    const premium = mapping.premium.split('/')[1] ?? mapping.premium;
    lines.push(`  ${tier.padEnd(10)} ${eco.padEnd(28)} ${auto.padEnd(28)} ${premium}`);
  }

  return lines.join('\n');
}
