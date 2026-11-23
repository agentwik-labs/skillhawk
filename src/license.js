// Teams license: the company vault and its admin commands need a paid key, checked offline.
// Key format (shared with Autopilot): base64url(JSON payload) + "." + base64url(ed25519 signature).
// Payload: { v: 1, id, email, plan: "team" | "enterprise", org, seats, exp: "YYYY-MM-DD", sub }.
// The key is read from SKILLHAWK_LICENSE (servers, CI) or ~/.skillhawk/license (`skillhawk license activate <key>`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRACE_DAYS = 7;
export const TEAM_PLANS = ['team', 'enterprise'];
export const BUY_URL = 'https://skillhawk.ai/#/teams';

/** Commands that need a Teams license, and what each one is, for the refusal message. */
export const GATED = {
  serve: 'the company vault server',
  org: 'vault organisations',
  token: 'vault member tokens',
  revoke: 'revoking a member',
  offboard: 'offboarding',
  'exit-interview': 'exit interviews',
  mark: 'per-person marked copies',
  trace: 'leak tracing',
  governance: 'vault governance export',
  evidence: 'vault evidence bundles',
  audit: 'the vault audit log',
  alerts: 'vault beacon alerts',
  stream: 'streaming skills from the vault',
};

const home = () => process.env.SKILLHAWK_HOME || path.join(os.homedir(), '.skillhawk');
const keyFile = () => path.join(home(), 'license');

function publicKey(env = process.env) {
  // Tests sign their own keys; the override only works under `node --test`.
  if (env.NODE_TEST_CONTEXT && env.SKILLHAWK_TEST_LICENSE_PUBKEY) return env.SKILLHAWK_TEST_LICENSE_PUBKEY;
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'license-public-key.pem'), 'utf8');
}

/** { ok, signed, payload?, reason?, daysLeft?, inGrace? }. signed = issued by Skillhawk, even if expired. */
export function verify(token, { now = Date.now(), env = process.env } = {}) {
  const [body, sig] = String(token || '').trim().split('.');
  if (!body || !sig) return { ok: false, signed: false, reason: 'not a license key' };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(body), crypto.createPublicKey(publicKey(env)), Buffer.from(sig, 'base64url')); } catch { good = false; }
  if (!good) return { ok: false, signed: false, reason: 'not issued by Skillhawk, or altered' };
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, signed: false, reason: 'unreadable key' }; }
  if (payload.v !== 1 || !TEAM_PLANS.includes(payload.plan)) return { ok: false, signed: true, payload, reason: `a ${payload.plan || 'different'} key, not a Teams license` };
  const daysLeft = Math.floor((Date.parse(`${payload.exp}T23:59:59Z`) - now) / 864e5);
  if (daysLeft < -GRACE_DAYS) return { ok: false, signed: true, payload, daysLeft, reason: `expired on ${payload.exp}` };
  return { ok: true, signed: true, payload, daysLeft, inGrace: daysLeft < 0 };
}

export const load = (env = process.env) => {
  if (env.SKILLHAWK_LICENSE) return env.SKILLHAWK_LICENSE.trim();
  try { return fs.readFileSync(keyFile(), 'utf8').trim(); } catch { return ''; }
};

export function current(opts = {}) {
  const tok = load(opts.env);
  if (!tok) return { ok: false, signed: false, reason: 'no license key on this machine' };
  return verify(tok, opts);
}

/** Throws unless a Teams license is present. Revoke and offboard also work on an expired key, so a lapsed
 *  subscription never stops anyone from cutting a leaver's access. */
export function requireTeams(cmd, opts = {}) {
  const st = current(opts);
  if (st.ok) {
    if (st.inGrace) process.stderr.write(`skillhawk: Teams license expired on ${st.payload.exp}; ${GRACE_DAYS + st.daysLeft} grace day(s) left. Renew: ${BUY_URL}\n`);
    return st;
  }
  if (st.signed && TEAM_PLANS.includes(st.payload?.plan) && (cmd === 'revoke' || cmd === 'offboard')) return st;
  const what = GATED[cmd] || cmd;
  const e = new Error(`${what} is part of Skillhawk Teams (${st.reason}).\n  Get a key: ${BUY_URL}  ·  then: skillhawk license activate <key>  (or set SKILLHAWK_LICENSE)\n  Everything else in skillhawk stays free.`);
  e.code = 'LICENSE';
  throw e;
}

export function licenseCmd(args) {
  const sub = args[0] || 'status';
  if (sub === 'activate') {
    const v = verify(args[1]);
    if (!v.ok) throw new Error(`that key does not work: ${v.reason}`);
    fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile(), `${String(args[1]).trim()}\n`, { mode: 0o600 });
    return void console.log(`Teams license active: ${v.payload.org || v.payload.email}, ${v.payload.seats || '?'} seats, until ${v.payload.exp}.`);
  }
  if (sub === 'remove') { fs.rmSync(keyFile(), { force: true }); return void console.log('license key removed from this machine'); }
  if (sub !== 'status') throw new Error('usage: skillhawk license [status | activate <key> | remove]');
  const st = current();
  if (st.ok) return void console.log(`Teams license: ${st.payload.org || st.payload.email}, ${st.payload.seats || '?'} seats, until ${st.payload.exp}${st.inGrace ? ' (expired; in grace period)' : ''}.`);
  console.log(`No Teams license (${st.reason}). The company vault, revoke, offboard and exit-interview need one: ${BUY_URL}\nEverything else is free.`);
}
