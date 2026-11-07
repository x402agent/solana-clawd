import test from 'node:test';
import assert from 'node:assert/strict';
import { neonGatewayConfigured, completeWithNeon, shouldUseNeon, NEON_MODEL_ID } from '../src/neon';

test('default and !ai prompts use Neon only when the gateway env is set', () => {
  const previousUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
  const previousToken = process.env.NEON_AI_GATEWAY_TOKEN;
  delete process.env.NEON_AI_GATEWAY_BASE_URL;
  delete process.env.NEON_AI_GATEWAY_TOKEN;
  try {
    assert.equal(shouldUseNeon('Explain Serverless Postgres.'), false);
    process.env.NEON_AI_GATEWAY_BASE_URL = 'https://example.invalid/gateway';
    process.env.NEON_AI_GATEWAY_TOKEN = 'placeholder-not-a-secret';
    assert.equal(neonGatewayConfigured(), true);
    assert.equal(shouldUseNeon('Explain Serverless Postgres.'), true);
    assert.equal(shouldUseNeon('!ai Explain Serverless Postgres.'), true);
    assert.equal(shouldUseNeon('!ai --openai Explain Serverless Postgres.'), false);
    assert.equal(shouldUseNeon('!ai --claude Explain Serverless Postgres.'), false);
  } finally {
    if (previousUrl === undefined) delete process.env.NEON_AI_GATEWAY_BASE_URL;
    else process.env.NEON_AI_GATEWAY_BASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.NEON_AI_GATEWAY_TOKEN;
    else process.env.NEON_AI_GATEWAY_TOKEN = previousToken;
  }
});

test('Neon completion stays optional when no gateway credentials are configured', { timeout: 120_000 }, async () => {
  if (!neonGatewayConfigured() || process.env.TEE_NEON_LIVE_TEST !== 'true') {
    assert.equal(NEON_MODEL_ID, 'claude-opus-5-5');
    return;
  }
  const result = await completeWithNeon('Explain Serverless Postgres.');
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.trim().length > 0, 'completion text is empty');
  assert.equal(result.text.startsWith('[demo'), false);
  assert.equal(result.modelId, NEON_MODEL_ID);
});
