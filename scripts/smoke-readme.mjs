#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.test.mjs')).map((name) => `scripts/${name}`);
const checks = [
  ['scripts/workspace.mjs', 'doctor'],
  ['scripts/workspace.mjs', 'verify', 'services', '--task', 'build'],
  ['scripts/workspace.mjs', 'verify', 'services', '--task', 'check'],
  ['--test', ...tests],
  ['scripts/stack.mjs', 'check'],
];
for (const args of checks) {
  console.log(`[smoke] node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 300000 });
  if (result.error || result.status !== 0) {
    console.error(`[smoke] Failed: ${result.error?.message || `exit ${result.status}`}`);
    process.exit(1);
  }
}
console.log('[smoke] Local workspace and Gateway-to-MCP integration passed.');
