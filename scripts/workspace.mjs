#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const categories = new Set(['core', 'optional', 'reference', 'configuration', 'documentation', 'data', 'container', 'placeholder', 'tooling', 'submodule']);
const validTasks = new Set(['check', 'build', 'install']);

export function readManifest(root = workspaceRoot) {
  return JSON.parse(readFileSync(path.join(root, 'workspace.components.json'), 'utf8'));
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !value.includes('\\');
}

// existsSync alone accepts wrong casing on macOS, then fails after checkout on Linux.
export function exactPath(root, relative) {
  if (!safeRelative(relative)) return { exists: false, exact: false };
  if (relative === '.') return { exists: existsSync(root), exact: true };
  let current = root;
  for (const part of relative.split('/').filter(p => p && p !== '.')) {
    if (!existsSync(current) || !statSync(current).isDirectory()) return { exists: false, exact: false };
    const names = readdirSync(current);
    if (!names.includes(part)) {
      const actual = names.find(name => name.toLowerCase() === part.toLowerCase());
      return { exists: Boolean(actual), exact: false, actual };
    }
    current = path.join(current, part);
  }
  return { exists: existsSync(current), exact: true };
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(manifest?.components)) return [...errors, 'components must be an array'];
  const ids = new Set();
  const paths = new Set();
  for (const c of manifest.components) {
    if (!c || !/^[a-z0-9][a-z0-9-]*$/.test(c.id ?? '')) errors.push('each component must have a lowercase id');
    if (ids.has(c.id)) errors.push(`duplicate component id: ${c.id}`);
    ids.add(c.id);
    if (!safeRelative(c.path)) errors.push(`${c.id}: path must stay inside the workspace`);
    if (paths.has(c.path)) errors.push(`duplicate component path: ${c.path}`);
    paths.add(c.path);
    if (!categories.has(c.category)) errors.push(`${c.id}: unknown category ${c.category}`);
    if (typeof c.purpose !== 'string' || !c.purpose.trim()) errors.push(`${c.id}: purpose is required`);
    if (typeof c.required !== 'boolean') errors.push(`${c.id}: required must be boolean`);
    for (const file of c.manifests ?? []) if (!safeRelative(file)) errors.push(`${c.id}: invalid manifest path`);
    for (const [task, script] of Object.entries(c.tasks ?? {})) {
      if (!['check', 'build'].includes(task) || typeof script !== 'string' || !/^[a-z0-9:_-]+$/i.test(script)) errors.push(`${c.id}: invalid task ${task}`);
    }
  }
  for (const c of manifest.components) {
    for (const id of [...(c.buildAfter ?? []), ...(c.runtime?.connectsTo ?? [])]) {
      if (!ids.has(id)) errors.push(`${c.id}: unknown dependency ${id}`);
    }
  }
  if (!manifest.profiles || typeof manifest.profiles !== 'object') errors.push('profiles must be an object');
  for (const [name, members] of Object.entries(manifest.profiles ?? {})) {
    if (!Array.isArray(members) || members.some(id => !ids.has(id))) errors.push(`${name}: profile contains unknown components`);
    else if (new Set(members).size !== members.length) errors.push(`${name}: duplicate profile member`);
  }
  if (!errors.length) {
    try { orderComponents(manifest, manifest.components.map(c => c.id)); } catch (error) { errors.push(error.message); }
  }
  return errors;
}

export function orderComponents(manifest, ids) {
  const byId = new Map(manifest.components.map(c => [c.id, c]));
  const done = new Set();
  const visiting = new Set();
  const result = [];
  function visit(id) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`build dependency cycle at ${id}`);
    const c = byId.get(id);
    if (!c) throw new Error(`Unknown component: ${id}`);
    visiting.add(id);
    for (const dep of c.buildAfter ?? []) visit(dep);
    visiting.delete(id);
    done.add(id);
    result.push(c);
  }
  for (const id of ids) visit(id);
  return result;
}

function readPackage(root, component) {
  const filename = path.join(root, component.path, 'package.json');
  return existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : undefined;
}

