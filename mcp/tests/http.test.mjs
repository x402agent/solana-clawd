import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.MCP_FEDERATION_ENABLED = 'false';
const { createHttpApp } = await import('../dist/http.js');

test('authenticated MCP session initializes, lists tools, and closes', async (t) => {
  const { app, close } = createHttpApp('test-key');
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const base = `http://127.0.0.1:${listener.address().port}`;
  t.after(async () => { await close(); await new Promise(resolve => listener.close(resolve)); });
  const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const post = (body, sessionId) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify(body) });
  const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
  const decode = async (response) => {
    const body = await response.text();
    return response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(body.split('\n').find(line => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  };

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await (await fetch(`${base}/health`)).json()).version, '3.0.0');
  assert.equal((await fetch(`${base}/mcp`, { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await post(rpc(1, 'tools/list'))).status, 400);
  assert.equal((await post(rpc(1, 'tools/list'), 'missing-session')).status, 404);
  const initialized = await post(rpc(2, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } }));
  assert.equal(initialized.status, 200);
  const sid = initialized.headers.get('mcp-session-id');
  assert.ok(sid);
  assert.match(initialized.headers.get('access-control-expose-headers'), /mcp-session-id/);
  assert.equal((await decode(initialized)).result.serverInfo.version, '3.0.0');
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid)).status, 202);
  const listing = await decode(await post(rpc(3, 'tools/list'), sid));
  for (const name of ['integration_status', 'gateway_health', 'gateway_skill_catalog', 'agentkit_list_agents']) {
    assert.ok(listing.result.tools.some(tool => tool.name === name), `missing ${name}`);
  }
  const failed = await decode(await post(rpc(4, 'tools/call', { name: 'missing_tool', arguments: {} }), sid));
  assert.equal(failed.result.isError, true);
  const deleted = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sid } });
  assert.equal(deleted.status, 200);
  assert.equal((await post(rpc(5, 'tools/list'), sid)).status, 404);
});
