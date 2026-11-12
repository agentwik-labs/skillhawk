import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { markSkill, trace } from '../src/mark.js';
import { reviewFiles } from '../src/review.js';
import { readSkillDir } from '../src/skill.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'skillyard.js');
const SECRET = 'test-org-secret';
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'];
const skillText = (n) => fs.readFileSync(path.join(ROOT, 'registry', 'public', n, 'SKILL.md'), 'utf8');
const ORIGINAL = skillText('code-review');
const ZW = /[​-‏⁠-⁤﻿]/g;

const copies = NAMES.map((recipient) => ({ recipient, ...markSkill(ORIGINAL, { recipient, version: '1.0.0', orgSecret: SECRET }) }));
const prints = copies.map((c) => c.fingerprint);
const top = (text, o = {}) => trace(text, prints, { orgSecret: SECRET, ...o });
const lines = (t) => t.split('\n');

// Test helpers: a deterministic "paraphrase" and a simple collusion merge.
function paraphrase(text) {
  let n = 0;
  const revert = (re, to) => (s) => s.replace(re, (m) => (n++ % 2 ? to(m) : m));
  return text
    .replace(ZW, '')
    .split('\n').map((l) => l.trim().replace(/[ \t]+/g, ' ')).join('\n')
    .replace(/(Don|Doesn|Isn|Aren|Didn)['’]t/g, revert(/./, (m) => `${m.slice(0, -3)} not`.replace(/^Don$/, 'Do')))
    .replace(/\b(ensure|verify|prior to|for example,)\b/g, (m) => (n++ % 2 ? { ensure: 'make sure', verify: 'check', 'prior to': 'before', 'for example,': 'e.g.' }[m] : m));
}
function merge(a, b) {
  const [la, lb] = [lines(a), lines(b)];
  return la.map((l, i) => (Math.floor(i / 2) % 2 === 0 ? l : lb[i] ?? l)).join('\n');
}

test('marking is deterministic and differs per recipient', () => {
  const again = markSkill(ORIGINAL, { recipient: 'alice', version: '1.0.0', orgSecret: SECRET });
  assert.equal(again.text, copies[0].text);
  assert.deepEqual(again.fingerprint, prints[0]);
  assert.equal(new Set(copies.map((c) => c.text)).size, 10);
  assert.notEqual(markSkill(ORIGINAL, { recipient: 'alice', version: '1.0.1', orgSecret: SECRET }).text, copies[0].text);
  assert.ok(prints[0].sites.length >= 24, `sites ${prints[0].sites.length}`);
  assert.equal(prints[0].code.length, 32);
  assert.ok(prints[0].zwPoints >= 6);
  assert.deepEqual(JSON.parse(JSON.stringify(prints[0])), prints[0]);
});

test('10 recipients are each traced from the full copy', () => {
  for (const c of copies) {
    const r = top(c.text);
    assert.equal(r[0].recipient, c.recipient);
    assert.ok(r[0].confidence > 0.999999, String(r[0].confidence));
    assert.ok(r[1].confidence < 0.5, `runner-up ${r[1].recipient} ${r[1].confidence}`);
    assert.ok(r[0].evidence.length === 3);
  }
});

test('still traced after zero-width characters are stripped', () => {
  for (const c of copies) {
    const r = top(c.text.replace(ZW, ''));
    assert.equal(r[0].recipient, c.recipient);
    assert.ok(!r[0].evidence.some((e) => /zero-width/.test(e)));
    assert.ok(r[0].confidence > 0.999, String(r[0].confidence));
    assert.ok(r[1].confidence < 0.5);
  }
});

test('traced from a ~30% fragment, with lower confidence than the full copy', () => {
  for (const c of copies) {
    const ls = lines(c.text);
    const frag = ls.slice(Math.floor(ls.length * 0.3), Math.floor(ls.length * 0.6)).join('\n');
    assert.ok(Math.abs(frag.length / c.text.length - 0.3) < 0.12);
    const [r, full] = [top(frag), top(c.text)];
    assert.equal(r[0].recipient, c.recipient, JSON.stringify(r.slice(0, 2)));
    assert.ok(r[0].evidenceBits < full[0].evidenceBits);
    assert.ok(r[0].confidence <= full[0].confidence);
    assert.ok(r[0].confidence > 0.9, String(r[0].confidence));
    // wording alone (zero-width stripped, fragment) still points at the right person
    const w = top(frag.replace(ZW, ''));
    assert.equal(w[0].recipient, c.recipient, JSON.stringify(w.slice(0, 2)));
    assert.ok(w[0].evidence.some((e) => /wording/.test(e)));
  }
});

test('canaries identify the recipient after a simulated paraphrase', () => {
  for (const c of copies) {
    const p = paraphrase(c.text);
    assert.notEqual(p, c.text);
    const r = top(p);
    assert.equal(r[0].recipient, c.recipient);
    assert.ok(r[0].evidence.some((e) => /^canary: name/.test(e)), r[0].evidence.join('|'));
    assert.ok(r[0].confidence > 0.999999);
    assert.ok(r.slice(1).every((x) => !x.evidence.some((e) => /canary/.test(e))));
  }
});

test('a merged copy lists both colluders at the top', () => {
  for (const [i, j] of [[0, 1], [2, 7], [4, 9], [3, 5]]) {
    const merged = merge(copies[i].text, copies[j].text);
    const names = top(merged).slice(0, 2).map((r) => r.recipient).sort();
    assert.deepEqual(names, [NAMES[i], NAMES[j]].sort());
    // wording alone is a weaker signal under collusion (about 30 sites): both colluders still rank in the top few of 10
    const w = top(merged.replace(ZW, '')).slice(0, 4).map((r) => r.recipient);
    assert.ok(w.includes(NAMES[i]) && w.includes(NAMES[j]), `wording layer alone: ${w}`);
  }
});

test('unmarked or unrelated text matches nobody', () => {
  const r = top(ORIGINAL);
  assert.ok(r.every((x) => x.confidence < 0.9), JSON.stringify(r[0]));
  const other = markSkill(ORIGINAL, { recipient: 'mallory', version: '1.0.0', orgSecret: SECRET }).text;
  assert.ok(top(other)[0].confidence < 0.9);
  assert.ok(trace(copies[0].text, prints, { orgSecret: 'wrong-secret' })[0].evidence.every((e) => !/zero-width|canary/.test(e)));
});

test('marked copies keep their grade and leave code, frontmatter and links alone', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'registry', 'public')).map((n) => path.join(ROOT, 'registry', 'public', n));
  dirs.push(path.join(ROOT, 'examples', 'good', fs.readdirSync(path.join(ROOT, 'examples', 'good'))[0]));
  assert.ok(dirs.length >= 30);
  for (const d of dirs) {
    const files = readSkillDir(d);
    const text = files['SKILL.md'].toString('utf8');
    const { text: marked } = markSkill(text, { recipient: 'alice', version: '2.0.0', orgSecret: SECRET });
    const [a, b] = [reviewFiles(files, d), reviewFiles({ ...files, 'SKILL.md': Buffer.from(marked) }, d)];
    assert.equal(b.grade, a.grade, `${d}: ${a.grade} -> ${b.grade}`);
    assert.ok(b.valid === a.valid);
    const clean = marked.replace(ZW, '');
    const fm = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0];
    if (fm) assert.ok(clean.startsWith(fm), `${d} frontmatter`);
    for (const m of text.matchAll(/^```[\s\S]*?^```/gm)) assert.ok(clean.includes(m[0]), `${d} code fence`);
    for (const m of text.matchAll(/`[^`\n]+`|https?:\/\/[^\s)]+/g)) assert.ok(clean.includes(m[0]), `${d} ${m[0]}`);
  }
});

test('layers can be chosen', () => {
  const only = (layers) => markSkill(ORIGINAL, { recipient: 'alice', version: '1', orgSecret: SECRET, layers }).text;
  assert.ok(!ZW.test(only(['wording', 'canary'])));
  assert.ok(!/Illustrative sample values/.test(only(['zw', 'wording'])));
  assert.equal(only(['zw']).replace(ZW, ''), ORIGINAL);
});

test('CLI: mark appends to marks.json and trace reads it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-'));
  const marks = path.join(tmp, 'marks.json');
  const src = path.join(ROOT, 'registry', 'public', 'code-review');
  for (const who of ['alice', 'bob']) {
    const out = execFileSync('node', [BIN, 'mark', src, '--recipient', who, '--version', '1.0.0', '--secret', SECRET, '--out', path.join(tmp, who), '--marks', marks], { encoding: 'utf8' });
    assert.match(out, /review grade A/);
  }
  assert.equal(JSON.parse(fs.readFileSync(marks, 'utf8')).length, 2);
  assert.ok(fs.existsSync(path.join(tmp, 'bob', 'skill.json')) || fs.existsSync(path.join(tmp, 'bob', 'SKILL.md')));
  const leak = path.join(tmp, 'leak.md');
  fs.writeFileSync(leak, fs.readFileSync(path.join(tmp, 'bob', 'SKILL.md'), 'utf8').split('\n').slice(10, 40).join('\n'));
  const out = execFileSync('node', [BIN, 'trace', leak, '--marks', marks, '--secret', SECRET], { encoding: 'utf8' });
  assert.match(out.split('\n')[0], /^bob\b/);
});
