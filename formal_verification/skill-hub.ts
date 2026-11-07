/**
 * formal_verification/skill-hub.ts
 *
 * Skill Hub registry — reads skills/catalog.json, enforces the formal
 * verification gate, and issues deterministic on-chain skill IDs.
 *
 * A skill ID is SHA-256(slug + kind + spec_hash), encoded as 32 bytes.
 * Registration is blocked until the gate produces a passing StrideReport
 * (score ≥ 60 for skills, ≥ 70 for agents).
 *
 * On-chain submission is done via the skill_hub Anchor program at
 * agents/agent-minter/src/lib.rs. This module handles only the
 * off-chain side: validation, ID generation, and registry JSON.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeComponent, StrideReport } from './stride.js';

// ── Constants ──────────────────────────────────────────────────────────────

export const MIN_STRIDE_SCORE_SKILL = 60;
export const MIN_STRIDE_SCORE_AGENT = 70;

// Locate the workspace from either source or gateway/dist/formal_verification.
function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, 'skills', 'catalog.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Skill Hub workspace not found: skills/catalog.json is missing');
    current = parent;
  }
}
const REPO_ROOT = findRepoRoot();
export const SKILLS_ROOT = path.resolve(REPO_ROOT, 'skills');
const CATALOG_PATH = path.join(REPO_ROOT, 'skills', 'catalog.json');
const SKILL_HUB_REGISTRY = path.join(REPO_ROOT, 'formal_verification', 'skill-hub-registry.json');

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertSafeRegistryKey(key: string): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error('Invalid registry key');
  }
}

function assertSafeSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9._ -]{0,127}$/i.test(slug)) {
    throw new Error('Invalid slug');
  }
}

function resolveSkillComponentPath(inputPath: string | undefined, slug: string): string {
  const candidate = inputPath && inputPath.trim().length > 0
    ? path.resolve(REPO_ROOT, inputPath)
    : path.resolve(SKILLS_ROOT, slug);

  if (!isPathWithinRoot(candidate, REPO_ROOT)) {
    throw new Error('[SkillHub] Invalid component_path: path must stay within repository root');
  }

  return candidate;
}

// ── Types ──────────────────────────────────────────────────────────────────

export type ComponentKind = 'agent' | 'skill' | 'plugin' | 'mcp_server' | 'program';

export interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  category: string;
  /** Optional: path to the skill directory for STRIDE analysis */
  path?: string;
}

export interface SkillHubEntry {
  skill_id: string;       // hex-encoded 32 bytes
  slug: string;
  name: string;
  kind: ComponentKind;
  stride_score: number;
  kani_verified: boolean;
  spec_hash: string;      // hex SHA-256 of spec content or slug
  authority: string;      // Solana pubkey of registrar
  metadata_uri: string;
  registered_at: string;  // ISO-8601
  active: boolean;
  on_chain?: boolean;
  sas_attestation?: string;
}

export interface SkillHubRegistry {
  version: 1;
  updated_at: string;
  skills: Record<string, SkillHubEntry>;  // keyed by skill_id hex
}

// ── Registry I/O ──────────────────────────────────────────────────────────

function loadRegistry(): SkillHubRegistry {
  try {
    const raw = fs.readFileSync(SKILL_HUB_REGISTRY, 'utf8');
    return JSON.parse(raw) as SkillHubRegistry;
  } catch {
    return { version: 1, updated_at: new Date().toISOString(), skills: {} };
  }
}

function saveRegistry(reg: SkillHubRegistry): void {
  reg.updated_at = new Date().toISOString();
  fs.writeFileSync(SKILL_HUB_REGISTRY, JSON.stringify(reg, null, 2), 'utf8');
}

// ── Skill ID derivation ────────────────────────────────────────────────────

/**
 * Deterministic 32-byte skill ID: SHA-256(slug | kind | spec_hash).
 * This matches what the on-chain register_skill instruction expects.
 */
