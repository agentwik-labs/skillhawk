// tools/index-snapshot.mjs: weekly snapshot of the public index, with a diff against the previous week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'index-snapshot.mjs'), ...args], { encoding: 'utf8' });

test('snapshot grades every skill, then a second week records what changed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-index-'));
  const repo = path.join(d, 'repo'); const out = path.join(d, 'index');
  fs.cpSync(path.join(ROOT, 'test/fixtures/review/good'), path.join(repo, 'skills'), { recursive: true });
  let r = run(['--local', `acme/skills=${repo}`, '--out', out, '--date', '2026-11-17']);
  assert.equal(r.status, 0, r.stderr);
  const w1 = JSON.parse(fs.readFileSync(path.join(out, '2026-11-17.json'), 'utf8'));
  assert.equal(w1.totals.skills, 1);
  assert.equal(w1.skills[0].id, 'acme/skills/skills/api-errors');
  assert.equal(w1.skills[0].grade, 'A');
  assert.match(fs.readFileSync(path.join(out, 'CHANGES.md'), 'utf8'), /First snapshot/);
  // week 2: the skill gets worse and a second one appears
  fs.cpSync(path.join(ROOT, 'test/fixtures/review/bad/team-notes'), path.join(repo, 'skills', 'team-notes'), { recursive: true });
  const md = path.join(repo, 'skills', 'api-errors', 'SKILL.md');
  fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/^description:.*$/m, 'description: Notes.'));
  r = run(['--local', `acme/skills=${repo}`, '--out', out, '--date', '2026-11-24']);
  assert.equal(r.status, 0, r.stderr);
  const w2 = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
  assert.equal(w2.changes.since, '2026-11-17');
  assert.deepEqual(w2.changes.added, ['acme/skills/skills/team-notes']);
  assert.match(w2.changes.changed[0].what.join(' '), /grade A -> /);
  const changes = fs.readFileSync(path.join(out, 'CHANGES.md'), 'utf8');
  assert.ok(changes.indexOf('## 2026-11-24') < changes.indexOf('## 2026-11-17'), 'newest first');
  // re-running the same week replaces that week's section instead of duplicating it
  run(['--local', `acme/skills=${repo}`, '--out', out, '--date', '2026-11-24']);
  assert.equal(fs.readFileSync(path.join(out, 'CHANGES.md'), 'utf8').match(/## 2026-11-24/g).length, 1);
  assert.doesNotMatch(JSON.stringify(w2), /Internal notes|# /, 'no skill text is copied');
});