export function inspectWorkspace(manifest, root = workspaceRoot) {
  const errors = validateManifest(manifest);
  const warnings = [];
  const components = [];
  if (errors.length) return { errors, warnings, components };
  for (const c of manifest.components) {
    const location = exactPath(root, c.path);
    let status = 'present';
    if (!location.exact && location.exists) {
      errors.push(`${c.path}: case mismatch${location.actual ? ` (found ${location.actual})` : ''}`);
      status = 'case-mismatch';
    } else if (!location.exists) {
      (c.required ? errors : warnings).push(`${c.path}: ${c.required ? 'required component missing' : 'optional component absent'}`);
      status = 'absent';
    } else if (c.submodule && readdirSync(path.join(root, c.path)).length === 0) {
      warnings.push(`${c.path}: optional submodule is not initialized`);
      status = 'uninitialized';
    } else if (c.category === 'placeholder') {
      warnings.push(`${c.path}: placeholder, no runtime to verify`);
      status = 'placeholder';
    }
    if (status === 'present') {
      for (const file of c.manifests ?? []) {
        const result = exactPath(root, path.posix.join(c.path, file));
        if (!result.exists || !result.exact) (c.required ? errors : warnings).push(`${c.path}/${file}: manifest missing or wrong case`);
      }
      if (c.manifests?.includes('package.json')) {
        try {
          const pkg = readPackage(root, c);
          for (const script of Object.values(c.tasks ?? {})) {
            if (!pkg?.scripts?.[script]) (c.required ? errors : warnings).push(`${c.path}: npm script '${script}' is missing`);
          }
          if (!existsSync(path.join(root, c.path, 'node_modules')) && !existsSync(path.join(root, 'node_modules'))) {
            warnings.push(`${c.path}: dependencies not installed (use workspace install explicitly)`);
          }
        } catch { errors.push(`${c.path}/package.json: invalid JSON`); }
      }
    }
    components.push({ id: c.id, path: c.path, category: c.category, required: c.required, status });
  }
  const catalogedRoots = new Set(manifest.components.map(c => c.path.split('/')[0]));
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.isDirectory() && !['.git', 'node_modules', 'dist', '.cache', '.workspace'].includes(item.name) && !catalogedRoots.has(item.name)) {
      warnings.push(`${item.name}: directory is not cataloged in workspace.components.json`);
    }
  }
  if (existsSync(path.join(root, '.gitmodules'))) {
    const declared = [...readFileSync(path.join(root, '.gitmodules'), 'utf8').matchAll(/^\s*path\s*=\s*(.+)$/gm)].map(match => match[1].trim());
    const cataloged = new Set(manifest.components.filter(c => c.submodule).map(c => c.path));
    for (const submodule of declared) {
      if (!cataloged.has(submodule)) errors.push(`.gitmodules: ${submodule} is not cataloged as a submodule`);
    }
    for (const submodule of cataloged) {
      if (!declared.includes(submodule)) errors.push(`workspace.components.json: ${submodule} is not declared in .gitmodules`);
    }
  }
  try {
    const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const workspace of rootPackage.workspaces ?? []) {
      if (workspace.includes('*')) continue;
      const result = exactPath(root, `${workspace}/package.json`);
      if (!result.exists || !result.exact) errors.push(`package.json workspaces: ${workspace} has no exact-case package.json`);
    }
  } catch { errors.push('root package.json is missing or invalid'); }
  return { errors, warnings, components };
}

