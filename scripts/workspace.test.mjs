import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPlan, exactPath, executePlan, inspectWorkspace, main,
  orderComponents, readManifest, validateManifest,
} from './workspace.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clawd-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: 1,
    profiles: { core: ['root', 'sdk'], optional: ['optional'] },
    components: [
      { id: 'root', path: '.', category: 'core', purpose: 'Root facade', required: true, manifests: ['package.json'], buildAfter: ['sdk'], tasks: { check: 'typecheck:root', build: 'build:root' } },
      { id: 'sdk', path: 'sdk', category: 'core', purpose: 'SDK', required: true, manifests: ['package.json'], tasks: { check: 'typecheck', build: 'build' } },
      { id: 'optional', path: 'optional', category: 'submodule', purpose: 'Optional tree', required: false, submodule: true },
    ],
  };
  mkdirSync(path.join(root, 'sdk'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'build:root': 'tsc', 'typecheck:root': 'tsc --noEmit' } }));
  writeFileSync(path.join(root, 'sdk/package.json'), JSON.stringify({ scripts: { build: 'tsc', typecheck: 'tsc --noEmit' } }));
  writeFileSync(path.join(root, 'workspace.components.json'), JSON.stringify(manifest));
  return { root, manifest };
}

test('checked-in inventory has a valid acyclic graph and every profile resolves', () => {
  const manifest = readManifest();
  assert.deepEqual(validateManifest(manifest), []);
  for (const members of Object.values(manifest.profiles)) {
    const ordered = orderComponents(manifest, members);
    assert.equal(new Set(ordered.map(c => c.id)).size, ordered.length);
    const positions = new Map(ordered.map((c, i) => [c.id, i]));
    for (const c of ordered) for (const dependency of c.buildAfter ?? []) assert.ok(positions.get(dependency) < positions.get(c.id));
  }
});

test('invalid paths, duplicate IDs, unknown dependencies and cycles are rejected', t => {
  const { manifest } = fixture(t);
  const badPath = structuredClone(manifest);
  badPath.components[0].path = '../outside';
  assert.match(validateManifest(badPath).join('\n'), /stay inside/);
  const duplicate = structuredClone(manifest);
  duplicate.components[1].id = 'root';
  assert.match(validateManifest(duplicate).join('\n'), /duplicate component id/);
  const missing = structuredClone(manifest);
  missing.components[0].buildAfter = ['no-such-component'];
  assert.match(validateManifest(missing).join('\n'), /unknown dependency/);
  const cycle = structuredClone(manifest);
  cycle.components[1].buildAfter = ['root'];
  assert.match(validateManifest(cycle).join('\n'), /cycle/);
});

test('path checks preserve exact casing even on case-insensitive hosts', t => {
  const { root } = fixture(t);
  assert.deepEqual(exactPath(root, 'sdk/package.json'), { exists: true, exact: true });
  assert.deepEqual(exactPath(root, 'SDK/package.json'), { exists: true, exact: false, actual: 'sdk' });
  assert.equal(exactPath(root, '../outside').exists, false);
});

test('optional absent submodule is informational while required missing source fails', t => {
  const { root, manifest } = fixture(t);
  let report = inspectWorkspace(manifest, root);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some(w => w.includes('optional component absent')));
  rmSync(path.join(root, 'sdk'), { recursive: true });
  report = inspectWorkspace(manifest, root);
  assert.ok(report.errors.some(e => e.includes('required component missing')));
});

test('invalid root workspace paths fail static inspection', t => {
  const { root, manifest } = fixture(t);
  const rootPackage = JSON.parse(JSON.stringify({ scripts: { 'build:root': 'tsc', 'typecheck:root': 'tsc --noEmit' }, workspaces: ['missing/packages/sdk'] }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
  assert.ok(inspectWorkspace(manifest, root).errors.some(e => e.includes('workspaces: missing/packages/sdk')));
});

test('build/check plans use explicit package-local npm tasks and never install', t => {
  const { root, manifest } = fixture(t);
  const build = createPlan(manifest, 'core', 'build', root);
  assert.deepEqual(build.map(s => s.id), ['sdk', 'root']);
  assert.deepEqual(build[0].args, ['--prefix', 'sdk', 'run', 'build', '--ignore-scripts']);
  assert.ok(build.every(s => s.command === 'npm' && s.args.includes('run') && !s.args.includes('install') && !s.args.includes('ci')));
  const check = createPlan(manifest, 'core', 'check', root);
  assert.ok(check.every(s => s.args.includes('--ignore-scripts')));
  assert.throws(() => createPlan(manifest, 'unknown', 'build', root), /Unknown profile/);
  assert.throws(() => createPlan(manifest, 'core', 'deploy', root), /Unknown task/);
});

test('install is explicit, root first, locked packages use ci, lifecycle scripts disabled', t => {
  const { root, manifest } = fixture(t);
  writeFileSync(path.join(root, 'sdk/package-lock.json'), '{}');
  const plan = createPlan(manifest, 'core', 'install', root);
  assert.deepEqual(plan.map(s => s.id), ['root', 'sdk']);
  assert.ok(plan[0].args.includes('install'));
  assert.ok(plan[1].args.includes('ci'));
  assert.ok(plan.every(s => s.args.includes('--ignore-scripts') && s.args.includes('--legacy-peer-deps')));
});

test('failed build blocks dependents and preserves failure evidence', t => {
  const { root, manifest } = fixture(t);
  const plan = createPlan(manifest, 'core', 'build', root);
  const commands = [];
  const result = executePlan(plan, { root, execute: (...args) => { commands.push(args); return { status: 2 }; }, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(commands.length, 1);
  assert.deepEqual(result.results.map(r => r.status), ['failed', 'failed']);
  assert.match(result.results[1].reason, /dependency 'sdk' failed/);
});

test('unavailable optional profile tasks fail honestly without running commands', t => {
  const { root, manifest } = fixture(t);
  const plan = createPlan(manifest, 'optional', 'check', root);
  const result = executePlan(plan, { root, execute: () => assert.fail('must not execute'), log: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.results[0].reason, /no check task/);
});

test('CLI consumes positional profile, plan does not execute, verify cannot install', t => {
  const { root } = fixture(t);
  assert.equal(main(['plan', 'core', '--task', 'build', '--json'], root), 0);
  assert.equal(main(['plan', 'optional'], root), 1);
  assert.throws(() => main(['verify', 'core', '--task', 'install'], root), /verify never installs/);
  assert.throws(() => main(['doctor', '--bad-option'], root), /Unknown option/);
});
