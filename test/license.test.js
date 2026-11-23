import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signKey, TEST_KEY } from './_license.js';
import { verify, requireTeams } from '../src/license.js';

const BIN = path.resolve('bin/skillyard.js');
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const base = { v: 1, id: 'x', email: 'a@b.c', org: 'acme', seats: 5 };
const run = (args, env) => {
  try { return { code: 0, out: execFileSync('node', [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

test('a valid Teams key verifies; Autopilot, tampered and expired keys do not', () => {
  assert.equal(verify(TEST_KEY).ok, true);
  assert.match(verify(signKey({ ...base, plan: 'watch', exp: day(30) })).reason, /not a Teams license/);
  assert.match(verify(`${TEST_KEY}x`).reason, /not issued by Skillhawk/);
  const old = verify(signKey({ ...base, plan: 'team', exp: day(-30) }));
  assert.equal(old.ok, false); assert.equal(old.signed, true);
  assert.equal(verify(signKey({ ...base, plan: 'team', exp: day(-3) })).inGrace, true);
});

test('gated commands refuse without a key, and free commands still run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
  const env = { SKILLHAWK_LICENSE: '', SKILLHAWK_HOME: home };
  for (const args of [['offboard', 'alice'], ['exit-interview', 'pat'], ['serve'], ['org', 'create', 'x'], ['mcp', '--stream'], ['trace', 'a.md']]) {
    const r = run(args, env);
    assert.equal(r.code, 1, args.join(' ')); assert.match(r.out, /part of Skillhawk Teams/);
  }
  assert.equal(run(['--version'], env).code, 0);
  assert.match(run(['license'], env).out, /No Teams license/);
});

test('revoke and offboard pass the gate on an expired key; other Teams commands do not', () => {
  const old = signKey({ ...base, plan: 'team', exp: day(-60) });
  const env = { SKILLHAWK_LICENSE: old };
  assert.doesNotThrow(() => requireTeams('revoke', { env: { ...process.env, ...env } }));
  assert.doesNotThrow(() => requireTeams('offboard', { env: { ...process.env, ...env } }));
  assert.throws(() => requireTeams('serve', { env: { ...process.env, ...env } }), /expired/);
});

test('the test public key only works under node --test', () => {
  assert.equal(verify(TEST_KEY, { env: { SKILLHAWK_TEST_LICENSE_PUBKEY: process.env.SKILLHAWK_TEST_LICENSE_PUBKEY } }).ok, false);
});
