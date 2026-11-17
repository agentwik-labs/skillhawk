#!/usr/bin/env node
// Weekly public index: grade and security-scan every skill in the public repositories we track, and record it.
// Deterministic, no model calls. Each run writes data/index/<date>.json and latest.json, and prepends the week's
// changes to CHANGES.md. Snapshots are committed to the public repository, so git history dates each result.
// Only our own findings and public metadata are recorded; no skill text is copied.
//
//   node tools/index-snapshot.mjs [--out data/index] [--sources sources/community.json] [--date YYYY-MM-DD]
//   node tools/index-snapshot.mjs --local owner/repo=path[,owner/repo=path]   (tests: no network)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRepo } from '../src/importer.js';
import { reviewDir, findSkillDirs } from '../src/review.js';
import { secureScan } from '../src/secure.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const out = path.resolve(flag('out') || path.join(ROOT, 'data', 'index'));
const date = flag('date') || new Date().toISOString().slice(0, 10);
const local = flag('local');
const SEV = ['high', 'medium', 'low'];

const count = (fs_, key = 'severity') => Object.fromEntries(SEV.map((s) => [s, fs_.filter((f) => f[key] === s).length]));
const rules = (fs_) => [...new Set(fs_.map((f) => f.rule))].sort();
const posix = (p) => p.split(path.sep).join('/');

function repos() {
  if (local) return local.split(',').map((pair) => { const [repo, dir] = pair.split('='); return { repo, dir: path.resolve(dir), url: `https://github.com/${repo}`, sha: 'local', date }; });
  const src = JSON.parse(fs.readFileSync(path.resolve(flag('sources') || path.join(ROOT, 'sources', 'community.json')), 'utf8')).sources;
  const list = [];
  for (const repo of src) {
    try { list.push({ repo, ...fetchRepo(repo) }); } catch (e) { list.push({ repo, error: e.message }); }
  }
  return list;
}

function judge(r) {
  const skills = [];
  for (const dir of findSkillDirs([r.dir])) {
    const rel = posix(path.relative(r.dir, dir)) || '.';
    let rev; let sec;
    try { rev = reviewDir(dir); } catch (e) { skills.push({ id: `${r.repo}/${rel}`, repo: r.repo, path: rel, error: `review: ${e.message}` }); continue; }
    try { sec = secureScan([dir]); } catch { sec = { high: 0, medium: 0, low: 0, findings: [] }; }
    skills.push({
      id: `${r.repo}/${rel}`, repo: r.repo, path: rel, name: rev.name, commit: r.sha,
      grade: rev.grade, score: rev.score, tokens: rev.tokens,
      review: { ...count(rev.findings), rules: rules(rev.findings) },
      secure: { high: sec.high, medium: sec.medium, low: sec.low, rules: rules(sec.findings) },
    });
  }
  return skills;
}

function diff(prev, cur) {
  const before = new Map((prev?.skills || []).map((s) => [s.id, s]));
  const after = new Map(cur.skills.map((s) => [s.id, s]));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [];
  for (const [id, s] of after) {
    const p = before.get(id);
    if (!p || p.error || s.error) continue;
    const what = [];
    if (p.grade !== s.grade) what.push(`grade ${p.grade} -> ${s.grade}`);
    for (const k of SEV) if (p.secure[k] !== s.secure[k]) what.push(`security ${k} ${p.secure[k]} -> ${s.secure[k]}`);
    const newRules = s.secure.rules.filter((x) => !p.secure.rules.includes(x));
    if (newRules.length) what.push(`new security findings: ${newRules.join(', ')}`);
    if (what.length) changed.push({ id, what });
  }
  return { since: prev?.date || null, added, removed, changed };
}

const list = repos();
const skills = list.filter((r) => r.dir).flatMap(judge).sort((a, b) => a.id.localeCompare(b.id));
for (const r of list) if (r.dir && !local) fs.rmSync(r.dir, { recursive: true, force: true });
const grades = Object.fromEntries(['A', 'B', 'C', 'D', 'F'].map((g) => [g, skills.filter((s) => s.grade === g).length]));
const snap = {
  date,
  method: 'skillhawk review (A-F grade, line findings) and skillhawk secure (skill, script and config checks), run on each repository at the listed commit. Deterministic; no model calls. Only our findings and public metadata are recorded.',
  sources: list.map((r) => (r.error ? { repo: r.repo, error: r.error } : { repo: r.repo, commit: r.sha, commitDate: r.date, skills: skills.filter((s) => s.repo === r.repo).length })),
  totals: { skills: skills.length, grades, withSecurityHigh: skills.filter((s) => s.secure?.high > 0).length },
  skills,
};

fs.mkdirSync(out, { recursive: true });
const prevFile = fs.readdirSync(out).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${date}.json`).sort().pop();
const prev = prevFile ? JSON.parse(fs.readFileSync(path.join(out, prevFile), 'utf8')) : null;
const d = diff(prev, snap);
snap.changes = d;
const json = `${JSON.stringify(snap, null, 2)}\n`;
fs.writeFileSync(path.join(out, `${date}.json`), json);
fs.writeFileSync(path.join(out, 'latest.json'), json);

const lines = [`## ${date}`, '', `${snap.totals.skills} skills from ${list.filter((r) => r.dir).length} repositories; grades ${Object.entries(grades).map(([g, n]) => `${g}=${n}`).join(' ')}; ${snap.totals.withSecurityHigh} with a high security finding.`];
if (!prev) lines.push('', 'First snapshot.');
else {
  lines.push('', `Since ${d.since}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed.`);
  for (const c of d.changed) lines.push(`- \`${c.id}\`: ${c.what.join('; ')}`);
  for (const a of d.added) lines.push(`- added \`${a}\``);
  for (const r of d.removed) lines.push(`- removed \`${r}\``);
}
const errors = list.filter((r) => r.error);
if (errors.length) lines.push('', `Not fetched: ${errors.map((r) => `${r.repo} (${r.error})`).join('; ')}`);
const changesFile = path.join(out, 'CHANGES.md');
const head = '# Skillhawk public index: weekly changes\n\nNewest first. Data: one JSON file per week in this folder; `latest.json` is the newest.\n\n';
const old = fs.existsSync(changesFile) ? fs.readFileSync(changesFile, 'utf8').replace(head, '') : '';
const body = old.replace(new RegExp(`^## ${date}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm'), '');
fs.writeFileSync(changesFile, `${head}${lines.join('\n')}\n\n${body}`.replace(/\n{3,}/g, '\n\n'));
console.log(`index ${date}: ${snap.totals.skills} skills, ${d.changed.length} changed, ${d.added.length} added, ${d.removed.length} removed${errors.length ? `, ${errors.length} repos not fetched` : ''}`);
