process.env.SKILLYARD_EXCLUDE = 'private-work,-fake-private';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSessions, estimate, statement, DEFAULTS } from '../src/savings.js';
import { tmp, session } from './_logs.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const PROMPT = ['deploy the staging release service pipeline'];

function fixture(nWith, nWithout) {
  const logs = tmp();
  for (let i = 0; i < nWith; i++) session(logs, { id: `w${i}`, prompts: PROMPT, skill: 'deploy-runbook', tokens: 800 });
  for (let i = 0; i < nWithout; i++) session(logs, { id: `o${i}`, prompts: PROMPT, corrections: ["no, that's wrong, I said use the staging config"], tokens: 1500 });
  session(logs, { id: 'other', cwd: '/fake/blog', prompts: ['write a poem about autumn leaves'] });
  return logs;
}

test('estimates corrections avoided, tokens and dollars versus comparable sessions', async () => {
  const s = await readSessions({ logs: fixture(12, 12), days: 30, now: NOW });
  const r = estimate(s);
  const d = r.skills.find((x) => x.skill === 'deploy-runbook');
  assert.equal(d.matchedWith, 12);
  assert.equal(d.controls, 12);
  assert.equal(d.confidence, 'medium');
  assert.ok(Math.abs(d.correctionsAvoided - 6) < 1e-9); // controls: 1 correction per 2 prompts; with the skill: none
  assert.ok(Math.abs(d.parts.corrections - 6 * 2 * (100 / 60)) < 1e-9);
  assert.ok(d.tokensDelta > 0 && d.parts.tokens > 0);
  assert.ok(r.total > 0);
  assert.ok(!r.skills.some((x) => x.skill === '(no skill)'));
});

test('constants are overridable and low confidence is stated under 10 sessions', async () => {
  const s = await readSessions({ logs: fixture(4, 5), days: 30, now: NOW });
  const base = estimate(s).skills[0];
  const rich = estimate(s, { hourlyRate: 200 }).skills[0];
  assert.equal(base.confidence, 'low');
  assert.ok(Math.abs(rich.parts.corrections - 2 * base.parts.corrections) < 1e-9);
  assert.equal(DEFAULTS.hourlyRate, 100);
  const md = statement(estimate(s), 30);
  assert.match(md, /Skillhawk saved an estimated \*\*\$/);
  assert.match(md, /low/);
  assert.match(md, /## Method/);
});

test('days window and private-work exclusion', async () => {
  const logs = fixture(3, 3);
  session(logs, { id: 'p3', cwd: '/fake/private-work/app', prompts: PROMPT, skill: 'secret-skill' });
  session(logs, { id: 'old', day: '2026-01-01', prompts: PROMPT, skill: 'old-skill' });
  const r = estimate(await readSessions({ logs, days: 30, now: NOW }));
  assert.deepEqual(r.skills.map((x) => x.skill), ['deploy-runbook']);
});

test('CLI: savings --json and --statement; price table override', () => {
  const logs = fixture(10, 10);
  const out = path.join(tmp(), 'sub', 'statement.md');
  const tbl = path.join(tmp(), 'p.json');
  fs.writeFileSync(tbl, JSON.stringify({ sonnet: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }));
  const run = (...a) => spawnSync('node', ['bin/skillyard.js', 'savings', '--logs', logs, '--days', '0', ...a], { encoding: 'utf8' });
  const j = run('--json', '--statement', out, '--price-table', tbl);
  assert.equal(j.status, 0, j.stderr);
  const r = JSON.parse(j.stdout);
  assert.equal(r.skills[0].parts.tokens, 0);
  assert.match(fs.readFileSync(out, 'utf8'), /^# Skillhawk savings statement/);
  assert.match(run().stdout, /deploy-runbook/);
});
