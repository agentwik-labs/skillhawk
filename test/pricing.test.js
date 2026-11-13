// The public pricing (web/app.js PRICING) must say what src/plans.js charges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJourney } from '../src/prerender.js';
import { PLANS, PLAN_ORDER } from '../src/plans.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRICING } = loadJourney(path.join(ROOT, 'web'));

test('site plans are the plans in src/plans.js, in the same order', () => {
  assert.deepEqual(PRICING.plans.map((p) => p.id), PLAN_ORDER);
});

test('site prices and seats match src/plans.js', () => {
  for (const p of PRICING.plans) {
    const src = PLANS[p.id];
    assert.ok(src, `unknown plan ${p.id}`);
    assert.equal(p.name, src.name, p.id);
    assert.equal(p.monthlyUsd, src.monthlyUsd, `${p.id} monthlyUsd`);
    assert.equal(p.seats, src.includedSeats, `${p.id} seats`);
    assert.equal(p.extraSeatUsd, src.extraSeatUsd, `${p.id} extraSeatUsd`);
    if (src.monthlyUsd === null) assert.equal(p.price, 'Custom', p.id);
    else assert.equal(p.price, `$${src.monthlyUsd}`, `${p.id} displayed price`);
    if (src.monthlyUsd) assert.match(p.per, new RegExp(`\\b${src.includedSeats} seats?\\b`), `${p.id} shows its seats`);
    if (src.extraSeatUsd) assert.match(p.blurb, new RegExp(`\\$${src.extraSeatUsd} each`), `${p.id} shows the extra-seat price`);
  }
});

test('heading and note state the pricing and that nothing is charged yet', () => {
  assert.equal(PRICING.heading, `Free for developers. $${PLANS.pro.monthlyUsd} for one, $${PLANS.team.monthlyUsd} for a team of five.`);
  assert.match(PRICING.note, /Paid plans start after a free pilot; nothing is charged today\./);
  assert.ok(PRICING.audit, 'audit line kept');
});
