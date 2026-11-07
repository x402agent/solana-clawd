#!/usr/bin/env node

// Compatibility entrypoint. All component ordering and verification lives in
// workspace.mjs, so npm build/typecheck/doctor use the same component registry.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const known = new Set(['--build', '--typecheck', '--lint']);
if ([...args].some(arg => !known.has(arg)) || args.size > 1) {
  console.error('Usage: repo-doctor.mjs [--build|--typecheck|--lint]');
  process.exit(1);
}
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20 || nodeMajor >= 23) {
  console.error(`Node 20 or 22 required; found ${process.version}. Use Node 22 from .nvmrc.`);
  process.exit(1);
}

const command = args.has('--lint') ? 'bash' : process.execPath;
const commandArgs = args.has('--lint')
  ? [resolve(root, 'scripts/repo-hygiene-audit.sh')]
  : [resolve(root, 'scripts/workspace.mjs'), ...(
    args.has('--build') ? ['verify', 'core', '--task', 'build']
      : args.has('--typecheck') ? ['verify', 'core', '--task', 'check']
        : ['doctor', 'core']
  )];
const result = spawnSync(command, commandArgs, { cwd: root, env: process.env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
