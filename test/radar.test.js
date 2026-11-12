process.env.SKILLYARD_EXCLUDE = 'private-work,-fake-private';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cluster, radar, shingles } from '../src/radar.js';
import { tmp, session } from './_logs.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const PR = ['no, never push straight to main, open a pull request instead', "no, don't push to main directly, use a pull request"];

function team() {
  const root = tmp('team-');
  for (const [p, lines] of [['alice', PR], ['bob', [PR[1], PR[0]]], ['carol', ["no, that's wrong, the chart colors should be blue"]]]) {
    session(path.join(root, p), { id: `${p}1`, cwd: '/fake/shop', prompts: ['ship the release branch to production'], corrections: lines, day: '2026-11-10' });
    session(path.join(root, p), { id: `${p}2`, cwd: '/fake/shop', prompts: ['ship the hotfix branch to production'], corrections: lines.slice(0, 1), day: '2026-11-11' });
  }
  return root;
}

test('clusters repeated corrections and ranks by people x frequency', async () => {
  const root = team();
  const dirs = ['alice', 'bob', 'carol'].map((p) => path.join(root, p));
  const cwd = tmp('out-');
  const r = await radar({ dirs, minPeople: 2, days: 14, now: NOW, cwd });
  assert.equal(r.people, 3);
  assert.equal(r.clusters.length, 1); // carol's one-off is not shared
  const c = r.clusters[0];
  assert.equal(c.people, 2);
  assert.ok(c.count >= 4);
  assert.ok(fs.existsSync(path.join(cwd, c.dir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(cwd, c.dir, 'tests', 'cases.yaml')));
  assert.equal(c.staticTest.fail, 0);
  assert.equal(c.secureHigh, 0);
  assert.ok(!JSON.stringify({ ...c, dir: 0 }).includes('pull request')); // counts only in the summary
});

test('--team treats each subfolder as a person; min-people filters', async () => {
  const root = team();
  const cwd = tmp('out-');
  const r = await radar({ dirs: [root], team: true, minPeople: 3, now: NOW, cwd });
  assert.equal(r.people, 3);
  assert.equal(r.clusters.length, 0);
  assert.equal(cluster([{ said: 'a b c', asked: '', person: 'x', id: '1', session: 's' }]).length, 1);
  assert.ok(shingles('never push to main').has('push main'));
});

test('--branch makes a local branch with the draft, nothing pushed', async () => {
  const root = team();
  const repo = tmp('repo-');
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const r = await radar({ dirs: ['alice', 'bob'].map((p) => path.join(root, p)), now: NOW, cwd: repo, branch: true });
  assert.match(r.clusters[0].branch, /^skillyard\/radar-/);
  assert.ok(g('branch', '--list').includes(r.clusters[0].branch));
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.match(g('show', '--stat', r.clusters[0].branch), /SKILL\.md/);
});

test('CLI radar prints counts', () => {
  const root = team();
  const out = spawnSync('node', [path.resolve('bin/skillyard.js'), 'radar', path.join(root, 'alice'), path.join(root, 'bob'), '--days', '0'], { cwd: tmp('out-'), encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Cluster [0-9a-f]{8}: 2 people/);
  assert.doesNotMatch(out.stdout, /pull request/);
});
