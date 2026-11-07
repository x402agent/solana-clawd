#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const command = args.shift() ?? 'help';

function run(relativePath: string, forwarded: string[]): Promise<number> {
  const target = resolve(repoRoot, relativePath);
  if (!existsSync(target)) {
    throw new Error(`Missing ${relativePath}. Run npm run workspace:build first.`);
  }
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [target, ...forwarded], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      done(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`solana-clawd v${manifest.version}`);
    return 0;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(`solana-clawd v${manifest.version}

Usage: clawd <command> [arguments]

  workspace <list|doctor|plan|verify|install> [profile] [options]
  map                         List workspace components
  doctor [profile]            Report workspace readiness
  verify [profile] [options]  Run workspace checks
  runtime [arguments]         Open the SDK runtime CLI (--help for usage)
  tui [arguments]             Open the HERMES terminal
  demo                        Show the local simulated buddy and tool catalog
  birth [species]             Create a local simulated buddy
  spinners                    Print the available animation frames
  --version                   Print this package version

Start with: clawd doctor
Integration guide: docs/WORKSPACE.md`);
    return 0;
  }
  if (command === 'workspace') return run('scripts/workspace.mjs', args);
  if (command === 'map') return run('scripts/workspace.mjs', ['list', ...args]);
  if (command === 'doctor' || command === 'verify') {
    return run('scripts/workspace.mjs', [command, ...args]);
  }
  if (command === 'runtime') return run('sdk/dist/index.js', args.length ? args : ['--help']);
  if (command === 'tui') return run('tui/dist/index.js', args);
  if (command === 'spinners') {
    const { CLAWD_SPINNERS } = await import('../animations/index.js');
    for (const [name, spinner] of Object.entries(CLAWD_SPINNERS)) {
      console.log(`${name}: ${spinner.frames.join(' ')} (${spinner.interval}ms)`);
    }
    return 0;
  }
  if (command === 'demo' || command === 'birth') {
    const { BLOCKCHAIN_SPECIES, createBlockchainBuddy, formatBuddyCard } = await import('../buddy/index.js');
    const species = args[0] ?? 'lobster';
    if (!BLOCKCHAIN_SPECIES.includes(species as typeof BLOCKCHAIN_SPECIES[number])) {
      throw new Error(`Unknown species ${species}. Choose: ${BLOCKCHAIN_SPECIES.join(', ')}`);
    }
    const buddy = createBlockchainBuddy(species as typeof BLOCKCHAIN_SPECIES[number]);
    console.log('Local simulated buddy (no funded wallet or transaction).');
    console.log(formatBuddyCard(buddy));
    if (command === 'demo') {
      const { ALL_SOLANA_TOOLS } = await import('../tools/solana-agent.js');
      console.log(`Available agent tools: ${ALL_SOLANA_TOOLS.map(tool => tool.function.name).join(', ')}`);
    }
    return 0;
  }
  throw new Error(`Unknown command: ${command}. Run clawd --help.`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
