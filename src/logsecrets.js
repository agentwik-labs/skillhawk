// skillhawk logs-secrets: keys, tokens and passwords that ended up in your agent session logs (pasted into a prompt,
// printed by a command, read from a file). Lists the file, line and kind, never the value. With --redact it rewrites
// those lines with the secret replaced by [redacted:<kind>]; sessions active in the last 10 minutes are skipped.
// Redacting a log does not make a leaked key safe: rotate the key too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listJsonl } from './tokens.js';

export const PATTERNS = [
  ['anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai', /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github', /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g],
  ['slack', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['assignment', /\b(?:[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD))\s*[=:]\s*(?:\\?["'])?([A-Za-z0-9_\-/+.=]{16,})/g],
];
// a real key body is random: digits and both cases, and few long words (slugs like sk-my-long-branch-name are not keys)
export const random = (v) => /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v) && !/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}/.test(v);
const PLACEHOLDER = /(x{6,}|your[_-]|example|placeholder|redacted|\*{4,}|<[^>]+>|\.\.\.|changeme|dummy|test[_-]?key)/i;

/** Secrets in one string: [{kind, index, value}] (value is used only to redact; never printed). */
export function secretsIn(text) {
  const out = [];
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = kind === 'assignment' ? m[1] : m[0];
      if (PLACEHOLDER.test(value)) continue;
      if (!['private-key', 'aws-access-key'].includes(kind) && !random(kind === 'assignment' ? value : value.replace(/^[a-z]+[-_](?:ant-|proj-|live_)?(?:api\d+-)?/, ''))) continue;
      if (out.some((o) => o.value === value)) continue;
      out.push({ kind, value });
    }
  }
  return out;
}
const mask = (v) => `${v.slice(0, 4)}…(${v.length} chars)`;

export function scanLogs({ roots = [path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.codex', 'sessions')], since = 0 } = {}) {
  const found = [];
  for (const root of roots) for (const f of listJsonl(root)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => { if (ln.length < 20) return; for (const s of secretsIn(ln)) found.push({ file: f, line: i + 1, kind: s.kind, preview: mask(s.value), mtime: st.mtimeMs, _value: s.value }); });
  }
  return found;
}

/** Rewrite the affected files with values replaced. Skips files written in the last `activeMinutes`. */
export function redactLogs(found, { now = Date.now(), activeMinutes = 10 } = {}) {
  const byFile = new Map();
  for (const x of found) (byFile.get(x.file) || byFile.set(x.file, []).get(x.file)).push(x);
  const done = [], skipped = [];
  for (const [file, xs] of byFile) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs < activeMinutes * 60e3) { skipped.push(file); continue; }
    let text = fs.readFileSync(file, 'utf8');
    for (const x of xs) {
      // the value as it appears in JSON (escaped) and raw
      for (const v of new Set([x._value, JSON.stringify(x._value).slice(1, -1)])) text = text.split(v).join(`[redacted:${x.kind}]`);
    }
    const tmp = `${file}.skillhawk-tmp`;
    fs.writeFileSync(tmp, text, { mode: st.mode & 0o777 });
    fs.renameSync(tmp, file);
    done.push({ file, count: xs.length });
  }
  return { done, skipped };
}

export async function run(_args, flags = {}) {
  const roots = typeof flags.logs === 'string' ? [path.resolve(flags.logs)] : undefined;
  const found = scanLogs({ roots });
  if (flags.json) return void console.log(JSON.stringify(found.map(({ _value, ...x }) => x), null, 1));
  if (!found.length) return void console.log('No keys, tokens or passwords found in your agent session logs.');
  const kinds = found.reduce((a, x) => ({ ...a, [x.kind]: (a[x.kind] || 0) + 1 }), {});
  console.log(`${found.length} secret${found.length > 1 ? 's' : ''} in ${new Set(found.map((x) => x.file)).size} session log(s): ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  for (const x of found.slice(0, 25)) console.log(`  ${x.kind.padEnd(15)} ${x.preview.padEnd(18)} ${x.file.replace(os.homedir(), '~')}:${x.line}`);
  if (found.length > 25) console.log(`  … ${found.length - 25} more (--json)`);
  if (!flags.redact) return void console.log('\nRedact them in place: skillhawk logs-secrets --redact. Rotate any real key that appears here: a log is only one of the places it went.');
  const r = redactLogs(found);
  console.log(`\nRedacted ${r.done.reduce((a, d) => a + d.count, 0)} in ${r.done.length} file(s).${r.skipped.length ? ` Skipped ${r.skipped.length} active session(s); run again later.` : ''} Rotate the real keys.`);
}
