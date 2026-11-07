/**
 * gateway/src/skillHub.ts
 *
 * Express router for the Skill Hub API.
 * All read endpoints are public. Write endpoints require a valid
 * authority signature header (X-Authority-Pubkey + X-Signature).
 *
 * Routes:
 *   GET  /api/skills                  — list all active skills
 *   GET  /api/skills/:skillId         — single skill by hex ID
 *   GET  /api/skills/slug/:slug        — single skill by slug
 *   GET  /api/skills/kinds            — list component kinds + counts
 *   POST /api/skills/register         — register a new skill (gate enforced)
 *   POST /api/skills/revoke/:skillId  — revoke a skill (authority-gated)
 *   GET  /api/skills/catalog          — raw catalog.json passthrough
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import * as path from 'node:path';
import * as fs from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  listSkills,
  getSkillById,
  getSkillBySlug,
  registerSkill,
  revokeSkill,
  loadCatalog,
  ComponentKind,
  SKILLS_ROOT,
} from '../../formal_verification/skill-hub.js';

const router = Router();


const metadataRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

function escapeForXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveSkillDocPath(slug: string, candidate: string): string | null {
  const target = path.resolve(SKILLS_ROOT, slug, candidate);
  const rel = path.relative(SKILLS_ROOT, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function verifyAuthoritySignature(authority: string, signature: string | undefined, body: unknown): boolean {
  if (!signature) return false;
  try {
    const payload = JSON.stringify(body ?? {});
    const messageBytes = new TextEncoder().encode(payload);
    const signatureBytes = bs58.decode(signature);
    const pubKeyBytes = bs58.decode(authority);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, pubKeyBytes);
  } catch {
    return false;
  }
}

function cacheHeaders(seconds: number) {
  return (_req: Request, res: Response, next: () => void) => {
    res.setHeader('Cache-Control', `public, max-age=${seconds}`);
    next();
  };
}

// ── GET /api/skills ────────────────────────────────────────────────────────

router.get('/api/skills', cacheHeaders(30), (_req: Request, res: Response) => {
  try {
    const kindFilter = _req.query.kind as ComponentKind | undefined;
    const activeOnly = _req.query.active !== 'false';
    const skills = listSkills({ kind: kindFilter, active: activeOnly });
    res.json({ count: skills.length, skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/skills/catalog ────────────────────────────────────────────────

router.get('/api/skills/catalog', cacheHeaders(120), (_req: Request, res: Response) => {
  try {
    const catalog = loadCatalog();
    res.json({ count: catalog.length, catalog });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/skills/kinds ──────────────────────────────────────────────────

router.get('/api/skills/kinds', cacheHeaders(60), (_req: Request, res: Response) => {
  const skills = listSkills({ active: true });
  const counts: Record<string, number> = {};
  for (const s of skills) {
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  }
  res.json({ kinds: counts });
});

// ── GET /api/skills/:skillId ───────────────────────────────────────────────

router.get('/api/skills/:skillId([0-9a-f]{64})', cacheHeaders(60), (req: Request, res: Response) => {
  const entry = getSkillById(firstParam(req.params.skillId));
  if (!entry) {
    res.status(404).json({ error: 'Skill not found' });
    return;
  }
  res.json(entry);
});

// ── GET /api/skills/slug/:slug ─────────────────────────────────────────────

router.get('/api/skills/slug/:slug', cacheHeaders(60), (req: Request, res: Response) => {
  const entry = getSkillBySlug(firstParam(req.params.slug));
  if (!entry) {
    res.status(404).json({ error: 'Skill not found' });
    return;
  }
  res.json(entry);
});

// ── GET /api/skills/slug/:slug/metadata.json ───────────────────────────────

router.get('/api/skills/slug/:slug/metadata.json', cacheHeaders(300), metadataRouteLimiter, (req: Request, res: Response) => {
  const entry = getSkillBySlug(firstParam(req.params.slug));
  if (!entry || !entry.active) {
    res.status(404).json({ error: 'Skill not found or inactive' });
    return;
  }

  // Try to read a README or skill.md for a richer description
  let description = '';
  for (const candidate of ['README.md', 'skill.md', 'SKILL.md']) {
    const fp = resolveSkillDocPath(entry.slug, candidate);
    if (!fp) continue;
    if (fs.existsSync(fp)) {
      description = fs.readFileSync(fp, 'utf8').slice(0, 500);
      break;
    }
  }

  res.json({
    name: entry.name,
    description: description || entry.slug,
    image: `https://solanaclawd.com/api/skills/slug/${entry.slug}/card.svg`,
    external_url: `https://solanaclawd.com/skills/${entry.slug}`,
    attributes: [
      { trait_type: 'Kind', value: entry.kind },
      { trait_type: 'STRIDE Score', value: entry.stride_score },
      { trait_type: 'Kani Verified', value: String(entry.kani_verified) },
      { trait_type: 'Active', value: String(entry.active) },
      { trait_type: 'Registered At', value: entry.registered_at },
    ],
    properties: {
      skill_id: entry.skill_id,
      spec_hash: entry.spec_hash,
      authority: entry.authority,
      on_chain: entry.on_chain ?? false,
    },
  });
});

// ── GET /api/skills/slug/:slug/card.svg ───────────────────────────────────

router.get('/api/skills/slug/:slug/card.svg', cacheHeaders(600), (req: Request, res: Response) => {
  const slug = firstParam(req.params.slug);
  const entry = getSkillBySlug(slug);
  const name = entry?.name ?? slug;
  const score = entry?.stride_score ?? 0;
  const kind = entry?.kind ?? 'skill';
  const scoreColor = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';
  const safeName = escapeForXml(name.slice(0, 30));
  const safeKind = escapeForXml(kind.toUpperCase());
  const safeSkillIdPrefix = escapeForXml(entry?.skill_id?.slice(0, 16) ?? '');

  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160" viewBox="0 0 400 160">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f172a"/>
      <stop offset="100%" style="stop-color:#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="400" height="160" rx="12" fill="url(#bg)"/>
  <rect x="0" y="0" width="4" height="160" rx="2" fill="${scoreColor}"/>
  <text x="24" y="44" font-family="monospace" font-size="18" font-weight="bold" fill="#f8fafc">${safeName}</text>
  <text x="24" y="70" font-family="monospace" font-size="12" fill="#94a3b8">${safeKind}</text>
  <text x="24" y="110" font-family="monospace" font-size="11" fill="#64748b">STRIDE</text>
  <text x="24" y="130" font-family="monospace" font-size="22" font-weight="bold" fill="${scoreColor}">${score}</text>
  <text x="80" y="130" font-family="monospace" font-size="11" fill="#475569">/100</text>
  ${entry?.kani_verified ? `<text x="330" y="130" font-family="monospace" font-size="11" fill="#22c55e">KANI ✓</text>` : ''}
  <text x="24" y="150" font-family="monospace" font-size="9" fill="#334155">${safeSkillIdPrefix}...</text>
</svg>`);
});

// ── POST /api/skills/register ──────────────────────────────────────────────

const registerRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/api/skills/register', registerRouteLimiter, async (req: Request, res: Response) => {
  const { slug, name, kind, authority, metadata_uri, component_path, kani_verified } = req.body ?? {};

  if (!slug || !authority) {
    res.status(400).json({ error: 'slug and authority are required' });
    return;
  }

  const authorityHeader = req.headers['x-authority-pubkey'] as string | undefined;
  if (authorityHeader && authorityHeader !== authority) {
    res.status(401).json({ error: 'authority mismatch' });
    return;
  }
  const signature = req.headers['x-signature'] as string | undefined;
  if (!verifyAuthoritySignature(authority, signature, req.body)) {
    res.status(401).json({ error: 'valid X-Signature required' });
    return;
  }

  try {
    const result = await registerSkill({
      slug,
      name: name ?? slug,
      kind: (kind ?? 'skill') as ComponentKind,
      authority,
      metadata_uri,
      component_path,
      kani_verified: kani_verified === true,
    });

    res.status(201).json({
      skill_id: result.skill_id,
      stride_score: result.verification.stride_score,
      kani_verified: result.entry.kani_verified,
      entry: result.entry,
      message: 'Registered. Submit skill_id on-chain via register_skill instruction.',
    });
  } catch (err: any) {
    res.status(422).json({ error: err.message });
  }
});

// ── POST /api/skills/revoke/:skillId ──────────────────────────────────────

router.post('/api/skills/revoke/:skillId([0-9a-f]{64})', (req: Request, res: Response) => {
  const authority = (req.headers['x-authority-pubkey'] as string) ?? req.body?.authority;
  if (!authority) {
    res.status(401).json({ error: 'X-Authority-Pubkey header required' });
    return;
  }
  const signature = req.headers['x-signature'] as string | undefined;
  if (!verifyAuthoritySignature(authority, signature, req.body ?? { skillId: req.params.skillId })) {
    res.status(401).json({ error: 'valid X-Signature required' });
    return;
  }

  try {
    const skillId = firstParam(req.params.skillId);
    revokeSkill(skillId, authority);
    res.json({ revoked: true, skill_id: skillId });
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

export default router;
