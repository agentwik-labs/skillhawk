// Skillhawk SessionStart hook: one line to the user, only when a scheduled agent or the shell is set to bill an API key,
// and only when that finding is new or changed since it was last shown. Silent otherwise. Never prints key values.
// Opt out: SKILLHAWK_NO_HINTS=1. SKILLHAWK_HOOK_ARGS (a JSON array) adds flags to `agents`, e.g. for demos on example data. State: ~/.skillhawk/session-hook.json (a hash of the finding, nothing else).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function message(report) {
  const billing = report?.flagged?.billing || [];
  const shell = report?.flagged?.shell || [];
  if (!billing.length && !shell.length) return null;
  const parts = [];
  if (billing.length) parts.push(`${billing.length} scheduled agent${billing.length > 1 ? 's' : ''} (${[...new Set(billing.map((b) => b.where))].join(', ')}) bill${billing.length > 1 ? '' : 's'} an API key per token`);
  if (shell.length) parts.push(`your shell exports ${[...new Set(shell.flatMap((s) => s.vars || s.names || [s.var || s.name]).filter(Boolean))].join(', ') || 'an API key'}, so agents started from it bill that key`);
  return `Skillhawk: ${parts.join('; ')}. Run /skillhawk:billing for details and the fix.`;
}

export function decide(report, statePath) {
  const msg = message(report);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  const key = msg ? crypto.createHash('sha256').update(msg).digest('hex') : null;
  if (key !== state.key) { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify({ key, at: new Date().toISOString() })); }
  return msg && key !== state.key ? msg : null;
}

if (import.meta.url === `file://${process.argv[1]}` && !process.env.SKILLHAWK_NO_HINTS) {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no stdin */ }
  const r = spawnSync('npx', ['-y', 'skillhawk', 'agents', '--json', ...JSON.parse(process.env.SKILLHAWK_HOOK_ARGS || '[]')], { cwd: input.cwd || process.cwd(), encoding: 'utf8', timeout: 15000, env: { ...process.env, SKILLHAWK_NO_HINTS: '1' } });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { process.exit(0); }
  const msg = decide(report, path.join(os.homedir(), '.skillhawk', 'session-hook.json'));
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
}
