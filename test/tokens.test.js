process.env.SKILLYARD_EXCLUDE = 'private-work,-fake-private';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collect, costOf, PRICES } from '../src/tokens.js';

const LOGS = path.resolve('test/fixtures/token-logs');
const NOW = Date.parse('2026-11-12T12:00:00Z');

test('aggregates per day, repo and skill; dedupes streamed records; skips private-work', async () => {
  const r = await collect({ logs: LOGS, days: 7, now: NOW });
  assert.equal(r.sessionsCounted, 1);
  assert.equal(r.skippedExcluded, 1);
  assert.deepEqual(r.byDay.map((d) => d.day), ['2026-11-10', '2026-11-11']);
  assert.equal(r.totals.turns, 3); // m1 once (dup dropped), m2, m3; the January turn is outside 7 days
  assert.equal(r.totals.input, 160);
  assert.equal(r.totals.cacheRead, 12000);
  assert.deepEqual(r.byRepo.map((x) => x.repo), ['shop']);
  const skill = r.bySkill.find((s) => s.skill === 'deploy-runbook');
  assert.equal(skill.turns, 2); // invoking turn + the follow-up before the next human prompt
  assert.ok(r.bySkill.some((s) => s.skill === '(no skill)' && s.turns === 1));
  assert.equal(r.topSessions[0].session, 'aaaa1111');
});

test('cost uses the price table by model family', () => {
  const u = { input: 1e6, output: 1e6, cacheWrite: 0, cacheRead: 0 };
  assert.equal(costOf(u, 'claude-opus-4-1'), PRICES.opus.input + PRICES.opus.output);
  assert.equal(costOf(u, 'claude-haiku-4-5'), PRICES.haiku.input + PRICES.haiku.output);
  assert.equal(costOf(u, 'unknown'), PRICES.sonnet.input + PRICES.sonnet.output);
});

test('nothing is excluded without a configured exclusion; days=0 reads everything', async () => {
  const saved = process.env.SKILLYARD_EXCLUDE;
  process.env.SKILLYARD_EXCLUDE = '';
  try {
    const r = await collect({ logs: LOGS, days: 0, exclude: [], now: NOW });
    assert.equal(r.sessionsCounted, 2);
    assert.equal(r.skippedExcluded, 0);
  } finally { process.env.SKILLYARD_EXCLUDE = saved; }
});

test('CLI prints a table and --json', () => {
  const t = spawnSync('node', ['bin/skillyard.js', 'tokens', '--logs', LOGS, '--days', '0'], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /Per repo/);
  assert.match(t.stdout, /deploy-runbook/);
  const j = spawnSync('node', ['bin/skillyard.js', 'tokens', '--logs', LOGS, '--days', '0', '--json'], { encoding: 'utf8' });
  assert.ok(JSON.parse(j.stdout).totals.tokens > 0);
});

test('every Claude Code skill invocation shape is attributed (not "(no skill)")', async () => {
  const r = await collect({ logs: path.resolve('test/fixtures/skill-shapes'), days: 0, now: NOW });
  const names = r.bySkill.map((s) => s.skill).sort();
  assert.deepEqual(names, ['alpha-skill', 'beta-skill', 'delta-skill', 'epsilon-skill', 'gamma-skill', 'zeta-skill']);
  assert.ok(!r.bySkill.some((s) => s.skill === '(no skill)'));
});
