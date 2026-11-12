import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findSkillDirs, reviewDir, reviewFiles, reviewLibrary, fixText, fixDir } from '../src/review.js';
import { parseArgs } from '../src/args.js';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'review');
const BIN = path.join(FX, '..', '..', '..', 'bin', 'skillyard.js');
const rules = (r) => r.findings.map((f) => f.rule);

test('finds skill folders recursively', () => {
  assert.equal(findSkillDirs([FX]).length, 4);
});

test('a good skill gets an A with no findings', () => {
  const r = reviewDir(path.join(FX, 'good', 'api-errors'));
  assert.equal(r.grade, 'A');
  assert.deepEqual(r.findings, []);
});

test('a bad skill is graded low with line-level findings and fixes', () => {
  const r = reviewDir(path.join(FX, 'bad', 'team-notes'));
  assert.ok('DF'.includes(r.grade), r.grade);
  for (const want of ['license-header-above-frontmatter', 'trigger-hijack', 'description-no-when', 'vague-instruction', 'contradiction', 'broken-link']) {
    assert.ok(rules(r).includes(want), `missing ${want}: ${rules(r)}`);
  }
  const hedge = r.findings.find((f) => f.rule === 'vague-instruction');
  assert.equal(hedge.file, 'SKILL.md');
  assert.ok(hedge.line > 1 && hedge.fix);
  assert.equal(r.findings.filter((f) => f.rule === 'contradiction').length, 2);
});

test('library pass flags the duplicate pair and nothing else', () => {
  const skills = findSkillDirs([FX]).map((d) => {
    const r = reviewDir(d);
    const text = fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8');
    return { dir: d, name: r.name, description: r.description, body: text.split('---').slice(2).join('---'), lines: text.split('\n'), fm: 5 };
  });
  const lib = reviewLibrary(skills);
  assert.equal(lib.duplicates.length, 1);
  assert.deepEqual(lib.duplicates[0].names.sort(), ['commit-style-a', 'commit-style-b']);
  assert.equal(lib.duplicates[0].severity, 'high');
});

test('fixText moves a license header inside the frontmatter and leaves prose alone', () => {
  const src = '<!-- Copyright 2026 Acme -->\n---\nname: x\ndescription: Use when testing.  \n---\n\nBody text, unchanged.\n';
  const r = fixText(src);
  assert.match(r.text, /^---\nname: x\ndescription: Use when testing\.\n# Copyright 2026 Acme\n---\n\nBody text, unchanged\.\n$/);
  assert.equal(r.changes.length, 2);
  assert.deepEqual(fixText(r.text).changes, []);
});

test('--fix rewrites only mechanical problems and the CLI reports', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-'));
  fs.cpSync(path.join(FX, 'bad'), tmp, { recursive: true });
  const dir = path.join(tmp, 'team-notes');
  const before = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const changes = fixDir(dir);
  assert.equal(changes.length, 1);
  const after = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.ok(after.startsWith('---\nname: team-notes'));
  assert.equal(after.split('\n---\n').pop(), before.split('\n---\n').pop());
  assert.ok(!rules(reviewDir(dir)).includes('license-header-above-frontmatter'));
});

test('CLI prints a report and writes json', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-json-')), 'r.json');
  let stdout;
  try { stdout = execFileSync('node', [BIN, 'review', FX, '--json', out], { encoding: 'utf8' }); } catch (e) { stdout = e.stdout; }
  assert.match(stdout, /skillyard review: 4 skills/);
  assert.match(stdout, /library: 1 duplicate/);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.skills.length, 4);
  assert.equal(j.library.duplicates.length, 1);
});

// ---- precision regression: well-regarded real skills must not draw bogus findings ----
const FP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fp-corpus');

test('fp-corpus (ibelick/ui-skills, MIT): no high contradictions and grade B or better', () => {
  const dirs = findSkillDirs([FP]);
  assert.equal(dirs.length, 6);
  for (const d of dirs) {
    const r = reviewDir(d);
    assert.ok('AB'.includes(r.grade), `${path.basename(d)} graded ${r.grade}`);
    const bad = r.findings.filter((f) => f.rule === 'contradiction' && f.severity === 'high');
    assert.deepEqual(bad, [], path.basename(d));
  }
});

test('a repeated rule is a low duplicate-rule, not a contradiction', () => {
  const md = '---\nname: dup\ndescription: Edits metadata. Use when fixing meta tags on a page.\n---\n# Dup\n\n- Keep diffs minimal and scoped to metadata only. Do not refactor unrelated code.\n- Other filler rule about something else entirely goes right here.\n- keep diffs minimal and scoped to metadata only\n';
  const r = reviewFiles({ 'SKILL.md': Buffer.from(md) });
  assert.ok(!r.findings.some((f) => f.rule === 'contradiction'));
  assert.equal(r.findings.find((f) => f.rule === 'duplicate-rule')?.severity, 'low');
});

test('unrelated unless-rules are not contradictions; one heuristic finding cannot drop below B', () => {
  const md = '---\nname: scoped\ndescription: Styles things. Use when styling a page with Tailwind.\n---\n# Scoped\n\n- MUST use Tailwind CSS defaults unless custom values already exist.\n- NEVER add animation unless it is explicitly requested.\n- Try to be nice.\n';
  const r = reviewFiles({ 'SKILL.md': Buffer.from(md) });
  assert.ok(!r.findings.some((f) => f.rule === 'contradiction'));
  assert.ok('AB'.includes(r.grade), r.grade);
});

test('engineering-handbook keeps its 3 real contradictions and stays F', () => {
  const r = reviewDir(path.join(FX, '..', '..', '..', 'examples', 'bad', 'engineering-handbook'));
  assert.equal(r.findings.filter((f) => f.rule === 'contradiction' && f.severity === 'high').length, 3);
  assert.equal(r.grade, 'F');
});

test('parseArgs: --gate takes a value only from its enum', () => {
  assert.deepEqual(parseArgs(['secure', '--gate', 'high', 'dir']), { _: ['secure', 'dir'], gate: 'high' });
  assert.deepEqual(parseArgs(['secure', '--gate', 'dir']), { _: ['secure', 'dir'], gate: true });
  assert.deepEqual(parseArgs(['secure', '--gate=low', 'dir']), { _: ['secure', 'dir'], gate: 'low' });
  assert.deepEqual(parseArgs(['review', '--json', 'out.json', 'dir']), { _: ['review', 'dir'], json: 'out.json' });
});