export function deriveSkillId(slug: string, kind: ComponentKind, specHash: string): string {
  return crypto
    .createHash('sha256')
    .update(`${slug}:${kind}:${specHash}`)
    .digest('hex');
}

/**
 * Compute a spec hash from the skill directory or its slug.
 * If a real spec file exists, hash its contents; otherwise hash the slug.
 */
export function computeSpecHash(slugOrPath: string): string {
  // Defensive validation at sink: this function must only operate on slug-safe input.
  assertSafeSlug(slugOrPath);
  const safeSlug = slugOrPath;

  const bases = [
    path.resolve(SKILLS_ROOT, safeSlug),
    path.resolve(REPO_ROOT, safeSlug),
  ].filter((base, index) => isPathWithinRoot(base, index === 0 ? SKILLS_ROOT : REPO_ROOT));

  for (const base of bases) {
    for (const c of ['SPEC.md', 'spec.md', 'README.md'].map((name) => path.resolve(base, name))) {
      if (!isPathWithinRoot(c, REPO_ROOT)) continue;
      if (!fs.existsSync(c)) continue;

      const realCandidate = fs.realpathSync(c);
      if (!isPathWithinRoot(realCandidate, REPO_ROOT)) continue;

      return crypto.createHash('sha256').update(fs.readFileSync(realCandidate)).digest('hex');
    }
  }
  // Fallback: hash the slug itself
  return crypto.createHash('sha256').update(safeSlug).digest('hex');
}

// ── Verification gate ──────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  stride_score: number;
  kani_verified: boolean;
  blocked_reason?: string;
  report?: StrideReport;
}

/**
 * Run the formal verification gate on a component path or slug.
 * Returns the result; throws nothing — caller decides how to handle failure.
 */
export async function runVerificationGate(
  componentPath: string,
  kind: ComponentKind,
): Promise<VerificationResult> {
  const minScore = kind === 'agent' ? MIN_STRIDE_SCORE_AGENT : MIN_STRIDE_SCORE_SKILL;

  let report: StrideReport | undefined;
  let strideScore = 0;

  try {
    report = await analyzeComponent(componentPath);
    strideScore = report.threat_score;
  } catch (err) {
    // If path doesn't exist we still get a score-0 result
    strideScore = 0;
  }

  const kaniVerified = false; // off-chain kani runs separately; gate.ts handles it

  if (strideScore < minScore) {
    return {
      passed: false,
      stride_score: strideScore,
      kani_verified: kaniVerified,
      blocked_reason: `STRIDE score ${strideScore} < minimum ${minScore} for ${kind}`,
      report,
    };
  }

  return { passed: true, stride_score: strideScore, kani_verified: kaniVerified, report };
}

// ── Catalog helpers ────────────────────────────────────────────────────────

export function loadCatalog(): CatalogEntry[] {
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    return JSON.parse(raw) as CatalogEntry[];
  } catch {
    return [];
  }
}

export function catalogEntryToKind(entry: CatalogEntry): ComponentKind {
  const cat = (entry.category ?? '').toLowerCase();
  if (cat.includes('agent') || cat.includes('ai')) return 'agent';
  if (cat.includes('mcp') || entry.slug.endsWith('-mcp')) return 'mcp_server';
  if (cat.includes('plugin')) return 'plugin';
  return 'skill';
}

// ── Registration ───────────────────────────────────────────────────────────

export interface RegisterSkillOptions {
  slug: string;
  name: string;
  kind: ComponentKind;
  authority: string;
  metadata_uri?: string;
  /** Override STRIDE analysis path (defaults to skills/<slug>) */
  component_path?: string;
  /** Override kani_verified flag if you've already run kani externally */
  kani_verified?: boolean;
}

export interface RegisterSkillResult {
  skill_id: string;
  entry: SkillHubEntry;
  verification: VerificationResult;
}

/**
 * Register a skill into the local skill-hub-registry.json.
 * The formal verification gate MUST pass before the entry is written.
 *
 * For on-chain submission, take the returned `skill_id` and call the
 * `register_skill` instruction on the skill_hub Anchor program.
 */
