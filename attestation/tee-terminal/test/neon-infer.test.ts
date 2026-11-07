import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAttestationEnv } from '../src/load-env';
import { completeWithNeon, shouldUseNeon, NEON_MODEL_ID } from '../src/neon';

loadAttestationEnv();

test('default and !ai prompts use Neon; explicit provider flags do not', () => {
  assert.equal(shouldUseNeon('Explain Serverless Postgres.'), true);
  assert.equal(shouldUseNeon('!ai Explain Serverless Postgres.'), true);
  assert.equal(shouldUseNeon('!ai --openai Explain Serverless Postgres.'), false);
  assert.equal(shouldUseNeon('!ai --claude Explain Serverless Postgres.'), false);
});

test('Neon completion returns live text for Explain Serverless Postgres.', { timeout: 120_000 }, async () => {
  loadAttestationEnv();
  const result = await completeWithNeon('Explain Serverless Postgres.');
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.trim().length > 0, 'completion text is empty');
  assert.equal(result.text.startsWith('[demo'), false);
  assert.equal(result.modelId, 'claude-opus-5-5');
  assert.equal(result.modelId, NEON_MODEL_ID);
});
