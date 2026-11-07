import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = resolve(root, 'README.md');

const headings = [
  '## ⛏️ Clawd ORE Mining Agent — NEW',
  '## ⚡ One-Shot Install — Pick Your Path',
  '## The Thesis',
  '## SDK-First Runtime',
  '## 🌑 Dark DeFi — Privacy Layer',
  '## ORE Mining Automation',
  '## CLAWD: Cryptographic Layer for Autonomous Work & Decisions',
  '## Proof of Agentic Action',
  '## AUD Loop — Algorithmic Utility Delta',
  '## $CLAWD Token',
  '## Quick Start',
  '## 🔐 Bitwarden Secrets Manager — Installation Integration',
  '## Hosted SDK Graph',
  '## Google ADK + Private Agent Gateway',
  '## Skills Catalog Update',
  '## Hackathon Submission',
  '## AMM Pool Routing Upgrade',
  '## 🌊 Perps Overhaul — TWAMM · Phoenix MM · Aggregator Venues · Skills',
  '## Public Gitlawb Mirrors',
  '## Repository Galaxy',
  '## 🦞👑 `/Perps` — The Execution Heart',
  '## ⚡ MCP Server v3 — Federated Trust Machine',
  '## 🤖 Crustacean Automation (`clawd-automaton`)',
  '## 🖥️ TUI — Bloomberg-Style Sovereign Terminal',
  '## 🧠 MemeBRain — Persistent Agent Memory',
  '## 📦 On-Chain Programs',
  '## 📦 Packages',
  '## ⚡ x402 — Agent-Native Payments',
  '## 🤝 Backrooms',
  '## 🗺️ Repo Map',
  '## 📖 Reading Order',
  '## Fast Start',
  '## License',
];

const covered = [
  'a2a-x402-main',
  'agent-tasks',
  'llm-wiki-tang',
  'memory',
  'payments',
  'plugin.delivery',
  'python',
  'starter',
  'ultra',
  'src',
  'BROWSER.md',
  'DARKDEFI.md',
  'gateway-destinations-snapshot.md',
  'upgrade.txt',
  'workspace.components.json',
  'Perps',
  'attestation/agent-router',
  'attestation/cereal_macro',
  'attestation/clients',
  'attestation/core',
  'attestation/examples',
  'attestation/formal_verification',
  'attestation/idl',
  'attestation/inference',
  'attestation/integration_tests',
  'attestation/program',
  'attestation/scripts',
  'attestation/tee-terminal',
  'formal_verification/kani',
  'formal_verification/gate.ts',
  'formal_verification/skill-hub.ts',
  'formal_verification/skill-hub-registry.json',
  'formal_verification/stride.ts',
  'formal_verification/verified-registry.json',
  'formal_verification/SPEC.md',
  'formal_verification/VERIFIER.md',
];

const secretTargets = ['attestation/.env', 'node_modules', 'amm/node_modules', 'dist', 'attestation/target'];

function normalizeLink(target) {
  const bare = target.trim().split('#')[0].split('?')[0];
  if (!bare || /^(?:https?:|mailto:)/i.test(bare)) return null;
  const relative = bare.replace(/^\.\//, '').replace(/\/$/, '');
  if (!relative || relative.startsWith('/')) return null;
  return relative;
}

function relativeLinks(readme) {
  const found = [];
  for (const match of readme.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const relative = normalizeLink(match[1]);
    if (relative) found.push(relative);
  }
  return found;
}

test('root README keeps its page and names the completed paths', () => {
  const readme = readFileSync(readmePath, 'utf8');
  assert.deepEqual(readme.split('\n').filter((line) => line.startsWith('## ')), headings);
  assert.match(readme, /AI will not become truly useful/);
  assert.match(readme, /C L A W D   O R E   M I N I N G   A G E N T/);
  assert.match(readme, /CLAWD — The Verifiable Agentic Harness/);

  const facade = readme.split('\n').filter((line) => /facade/.test(line) && /(?:^|[^\w./-])src\//.test(line));
  assert.ok(facade.some((line) => line.includes('public SDK and CLI facade') && !line.includes('packages/clawd/src')));

  const provider = readme.split('\n').filter((line) => /(?:^|[^\w./-])memory\//.test(line) && /Python memory provider/.test(line));
  assert.ok(provider.length >= 1);

  const localOnly = readme.split('\n').find((line) => line.startsWith('| Local-only vaults'));
  assert.ok(localOnly);
  assert.match(localOnly, /`node_modules`/);
  assert.match(localOnly, /`amm\/node_modules`/);
  assert.match(localOnly, /`dist`/);
  assert.match(localOnly, /`attestation\/target`/);
  assert.match(localOnly, /live `attestation\/\.env`/);
  assert.match(localOnly, /Ignored\. Do not push to GitHub, gitlawb, npm, or deployment artifacts/);

  const links = relativeLinks(readme);
  for (const secret of secretTargets) {
    assert.equal(links.some((link) => link === secret || link.startsWith(`${secret}/`)), false, secret);
  }
  for (const rel of covered) {
    assert.equal(links.includes(rel), true, `missing relative link for ${rel}`);
    assert.equal(existsSync(resolve(root, rel)), true, rel);
  }
});