export function createPlan(manifest, profile = 'core', task = 'check', root = workspaceRoot) {
  if (!validTasks.has(task)) throw new Error(`Unknown task '${task}'; use check, build or install`);
  if (!manifest.profiles[profile]) throw new Error(`Unknown profile '${profile}'; use ${Object.keys(manifest.profiles).join(', ')}`);
  const components = orderComponents(manifest, manifest.profiles[profile]);
  if (task === 'install') components.sort((a, b) => (a.path === '.' ? -1 : b.path === '.' ? 1 : 0));
  return components.map(c => {
    const base = { id: c.id, path: c.path, task, buildAfter: c.buildAfter ?? [] };
    if (task === 'install') {
      if (!existsSync(path.join(root, c.path, 'package.json'))) return { ...base, unavailable: 'package.json missing' };
      const action = existsSync(path.join(root, c.path, 'package-lock.json')) ? 'ci' : 'install';
      return { ...base, command: 'npm', args: ['--prefix', c.path, action, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'] };
    }
    const script = c.tasks?.[task];
    if (!script) return { ...base, unavailable: `no ${task} task is defined` };
    const location = exactPath(root, path.posix.join(c.path, 'package.json'));
    if (!location.exists || !location.exact) return { ...base, unavailable: 'package.json missing or wrong case' };
    const pkg = readPackage(root, c);
    if (!pkg?.scripts?.[script]) return { ...base, unavailable: `npm script '${script}' is missing` };
    return { ...base, command: 'npm', args: ['--prefix', c.path, 'run', script, '--ignore-scripts'] };
  });
}

export function executePlan(plan, { root = workspaceRoot, execute = spawnSync, log = console.log } = {}) {
  const results = [];
  const failures = new Set();
  for (const step of plan) {
    const failedDependency = step.buildAfter.find(id => failures.has(id));
    if (step.unavailable || failedDependency) {
      const reason = step.unavailable ?? `dependency '${failedDependency}' failed`;
      log(`[workspace] FAIL ${step.id}: ${reason}`);
      failures.add(step.id);
      results.push({ id: step.id, status: 'failed', reason });
      continue;
    }
    log(`\n[workspace] ${step.task} ${step.id}: ${step.command} ${step.args.join(' ')}`);
    const result = execute(step.command, step.args, { cwd: root, stdio: 'inherit', env: process.env });
    if (result.error || result.status !== 0) {
      const reason = result.error?.message ?? `exit status ${result.status ?? 'unknown'}`;
      log(`[workspace] FAIL ${step.id}: ${reason}`);
      failures.add(step.id);
      results.push({ id: step.id, status: 'failed', reason });
    } else results.push({ id: step.id, status: 'passed' });
  }
  return { ok: failures.size === 0, results };
}

function usage() {
  console.log(`Usage: node scripts/workspace.mjs <command> [profile] [--task check|build|install] [--json] [--dry-run]

  list                  Component inventory and runtime connections
  doctor                Read-only manifest, path and package readiness check
  plan [core]           Ordered command plan; never executes commands
  verify [core]         Run check (default) or build; never installs dependencies
  install [core]        Explicit dependency install; lifecycle scripts disabled

Profiles: core, services, packages, attestation
Optional submodules, providers, wallet actions and deployments are never started by this runner.`);
}

export function main(argv = process.argv.slice(2), root = workspaceRoot) {
  const [command = 'doctor', ...rest] = argv;
  if (['-h', '--help', 'help'].includes(command)) { usage(); return 0; }
  if (!['list', 'doctor', 'plan', 'verify', 'install'].includes(command)) throw new Error(`Unknown command: ${command}`);
  let json = false;
  let dryRun = false;
  let task = command === 'install' ? 'install' : 'check';
  let taskProvided = false;
  const positionals = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (value === '--json') json = true;
    else if (value === '--dry-run') dryRun = true;
    else if (value === '--task') {
      if (taskProvided || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error('--task requires one value');
      task = rest[++index];
      taskProvided = true;
    } else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    else positionals.push(value);
  }
  if (positionals.length > 1) throw new Error('Only one profile can be selected');
  if (['list', 'doctor'].includes(command) && (positionals.length || taskProvided || dryRun)) throw new Error(`${command} accepts only --json`);
  if (command === 'install' && taskProvided) throw new Error('install does not accept --task');
  if (json && ['verify', 'install'].includes(command) && !dryRun) throw new Error('--json is available for list, doctor, plan and --dry-run');
  const profile = positionals[0] ?? 'core';
  const manifest = readManifest(root);
  const schemaErrors = validateManifest(manifest);
  if (schemaErrors.length) throw new Error(schemaErrors.join('\n'));
  if (command === 'list') {
    if (json) console.log(JSON.stringify(manifest, null, 2));
    else for (const c of manifest.components) console.log(`${c.id.padEnd(25)} ${c.path.padEnd(40)} ${c.category.padEnd(14)} ${c.purpose}${c.runtime?.connectsTo ? ` [connects: ${c.runtime.connectsTo.join(', ')}]` : ''}`);
    return 0;
  }
  if (command === 'doctor') {
    const result = inspectWorkspace(manifest, root);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`[workspace] Cataloged ${result.components.length} components; ${result.errors.length} errors, ${result.warnings.length} readiness notes.`);
      for (const error of result.errors) console.log(`ERROR ${error}`);
      for (const warning of result.warnings) console.log(`NOTE  ${warning}`);
    }
    return result.errors.length ? 1 : 0;
  }
  if (command === 'verify' && task === 'install') throw new Error('verify never installs; use the explicit install command');
  const plan = createPlan(manifest, profile, task, root);
  if (command === 'plan' || dryRun) {
    if (json) console.log(JSON.stringify({ profile, task, plan }, null, 2));
    else {
      console.log(`[workspace] ${profile} / ${task}`);
      for (const s of plan) console.log(`${s.id}: ${s.unavailable ? `UNAVAILABLE (${s.unavailable})` : `${s.command} ${s.args.join(' ')}`}`);
    }
    return plan.some(s => s.unavailable) ? 1 : 0;
  }
  const result = executePlan(plan, { root });
  console.log(`\n[workspace] ${profile} / ${task}: ${result.results.filter(r => r.status === 'passed').length}/${result.results.length} passed.`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`[workspace] ${error.message}`); process.exitCode = 1; }
}
