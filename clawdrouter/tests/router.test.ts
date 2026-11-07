/**
 * ClawdRouter — Router Tests
 * Tests model routing, profiles, and the registry
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeRequest, PROFILE_INFO } from '../src/router/profiles.js';
import {
  MODEL_REGISTRY,
  getModel,
  getEnabledModels,
  getFreeModels,
  getModelsByProvider,
  getModelsByFeature,
  estimateCostPerRequest,
  resolveModelAlias,
  TIER_MAPPING,
} from '../src/models/registry.js';
import { scoreRequest } from '../src/router/scorer.js';
import type { ScoredRequest, RoutingProfile, RequestTier } from '../src/types.js';

// ── Model Registry ──────────────────────────────────────────────────

describe('Model Registry', () => {
  it('should have 55+ models', () => {
    assert.ok(MODEL_REGISTRY.length >= 55, `Registry has ${MODEL_REGISTRY.length} models, expected 55+`);
  });

  it('should have models from 9 providers', () => {
    const providers = new Set(MODEL_REGISTRY.map(m => m.provider));
    assert.ok(providers.size >= 8, `Got ${providers.size} providers, expected 8+`);
  });

  it('should have 11+ free models', () => {
    const free = getFreeModels();
    assert.ok(free.length >= 11, `Got ${free.length} free models, expected 11+`);
  });

  it('should have all TIER_MAPPING models in registry', () => {
    for (const [tier, mapping] of Object.entries(TIER_MAPPING)) {
      for (const [profile, modelId] of Object.entries(mapping)) {
        const model = getModel(modelId);
        assert.ok(model, `TIER_MAPPING[${tier}][${profile}] = ${modelId} not found in registry`);
      }
    }
  });

  it('should have unique model IDs', () => {
    const ids = MODEL_REGISTRY.map(m => m.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'Duplicate model IDs found');
  });

  it('should have valid quality scores (0-100)', () => {
    for (const m of MODEL_REGISTRY) {
      assert.ok(m.qualityScore >= 0 && m.qualityScore <= 100,
        `${m.id} quality ${m.qualityScore} out of range`);
    }
  });
});

// ── Model Aliases ───────────────────────────────────────────────────

describe('Model Aliases', () => {
  it('should resolve "claude" to claude-sonnet-4.6', () => {
    assert.equal(resolveModelAlias('claude'), 'anthropic/claude-sonnet-4.6');
  });

  it('should resolve "opus" to claude-opus-4.6', () => {
    assert.equal(resolveModelAlias('opus'), 'anthropic/claude-opus-4.6');
  });

  it('should resolve "grok" to grok-4-1-fast-reasoning', () => {
    assert.equal(resolveModelAlias('grok'), 'xai/grok-4-1-fast-reasoning');
  });

  it('should resolve "free" to nemotron-ultra-253b', () => {
    assert.equal(resolveModelAlias('free'), 'nvidia/nemotron-ultra-253b');
  });

  it('should return null for unknown aliases', () => {
    assert.equal(resolveModelAlias('nonexistent-model'), null);
  });
});

// ── Cost Estimation ─────────────────────────────────────────────────

describe('Cost Estimation', () => {
  it('should return 0 for free models', () => {
    const model = getModel('nvidia/gpt-oss-120b')!;
    assert.equal(estimateCostPerRequest(model), 0);
  });

  it('should calculate cost correctly', () => {
    const model = getModel('anthropic/claude-opus-4.6')!;
    // (5.00 * 500 + 25.00 * 500) / 1_000_000 = 0.015
    const cost = estimateCostPerRequest(model);
    assert.equal(cost, 0.015);
  });

  it('should show significant savings for budget models vs opus', () => {
    const opus = getModel('anthropic/claude-opus-4.6')!;
    const flash = getModel('google/gemini-2.5-flash')!;
    const opusCost = estimateCostPerRequest(opus);
    const flashCost = estimateCostPerRequest(flash);
    const savings = 1 - flashCost / opusCost;
    assert.ok(savings > 0.90, `Expected 90%+ savings, got ${(savings * 100).toFixed(0)}%`);
  });
});

// ── Routing ─────────────────────────────────────────────────────────

describe('Routing', () => {
  const profiles: RoutingProfile[] = ['eco', 'auto', 'premium'];
  const tiers: RequestTier[] = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

  for (const profile of profiles) {
    for (const tier of tiers) {
      it(`should route ${tier} requests with ${profile} profile`, () => {
        const scored: ScoredRequest = {
          tier,
          scores: {} as any,
          totalScore: 0.5,
          reasoning: 'test',
        };
        const { model, fallback } = routeRequest(scored, profile);
        assert.ok(model, `No model returned for ${tier}/${profile}`);
        assert.ok(model.id, `Model has no ID for ${tier}/${profile}`);
        assert.ok(model.enabled, `Model ${model.id} is not enabled`);
      });
    }
  }

  it('should route eco to cheapest models', () => {
    const scored: ScoredRequest = {
      tier: 'SIMPLE',
      scores: {} as any,
      totalScore: 0.1,
      reasoning: 'test',
    };
    const { model } = routeRequest(scored, 'eco');
    assert.equal(estimateCostPerRequest(model), 0, 'ECO SIMPLE should be free');
  });

  it('should route premium to high-quality models', () => {
    const scored: ScoredRequest = {
      tier: 'COMPLEX',
      scores: {} as any,
      totalScore: 0.6,
      reasoning: 'test',
    };
    const { model } = routeRequest(scored, 'premium');
    assert.ok(model.qualityScore >= 90, `Premium COMPLEX model quality ${model.qualityScore} should be 90+`);
  });

  it('should handle excluded models with fallback', () => {
    const scored: ScoredRequest = {
      tier: 'SIMPLE',
      scores: {} as any,
      totalScore: 0.1,
      reasoning: 'test',
    };
    // Exclude the default ECO SIMPLE model
    const { model, fallback } = routeRequest(scored, 'eco', ['nvidia/gpt-oss-120b']);
    assert.ok(model, 'Should still return a model when primary is excluded');
    assert.notEqual(model.id, 'nvidia/gpt-oss-120b', 'Should not return excluded model');
  });
});

// ── End-to-End Routing ──────────────────────────────────────────────

describe('End-to-End Routing', () => {
  it('should route a simple greeting cheaply', () => {
    const scored = scoreRequest([{ role: 'user', content: 'Hi there!' }]);
    const { model } = routeRequest(scored, 'auto');
    const cost = estimateCostPerRequest(model);
    assert.ok(cost < 0.005, `Simple greeting should cost < $0.005, got $${cost}`);
  });

  it('should route complex Solana code to capable model', () => {
    const scored = scoreRequest([{
      role: 'user',
      content: 'Design a Solana program with Anchor that implements a bonding curve AMM with PDA-derived vaults, CPI calls to token program, and proper rent exemption handling. Include full error types and access control.',
    }]);
    const { model } = routeRequest(scored, 'auto');
    assert.ok(model.qualityScore >= 70, `Complex Solana code model quality ${model.qualityScore} should be 70+`);
  });
});

// ── Profiles ────────────────────────────────────────────────────────

describe('Profile Info', () => {
  it('should have all three profiles defined', () => {
    assert.ok(PROFILE_INFO.eco);
    assert.ok(PROFILE_INFO.auto);
    assert.ok(PROFILE_INFO.premium);
  });

  it('should have descriptions and emojis', () => {
    for (const [key, info] of Object.entries(PROFILE_INFO)) {
      assert.ok(info.name, `${key} missing name`);
      assert.ok(info.emoji, `${key} missing emoji`);
      assert.ok(info.description, `${key} missing description`);
    }
  });
});


describe('Routing exclusions', () => {
  const scored: ScoredRequest = { tier: 'SIMPLE', scores: {} as any, totalScore: 0.1, reasoning: 'test' };
  it('never restores an explicitly excluded model when no alternatives remain', () => {
    assert.throws(() => routeRequest(scored, 'eco', ['']), /No enabled, non-excluded model/);
  });
  it('applies case insensitive exclusions to fallback models', () => {
    const { model } = routeRequest(scored, 'eco', ['NVIDIA']);
    assert.ok(!model.id.toLowerCase().includes('nvidia'));
  });
});
