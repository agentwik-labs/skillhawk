// The public pricing (web/app.js PRICING) must say what src/plans.js charges. Teams are by inquiry: no listed price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJourney } from '../src/prerender.js';
import { PLANS, PREORDERS } from '../src/plans.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRICING } = loadJourney(path.join(ROOT, 'web'));

test('site shows Free, Watch, Pro and a Teams inquiry card, in that order', () => {
  assert.deepEqual(PRICING.plans.map((p) => p.id), ['free', 'watch', 'pro', 'team']);
});

test('pre-order cards say so, and Watch matches src/plans.js PREORDERS', () => {
  const w = PRICING.plans.find((p) => p.id === 'watch');
  assert.equal(w.monthlyUsd, PREORDERS.watch.monthlyUsd);
  assert.equal(w.yearlyUsd, PREORDERS.watch.yearlyUsd);
  assert.equal(w.price, `$${PREORDERS.watch.monthlyUsd}`);
  assert.match(w.per, new RegExp(`\\$${PREORDERS.watch.yearlyUsd} a year`));
  for (const p of PRICING.plans.filter((x) => x.preorder)) assert.match(p.blurb, /^Pre-order\./, `${p.id} says pre-order`);
  assert.match(PRICING.note, /not built/);
  assert.match(w.blurb, /Not built yet/);
});

test('listed prices match src/plans.js', () => {
  for (const p of PRICING.plans.filter((x) => !x.inquiry && PLANS[x.id])) {
    const src = PLANS[p.id];
    assert.ok(src, `unknown plan ${p.id}`);
    assert.equal(p.name, src.name, p.id);
    assert.equal(p.monthlyUsd, src.monthlyUsd, `${p.id} monthlyUsd`);
    assert.equal(p.price, `$${src.monthlyUsd}`, `${p.id} displayed price`);
  }
});

test('Teams has no price and points to the inquiry form', () => {
  const t = PRICING.plans.find((p) => p.id === 'team');
  assert.equal(t.inquiry, true);
  assert.equal(t.monthlyUsd, null);
  assert.doesNotMatch(`${t.price} ${t.per} ${t.blurb}`, /\$\d/);
  assert.equal(t.cta.href, '#/teams');
});

test('heading states the Watch price', () => {
  assert.equal(PRICING.heading, `Free checks today. Watch planned at $${PREORDERS.watch.monthlyUsd} a month.`);
});

test('web/app.js parses (the tests above only read its data block)', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, 'web', 'app.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
