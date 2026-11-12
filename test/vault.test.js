import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { RemoteRegistry } from '../src/client.js';
import { readSkillDir } from '../src/skill.js';
import { lineDiff } from '../src/vault.js';
import { pull } from '../src/vault-cli.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-vault-'));
const ROOT = path.join(import.meta.dirname, '..');
let server; let base; let admin; let editor; let reader; let other;

const skill = (name, { version = '1.0.0', body = 'Run the migration, then check the logs for errors and report the result. ' } = {}) => ({
  'SKILL.md': Buffer.from(`---\nname: ${name}\ndescription: Does ${name} work for the team carefully. Use when asked to ${name}.\nlicense: MIT\n---\n\n# ${name}\n\n${body}\n`),
  'skill.json': Buffer.from(JSON.stringify({ name, version, title: name, summary: `${name} summary`, category: 'engineering', tags: ['t'] })),
});
const reg = (token) => new RemoteRegistry({ registry: base, token });

before(async () => {
  server = createServer({ dataDir: path.join(tmp, 'data'), adminToken: 'root' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = server.store;
  s.createOrg({ slug: 'acme' });
  s.createOrg({ slug: 'globex' });
  admin = s.createToken({ org: 'acme', name: 'alice', role: 'admin' }).token;
  editor = s.createToken({ org: 'acme', name: 'bob', role: 'editor' }).token;
  reader = s.createToken({ org: 'acme', name: 'carol', role: 'reader' }).token;
  other = s.createToken({ org: 'globex', name: 'dave', role: 'admin' }).token;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('orgs get a secret and ed25519 keypair that never leave the server', async () => {
  const o = server.store.db.orgs.acme;
  assert.match(o.publicKey, /BEGIN PUBLIC KEY/);
  assert.match(o.privateKey, /BEGIN PRIVATE KEY/);
  assert.equal(o.secret.length, 64);
  assert.equal(o.minGrade, 'C');
  const res = await (await fetch(`${base}/api/orgs/acme`, { headers: { Authorization: `Bearer ${admin}` } })).json();
  assert.ok(res.publicKey);
  assert.ok(!('secret' in res) && !('privateKey' in res));
});

test('roles: reader reads, editor publishes and rolls back, only admin reads the audit log', async () => {
  await assert.rejects(reg(reader).publish('acme', skill('runbook')), /cannot publish/);
  await reg(editor).publish('acme', skill('runbook'));
  await reg(admin).publish('acme', skill('runbook', { version: '1.1.0', body: 'Run the migration, then check the logs. Roll back on any error. ' }));
  assert.equal((await reg(reader).bundle('acme', 'runbook')).version, '1.1.0');
  await assert.rejects(reg(reader).rollback('acme', 'runbook', '1.0.0'), /editor or admin/);
  await assert.rejects(reg(other).rollback('acme', 'runbook', '1.0.0'), /not found/);
  await assert.rejects(reg(reader).audit({ org: 'acme' }), /admin/);
  await assert.rejects(reg(editor).audit({ org: 'acme' }), /admin/);
  await assert.rejects(reg(null).audit({}), /admin/);
  assert.ok((await reg(admin).audit({ org: 'acme' })).length >= 3);
  // an org admin only ever sees their own org
  assert.ok((await reg(other).audit({ org: 'acme' })).every((e) => e.org === 'globex'));
});

test('versions, diff and rollback keep full history', async () => {
  const vs = await reg(reader).versions('acme', 'runbook');
  assert.deepEqual(vs.map((v) => [v.version, v.current]), [['1.1.0', true], ['1.0.0', false]]);
  const d = await reg(reader).diff('acme', 'runbook', '1.0.0', '1.1.0');
  const f = d.files.find((x) => x.file === 'SKILL.md');
  assert.equal(f.status, 'changed');
  assert.match(f.diff, /\+Run the migration, then check the logs\. Roll back/);
  assert.match(f.diff, /-Run the migration, then check the logs for errors/);
  assert.deepEqual(lineDiff('a\nb', 'a\nc').filter((l) => l[0] !== ' '), ['-b', '+c']);
  await reg(editor).rollback('acme', 'runbook', '1.0.0');
  assert.equal((await reg(reader).get('acme', 'runbook')).version, '1.0.0');
  assert.equal((await reg(reader).versions('acme', 'runbook')).length, 2);
  assert.equal((await reg(reader).get('acme', 'runbook', '1.1.0')).version, '1.1.0');
  await assert.rejects(reg(editor).rollback('acme', 'runbook', '9.9.9'), /no version/);
  await reg(editor).publish('acme', skill('runbook', { version: '1.2.0', body: 'Run the migration and check the logs, then post the summary. ' }));
  assert.equal((await reg(reader).get('acme', 'runbook')).version, '1.2.0');
});

test('audit log records pull, publish, rollback with who, version, host', async () => {
  await reg(reader).bundle('acme', 'runbook', '1.0.0');
  const log = await reg(admin).audit({ org: 'acme', skill: '@acme/runbook' });
  const by = (a) => log.filter((e) => e.action === a);
  assert.ok(by('publish').length >= 3 && by('rollback').length === 1 && by('pull').length >= 1);
  const rb = by('rollback')[0];
  assert.equal(rb.who, 'bob');
  assert.equal(rb.version, '1.0.0');
  assert.equal(rb.host, os.hostname());
  assert.equal(by('pull')[0].who, 'carol');
  assert.ok(by('publish').every((e) => e.check.passed));
  assert.ok(log.every((e) => e.at && e.skill === '@acme/runbook'));
  const lines = fs.readFileSync(path.join(tmp, 'data', 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= log.length);
});

test('pull writes skillyard.lock and --frozen installs exactly the lock', async () => {
  await reg(editor).publish('acme', skill('onboarding'));
  const proj = fs.mkdtempSync(path.join(tmp, 'proj-'));
  const cwd = process.cwd();
  process.chdir(proj);
  Object.assign(process.env, { SKILLYARD_REGISTRY: base, SKILLYARD_TOKEN: reader, SKILLYARD_HOME: path.join(tmp, 'home') });
  try {
    await pull([], { org: 'acme' });
    const lockFile = path.join(proj, 'skillyard.lock');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.deepEqual(Object.keys(lock.skills), ['@acme/onboarding', '@acme/runbook']);
    assert.equal(lock.skills['@acme/runbook'].version, '1.2.0');
    assert.match(lock.skills['@acme/runbook'].hash, /^sha256-/);
    assert.ok(fs.existsSync(path.join(proj, '.claude/skills/runbook/SKILL.md')));
    // roll back on the server: --frozen still installs the locked 1.2.0.
    await reg(editor).rollback('acme', 'runbook', '1.0.0');
    fs.rmSync(path.join(proj, '.claude'), { recursive: true });
    await pull([], { frozen: true });
    assert.match(fs.readFileSync(path.join(proj, '.claude/skills/runbook/SKILL.md'), 'utf8'), /post the summary/);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).skills['@acme/runbook'].version, '1.2.0');
    // a tampered lock hash is refused
    lock.skills['@acme/runbook'].hash = 'sha256-bad';
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    await assert.rejects(pull([], { frozen: true }), /does not match/);
    // a plain pull follows the server and rewrites the lock
    await pull([], { org: 'acme' });
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).skills['@acme/runbook'].version, '1.0.0');
  } finally {
    process.chdir(cwd);
  }
  const pulls = (await reg(admin).audit({ org: 'acme' })).filter((e) => e.action === 'pull' && e.who === 'carol');
  assert.ok(pulls.length >= 6);
});

test('publish is blocked by a failing skill; admin --force overrides and is logged', async () => {
  const bad = readSkillDir(path.join(ROOT, 'examples/bad/engineering-handbook'));
  await assert.rejects(reg(editor).publish('acme', bad), (e) => /publish checks failed/.test(e.message) && /review grade F is below the org minimum C/.test(e.message) && /contradiction/.test(e.message));
  await assert.rejects(reg(editor).publish('acme', bad, undefined, { force: true }), /only an org admin can force/);
  await assert.rejects(reg(other).publish('acme', bad, undefined, { force: true }), /cannot publish/);
  await assert.rejects(reg(admin).get('acme', 'engineering-handbook'), /not found/);
  const ok = await reg(admin).publish('acme', bad, undefined, { force: true });
  assert.equal(ok.id, '@acme/engineering-handbook');
  const log = await reg(admin).audit({ org: 'acme', skill: '@acme/engineering-handbook' });
  assert.deepEqual(log.map((e) => e.action).sort(), ['publish', 'publish.forced', 'publish.rejected', 'publish.rejected']);
  const forced = log.find((e) => e.action === 'publish.forced');
  assert.equal(forced.who, 'alice');
  assert.equal(forced.check.grade, 'F');
  assert.equal(log.find((e) => e.action === 'publish').check.forced, true);
});

test('a high security finding blocks publish even at a lenient grade', async () => {
  await reg(admin).request('PATCH', '/api/orgs/acme', { minGrade: 'F' });
  const risky = skill('risky');
  risky['requirements.txt'] = Buffer.from('git+https://example.com/evil/pkg.git\n');
  await assert.rejects(reg(editor).publish('acme', risky), /1 high security finding[\s\S]*dep-remote|1 high security finding[\s\S]*URL or git ref/);
  assert.ok((await reg(admin).audit({ org: 'acme', skill: '@acme/risky' })).some((e) => e.action === 'publish.rejected' && e.check.high === 1));
  await assert.rejects(reg(editor).request('PATCH', '/api/orgs/acme', { minGrade: 'A' }), /org admin/);
});

test('integration: published skills are signed, pulls are marked per person and traceable, tampering is refused', async () => {
  const { trace } = await import('../src/mark.js');
  await reg(admin).publish('acme', skill('signed-runbook'));
  const rec = server.store.db.skills['@acme/signed-runbook'] || Object.values(server.store.db.skills).find((r) => r.versions?.['1.0.0'] && JSON.stringify(r).includes('signed-runbook'));
  const ver = rec.versions['1.0.0'];
  assert.ok(ver.signature?.sig, 'publish stored an org signature');
  const a = await reg(editor).bundle('acme', 'signed-runbook');
  const c = await reg(reader).bundle('acme', 'signed-runbook');
  const text = (b) => Buffer.from(b.files['SKILL.md'], 'base64').toString('utf8');
  assert.notEqual(text(a), text(c), 'each recipient gets a different copy');
  const marks = server.store.db.marks || [];
  const fps = (Array.isArray(marks) ? marks : Object.values(marks)).map((m) => m.fingerprint).filter(Boolean);
  const hit = trace(text(c), fps, { orgSecret: server.store.db.orgs.acme.secret });
  assert.equal(hit[0].recipient, 'carol');
  const saved = ver.signature.manifest['SKILL.md'];
  ver.signature.manifest['SKILL.md'] = '0'.repeat(64);
  await assert.rejects(reg(reader).bundle('acme', 'signed-runbook'), /signature check failed/);
  ver.signature.manifest['SKILL.md'] = saved;
});
