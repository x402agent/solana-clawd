import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { availablePort, portNumber, startStack } from './stack.mjs';

test('stack validates ports before spawning any service', async () => {
  for (const value of ['abc', '1.5', 0, -1, 65536]) assert.throws(() => portNumber(value, 'PORT'));
  await assert.rejects(startStack({ env: { GATEWAY_PORT: '9001', MCP_PORT: '9001' } }), /must differ/);
});

test('stack refuses an occupied port instead of attaching to another process', async () => {
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(availablePort(occupied.address().port), { code: 'EADDRINUSE' });
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});
