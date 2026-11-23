// skillhawk mcp: local checks over stdio, no registry, no account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '../src/mcp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'skillyard.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skillhawk-mcp-'));
const call = (h, name, args, id = 1) => h({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('no registry: only local tools and the three local prompts; no resources; registry tools unknown', async () => {
  const h = createMcpHandler(null, { root: ROOT, local: true });
  const init = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'skillhawk');
  assert.match(init.result.instructions, /Nothing leaves the machine/);
  const names = (await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name);
  for (const n of ['review_skill', 'secure_scan', 'compile_skill', 'check_agents', 'health_check']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('search_skills'));
  const prompts = (await h({ jsonrpc: '2.0', id: 3, method: 'prompts/list' })).result.prompts;
  assert.deepEqual(prompts.map((p) => p.name), ['billing', 'review-skills', 'secure', 'health']);
  assert.match(init.result.instructions, /check_agents.*bills/);
  const got = (await h({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'review-skills', arguments: { path: 'skills' } } })).result;
  assert.match(got.messages[0].content.text, /review_skill.*secure_scan.*"skills"/);
  assert.match((await h({ jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'billing' } })).result.messages[0].content.text, /check_agents.*Never print key values/s);
  assert.equal((await h({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'nope' } })).error.code, -32602);
  assert.deepEqual((await h({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).result.resources, []);
  assert.equal((await call(h, 'search_skills', { query: 'x' })).error.code, -32602);
});

test('the HTTP-style handler (no local flag) never offers local tools', async () => {
  const h = createMcpHandler({ search: async () => [] }, {});
  const names = (await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.ok(!names.includes('secure_scan') && !names.includes('check_agents'));
});

test('review_skill grades like the CLI', async () => {
  const h = createMcpHandler(null, { root: ROOT, local: true });
  const good = (await call(h, 'review_skill', { path: 'test/fixtures/review/good' })).result;
  assert.equal(good.isError, false);
  assert.equal(good.structuredContent.skills[0].grade, 'A');
  const bad = (await call(h, 'review_skill', { path: 'test/fixtures/review/bad' })).result;
  assert.ok('DF'.includes(bad.structuredContent.skills[0].grade));
  assert.match(bad.content[0].text, /fix:/);
  const none = (await call(h, 'review_skill', { path: 'src' })).result;
  assert.equal(none.isError, true);
});

test('secure_scan reports the same findings as the CLI', async () => {
  const h = createMcpHandler(null, { root: ROOT, local: true });
  const r = (await call(h, 'secure_scan', { path: 'test/fixtures/secure-bad' })).result;
  assert.ok(r.structuredContent.high > 0);
  const cli = spawnSync(process.execPath, [BIN, 'secure', 'test/fixtures/secure-bad', '--json', path.join(tmp(), 'o.json')], { cwd: ROOT, encoding: 'utf8' });
  const m = /skillhawk secure: (\d+) high, (\d+) medium, (\d+) low/.exec(cli.stdout);
  assert.deepEqual([r.structuredContent.high, r.structuredContent.medium, r.structuredContent.low], m.slice(1).map(Number));
});

test('compile_skill writes inside the working folder only', async () => {
  const d = tmp();
  fs.cpSync(path.join(ROOT, 'test/fixtures/review/good/api-errors'), path.join(d, 'api-errors'), { recursive: true });
  const h = createMcpHandler(null, { root: d, local: true });
  const r = (await call(h, 'compile_skill', { path: 'api-errors', targets: 'codex,cursor' })).result;
  assert.equal(r.isError, false, r.content[0].text);
  assert.ok(fs.existsSync(path.join(d, '.skillyard/compiled/codex/AGENTS.md')));
  assert.ok(fs.existsSync(path.join(d, '.skillyard/compiled/cursor/.cursor/rules/api-errors.mdc')));
  const out = (await call(h, 'compile_skill', { path: 'api-errors', out: os.tmpdir() })).result;
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /must be inside/);
});

test('check_agents runs the agents check from fixtures', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'ps.txt'), '  100     1 3-04:00:00   0.1  204800 ??       claude -p "nightly"\n');
  const h = createMcpHandler(null, { root: d, local: true, agentsFixtures: { fromPs: path.join(d, 'ps.txt'), logs: path.join(d, 'none'), noCrontab: true, unitDir: path.join(d, 'none') } });
  const r = (await call(h, 'check_agents', {})).result;
  assert.equal(r.structuredContent.flaggedCount, 1);
  assert.match(r.content[0].text, /Nothing was stopped/);
});

test('stdio: `skillhawk mcp` with no registry answers tools/list over stdin', async () => {
  const home = tmp();
  const env = { ...process.env, SKILLYARD_HOME: home };
  delete env.SKILLYARD_REGISTRY; delete env.SKILLYARD_TOKEN;
  const p = spawn(process.execPath, [BIN, 'mcp'], { cwd: ROOT, env });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  await new Promise((r) => p.on('close', r));
  const names = JSON.parse(out.trim().split('\n')[0]).result.tools.map((t) => t.name);
  assert.ok(names.includes('review_skill') && !names.includes('search_skills'));
});

test('connect without a registry prints the local stdio setup under the skillhawk name', () => {
  const env = { ...process.env, SKILLYARD_HOME: tmp() };
  delete env.SKILLYARD_REGISTRY; delete env.SKILLYARD_TOKEN;
  const r = spawnSync(process.execPath, [BIN, 'connect', 'claude'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude mcp add --scope user skillhawk --/);
  assert.match(r.stdout, /review_skill, secure_scan, compile_skill, check_agents/);
  assert.doesNotMatch(r.stdout, /localhost:7420/);
});
