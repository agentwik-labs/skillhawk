import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { generateKeys, signFiles, verifyFiles } from '../src/sign.js';
import { parseYaml, loadCases, validateCases, staticTest, devCycle, devWatch, compareMarkdown, addCasesStub } from '../src/devloop.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'skillyard.js');
const FX = path.join(ROOT, 'test', 'fixtures', 'trigger');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sy-'));
const sy = (args, opts = {}) => { try { return { code: 0, out: execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: 'pipe', ...opts }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\nlicense: MIT\n---\n\n# ${name}\n\nSteps for the job, long enough to avoid the short-body warning in the validator checks.\n`;

test('sign and verify round trip, with tamper detection', () => {
  const { publicKey, privateKey } = generateKeys();
  const files = [{ path: 'SKILL.md', content: 'hello' }, { path: 'references/a.md', content: Buffer.from('a') }];
  const sig = signFiles([...files].reverse(), privateKey);
  assert.equal(sig.alg, 'ed25519');
  assert.deepEqual(Object.keys(sig.manifest), ['SKILL.md', 'references/a.md']);
  assert.deepEqual(verifyFiles(files, sig, publicKey), { ok: true, changed: [] });
  const t = verifyFiles([{ path: 'SKILL.md', content: 'hello!' }, files[1], { path: 'x.sh', content: 'rm' }], sig, publicKey);
  assert.equal(t.ok, false);
  assert.deepEqual(t.changed, ['SKILL.md', 'x.sh']);
  assert.equal(verifyFiles(files.slice(0, 1), sig, publicKey).changed[0], 'references/a.md');
  // edited manifest and wrong key both fail
  const forged = { ...sig, manifest: { ...sig.manifest, 'SKILL.md': 'f'.repeat(64) } };
  assert.equal(verifyFiles(files, forged, publicKey).ok, false);
  assert.equal(verifyFiles(files, sig, generateKeys().publicKey).ok, false);
  // the signature file never counts as content
  assert.equal(verifyFiles([...files, { path: '.skillyard-signature.json', content: '{}' }], sig, publicKey).ok, true);
});

test('keys create / sign / verify via the CLI; verify exits 1 and names the changed file', () => {
  const d = tmp();
  const skill = path.join(d, 'my-skill');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), skillMd('my-skill', 'Does a thing. Use when asked.'));
  assert.equal(sy(['keys', 'create', '--out', path.join(d, 'k')]).code, 0);
  const priv = path.join(d, 'k', 'skillyard-private.pem');
  const pub = path.join(d, 'k', 'skillyard-public.pem');
  assert.equal(sy(['sign', skill, '--key', priv]).code, 0);
  assert.ok(fs.existsSync(path.join(skill, '.skillyard-signature.json')));
  assert.equal(sy(['verify', skill, '--pub', pub]).code, 0);
  fs.appendFileSync(path.join(skill, 'SKILL.md'), 'extra line\n');
  const r = sy(['verify', skill, '--pub', pub]);
  assert.equal(r.code, 1);
  assert.match(r.out, /changed: SKILL\.md/);
});

test('cases parsing: yaml shapes and json', () => {
  const c = loadCases(path.join(FX, 'release-notes')).cases;
  assert.equal(c.should_fire.length, 2);
  assert.equal(c.should_fire[1], 'Draft a changelog entry for this sprint');
  assert.equal(c.should_not_fire[1], 'why is this database query so slow?');
  assert.deepEqual(c.behaviour[0].expect, ['dark mode', 'login']);
  assert.equal(c.behaviour[1].rubric, 'Uses a Keep a Changelog style heading');
  assert.deepEqual(validateCases(c), []);
  assert.deepEqual(parseYaml('a: [x, "y, z"]\nb:\n- one\n- two\n'), { a: ['x', 'y, z'], b: ['one', 'two'] });
  assert.ok(validateCases({ should_fire: 'nope' }).length);
  assert.ok(validateCases({ behaviour: [{ prompt: 'p' }] })[0].includes('expect, forbid or rubric'));
  const d = tmp();
  fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, 'tests', 'cases.json'), JSON.stringify({ should_fire: ['a b'] }));
  assert.deepEqual(loadCases(d).cases, { should_fire: ['a b'] });
});