export async function registerSkill(opts: RegisterSkillOptions): Promise<RegisterSkillResult> {
  assertSafeSlug(opts.slug);
  const componentPath = resolveSkillComponentPath(opts.component_path, opts.slug);
  const verification = await runVerificationGate(componentPath, opts.kind);

  if (!verification.passed) {
    throw new Error(
      `[SkillHub] Registration blocked: ${verification.blocked_reason}\n` +
      `Run 'npx tsx formal_verification/gate.ts verify --path ${componentPath}' to see details.`,
    );
  }

  const specHash = computeSpecHash(opts.slug);
  const skillId = deriveSkillId(opts.slug, opts.kind, specHash);
  const metadataUri = opts.metadata_uri ?? `https://solanaclawd.com/skills/${opts.slug}/metadata.json`;

  const entry: SkillHubEntry = {
    skill_id: skillId,
    slug: opts.slug,
    name: opts.name,
    kind: opts.kind,
    stride_score: verification.stride_score,
    kani_verified: opts.kani_verified ?? verification.kani_verified,
    spec_hash: specHash,
    authority: opts.authority,
    metadata_uri: metadataUri,
    registered_at: new Date().toISOString(),
    active: true,
    on_chain: false,
  };

  const registry = loadRegistry();
  assertSafeRegistryKey(skillId);
  registry.skills[skillId] = entry;
  saveRegistry(registry);

  return { skill_id: skillId, entry, verification };
}

// ── Bulk catalog import ────────────────────────────────────────────────────

export interface BulkImportOptions {
  authority: string;
  /** Only import skills that don't already exist in the registry */
  skip_existing?: boolean;
  /** Dry-run: validate but don't write */
  dry_run?: boolean;
}

export interface BulkImportResult {
  registered: string[];
  skipped: string[];
  blocked: Array<{ slug: string; reason: string }>;
}

/**
 * Import all catalog.json entries into the skill hub, running the
 * verification gate on each. Meant for the initial seed run.
 */
export async function bulkImportCatalog(opts: BulkImportOptions): Promise<BulkImportResult> {
  const catalog = loadCatalog();
  const registry = loadRegistry();
  const result: BulkImportResult = { registered: [], skipped: [], blocked: [] };

  for (const entry of catalog) {
    assertSafeSlug(entry.slug);
    const kind = catalogEntryToKind(entry);
    const specHash = computeSpecHash(entry.slug);
    const skillId = deriveSkillId(entry.slug, kind, specHash);

    if (opts.skip_existing && registry.skills[skillId]) {
      result.skipped.push(entry.slug);
      continue;
    }

    const componentPath = path.join(REPO_ROOT, 'skills', entry.slug);
    const verification = await runVerificationGate(componentPath, kind);

    if (!verification.passed) {
      result.blocked.push({ slug: entry.slug, reason: verification.blocked_reason! });
      continue;
    }

    if (!opts.dry_run) {
      const hubEntry: SkillHubEntry = {
        skill_id: skillId,
        slug: entry.slug,
        name: entry.name,
        kind,
        stride_score: verification.stride_score,
        kani_verified: false,
        spec_hash: specHash,
        authority: opts.authority,
        metadata_uri: `https://solanaclawd.com/skills/${entry.slug}/metadata.json`,
        registered_at: new Date().toISOString(),
        active: true,
        on_chain: false,
      };
      registry.skills[skillId] = hubEntry;
    }
    result.registered.push(entry.slug);
  }

  if (!opts.dry_run) {
    saveRegistry(registry);
  }
  return result;
}

// ── Queries ────────────────────────────────────────────────────────────────

