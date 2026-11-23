// skillhawk stuck: agent sessions that stopped and are waiting for you. From Claude Code's local logs: a session whose
// last entry is a tool call with no result for a few minutes is most likely waiting on a permission prompt (or a tool
// that hangs); a session whose last entry is a limit message is waiting for the reset. Reports what it is waiting on
// (tool and a redacted summary of the command or file), never the full content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listJsonl } from './tokens.js';
import { redact } from './studio/capture.js';
import { resetTime } from './usage.js';

/** The last ~64 KB of a file, as parsed records (the first partial line dropped). */
export function tail(file, bytes = 65536) {
  const st = fs.statSync(file); const n = Math.min(bytes, st.size);
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n'); if (n < st.size) lines.shift();
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const summarize = (name, input = {}) => {
  const v = input.command || input.file_path || input.path || input.url || input.pattern || input.description || input.prompt || '';
  return `${name}${v ? `: ${redact(String(v)).replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
};

/** What a session is waiting on, from its last records, or null when it is not waiting. */
export function waitingOn(recs, { now = Date.now(), minMinutes = 3 } = {}) {
  const meaningful = recs.filter((r) => ['user', 'assistant'].includes(r.type) && !r.isSidechain);
  const last = meaningful.at(-1); if (!last) return null;
  const t = Date.parse(last.timestamp || ''); if (!(t > 0)) return null;
  const idle = (now - t) / 60e3;
  if (last.type === 'assistant' && (last.error === 'rate_limit' || last.isApiErrorMessage)) {
    const c = last.message?.content; const text = Array.isArray(c) ? c.map((x) => x?.text || '').join(' ') : String(c || '');
    if (last.error === 'rate_limit') { const r = resetTime(text, t); return { kind: 'limit', what: text.slice(0, 120), since: t, resets: r }; }
    return { kind: 'error', what: text.slice(0, 120), since: t };
  }
  if (idle < minMinutes) return null;
  const parts = Array.isArray(last.message?.content) ? last.message.content : [];
  const calls = last.type === 'assistant' ? parts.filter((p) => p?.type === 'tool_use') : [];
  if (calls.length) return { kind: 'tool', what: calls.map((c) => summarize(c.name, c.input)).join('; '), since: t };
  return null;
}

export function findStuck({ logs = path.join(os.homedir(), '.claude', 'projects'), now = Date.now(), hours = 24, minMinutes = 3 } = {}) {
  const out = [];
  for (const f of listJsonl(logs)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (now - st.mtimeMs > hours * 3600e3) continue;
    let recs; try { recs = tail(f); } catch { continue; }
    const w = waitingOn(recs, { now, minMinutes });
    if (!w) continue;
    if (w.kind === 'limit' && w.resets && w.resets < now) continue; // reset already passed; it is just idle
    const cwd = recs.find((r) => r.cwd)?.cwd || '';
    const title = [...recs].reverse().find((r) => r.type === 'ai-title' || r.type === 'summary');
    out.push({ session: path.basename(f, '.jsonl').slice(0, 8), file: f, project: cwd ? path.basename(cwd) : path.basename(path.dirname(f)), cwd, title: title?.title || title?.aiTitle || title?.summary || null, ...w, minutes: Math.round((now - w.since) / 60e3) });
  }
  return out.sort((a, b) => a.since - b.since);
}

const LABEL = { tool: 'waiting on', limit: 'stopped by a limit', error: 'stopped by an error' };
export function render(xs) {
  if (!xs.length) return 'No agent session is waiting for you.';
  return [`${xs.length} session${xs.length > 1 ? 's' : ''} waiting for you:`, ...xs.map((x) => `  ${x.project} (${x.session})${x.title ? ` "${String(x.title).slice(0, 50)}"` : ''}: ${LABEL[x.kind]} ${x.what} · ${x.minutes} min${x.resets ? ` · resets ${new Date(x.resets).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}\n    resume: cd ${x.cwd.replace(os.homedir(), '~') || '.'} && claude --resume ${path.basename(x.file, '.jsonl')}`)].join('\n');
}

export async function run(_args, flags = {}) {
  const xs = findStuck({ logs: typeof flags.logs === 'string' ? path.resolve(flags.logs) : undefined, minMinutes: Number(flags.minutes) || 3 });
  if (flags.json) return void console.log(JSON.stringify(xs, null, 1));
  console.log(render(xs));
}