test('static trigger test picks the right skill among siblings', () => {
  const r = staticTest(path.join(FX, 'release-notes'));
  assert.equal(r.errors.length, 0);
  assert.equal(r.fail, 0);
  assert.equal(r.pass, 4);
  assert.equal(r.competitors, 2);
  const byPrompt = Object.fromEntries(r.results.map((x) => [x.prompt, x.winner]));
  assert.equal(byPrompt['fill out this PDF form with my address'], 'pdf-forms');
  assert.equal(byPrompt['why is this database query so slow?'], 'sql-tuning');
  // a wrong expectation is reported as a failure
  const d = tmp();
  fs.cpSync(FX, d, { recursive: true });
  fs.writeFileSync(path.join(d, 'release-notes', 'tests', 'cases.yaml'), 'should_fire:\n  - "fill out this PDF form"\n');
  const bad = staticTest(path.join(d, 'release-notes'));
  assert.equal(bad.fail, 1);
  assert.equal(bad.results[0].winner, 'pdf-forms');
  const cli = sy(['test', path.join(d, 'release-notes'), '--static']);
  assert.equal(cli.code, 1);
  assert.match(cli.out, /FAIL/);
  assert.equal(sy(['test', path.join(FX, 'release-notes'), '--static']).code, 0);
});

test('new scaffolds tests/cases.yaml that parses', () => {
  const d = tmp();
  assert.equal(sy(['new', 'fresh-skill', '--dir', d]).code, 0);
  const c = loadCases(path.join(d, 'fresh-skill')).cases;
  assert.deepEqual(validateCases(c), []);
  assert.equal(addCasesStub(path.join(d, 'fresh-skill')), false);
});

test('dev: re-installs into a temp agent dir and prints one status line; watch reacts to a change', async () => {
  const d = tmp();
  const proj = path.join(d, 'proj');
  fs.mkdirSync(proj);
  const skill = path.join(d, 'skills', 'release-notes');
  fs.cpSync(path.join(FX, 'release-notes'), skill, { recursive: true });
  const line = devCycle(skill, { agent: 'claude', cwd: proj });
  assert.match(line, /installed release-notes@/);
  assert.match(line, /review [A-F] \(\d+ findings?\)/);
  assert.match(line, /tests \d\/\d trigger/);
  const installed = path.join(proj, '.claude', 'skills', 'release-notes');
  assert.ok(fs.existsSync(path.join(installed, 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(installed, 'tests')), 'tests are not shipped');
  const once = sy(['dev', skill, '--once', '--cwd', proj]);
  assert.equal(once.code, 0);
  assert.equal(once.out.trim().split('\n').length, 1);
  const lines = [];
  const w = devWatch(skill, { agent: 'claude', cwd: proj }, (l) => lines.push(l));
  await new Promise((r) => setTimeout(r, 200));
  fs.appendFileSync(path.join(skill, 'SKILL.md'), '\nmore text\n');
  for (let i = 0; i < 30 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  w.close();
  assert.ok(lines.length >= 2, 'rebuilt after change');
  assert.match(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), /more text/);
});

test('ci --compare writes a markdown lift table for changed skills', () => {
  const d = tmp();
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, stdio: 'pipe' });
  g('init', '-q');
  const mk = (n, desc) => { fs.mkdirSync(path.join(d, 'skills', n), { recursive: true }); fs.writeFileSync(path.join(d, 'skills', n, 'SKILL.md'), skillMd(n, desc)); };
  mk('changed-skill', 'Does a thing. Use when asked.');
  mk('stable-skill', 'Stable thing. Use when asked about stable things.');
  g('add', '.'); g('commit', '-qm', 'one');
  fs.writeFileSync(path.join(d, 'skills', 'changed-skill', 'SKILL.md'), skillMd('changed-skill', 'Helps with everything. TODO fill in'));
  mk('new-skill', 'Brand new. Use when the user asks for new things.');
  g('add', '.'); g('commit', '-qm', 'two');
  const summary = path.join(d, 'summary.md');
  const r = sy(['ci', 'skills', '--compare', 'HEAD~1'], { cwd: d, env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  const md = fs.readFileSync(summary, 'utf8');
  assert.match(md, /lift-diff vs `HEAD~1`/);
  assert.match(md, /\| `skills\/changed-skill` \| [A-F] \(\d+\) → [A-F] \(\d+\)/);
  assert.match(md, /`skills\/new-skill` \| new → /);
  assert.ok(!md.split('lift-diff')[1].includes('stable-skill'), 'unchanged skills are not listed');
  assert.ok(r.out.includes('lift-diff'));
  const cwd = process.cwd();
  process.chdir(d);
  try { assert.match(compareMarkdown(['skills/changed-skill'], 'HEAD'), /No skill changed/); } finally { process.chdir(cwd); }
});
