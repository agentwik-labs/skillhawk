import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { RemoteRegistry } from '../src/client.js';
import { installBundle, listInstalled } from '../src/agents.js';
import { expireLeases } from '../src/lease.js';
import { formatReport } from '../src/offboard.js';
import { exitInterviewCmd } from '../src/exit-interview.js';
import { loadCases } from '../src/devloop.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-revoke-'));
let server; let base; let admin; let bob; let carol;

const skill = (name) => ({
  'SKILL.md': Buffer.from(`---\nname: ${name}\ndescription: Does ${name} work for the team carefully. Use when asked to ${name}.\nlicense: MIT\n---\n\n# ${name}\n\n## Steps\n\nRun the migration, then check the logs for errors and report the result.\n\n## Rules\n\nRoll back on any error.\n`),
  'skill.json': Buffer.from(JSON.stringify({ name, version: '1.0.0', title: name, summary: `${name} summary`, category: 'engineering', tags: ['t'] })),
});
const reg = (token) => new RemoteRegistry({ registry: base, token });
const rpc = (token, method, params, id = 1) => fetch(`${base}/mcp?stream=1`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
});
const call = async (token, name, args = {}) => (await (await rpc(token, 'tools/call', { name, arguments: args })).json()).result;

before(async () => {
  server = createServer({ dataDir: path.join(tmp, 'data'), adminToken: 'root' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = server.store;
  s.createOrg({ slug: 'acme' });
  admin = s.createToken({ org: 'acme', name: 'alice', role: 'admin' }).token;
  bob = s.createToken({ org: 'acme', name: 'bob', role: 'reader' }).token;
  carol = s.createToken({ org: 'acme', name: 'carol', role: 'reader' }).token;
  await reg(admin).publish('acme', skill('runbook'));
  await reg(admin).publish('acme', skill('onboarding'));
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('stream MCP over HTTP: lean list, marked content, audit entries', async () => {
  const init = await (await rpc(bob, 'initialize', {})).json();
  assert.match(init.result.instructions, /@acme\/runbook: Does runbook work/);
  assert.ok(!init.result.instructions.includes('Run the migration'), 'list must not carry skill bodies');
  const list = await call(bob, 'skill_list');
  assert.deepEqual(list.structuredContent.skills.map((s) => Object.keys(s).sort().join()), ['description,id', 'description,id']);
  const loaded = await call(bob, 'skill_load', { skill: '@acme/runbook' });
  assert.match(loaded.content[0].text, /the migration, then/);
  const sec = await call(bob, 'skill_section', { skill: '@acme/runbook', heading: 'Rules' });
  assert.match(sec.content[0].text, /Roll back/);
  assert.doesNotMatch(sec.content[0].text, /migration/);
  const marks = server.store.db.marks.filter((m) => m.recipient === 'bob');
  assert.ok(marks.length >= 1 && marks[0].fingerprint, 'delivery is marked for bob');
  const plain = skill('runbook')['SKILL.md'].toString();
  assert.notEqual(loaded.content[0].text.split('\n---\n\n').slice(1).join('\n---\n\n'), plain, 'copy differs from the stored original');
  const events = await reg(admin).audit({ org: 'acme' });
  assert.ok(events.some((e) => e.action === 'stream.load' && e.who === 'bob' && e.skill === '@acme/runbook'));
  assert.ok(events.some((e) => e.action === 'pull' && e.who === 'bob' && e.marked));
  assert.equal((await rpc('nope', 'ping')).status, 401);
});

test('revoke: the next call fails clearly and is audit-logged; offboard report lists what was pulled', async () => {
  await call(carol, 'skill_load', { skill: '@acme/onboarding' });
  await call(bob, 'skill_load', { skill: '@acme/onboarding' });
  await assert.rejects(reg(bob).request('POST', '/api/orgs/acme/revoke', { member: 'bob' }), /org admin/);
  const r = await reg(admin).request('POST', '/api/orgs/acme/revoke', { member: 'bob' });
  assert.equal(r.revoked.length, 1);
  const res = await rpc(bob, 'tools/call', { name: 'skill_load', arguments: { skill: '@acme/runbook' } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /access revoked by your org admin/);
  assert.equal((await rpc(carol, 'ping')).status, 200, 'other members unaffected');
  const events = await reg(admin).audit({ org: 'acme' });
  assert.ok(events.some((e) => e.action === 'member.revoke' && e.member === 'bob'));
  assert.ok(events.some((e) => e.action === 'access.denied'));
  await assert.rejects(reg(admin).request('POST', '/api/orgs/acme/revoke', { member: 'nobody' }), /no member/);
  const h = await reg(admin).request('GET', '/api/orgs/acme/members/bob/holdings');
  const md = formatReport(h);
  assert.match(md, /# Offboarding report: bob/);
  assert.match(md, /\| @acme\/runbook \| 1\.0\.0 \|/);
  assert.match(md, /\| @acme\/onboarding \| 1\.0\.0 \|/);
  assert.match(md, /revoked \d{4}/);
  assert.ok(h.held.every((x) => x.fingerprint), 'marks are listed');
});

test('installed copies carry a lease; expired leases are removed from a temp agent dir', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'agent-'));
  const b = await reg(admin).bundle('acme', 'runbook', 'latest', { pull: true });
  assert.ok(b.lease?.expiresAt);
  assert.ok(Math.abs(Date.parse(b.lease.expiresAt) - Date.now() - 7 * 86400000) < 60000, 'default lease is 7 days');
  installBundle('claude', b, { cwd });
  const dir = path.join(cwd, '.claude', 'skills', 'runbook');
  assert.ok(fs.existsSync(path.join(dir, '.skillyard-lease.json')));
  assert.deepEqual(expireLeases({ agents: ['claude'], cwd }), []);
  assert.equal(listInstalled('claude', { cwd }).length, 1);
  const gone = expireLeases({ agents: ['claude'], cwd, now: Date.now() + 8 * 86400000 });
  assert.equal(gone.length, 1);
  assert.equal(fs.existsSync(dir), false);
  await reg(admin).request('PATCH', '/api/orgs/acme', { leaseDays: 2 });
  const b2 = await reg(admin).bundle('acme', 'runbook', 'latest', { pull: true });
  assert.ok(Math.abs(Date.parse(b2.lease.expiresAt) - Date.now() - 2 * 86400000) < 60000);
  await assert.rejects(reg(admin).request('PATCH', '/api/orgs/acme', { leaseDays: 0 }), /leaseDays/);
});

test('exit-interview --answers drafts a private skill that grades B or better', async () => {
  const out = path.join(tmp, 'drafts');
  const answers = path.join(tmp, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({
    systems: ['the nightly billing sync', 'the Stripe webhook relay'],
    recurring_fixes: ['billing sync stalls at 2am -> restart the worker with ./bin/restart-sync and replay the last batch', { symptom: 'webhook relay returns 502', fix: 'rotate the relay key in the vault and redeploy the relay' }],
    people: ['Dana in finance ops — when invoices look doubled', 'Priya at Stripe support — when the relay key is rejected'],
    gotchas: ['Never replay a batch twice — customers get charged again'],
  }));
  const log = console.log; console.log = () => {};
  let r;
  try { r = await exitInterviewCmd(['pat'], { answers, out }); } finally { console.log = log; }
  assert.equal(r.drafts.length, 1);
  assert.ok('AB'.includes(r.drafts[0].grade), `grade ${r.drafts[0].grade}`);
  const dir = r.drafts[0].dir;
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(md, /restart the worker/);
  assert.match(md, /Dana in finance ops/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'));
  assert.equal(manifest.visibility, 'private');
  assert.ok(loadCases(dir).cases.should_fire.length >= 3);
  const files = Object.fromEntries(['SKILL.md', 'skill.json'].map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  const pub = await reg(admin).publish('acme', files);
  assert.equal(pub.visibility, 'private');
});
