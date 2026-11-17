// The public pricing (web/app.js PRICING) must say what src/plans.js charges. Teams are by inquiry: no listed price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJourney } from '../src/prerender.js';
import { PLANS } from '../src/plans.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRICING } = loadJourney(path.join(ROOT, 'web'));

test('site shows Free, Pro and a Teams inquiry card, in that order', () => {
  assert.deepEqual(PRICING.plans.map((p) => p.id), ['free', 'pro', 'team']);
});

test('listed prices match src/plans.js', () => {
  for (const p of PRICING.plans.filter((x) => !x.inquiry)) {
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

test('heading and note state the Pro price and that nothing is charged yet', () => {
  assert.equal(PRICING.heading, `Free for developers. $${PLANS.pro.monthlyUsd} a month for your private vault.`);
  assert.match(PRICING.note, /nothing is charged today/);
});
