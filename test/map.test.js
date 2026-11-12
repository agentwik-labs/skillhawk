import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMap, queryMap, sectionOf, overview, writeMap, loadMap, run } from '../src/map.js';
import { createMcpHandler } from '../src/mcp.js';

const FIX = path.resolve('test/fixtures/map-repo');
const BIN = path.resolve('bin/skillyard.js');

test('map indexes symbols, imports, skills and summaries', () => {
  const { map } = buildMap(FIX);
  const pay = map.files['src/payments.js'];
  assert.deepEqual(pay.symbols.map((s) => s.name), ['chargeCard', 'refundOrder']);
  assert.equal(pay.symbols[0].line, 2);
  assert.match(pay.summary, /Payment processing/);
  assert.deepEqual(map.files['src/checkout.js'].deps, ['src/payments.js']);
  assert.deepEqual(map.files['src/payments.js'].usedBy, ['src/checkout.js']);
  assert.deepEqual(map.files['src/tax.py'].deps, ['src/rates.py']);
  assert.ok(map.files['src/tax.py'].symbols.some((s) => s.name === 'TaxError' && s.kind === 'class'));
  assert.equal(map.skills.length, 1);
  assert.equal(map.skills[0].name, 'deploy-runbook');
  assert.match(map.folders['.'].summary, /fake repo/);
  assert.ok(overview(map).length < 8000);
});

test('query ranks the matching file and symbol with line numbers', () => {
  const { map } = buildMap(FIX);
  const hits = queryMap(map, 'refund order');
  assert.equal(hits[0].file, 'src/payments.js');
  assert.equal(hits[0].line, 3);
  assert.equal(queryMap(map, 'sales tax')[0].file, 'src/tax.py');
  assert.equal(queryMap(map, 'deploy rollback')[0].file, 'skills/deploy-runbook/SKILL.md');
  assert.deepEqual(queryMap(map, 'zzzz'), []);
});

test('--update re-reads only changed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-map-'));
  fs.cpSync(FIX, dir, { recursive: true });
  const first = buildMap(dir);
  assert.equal(first.stats.reused, 0);
  const again = buildMap(dir, { prev: first.map, update: true });
  assert.equal(again.stats.read, 0);
  fs.writeFileSync(path.join(dir, 'src/payments.js'), '// Payments v2.\nexport function payNow() {}\n');
  const third = buildMap(dir, { prev: again.map, update: true });
  assert.equal(third.stats.read, 1);
  assert.equal(third.map.files['src/payments.js'].symbols[0].name, 'payNow');
  writeMap(dir, '.skillyard/map', third.map);
  assert.ok(fs.existsSync(path.join(dir, '.skillyard/map/MAP.md')));
  assert.equal(loadMap(dir).v, 1);
});

test('sectionOf returns one section and ignores fenced headings', () => {
  const md = fs.readFileSync(path.join(FIX, 'skills/deploy-runbook/SKILL.md'), 'utf8');
  assert.match(sectionOf(md, 'rollback').text, /Revert the release tag/);
  assert.doesNotMatch(sectionOf(md, 'Rollback').text, /Notify/);
  assert.match(sectionOf(md, 'Rollback').text, /not a heading/);
  assert.ok(sectionOf(md, '').outline.length >= 4);
  assert.ok(sectionOf(md, 'nope').missing);
});

test('MCP serves map_query and skill_section from a local map', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-mcp-'));
  fs.cpSync(FIX, dir, { recursive: true });
  await run([dir], {});
  const h = createMcpHandler({}, { root: dir });
  const names = (await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.ok(names.includes('map_query') && names.includes('skill_section'));
  const call = async (name, args) => (await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })).result;
  assert.match((await call('map_query', { question: 'charge card' })).content[0].text, /src\/payments\.js:2/);
  assert.match((await call('skill_section', { skill: 'deploy-runbook', heading: 'Preflight' })).content[0].text, /CI is green/);
  assert.match((await call('skill_section', { skill: 'deploy-runbook' })).content[0].text, /Outline/);
  const noRoot = createMcpHandler({}); // HTTP registry mode never exposes the local map
  assert.ok(!(await noRoot({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.some((t) => t.name === 'map_query'));
});

test('CLI: map then map query', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-cli-'));
  fs.cpSync(FIX, dir, { recursive: true });
  const a = spawnSync('node', [BIN, 'map', dir], { encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr);
  const q = spawnSync('node', [BIN, 'map', 'query', 'tax', '--dir', dir], { encoding: 'utf8' });
  assert.match(q.stdout, /src\/tax\.py/);
});
