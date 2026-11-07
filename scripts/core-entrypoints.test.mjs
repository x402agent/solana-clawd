import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const providerKeys = ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'];

function cli(...args) {
  return spawnSync(process.execPath, [resolve(root, 'dist/entrypoints/clawd.js'), ...args], {
    cwd: root,
    env: { ...process.env, ...Object.fromEntries(providerKeys.map(key => [key, ''])) },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

async function withProvider(name, fn) {
  const saved = Object.fromEntries(providerKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of providerKeys) delete process.env[key];
  process.env[name] = 'test-provider-key';
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function completion(message) {
  return Response.json({ id: 'test-completion', object: 'chat.completion', created: 0, model: 'test-model', choices: [{ index: 0, finish_reason: 'stop', message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

test('published root entrypoints work without a provider or wallet', async () => {
  for (const args of [['--help'], ['--version'], ['spinners'], ['demo'], ['birth', 'lobster'], ['runtime', '--help']]) {
    const result = cli(...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.match(cli('--version').stdout, new RegExp(version.replaceAll('.', '\\.')));
  assert.equal(cli('missing-command').status, 1);
  assert.equal(cli('birth', 'missing-species').status, 1);
  const api = await import('solana-clawd');
  assert.equal(typeof api.resolveProvider, 'function');
  assert.equal(typeof api.execTool, 'function');
  assert.ok(api.CLAWD_SPINNERS.clawdSpin.frames.length > 1);
  assert.equal(typeof (await import('solana-clawd/buddy')).createBlockchainBuddy, 'function');
  assert.equal(typeof (await import('solana-clawd/metaplex')).spawnOnchain, 'function');
});

test('Anthropic credentials use the Messages API and translate tool schemas', async () => {
  await withProvider('ANTHROPIC_API_KEY', async () => {
    const { resolveOpenAIClient, thinkingCall, singleToolCall } = await import('../dist/providers/deepseek.js');
    assert.throws(resolveOpenAIClient, /Messages API/);
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json({ id: 'test-message', type: 'message', role: 'assistant', model: 'test-model', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: calls.length === 1 ? [{ type: 'text', text: 'Test answer' }] : [{ type: 'tool_use', id: 'test-tool', name: 'hold', input: { reason: 'test' } }] });
    };
    assert.equal((await thinkingCall({ system: 'test', userMessage: 'test' })).content, 'Test answer');
    const selected = await singleToolCall({ system: 'test', userMessage: 'test', tools: [{ type: 'function', function: { name: 'hold', parameters: { type: 'object', properties: { reason: { type: 'string' } } } } }] });
    assert.equal(selected.toolName, 'hold');
    assert.deepEqual(selected.toolInput, { reason: 'test' });
    assert.ok(calls.every(call => new URL(call.url).hostname === 'api.anthropic.com' && new URL(call.url).pathname === '/v1/messages'));
    assert.equal(calls[1].body.tools[0].input_schema.type, 'object');
  });
});

test('agent tools preserve host dry-run policy and report upstream failures', async () => {
  const { execTool } = await import('../dist/tools/solana-agent.js');
  const result = await execTool('ore_deploy', { dryRun: false, squares: [1], amountSol: 0.01 }, { rpc: 'http://localhost:8899', dryRun: true });
  assert.equal(result.success, true);
  assert.equal(result.data.dryRun, true);
  assert.equal((await execTool('unknown', {}, { rpc: 'http://localhost:8899' })).success, false);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    const failedQuote = await execTool('jupiter_swap', { inputMint: 'test', outputMint: 'test', amountLamports: 1 }, { rpc: 'http://localhost:8899', dryRun: true });
    assert.equal(failedQuote.success, false);
    assert.match(failedQuote.error, /503/);
    const failedPortfolio = await execTool('helius_portfolio', {}, { rpc: 'http://localhost:8899', heliusApiKey: 'test-provider-key', wallet: 'test-wallet' });
    assert.equal(failedPortfolio.success, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('multi-turn agent loop returns tool results using matching tool call IDs', async () => {
  await withProvider('DEEPSEEK_API_KEY', async () => {
    const { solanaAgentLoop } = await import('../dist/tools/solana-agent.js');
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (requests.length === 1) return completion({ role: 'assistant', content: null, tool_calls: [{ id: 'portfolio-call', type: 'function', function: { name: 'helius_portfolio', arguments: '{}' } }] });
      return completion({ role: 'assistant', content: 'No provider data, hold.' });
    };
    const result = await solanaAgentLoop({ rpc: 'http://localhost:8899', maxToolCalls: 2 });
    assert.equal(result.action, 'hold');
    assert.deepEqual(result.toolsCalled, ['helius_portfolio', 'hold']);
    const lastMessages = requests[1].messages.slice(-2);
    assert.equal(lastMessages[0].role, 'assistant');
    assert.equal(lastMessages[0].tool_calls[0].id, 'portfolio-call');
    assert.equal(lastMessages[1].role, 'tool');
    assert.equal(lastMessages[1].tool_call_id, 'portfolio-call');
    assert.equal(JSON.parse(lastMessages[1].content).success, false);
  });
});

test('optional dark adapter reports missing actual providers clearly', async () => {
  await assert.rejects(import('../sdk/dist/dark-integration.js'), /DARK_INTEGRATION_UNAVAILABLE/);
});
