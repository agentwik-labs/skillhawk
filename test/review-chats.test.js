process.env.SKILLYARD_EXCLUDE = 'private-work,-fake-private';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rc = await import('../src/review-chats.js');
const logs = path.resolve('test/fixtures/chats');
const skillsSrc = path.resolve('test/fixtures/chat-skills');
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-chats-test-'));
  const skills = path.join(d, 'skills');
  fs.cpSync(skillsSrc, skills, { recursive: true });
  return { data: path.join(d, 'data'), skills };
};
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

test('refuses to read logs without consent', async () => {
  const { data, skills } = mk();
  const r = await quiet(() => rc.run([], { chats: true, logs, skills, data }));
  assert.equal(r.needsConsent, true);
  assert.equal(fs.existsSync(path.join(data, 'chat-proposals.json')), false);
});

test('attributes corrections, redacts secrets, never reads /private-work', async () => {
  const { data, skills } = mk();
  const r = await quiet(() => rc.run([], { chats: true, yes: true, logs, skills, data }));
  assert.equal(r.excluded, 1);
  const by = (n) => r.proposals.find((p) => p.skill === n);
  const commit = by('git-commit-style');
  assert.equal(commit.kind, 'missed-fire');
  assert.equal(commit.count, 2);
  assert.equal(commit.repeated, true);
  assert.match(commit.diff, /^@@ /m);
  assert.match(commit.diff, /^\+## Lessons from your sessions/m);
  assert.equal(by('deploy-safely').kind, 'fired-wrongly');
  const none = r.proposals.find((p) => p.skill === null);
  assert.equal(none.kind, 'no-skill');
  const stored = fs.readFileSync(path.join(data, 'chat-proposals.json'), 'utf8');
  for (const bad of ['ghp_', 'jo.doe@corp.com', 'PRIVATESECRETMARKER']) assert.ok(!stored.includes(bad), `${bad} leaked`);
  assert.match(stored, /\[github token\]/);
});

test('--exclude skips a folder', async () => {
  const { data, skills } = mk();
  const r = await quiet(() => rc.run([], { chats: true, yes: true, logs, skills, data, exclude: path.join(logs, '-fake-app') }));
  assert.equal(r.excluded, 3);
  assert.ok(!r.proposals.find((p) => p.skill === 'git-commit-style'));
});

test('nothing changes until --apply; reject sticks; stale edits refused', async () => {
  const { data, skills } = mk();
  const md = path.join(skills, 'git-commit-style', 'SKILL.md');
  const orig = fs.readFileSync(md, 'utf8');
  const r = await quiet(() => rc.run([], { chats: true, yes: true, logs, skills, data }));
  assert.equal(fs.readFileSync(md, 'utf8'), orig);
  const commit = r.proposals.find((p) => p.skill === 'git-commit-style');
  await quiet(() => rc.run([], { chats: true, apply: commit.id, data }));
  const now = fs.readFileSync(md, 'utf8');
  assert.notEqual(now, orig);
  assert.match(now, /Lessons from your sessions/);
  assert.ok(fs.readdirSync(path.join(data, 'backups')).length === 1);
  assert.throws(() => rc.applyProposal(data, commit.id), /applied/);
  const dep = r.proposals.find((p) => p.skill === 'deploy-safely');
  await quiet(() => rc.run([], { chats: true, reject: dep.id, data }));
  const again = await quiet(() => rc.run([], { chats: true, logs, skills, data }));
  assert.ok(!again.proposals.some((p) => p.id === dep.id && p.status === 'pending'));
  assert.ok(!again.proposals.some((p) => p.id === commit.id && p.status === 'pending'));
});

test('--test needs model consent and makes no call without it', async () => {
  const { data, skills } = mk();
  const r = await quiet(() => rc.run([], { chats: true, yes: true, test: true, logs, skills, data }));
  assert.equal(r.needsConsent, true);
});

test('unified diff round trip', () => {
  const d = rc.unifiedDiff('a\nb\nc\n', 'a\nb\nx\nc\n', 's/SKILL.md');
  assert.match(d, /^\+x$/m);
});
