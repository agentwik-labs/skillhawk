#!/usr/bin/env node
// Builds web/media/library.json: Skillhawk's own judgement of every public skill in a registry.
// Each skill is graded by the reviewer (src/review.js) and checked by the security audit (src/secure.js, which also
// runs src/scan.js). Nothing here is invented: a skill that cannot be reviewed is left out, not guessed.
//
//   node tools/build-library.mjs --data <dataDir> [--out web/media/library.json]
//   node tools/build-library.mjs --dirs registry/public,<more skill folders> [--out ...]
//
// It also writes one badge per skill (src/badge.js) to <out dir>/badges/<scope>/<name>.svg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewDir, findSkillDirs } from '../src/review.js';
import { secureScan } from '../src/secure.js';
import { badgeSvg } from '../src/badge.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const out = path.resolve(flag('out') || path.join(ROOT, 'web/media/library.json'));
const data = flag('data');
const dirs = flag('dirs');
if (!data && !dirs) { console.error('usage: build-library.mjs --data <dataDir> | --dirs <a,b> [--out file]'); process.exit(2); }

const SEV = ['high', 'medium', 'low'];
const oneLine = (t, n = 120) => {
  const s = String(t || '').replace(/^>\s*/, '').replace(/\s+/g, ' ').trim();
  const first = s.split(/(?<=[a-z0-9)])\.\s/)[0].replace(/\.$/, '');
  return first.length <= n ? first : `${first.slice(0, first.lastIndexOf(' ', n)).replace(/[\s,;:-]+$/, '')}…`;
};

// ---- collect the skills to judge -----------------------------------------------------------------
const items = [];
if (data) {
  const db = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  for (const s of Object.values(db.skills)) {
    if (s.visibility !== 'public' || !['skillyard', 'community'].includes(s.scope)) continue;
    const v = s.versions[s.latest];
    const dir = path.join(data, 'blobs', s.scope, s.name, s.latest);
    if (!v || !fs.existsSync(dir)) continue;
    const m = v.manifest;
    items.push({ id: s.id, scope: s.scope === 'skillyard' ? 'public' : 'community', name: s.name, title: m.title || s.name,
      category: m.category || 'other', description: oneLine(m.summary || m.description), dir,
      source: s.source ? { repo: s.source.repo.replace('https://github.com/', ''), licence: s.source.license || m.license || null } : { repo: 'agentwik-labs/skillhawk', licence: m.license || 'MIT' } });
  }
} else {
  for (const d of dirs.split(',')) for (const sd of findSkillDirs([d])) {
    const name = path.basename(sd);
    let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(sd, 'skill.json'), 'utf8')); } catch { /* frontmatter only */ }
    const own = path.resolve(d) === path.join(ROOT, 'registry/public');
    items.push({ id: `@${own ? 'skillyard' : 'community'}/${name}`, scope: own ? 'public' : 'community', name, title: m.title || name, category: m.category || 'other',
      description: null, dir: sd, source: { repo: own ? 'agentwik-labs/skillhawk' : null, licence: m.license || null } });
  }
}

// ---- judge each one ------------------------------------------------------------------------------
const skills = [];
let skipped = 0;
for (const it of items) {
  let r, sec;
  try { r = reviewDir(it.dir); sec = secureScan([it.dir]); } catch { skipped++; continue; }
  const counts = Object.fromEntries(SEV.map((s) => [s, r.findings.filter((f) => f.severity === s).length]));
  const secure = sec.high ? 'high' : sec.medium ? 'medium' : sec.low ? 'low' : 'clean';
  const strip = (f) => f.replace(`${it.dir}${path.sep}`, '').replace(it.dir, '.');
  skills.push({
    id: it.id, scope: it.scope, name: it.name, title: it.title, category: it.category,
    description: it.description || oneLine(r.description), source: it.source,
    grade: r.grade, score: r.score, tokens: r.tokens,
    findings: counts,
    top: r.findings.slice(0, 5).map((f) => ({ severity: f.severity, rule: f.rule, file: f.file, line: f.line, message: oneLine(f.message, 140) })),
    secure, secureFindings: { high: sec.high, medium: sec.medium, low: sec.low },
    secureTop: sec.findings.slice(0, 3).map((f) => ({ severity: f.severity, rule: f.rule, file: strip(f.file), line: f.line, message: oneLine(f.message, 140) })),
  });
  const badgeDir = path.join(path.dirname(out), 'badges', it.id.split('/')[0].slice(1));
  fs.mkdirSync(badgeDir, { recursive: true });
  fs.writeFileSync(path.join(badgeDir, `${it.name}.svg`), badgeSvg({ grade: r.grade, secure: sec.high + sec.medium === 0, lift: null }));
}
skills.sort((a, b) => a.id.localeCompare(b.id));

// ---- summary and featured picks (best grades, clean security, one per category, ours and community mixed) ---
const grades = Object.fromEntries(['A', 'B', 'C', 'D', 'F'].map((g) => [g, skills.filter((s) => s.grade === g).length]));
const secureCounts = Object.fromEntries(['clean', 'low', 'medium', 'high'].map((k) => [k, skills.filter((s) => s.secure === k).length]));
const rank = (s) => s.score * 10 - s.tokens / 1000;
const pool = skills.filter((s) => s.grade === 'A' && s.secure === 'clean' && s.tokens >= 300 && !/deprecated/i.test(s.description)).sort((a, b) => rank(b) - rank(a));
const featured = [];
const seen = new Set();
for (const want of ['community', 'public', 'community', 'public', 'community', 'public', 'community', 'public']) {
  const pick = pool.find((s) => s.scope === want && !seen.has(s.category) && !featured.includes(s.id))
    || pool.find((s) => !seen.has(s.category) && !featured.includes(s.id));
  if (!pick) break;
  featured.push(pick.id); seen.add(pick.category);
}

const lib = {
  generatedAt: new Date().toISOString(),
  method: 'Grade from skillhawk review (A to F, line-level findings). Security from skillhawk secure, which includes the skill scanner. Same code as the CLI.',
  total: skills.length, scopes: { public: skills.filter((s) => s.scope === 'public').length, community: skills.filter((s) => s.scope === 'community').length },
  grades, secure: secureCounts, featured, skills,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(lib)}\n`);
console.log(`library: ${skills.length} skills (${lib.scopes.public} ours, ${lib.scopes.community} community)${skipped ? `, ${skipped} skipped` : ''}`);
console.log(`grades: ${Object.entries(grades).map(([g, n]) => `${g} ${n}`).join(', ')}`);
console.log(`secure: ${Object.entries(secureCounts).map(([g, n]) => `${g} ${n}`).join(', ')}`);
console.log(`featured: ${featured.join(', ')}`);
console.log(`wrote ${path.relative(process.cwd(), out)}`);