export function listSkills(filter?: { kind?: ComponentKind; active?: boolean }): SkillHubEntry[] {
  const registry = loadRegistry();
  let entries = Object.values(registry.skills);
  if (filter?.kind) entries = entries.filter(e => e.kind === filter.kind);
  if (filter?.active !== undefined) entries = entries.filter(e => e.active === filter.active);
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getSkillById(skillId: string): SkillHubEntry | undefined {
  assertSafeRegistryKey(skillId);
  return loadRegistry().skills[skillId];
}

export function getSkillBySlug(slug: string): SkillHubEntry | undefined {
  return Object.values(loadRegistry().skills).find(e => e.slug === slug);
}

export function revokeSkill(skillId: string, authority: string): void {
  assertSafeRegistryKey(skillId);
  if (!/^[0-9a-f]{64}$/.test(skillId)) throw new Error(`Invalid skill id: ${skillId}`);
  const registry = loadRegistry();
  if (!Object.hasOwn(registry.skills, skillId)) throw new Error(`Skill ${skillId} not found`);
  const entry = registry.skills[skillId];
  if (entry.authority !== authority) throw new Error('Not the skill authority');
  entry.active = false;
  saveRegistry(registry);
}

// ── Manifest types ─────────────────────────────────────────────────────────

export interface SkillManifest {
  schema_version: '1.0';
  slug: string;
  name: string;
  description?: string;
  kind: ComponentKind;
  category?: string;
  version?: string;
  author: {
    name?: string;
    solana_pubkey: string;
    github?: string;
    x_handle?: string;
    url?: string;
  };
  source?: {
    type: 'github' | 'url';
    url: string;
    branch?: string;
    sha?: string;
    subdirectory?: string;
  };
  content?: {
    readme?: string;
    skill_md?: string;
    package_json?: string;
    index_ts?: string;
    spec_md?: string;
  };
  tags?: string[];
  license?: string;
  metadata_uri?: string;
}

export interface SubmissionResult {
  skill_id: string;
  slug: string;
  stride_score: number;
  kani_verified: boolean;
  sas_attestation: {
    schema: string;
    fields: Record<string, string>;
    on_chain: boolean;
    address?: string;
    signature?: string;
  };
  on_chain: boolean;
  metadata_uri: string;
  hub_url: string;
  entry: SkillHubEntry;
}

// ── Content fetcher ────────────────────────────────────────────────────────

async function fetchGitHubContent(
  repoUrl: string,
  branch = 'main',
  subdirectory = '',
): Promise<Record<string, string>> {
  // Convert https://github.com/owner/repo → raw.githubusercontent.com
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Not a GitHub URL: ${repoUrl}`);
  const [, owner, repo] = match;
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  const prefix = subdirectory ? `/${subdirectory.replace(/^\//, '')}` : '';

  const filenames = ['README.md', 'readme.md', 'skill.md', 'SKILL.md', 'SPEC.md', 'spec.md', 'package.json'];
  const content: Record<string, string> = {};

  await Promise.allSettled(
    filenames.map(async (f) => {
      try {
        const resp = await fetch(`${base}${prefix}/${f}`);
        if (resp.ok) content[f] = await resp.text();
      } catch {}
    }),
  );
  return content;
}

function buildAnalysisText(manifest: SkillManifest, fetched: Record<string, string>): string {
  const parts: string[] = [`=== Skill: ${manifest.name} (${manifest.slug}) ===`];
  if (manifest.description) parts.push(manifest.description);
  for (const [name, text] of Object.entries(fetched)) {
    parts.push(`\n--- ${name} ---\n${text.slice(0, 8192)}`);
  }
  // Also include inline content
  if (manifest.content) {
    for (const [key, text] of Object.entries(manifest.content)) {
      if (text) parts.push(`\n--- ${key} (inline) ---\n${text.slice(0, 8192)}`);
    }
  }
  return parts.join('\n');
}

// ── STRIDE analysis on raw text (without a filesystem path) ───────────────

interface TextStrideResult {
  score: number;
  blocked: boolean;
  findings: Array<{ id: string; severity: string; description: string }>;
}

function analyzeText(text: string): TextStrideResult {
  // Lightweight subset of STRIDE rules — works on raw string content
  const rules: Array<{
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    pattern: RegExp;
    description: string;
  }> = [
    { id: 'S-001', severity: 'critical', pattern: /['"](0x)?[0-9a-fA-F]{64}['"]/, description: 'Hardcoded private key pattern' },
    { id: 'S-002', severity: 'critical', pattern: /secret_key\s*[:=]\s*['"][^'"]{20,}['"]/, description: 'Hardcoded secret key' },
    { id: 'T-001', severity: 'high', pattern: /eval\s*\(/, description: 'Dynamic eval() — code injection risk' },
    { id: 'T-002', severity: 'high', pattern: /exec\s*\(["'`]/, description: 'Shell exec with string literal' },
    { id: 'I-001', severity: 'high', pattern: /console\.(log|info|debug)\s*\(.*(?:key|secret|password|token)/i, description: 'Possible secret logged to console' },
    { id: 'I-002', severity: 'medium', pattern: /process\.env\.[A-Z_]{3,}/, description: 'Env var access — ensure not logged or exposed' },
    { id: 'D-001', severity: 'medium', pattern: /while\s*\(\s*true\s*\)/, description: 'Unconditional infinite loop' },
    { id: 'E-001', severity: 'high', pattern: /\.\.\/\.\.\/\.\.\//, description: 'Deep path traversal' },
    { id: 'E-002', severity: 'medium', pattern: /require\s*\(\s*['"`]\s*\.\.\//, description: 'Relative require outside package' },
  ];

  const findings: TextStrideResult['findings'] = [];
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      findings.push({ id: rule.id, severity: rule.severity, description: rule.description });
    }
  }

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const mediumCount = findings.filter(f => f.severity === 'medium').length;

  const score = Math.max(0, 100 - criticalCount * 25 - highCount * 10 - mediumCount * 3);
  const blocked = criticalCount > 0 || highCount >= 3;

  return { score, blocked, findings };
}

// ── SAS attestation ────────────────────────────────────────────────────────

export interface SASAttestationResult {
  schema: string;
  fields: Record<string, string>;
  on_chain: boolean;
  address?: string;
  signature?: string;
}

export async function createSASAttestation(
  skillId: string,
  entry: Omit<SkillHubEntry, 'sas_attestation'>,
): Promise<SASAttestationResult> {
  const fields: Record<string, string> = {
    component_name: entry.slug,
    component_kind: entry.kind,
    component_hash: entry.skill_id,
    stride_score: String(entry.stride_score),
    kani_verified: String(entry.kani_verified),
    verified_at: entry.registered_at,
    verifier: 'clawd-gate-v1',
    lineage: 'clawd-skill-hub-v1',
  };

  const sasKey = process.env['SAS_AUTHORITY_KEY'];
  if (!sasKey) {
    return { schema: 'clawd-component-verification-v1', fields, on_chain: false };
  }

  try {
    // Lazy-import @solana/web3.js so gateway starts without it if unavailable
    const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } =
      await import('@solana/web3.js');

    const rpcUrl = process.env['HELIUS_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    let secretKey: Uint8Array;
    if (sasKey.startsWith('[')) {
      secretKey = Uint8Array.from(JSON.parse(sasKey) as number[]);
    } else {
      const { default: bs58 } = await import('bs58');
      secretKey = bs58.decode(sasKey);
    }
    const authority = Keypair.fromSecretKey(secretKey);

    // SAS program instruction — schema + fields as instruction data
    const SAS_PROGRAM_ID = new PublicKey('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
    const data = Buffer.from(JSON.stringify({ schema: 'clawd-component-verification-v1', fields }), 'utf8');

    const ix = new TransactionInstruction({
      programId: SAS_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await connection.sendTransaction(tx, [authority]);
    await connection.confirmTransaction(sig, 'confirmed');

    return { schema: 'clawd-component-verification-v1', fields, on_chain: true, signature: sig };
  } catch (err: any) {
    // SAS failure is non-blocking (exit code 3 in the gate)
    console.warn('[SAS] Attestation failed (non-blocking):', err.message);
    return { schema: 'clawd-component-verification-v1', fields, on_chain: false };
  }
}

// ── Full public submission pipeline ───────────────────────────────────────

const PENDING_SUBMISSIONS = new Map<string, { started: number; status: 'running' | 'done' | 'failed'; result?: SubmissionResult; error?: string }>();

export async function submitSkill(manifest: SkillManifest): Promise<SubmissionResult> {
  // Validate slug format
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(manifest.slug)) {
    throw new Error('Invalid slug: must be 3-64 lowercase alphanumeric/hyphen');
  }
  if (!manifest.author?.solana_pubkey) {
    throw new Error('author.solana_pubkey is required');
  }
  if (!manifest.source && !manifest.content) {
    throw new Error('Either source or content must be provided');
  }

  // Check for existing skill
  const registry = loadRegistry();
  const existing = Object.values(registry.skills).find(e => e.slug === manifest.slug);
  if (existing?.active) {
    throw new Error(`Skill '${manifest.slug}' is already registered. Use a different slug or contact the authority to update.`);
  }

  // Fetch external content if source URL provided
  let fetched: Record<string, string> = {};
  if (manifest.source) {
    if (manifest.source.type === 'github') {
      fetched = await fetchGitHubContent(
        manifest.source.url,
        manifest.source.branch ?? 'main',
        manifest.source.subdirectory,
      );
    } else if (manifest.source.type === 'url') {
      // For direct URLs we just note the source; STRIDE runs on inline content
      fetched['source_url'] = manifest.source.url;
    }
  }

  // Build analysis text and run STRIDE
  const analysisText = buildAnalysisText(manifest, fetched);
  const stride = analyzeText(analysisText);
  const minScore = manifest.kind === 'agent' ? MIN_STRIDE_SCORE_AGENT : MIN_STRIDE_SCORE_SKILL;

  if (stride.blocked || stride.score < minScore) {
    const criticals = stride.findings.filter(f => f.severity === 'critical');
    const reason = criticals.length
      ? `Critical violation(s): ${criticals.map(f => f.id).join(', ')}`
      : `STRIDE score ${stride.score} < minimum ${minScore} for ${manifest.kind}`;
    throw new Error(`[SkillHub] Submission blocked — ${reason}`);
  }

  // Derive IDs
  const specContent = fetched['SPEC.md'] ?? fetched['spec.md'] ?? manifest.content?.spec_md ?? manifest.description ?? manifest.slug;
  const specHash = crypto.createHash('sha256').update(specContent).digest('hex');
  const skillId = deriveSkillId(manifest.slug, manifest.kind, specHash);

  const metadataUri = manifest.metadata_uri ?? `https://solanaclawd.com/api/skills/slug/${manifest.slug}/metadata.json`;

  const entry: SkillHubEntry = {
    skill_id: skillId,
    slug: manifest.slug,
    name: manifest.name,
    kind: manifest.kind,
    stride_score: stride.score,
    kani_verified: false,
    spec_hash: specHash,
    authority: manifest.author.solana_pubkey,
    metadata_uri: metadataUri,
    registered_at: new Date().toISOString(),
    active: true,
    on_chain: false,
  };

  // SAS attestation
  const sas = await createSASAttestation(skillId, entry);
  if (sas.on_chain) {
    entry.sas_attestation = sas.signature;
    entry.on_chain = true;
  }

  // Write to registry
  registry.skills[skillId] = entry;
  saveRegistry(registry);

  // Append to catalog.json if not already there
  const catalog = loadCatalog();
  if (!catalog.find(c => c.slug === manifest.slug)) {
    catalog.push({
      slug: manifest.slug,
      name: manifest.name,
      description: manifest.description ?? '',
      category: manifest.category ?? 'Community',
    });
    try {
      fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf8');
    } catch {}
  }

  return {
    skill_id: skillId,
    slug: manifest.slug,
    stride_score: stride.score,
    kani_verified: false,
    sas_attestation: sas,
    on_chain: sas.on_chain,
    metadata_uri: metadataUri,
    hub_url: `https://solanaclawd.com/skills/${manifest.slug}`,
    entry,
  };
}

// ── Submission queue ────────────────────────────────────────────────────────

export function startSubmission(manifest: SkillManifest): string {
  const jobId = crypto.randomUUID();
  PENDING_SUBMISSIONS.set(jobId, { started: Date.now(), status: 'running' });

  submitSkill(manifest)
    .then(result => {
      PENDING_SUBMISSIONS.set(jobId, { started: Date.now(), status: 'done', result });
    })
    .catch(err => {
      PENDING_SUBMISSIONS.set(jobId, { started: Date.now(), status: 'failed', error: String(err.message) });
    });

  return jobId;
}

export function getSubmissionStatus(jobId: string) {
  return PENDING_SUBMISSIONS.get(jobId) ?? null;
}

// ── Search ─────────────────────────────────────────────────────────────────

export function searchSkills(query: string, limit = 20): SkillHubEntry[] {
  const q = query.toLowerCase();
  return listSkills({ active: true })
    .filter(s =>
      s.slug.includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.kind.includes(q),
    )
    .slice(0, limit);
}

export { loadRegistry };

// ── CLI entry point ────────────────────────────────────────────────────────

if (process.argv[1] === import.meta.filename || process.argv[1]?.endsWith('skill-hub.ts')) {
  const [, , cmd, ...args] = process.argv;

  async function main() {
    if (cmd === 'list') {
      const skills = listSkills();
      console.log(`Skill Hub — ${skills.length} registered skills\n`);
      for (const s of skills) {
        const status = s.active ? '✓' : '✗';
        console.log(`  ${status} [${s.kind.padEnd(10)}] ${s.slug.padEnd(40)} score=${s.stride_score}`);
      }
      return;
    }

    if (cmd === 'register') {
      const slugArg = args.find(a => a.startsWith('--slug='))?.split('=')[1];
      const nameArg = args.find(a => a.startsWith('--name='))?.split('=')[1];
      const authorityArg = args.find(a => a.startsWith('--authority='))?.split('=')[1];
      const kindArg = (args.find(a => a.startsWith('--kind='))?.split('=')[1] ?? 'skill') as ComponentKind;

      if (!slugArg || !authorityArg) {
        console.error('Usage: npx tsx skill-hub.ts register --slug=<slug> --authority=<pubkey> [--name=<name>] [--kind=skill|agent|plugin|mcp_server|program]');
        process.exit(1);
      }

      try {
        const result = await registerSkill({
          slug: slugArg,
          name: nameArg ?? slugArg,
          kind: kindArg,
          authority: authorityArg,
        });
        console.log(`Registered: ${result.skill_id}`);
        console.log(`STRIDE score: ${result.verification.stride_score}`);
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
      return;
    }

    if (cmd === 'import') {
      const authorityArg = args.find(a => a.startsWith('--authority='))?.split('=')[1];
      const dryRun = args.includes('--dry-run');
      if (!authorityArg) {
        console.error('Usage: npx tsx skill-hub.ts import --authority=<pubkey> [--dry-run]');
        process.exit(1);
      }
      const result = await bulkImportCatalog({ authority: authorityArg, skip_existing: true, dry_run: dryRun });
      console.log(`Import complete${dryRun ? ' (dry-run)' : ''}:`);
      console.log(`  Registered: ${result.registered.length}`);
      console.log(`  Skipped:    ${result.skipped.length}`);
      console.log(`  Blocked:    ${result.blocked.length}`);
      if (result.blocked.length > 0) {
        console.log('\nBlocked skills:');
        for (const b of result.blocked) {
          console.log(`  ${b.slug}: ${b.reason}`);
        }
      }
      return;
    }

    console.error('Commands: list | register | import');
    process.exit(1);
  }

  main().catch(err => { console.error(err); process.exit(1); });
}
