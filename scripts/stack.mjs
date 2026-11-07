#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function portNumber(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be a port between 1 and 65535`);
  return port;
}

export async function availablePort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return actual;
}

export async function startStack({ env = process.env, quiet = false, timeoutMs = 20000, signal } = {}) {
  const gatewayPort = portNumber(env.GATEWAY_PORT || 8080, 'GATEWAY_PORT');
  const mcpPort = portNumber(env.MCP_PORT || 3001, 'MCP_PORT');
  if (gatewayPort === mcpPort) throw new Error('GATEWAY_PORT and MCP_PORT must differ');
  const services = [
    { name: 'gateway', entry: 'gateway/dist/gateway/src/index.js', port: gatewayPort },
    { name: 'mcp', entry: 'mcp/dist/http.js', port: mcpPort },
  ];
  for (const service of services) {
    if (!existsSync(path.join(repoRoot, service.entry))) throw new Error(`Missing ${service.entry}; run npm run workspace:build first`);
    await availablePort(service.port);
  }
  const serviceEnv = {
    ...env,
    GATEWAY_HOST: '127.0.0.1',
    MCP_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    MCP_PORT: String(mcpPort),
    GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    CLAWD_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    GATEWAY_BACKGROUND_ENABLED: env.GATEWAY_BACKGROUND_ENABLED || 'false',
    SOLANA_RPC_URL: env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  };
  const children = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }));
  };
  const abort = () => { void stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  const failIfStopped = () => {
    if (stopped || signal?.aborted) throw new Error('Stack startup cancelled');
    const failed = children.find((child) => child.exitCode !== null || child.signalCode !== null || child.startError);
    if (failed) throw new Error(`${failed.serviceName} exited before the stack was ready; check its configuration and build`);
  };
  try {
    for (const service of services) {
      failIfStopped();
      const child = spawn(process.execPath, [path.join(repoRoot, service.entry)], {
        cwd: repoRoot,
        env: serviceEnv,
        stdio: quiet ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'inherit', 'inherit'],
      });
      child.serviceName = service.name;
      child.on('error', (error) => { child.startError = error; });
      children.push(child);
      const deadline = Date.now() + timeoutMs;
      let ready = false;
      while (Date.now() < deadline) {
        failIfStopped();
        try {
          const response = await fetch(`http://127.0.0.1:${service.port}/health`, { signal: AbortSignal.timeout(1000) });
          const health = await response.json();
          if (response.ok && health.status === 'ok') { ready = true; break; }
        } catch {}
        await delay(100);
      }
      failIfStopped();
      if (!ready) throw new Error(`${service.name} did not become healthy within ${timeoutMs}ms`);
    }
    const done = new Promise((resolve) => {
      for (const child of children) child.once('exit', (code, childSignal) => {
        resolve({ service: child.serviceName, code, signal: childSignal });
        void stop();
      });
    });
    return { gatewayUrl: serviceEnv.GATEWAY_URL, mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`, children, done, stop: async () => {
      signal?.removeEventListener('abort', abort);
      await stop();
    } };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    await stop();
    throw error;
  }
}

export async function checkStack() {
  // Verification deliberately starts no provider sessions, bot polling, or signing flows.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NO_COLOR: '1',
    GATEWAY_PORT: String(await availablePort()),
    MCP_PORT: String(await availablePort()),
    GATEWAY_BACKGROUND_ENABLED: 'false',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    LIVE_TRADING: 'false',
    MAINNET_ENABLED: 'false',
    DOTENV_CONFIG_PATH: path.join(repoRoot, '.stack-check-no-env'),
  };
  const stack = await startStack({ env, quiet: true });
  let client;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    client = new Client({ name: 'workspace-check', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(stack.mcpUrl)), { timeout: 10000 });
    const { tools } = await client.listTools();
    for (const name of ['integration_status', 'gateway_health', 'gateway_skill_catalog']) {
      if (!tools.some((tool) => tool.name === name)) throw new Error(`MCP did not advertise ${name}`);
    }
    const health = await client.callTool({ name: 'gateway_health', arguments: {} }, undefined, { timeout: 10000 });
    if (health.isError) throw new Error('MCP could not reach the gateway');
    const contentText = (result) => result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    const parsedHealth = JSON.parse(contentText(health));
    if (parsedHealth.status !== 'ok') throw new Error('Gateway returned an unhealthy result through MCP');
    const catalog = await client.callTool({ name: 'gateway_skill_catalog', arguments: {} }, undefined, { timeout: 10000 });
    if (catalog.isError) throw new Error('MCP could not read the gateway skill catalog');
    const parsedCatalog = JSON.parse(contentText(catalog));
    const entries = Array.isArray(parsedCatalog) ? parsedCatalog : parsedCatalog.skills ?? parsedCatalog.catalog;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('Gateway skill catalog is empty or malformed');
    const status = await client.callTool({ name: 'integration_status', arguments: {} }, undefined, { timeout: 10000 });
    if (status.isError) throw new Error('MCP integration status failed');
    console.log(`[stack] PASS: MCP initialized; ${tools.length} tools; gateway health and ${entries.length} skills reached through MCP; integration status returned`);
  } finally {
    await client?.close().catch(() => {});
    await stack.stop();
  }
}

async function main() {
  const command = process.argv[2] || 'start';
  if (['help', '--help', '-h'].includes(command)) {
    console.log('Usage: npm run stack -- [start|check]\nstart: local gateway + MCP, shared root .env and loopback ports 8080/3001\ncheck: isolated service startup + MCP-to-gateway smoke, then shuts down');
    return;
  }
  if (command === 'check') { await checkStack(); return; }
  if (command !== 'start') throw new Error(`Unknown stack command: ${command}`);
  if (existsSync(path.join(repoRoot, '.env'))) process.loadEnvFile(path.join(repoRoot, '.env'));
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const stack = await startStack({ signal: controller.signal });
    console.log(`[stack] Ready: gateway ${stack.gatewayUrl}; MCP ${stack.mcpUrl}`);
    const exited = await stack.done;
    await stack.stop();
    if (!controller.signal.aborted) throw new Error(`${exited.service} stopped (exit ${exited.code ?? exited.signal})`);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[stack] ${error.message}`); process.exitCode = 1; });
}
