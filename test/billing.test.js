// Plans, seats, gates and the Stripe webhook (docs/plans-and-seats.md).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { RemoteRegistry } from '../src/client.js';
import { Store } from '../src/store.js';
import { monthlyPrice, accessLevel, validatePlan } from '../src/plans.js';
import { subscriptionState, verifyStripeSignature } from '../src/billing.js';
import { verifyFiles, SIGNATURE_FILE } from '../src/sign.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-billing-'));
const WH = 'whsec_test';
const PRICES = { pro: 'price_pro', team: 'price_team', seat: 'price_seat' };
const subs = new Map(); // fake Stripe: subscription id -> object
const stripe = {
  createCheckoutSession: async (p) => ({ url: `https://checkout.example/${p.client_reference_id}`, params: p }),
  getSubscription: async (id) => subs.get(id),
  createPortalSession: async (p) => ({ url: `https://portal.example/${p.customer}` }),
};
let server; let base; let owner;

const skill = (name, visibility) => ({
  'SKILL.md': Buffer.from(`---\nname: ${name}\ndescription: Does ${name} work for the team carefully. Use when asked to ${name}.\nlicense: MIT\n---\n\n# ${name}\n\n## Steps\n\nRun the migration, then check the logs for errors and report the result.\n\n## Rules\n\nRoll back on any error.\n`),
  'skill.json': Buffer.from(JSON.stringify({ name, version: '1.0.0', title: name, summary: `${name} summary`, category: 'engineering', tags: ['t'], ...(visibility ? { visibility } : {}) })),
});
const reg = (token) => new RemoteRegistry({ registry: base, token });
const api = (method, p, token, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const signed = (payload, secret = WH, t = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
};

before(async () => {
  server = createServer({
    dataDir: path.join(tmp, 'data'), adminToken: 'root', plans: 'enforce', stripe,
    billing: { configured: true, key: 'sk_test', webhookSecret: WH, prices: PRICES },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  server.store.createOrg({ slug: 'acme' });
  owner = server.store.createToken({ org: 'acme', name: 'owner', role: 'admin' }).token;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('price list: $20 Pro, $100 Team with 5 seats, $20 per extra seat', () => {
  assert.equal(monthlyPrice('pro'), 20);
  assert.equal(monthlyPrice('team'), 100);
  assert.equal(monthlyPrice('team', 7), 140);
  assert.equal(monthlyPrice('enterprise'), null);
  assert.throws(() => validatePlan('team', 3), /starts at 5/);
  assert.throws(() => validatePlan('pro', 2), /at most 1/);
});

test('a new org is a Team pilot with 5 seats; the sixth member is blocked; revoke frees a seat', async () => {
  const st = await (await api('GET', '/api/orgs/acme/billing', owner)).json();
  assert.equal(st.plan, 'team'); assert.equal(st.seats, 5); assert.equal(st.status, 'pilot'); assert.equal(st.access, 'full');
  for (const n of ['b', 'c', 'd', 'e']) assert.equal((await api('POST', '/api/orgs/acme/tokens', owner, { name: n })).status, 201);
  const sixth = await api('POST', '/api/orgs/acme/tokens', owner, { name: 'f' });
  assert.equal(sixth.status, 402);
  assert.match((await sixth.json()).error, /5 of 5 seats/);
  // reusing a name is the same member, but capped so a name can't be shared by a whole team
  assert.equal((await api('POST', '/api/orgs/acme/tokens', owner, { name: 'b' })).status, 201);
  assert.equal((await api('POST', '/api/orgs/acme/tokens', owner, { name: 'b' })).status, 201);
  assert.equal((await api('POST', '/api/orgs/acme/tokens', owner, { name: 'b' })).status, 409);
  // service tokens take no seat
  assert.equal((await api('POST', '/api/orgs/acme/tokens', owner, { name: 'ci', kind: 'service' })).status, 201);
  assert.equal((await api('POST', '/api/orgs/acme/revoke', owner, { member: 'e' })).status, 200);
  assert.equal((await api('POST', '/api/orgs/acme/tokens', owner, { name: 'f' })).status, 201);
  const after = await (await api('GET', '/api/orgs/acme/billing', owner)).json();
  assert.equal(after.seatsUsed, 5);
});

test('service tokens never read private skills, by any route', async () => {
  await reg(owner).publish('acme', skill('secret-runbook', 'private'));
  const ci = server.store.createToken({ org: 'acme', name: 'ci2', kind: 'service', scopes: ['read'] }).token;
  for (const p of ['/api/skills/@acme/secret-runbook', '/api/skills/@acme/secret-runbook/bundle', '/api/skills/@acme/secret-runbook/files/SKILL.md', '/api/skills/@acme/secret-runbook/files/skill.json', '/api/skills/@acme/secret-runbook/diff?from=1.0.0&to=1.0.0']) {
    assert.equal((await api('GET', p, ci)).status, 404, p);
  }
  const mcp = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ci}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_search', arguments: { query: 'secret' } } }) })).json();
  assert.doesNotMatch(JSON.stringify(mcp), /secret-runbook/);
});

test('a pulled private copy carries a signature over the marked text it was given', async () => {
  const b = await (await api('GET', '/api/skills/@acme/secret-runbook/bundle?pull=1', owner)).json();
  assert.ok(b.files[SIGNATURE_FILE], 'bundle ships a signature file');
  const files = Object.entries(b.files).filter(([p]) => p !== SIGNATURE_FILE).map(([p, v]) => ({ path: p, content: Buffer.from(v, 'base64') }));
  const sig = JSON.parse(Buffer.from(b.files[SIGNATURE_FILE], 'base64').toString());
  const pub = server.store.getOrg('acme').publicKey;
  assert.equal(verifyFiles(files, sig, pub).ok, true);
  files[0].content = Buffer.concat([files[0].content, Buffer.from('\nedited')]);
  assert.equal(verifyFiles(files, sig, pub).ok, false);
});

test('stream mode needs Team; Pro gets 402 over MCP; only the operator sets plans', async () => {
  assert.equal((await api('PATCH', '/api/orgs/acme/plan', owner, { plan: 'pro' })).status, 403);
  server.store.createOrg({ slug: 'solo' });
  const solo = server.store.createToken({ org: 'solo', name: 'sam', role: 'admin' }).token;
  const r = await api('PATCH', '/api/orgs/solo/plan', 'root', { plan: 'pro', seats: 1, status: 'active' });
  assert.equal(r.status, 200);
  const res = await fetch(`${base}/mcp?stream=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${solo}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(res.status, 402);
  assert.match((await res.json()).error, /Team plan/);
  // Pro still gets private skills
  assert.equal((await api('POST', '/api/skills/@solo', solo, { files: Object.fromEntries(Object.entries(skill('mine', 'private')).map(([k, v]) => [k, v.toString('base64')])) })).status, 201);
  // and its single seat is full
  assert.equal((await api('POST', '/api/orgs/solo/tokens', solo, { name: 'pat' })).status, 402);
  const audit = server.store.auditLog({ org: 'solo' });
  assert.ok(audit.some((e) => e.action === 'plan.change' && e.after.plan === 'pro'));
});

test('an ended pilot is read-only: pulls and revokes work, writes return 402', async () => {
  server.store.setPlan('acme', { pilotEndsAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(accessLevel(server.store.getOrg('acme')), 'read-only');
  assert.equal((await api('GET', '/api/skills/@acme/secret-runbook/bundle?pull=1', owner)).status, 200);
  const pub = await api('POST', '/api/skills/@acme', owner, { files: Object.fromEntries(Object.entries(skill('more')).map(([k, v]) => [k, v.toString('base64')])) });
  assert.equal(pub.status, 402);
  assert.match((await pub.json()).error, /pilot has ended/);
  assert.equal((await api('POST', '/api/orgs/acme/tokens', owner, { name: 'b' })).status, 402);
  assert.equal((await api('POST', '/api/orgs/acme/revoke', owner, { member: 'd' })).status, 200);
  assert.equal((await api('POST', '/api/orgs/acme/billing/checkout', owner, { plan: 'pro' })).status, 200, 'a lapsed org can still pay');
});

test('checkout carries the org; webhook verifies the signature, re-fetches the subscription and is idempotent', async () => {
  const team = await api('POST', '/api/orgs/acme/billing/checkout', owner, { plan: 'team', seats: 7 });
  assert.equal(team.status, 400, 'Team is by inquiry');
  assert.match((await team.json()).error, /talk to us/);
  const co = await (await api('POST', '/api/orgs/acme/billing/checkout', owner, { plan: 'pro' })).json();
  assert.equal(co.url, 'https://checkout.example/acme');
  assert.equal(co.seats, 1);
  // Team subscriptions still apply when the operator sets one up in Stripe:
  subs.set('sub_1', { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { org: 'acme' }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    items: { data: [{ price: { id: 'price_team' }, quantity: 1 }, { price: { id: 'price_seat' }, quantity: 2 }] } });
  const evt = { id: 'evt_1', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: { client_reference_id: 'acme', subscription: 'sub_1' } } };
  assert.equal((await signed(evt, 'whsec_wrong')).status, 400);
  assert.equal((await signed(evt, WH, Math.floor(Date.now() / 1000) - 3600)).status, 400, 'old timestamp');
  const ok = await (await signed(evt)).json();
  assert.equal(ok.applied.status, 'active'); assert.equal(ok.applied.seats, 7); assert.equal(ok.applied.access, 'full');
  assert.equal((await (await signed(evt)).json()).ignored, 'duplicate');
  // a stale "updated" event after cancel can't revive it: the subscription is re-fetched
  subs.get('sub_1').status = 'canceled';
  await signed({ id: 'evt_2', type: 'customer.subscription.updated', created: 1, data: { object: { id: 'sub_1', status: 'active' } } });
  assert.equal(server.store.getOrg('acme').billing.status, 'canceled');
  assert.equal((await (await signed({ id: 'evt_3', type: 'charge.refunded', data: { object: {} } })).json()).ignored, 'charge.refunded');
});

test('a canceled customer keeps their data: export, delete, portal; outsiders do not see billing', async () => {
  assert.equal(server.store.getOrg('acme').billing.status, 'canceled');
  const outsider = await (await api('GET', '/api/orgs/acme')).json();
  assert.equal(outsider.billing, undefined); assert.equal(outsider.plan, undefined); assert.equal(outsider.seats, undefined);
  assert.equal((await (await api('GET', '/api/orgs/acme', owner)).json()).billing.status, 'canceled', 'the org admin sees it');
  assert.equal((await api('GET', '/api/orgs/acme/export')).status, 403);
  const ex = await (await api('GET', '/api/orgs/acme/export', owner)).json();
  const sr = ex.skills.find((s) => s.id === '@acme/secret-runbook');
  assert.ok(sr && sr.versions[0].files['SKILL.md'], 'export includes private skill files');
  assert.equal((await (await api('POST', '/api/orgs/acme/billing/portal', owner)).json()).url, 'https://portal.example/cus_1');
  assert.equal((await api('DELETE', '/api/skills/@acme/secret-runbook', owner)).status, 200, 'delete works while read-only');
});

test('rate limit per client IP; behind a trusted proxy the forwarded address counts', async () => {
  const s = createServer({ dataDir: path.join(tmp, 'rl'), rateLimit: 3, trustProxy: true });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${s.address().port}/api/health`;
  const as = (ip) => fetch(u, { headers: { 'X-Forwarded-For': `9.9.9.9, ${ip}` } }).then((r) => r.status);
  assert.deepEqual([await as('1.1.1.1'), await as('1.1.1.1'), await as('1.1.1.1'), await as('1.1.1.1')], [200, 200, 200, 429]);
  assert.equal(await as('2.2.2.2'), 200, 'another client is not affected');
  s.close();
});

test('signature helper and subscription mapping', () => {
  const raw = Buffer.from('{"a":1}');
  const t = Math.floor(Date.now() / 1000);
  const good = crypto.createHmac('sha256', WH).update(`${t}.`).update(raw).digest('hex');
  assert.ok(verifyStripeSignature(raw, `t=${t},v1=deadbeef,v1=${good}`, WH), 'any v1 may match');
  assert.throws(() => verifyStripeSignature(raw, `t=${t}`, WH), /bad Stripe-Signature/);
  const st = subscriptionState({ id: 's', status: 'incomplete', items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] } }, PRICES);
  assert.equal(st.plan, 'pro'); assert.equal(st.seats, 1); assert.equal(st.status, null);
});

test('enforcement off (self-hosted default) has no limits; old orgs migrate to a pilot once', () => {
  const dir = path.join(tmp, 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  const tokens = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => [`t${i}`, { id: `t${i}`, org: 'old', name: n, scopes: ['read'], role: 'reader', hash: `h${i}`, createdAt: '2026-01-01' }]));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, orgs: { old: { slug: 'old', name: 'old' } }, tokens, skills: {}, events: [] }));
  const s = new Store(dir);
  assert.equal(s.getOrg('old').plan, 'team');
  assert.equal(s.getOrg('old').seats, 7, 'sized to the members it already has');
  assert.equal(s.getOrg('old').billing.pilotEndsAt, undefined, 'no end date until the operator sets one');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).orgs.old.plan, 'team', 'saved');
  for (const n of ['h', 'i', 'j']) s.createToken({ org: 'old', name: n });
  assert.equal(s.seatsUsed('old'), 10);
});
