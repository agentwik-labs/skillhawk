import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assign, startExperiment, hook, report, promote, twoProportionP } from '../src/ab.js';
import { tmp, session } from './_logs.js';

function setup() {
  const root = tmp('proj-');
  const mk = (n, body) => { const d = path.join(root, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: deploy\ndescription: Deploy things. Use when deploying.\n---\n${body}\n`); return d; };
  const a = mk('v1', 'version one');
  const b = mk('v2', 'version two');
  startExperiment({ skill: 'deploy', a, b, split: 50, root });
  return { root, a, b, skills: tmp('skills-') };
}

// Run N sessions through the hook, then write logs where `bad(arm, i)` says whether the session had a correction.
async function simulate(ctx, n, bad) {
  const logs = tmp('logs-');
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    const id = `sess-${i}`;
    const [{ arm }] = hook({ session: id, cwd: '/fake/shop', root: ctx.root, skillsDir: ctx.skills });
    assert.match(fs.readFileSync(path.join(ctx.skills, 'deploy', 'SKILL.md'), 'utf8'), arm === 'a' ? /version one/ : /version two/);
    const k = counts[arm]++;
    session(logs, { id, prompts: ['deploy the service'], corrections: bad(arm, k) ? ["no, that's wrong, I said use staging"] : [], skill: 'deploy' });
  }
  return { logs, counts };
}

test('assignment is deterministic and roughly honours the split', () => {
  assert.equal(assign('abc', 50), assign('abc', 50));
  const a = Array.from({ length: 1000 }, (_, i) => assign(`k${i}`, 30)).filter((x) => x === 'a').length;
  assert.ok(a > 240 && a < 360, `got ${a}`);
});

test('hook records assignments and installs the arm without touching other dirs', () => {
  const ctx = setup();
  const r1 = hook({ session: 's1', cwd: '/x', root: ctx.root, skillsDir: ctx.skills });
  const r2 = hook({ session: 's1', cwd: '/x', root: ctx.root, skillsDir: ctx.skills });
  assert.deepEqual(r1, r2);
  const exp = JSON.parse(fs.readFileSync(path.join(ctx.root, '.skillyard', 'ab', 'deploy.json'), 'utf8'));
  assert.equal(exp.assignments.length, 1);
  // no session id: falls back to cwd + date
  const r3 = hook({ cwd: '/y', date: '2026-11-10', root: ctx.root, skillsDir: ctx.skills });
  assert.equal(r3[0].arm, assign('deploy:/y|2026-11-10', 50));
});

test('B clearly wins: promote B, and promote copies it', async () => {
  const ctx = setup();
  const { logs } = await simulate(ctx, 160, (arm, k) => (arm === 'a' ? k % 10 < 7 : k % 10 < 1));
  const r = await report({ skill: 'deploy', root: ctx.root, logs });
  assert.ok(r.a.n >= 30 && r.b.n >= 30, `${r.a.n}/${r.b.n}`);
  assert.ok(r.p < 0.05);
  assert.equal(r.decision, 'promote B');
  assert.ok(r.b.correctionRate < r.a.correctionRate);
  const to = path.join(tmp('prod-'), 'deploy');
  const p = await promote({ skill: 'deploy', root: ctx.root, logs, to });
  assert.equal(p.arm, 'b');
  assert.match(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8'), /version two/);
});

test('no significant difference: no promotion', async () => {
  const ctx = setup();
  const { logs } = await simulate(ctx, 160, (arm, k) => (arm === 'a' ? k % 10 < 3 : k % 10 < 3 && k % 2 === 0 ? true : k % 10 < 2));
  const r = await report({ skill: 'deploy', root: ctx.root, logs });
  assert.ok(r.p >= 0.05, `p=${r.p}`);
  assert.notEqual(r.decision, 'promote B');
  await assert.rejects(promote({ skill: 'deploy', root: ctx.root, logs, to: tmp() }), /no significant winner/);
});

test('too few sessions never promotes, even with a big gap', async () => {
  const ctx = setup();
  const { logs } = await simulate(ctx, 20, (arm) => arm === 'a');
  const r = await report({ skill: 'deploy', root: ctx.root, logs });
  assert.equal(r.decision, 'keep collecting');
});

test('z-test sanity', () => {
  assert.ok(Math.abs(twoProportionP(30, 100, 30, 100) - 1) < 1e-6);
  assert.ok(twoProportionP(70, 100, 10, 100) < 1e-6);
});

test('CLI: start, hook from stdin, report', async () => {
  const root = tmp('proj-');
  const mk = (n, body) => { const d = path.join(root, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: deploy\ndescription: x\n---\n${body}\n`); return d; };
  const bin = path.resolve('bin/skillyard.js');
  const skills = tmp('skills-');
  const env = { ...process.env, SKILLYARD_SKILLS_DIR: skills };
  const s = spawnSync('node', [bin, 'ab', 'deploy', '--a', mk('a', 'one'), '--b', mk('b', 'two'), '--split', '50', '--root', root], { encoding: 'utf8', env });
  assert.equal(s.status, 0, s.stderr);
  const h = spawnSync('node', [bin, 'ab', 'hook', '--root', root], { encoding: 'utf8', env, input: JSON.stringify({ session_id: 'zz', cwd: root }) });
  assert.equal(h.status, 0, h.stderr);
  assert.ok(fs.existsSync(path.join(skills, 'deploy', 'SKILL.md')));
  const r = spawnSync('node', [bin, 'ab', 'report', 'deploy', '--root', root, '--logs', tmp()], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Decision: keep collecting/);
});
