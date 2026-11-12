import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secureScan } from '../src/secure.js';

const BAD = 'test/fixtures/secure-bad';
const has = (res, rule, file, sev) => res.findings.some((f) => f.rule === rule && f.file.includes(file) && (!sev || f.severity === sev));
const cli = (...a) => spawnSync(process.execPath, ['bin/skillyard.js', ...a], { encoding: 'utf8' });

test('MCP configs: unpinned, remote, http, inline secrets, broad roots', () => {
  const r = secureScan([BAD]);
  assert.ok(has(r, 'mcp-unpinned', '.mcp.json', 'medium'));
  assert.ok(has(r, 'mcp-remote-package', '.mcp.json', 'high'));
  assert.ok(has(r, 'mcp-plain-http', '.mcp.json', 'high'));
  assert.ok(has(r, 'mcp-inline-secret', '.mcp.json', 'high'));
  assert.ok(has(r, 'mcp-broad-root', '.mcp.json', 'high'));
  assert.ok(has(r, 'mcp-broad-root', '.cursor/mcp.json', 'high'));
  assert.ok(!r.findings.some((f) => f.file.includes('.cursor') && f.rule === 'mcp-unpinned'));
  assert.ok(r.findings.every((f) => f.line >= 1 && f.message && f.fix));
});

test('hooks and settings: curl|sh, network, writes outside repo, rm, bypass, broad Bash', () => {
  const r = secureScan([BAD]);
  assert.ok(has(r, 'pipe-to-shell', 'settings.json', 'high'));
  assert.ok(has(r, 'hook-network', 'settings.json', 'medium'));
  assert.ok(has(r, 'hook-write-outside', 'settings.json', 'medium'));
  assert.ok(has(r, 'hook-destructive', 'hooks/hooks.json', 'high'));
  assert.ok(has(r, 'permission-bypass', 'settings.json', 'high'));
  assert.ok(has(r, 'broad-tool-grant', 'settings.json', 'high'));
});

test('skill dependencies, install scripts, run-time fetches, tool grants', () => {
  const r = secureScan([BAD]);
  assert.ok(has(r, 'dep-remote', 'package.json', 'high'));
  assert.ok(has(r, 'dep-unpinned', 'package.json', 'medium'));
  assert.ok(has(r, 'dep-range', 'package.json', 'low'));
  assert.ok(has(r, 'install-script', 'package.json', 'high'));
  assert.ok(has(r, 'dep-remote', 'requirements.txt', 'high'));
  assert.ok(has(r, 'dep-unpinned', 'requirements.txt', 'medium'));
  assert.ok(has(r, 'fetch-and-exec', 'run.sh', 'high'));
  assert.ok(has(r, 'broad-tool-grant', 'SKILL.md', 'medium'));
});

test('clean config yields no findings; skills are scanned too', () => {
  assert.equal(secureScan(['test/fixtures/secure-good']).findings.length, 0);
  assert.equal(secureScan(['registry/public']).high >= 0, true);
});

test('CLI gate exits 1 on high, 0 when the level is not reached; --json writes a report', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sy-secure-')), 'r.json');
  const bad = cli('secure', BAD, '--gate', 'high', '--json', out);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /gate high: FAIL/);
  assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).high > 0);
  const good = cli('secure', 'test/fixtures/secure-good', '--gate', 'medium');
  assert.equal(good.status, 0);
  assert.match(good.stdout, /pass/);
});

test('ci runs the package checks', () => {
  const r = cli('ci', BAD);
  assert.match(r.stdout, /mcp-|plain http|secret/i);
  assert.equal(r.status, 1);
});
