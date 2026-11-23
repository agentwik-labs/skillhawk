import { test, before, after } from 'node:test';
import './_license.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.js';
import { RemoteRegistry } from '../src/client.js';
import { readSkillDir } from '../src/skill.js';
import { buildEvidence, verifyEvidence } from '../src/evidence.js';
import { buildGovernance } from '../src/governance.js';
import { Store } from '../src/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-govern-'));
const ROOT = path.join(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'skillyard.js');
let server; let base; let store; let admin; let alice; let bob;
const reg = (t) => new RemoteRegistry({ registry: base, token: t });
const pullText = async (t) => Buffer.from((await reg(t).bundle('acme', 'code-review', 'latest', { pull: true })).files['SKILL.md'], 'base64').toString('utf8');

before(async () => {
  server = createServer({ dataDir: path.join(tmp, 'data'), adminToken: 'root' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  store = server.store;
  store.createOrg({ slug: 'acme' });
  admin = store.createToken({ org: 'acme', name: 'root-admin', role: 'admin' }).token;
  alice = store.createToken({ org: 'acme', name: 'alice', role: 'reader' }).token;
  bob = store.createToken({ org: 'acme', name: 'bob', role: 'reader' }).token;
  await reg(admin).publish('acme', readSkillDir(path.join(ROOT, 'registry/public/code-review')), 'private');
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('beacon is off by default and enabling needs the legal flag', async () => {
  assert.ok(!/\/r\//.test(await pullText(alice)));
  assert.throws(() => store.setBeacon('acme', true, false), /legal-review/);
  assert.ok(!store.getOrg('acme').beacon?.enabled);
  assert.throws(() => execFileSync('node', [BIN, 'org', 'settings', 'acme', '--beacon', 'on', '--data', path.join(tmp, 'data')], { stdio: 'pipe' }), /legal-review/);
});

test('org settings --beacon on succeeds with --i-have-legal-review', () => {
  const data = path.join(tmp, 'cli-data');
  new Store(data).createOrg({ slug: 'beta' });
  const out = execFileSync('node', [BIN, 'org', 'settings', 'beta', '--beacon', 'on', '--i-have-legal-review', '--data', data]).toString();
  assert.match(out, /@beta: beacon on/);
  assert.equal(new Store(data).getOrg('beta').beacon.enabled, true);
  execFileSync('node', [BIN, 'org', 'settings', 'beta', '--beacon', 'off', '--data', data]);
  assert.equal(new Store(data).getOrg('beta').beacon.enabled, false);
});

test('enabled beacon adds one reference link; a hit is recorded; unknown token is not', async () => {
  store.setBeacon('acme', true, true);
  const text = await pullText(alice);
  const m = /Reference: (http:\/\/[^\s]+)\/r\/([A-Za-z0-9_-]+)/.exec(text);
  assert.ok(m, 'reference link present');
  assert.equal((text.match(/Reference: http/g) || []).length, 1);
  const res = await fetch(`${m[1]}/r/${m[2]}`, { headers: { 'user-agent': 'leakbot/1', referer: 'https://paste.example/x' } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Reference material moved; contact the owner\./);
  const a = store.alerts('acme');
  assert.equal(a.length, 1);
  assert.equal(a[0].recipient, 'alice');
  assert.equal(a[0].userAgent, 'leakbot/1');
  assert.equal(a[0].referer, 'https://paste.example/x');
  assert.deepEqual(Object.keys(a[0]).sort(), ['at', 'ip', 'org', 'recipient', 'referer', 'skill', 'token', 'userAgent', 'version']);
  await fetch(`${m[1]}/r/AAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal(store.alerts('acme').length, 1);
  const out = execFileSync('node', [BIN, 'alerts', '--org', 'acme', '--data', path.join(tmp, 'data')]).toString();
  assert.match(out, /alice/);
  store.setBeacon('acme', false, false);
});

test('evidence pack names the leaker, verifies signature and hash chain', async () => {
  const leaked = await pullText(bob); // beacon off again: bob's copy has the other layers only
  await pullText(alice);
  const dir = path.join(tmp, 'ev');
  const { evidence } = buildEvidence(store, { org: 'acme', leaked: Buffer.from(leaked), leakedName: 'leak.md', out: dir });
  assert.equal(evidence.topCandidate.recipient, 'bob');
  assert.ok(evidence.topCandidate.confidence > 0.9);
  assert.ok(evidence.pullHistory.length >= 1 && evidence.pullHistory[0].at);
  assert.equal(evidence.auditLog.ok, true);
  for (const f of ['report.md', 'evidence.json', 'evidence.sig.json', 'public-key.pem', 'takedown-notice-DRAFT.md', 'VERIFY.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /\*\*bob\*\*/);
  assert.match(fs.readFileSync(path.join(dir, 'takedown-notice-DRAFT.md'), 'utf8'), /review with counsel/);
  assert.equal(verifyEvidence(dir).ok, true);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
  j.topCandidate.recipient = 'alice';
  fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(j, null, 2));
  assert.equal(verifyEvidence(dir).ok, false);
});

test('tampering with an audit line breaks audit verify', () => {
  const data = path.join(tmp, 'data');
  assert.equal(store.verifyAudit().ok, true);
  assert.match(execFileSync('node', [BIN, 'audit', 'verify', '--data', data]).toString(), /^ok/);
  const file = path.join(data, 'audit.jsonl');
  const orig = fs.readFileSync(file, 'utf8');
  const lines = orig.trim().split('\n');
  lines[1] = lines[1].replace('"action":"', '"action":"x');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const r = store.verifyAudit();
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /line 2/);
  assert.throws(() => execFileSync('node', [BIN, 'audit', 'verify', '--data', data], { stdio: 'pipe' }));
  // removing an entry also breaks the chain
  fs.writeFileSync(file, `${orig.trim().split('\n').filter((_, i) => i !== 2).join('\n')}\n`);
  assert.equal(store.verifyAudit().ok, false);
  fs.writeFileSync(file, orig);
  assert.equal(store.verifyAudit().ok, true);
});

test('governance export has inventory and the control mapping', () => {
  const dir = path.join(tmp, 'gov');
  const r = buildGovernance(store, { org: 'acme', framework: 'all', out: dir });
  assert.equal(r.inventory.length, 1);
  assert.equal(r.inventory[0].skill, '@acme/code-review');
  assert.equal(r.inventory[0].signed, true);
  assert.ok(r.inventory[0].lastReviewGrade);
  for (const f of ['governance.md', 'governance.json', 'inventory.csv', 'approval-trail.json', 'access-control.json', 'change-history.json', 'audit-integrity.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const g = JSON.parse(fs.readFileSync(path.join(dir, 'governance.json'), 'utf8'));
  assert.deepEqual(Object.keys(g.mapping).sort(), ['euaiact', 'iso42001', 'soc2']);
  assert.ok(g.mapping.soc2.rows.every((x) => x.evidenceFiles.every((f) => fs.existsSync(path.join(dir, f)))));
  const md = fs.readFileSync(path.join(dir, 'governance.md'), 'utf8');
  assert.match(md, /supports evidence for/);
  assert.ok(!/\bis compliant\b/i.test(md));
  assert.match(fs.readFileSync(path.join(dir, 'inventory.csv'), 'utf8'), /@acme\/code-review/);
  assert.equal(buildGovernance(store, { org: 'acme', framework: 'soc2', out: path.join(tmp, 'gov2') }).mapping.soc2 !== undefined, true);
});
