import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://example.test/base';
let tmp; let out;
const read = (rel) => fs.readFileSync(path.join(out, rel), 'utf8');
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-prerender-'));
  const data = path.join(tmp, 'data'); // small fixture: an empty registry; the library list comes from web/media/library.json
  fs.mkdirSync(data);
  out = path.join(tmp, 'site');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'skillyard.js'), 'export', 'site', '--data', data, '--out', out, '--site-url', `${SITE}/`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('landing text is in index.html without JavaScript, and the SPA scripts are still there', () => {
  const html = read('index.html');
  assert.match(textOf(html), /Your agents keep running after you stop watching/);
  assert.match(textOf(html), /skillhawk review skills\//);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/base\/">/);
  assert.match(html, /src="app\.js/);
  const types = ldOf(html).map((x) => x['@type']);
  assert.ok(types.includes('SoftwareApplication'));
});

test('static pages exist with title, description, canonical and real text', () => {
  const pages = ['skills/index.html', 'tools/index.html', 'tools/review/index.html', 'proof/index.html', 'proof/scan/index.html', 'proof/lift/index.html', 'proof/reviewer-accuracy/index.html', 'proof/library/index.html', 'learn/index.html'];
  const lib = JSON.parse(read('media/library.json'));
  const s = lib.skills[0];
  pages.push(`skills/${s.id.split('/')[0].slice(1)}/${s.name}/index.html`);
  for (const p of pages) {
    const html = read(p);
    assert.match(html, /<title>[^<]{10,}<\/title>/, p);
    assert.match(html, /<meta name="description" content="[^"]{20,}"/, p);
    assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/base\//, p);
    assert.match(html, /<meta property="og:title"/, p);
    assert.ok(textOf(html).length > 400, `${p} has text`);
    ldOf(html); // parses
  }
  const sk = read(pages.at(-1));
  assert.match(textOf(sk), new RegExp(`Grade\\s+${s.grade}`));
  assert.match(textOf(sk), /npx skillhawk install/);
  assert.ok(ldOf(sk).some((x) => x['@type'] === 'BreadcrumbList'));
  assert.match(textOf(read('proof/scan/index.html')), /511 unique skills/);
});

test('five learn pages answer first, cite sources, and carry FAQPage JSON-LD', () => {
  const dirs = fs.readdirSync(path.join(out, 'learn')).filter((d) => fs.statSync(path.join(out, 'learn', d)).isDirectory());
  assert.equal(dirs.length, 5);
  const painpoints = '/private/tmp/claude-501/painpoints.md';
  for (const d of dirs) {
    const html = read(`learn/${d}/index.html`);
    assert.ok(ldOf(html).some((x) => x['@type'] === 'FAQPage' && x.mainEntity.length >= 2), d);
    assert.match(html, /<p class="sp-answer">/);
    const cited = [...html.matchAll(/<a href="(https?:\/\/[^"]+)" rel="noopener">/g)].map((m) => m[1]);
    assert.ok(cited.length >= 2 && cited.length <= 4, `${d}: ${cited.length} sources`);
    if (fs.existsSync(painpoints)) { const pp = fs.readFileSync(painpoints, 'utf8'); for (const u of cited) assert.ok(pp.includes(u), `${d}: ${u} not in painpoints.md`); }
  }
});

test('sitemap lists every static page; robots allows the AI bots; llms files exist', () => {
  const sm = read('sitemap.xml');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.every((l) => l.startsWith(`${SITE}/`)));
  for (const p of ['', 'skills/', 'tools/', 'tools/review/', 'proof/scan/', 'proof/lift/', 'proof/reviewer-accuracy/', 'proof/library/', 'learn/', 'learn/are-agent-skills-safe/']) assert.ok(locs.includes(`${SITE}/${p}`), p);
  assert.match(sm, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  // every generated index.html (except the studio demo) is in the sitemap
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['api', 'studio', 'media'].includes(e.name)) continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === 'index.html') found.push(path.relative(out, path.dirname(f))); } };
  walk(out);
  for (const f of found) assert.ok(locs.includes(f ? `${SITE}/${f}/` : `${SITE}/`), `${f} missing from sitemap`);
  const robots = read('robots.txt');
  for (const bot of ['GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'Bingbot']) assert.match(robots, new RegExp(`User-agent: ${bot}\\nAllow: /`));
  assert.ok(!/Disallow: \//.test(robots));
  assert.match(robots, new RegExp(`Sitemap: ${SITE}/sitemap.xml`));
  assert.match(read('llms.txt'), /^# Skillhawk/);
  const full = read('llms-full.txt');
  assert.match(full, /Are agent skills safe/);
  assert.match(full, /Command: skillhawk review skills\//);
});
