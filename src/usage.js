// skillhawk usage: will your subscription last the week? Reads Claude Code's local logs: tokens per assistant turn
// (priced at API list prices as a common unit, not a bill) and every time you actually hit a limit ("You've hit your
// session limit · resets 2:10pm"). Anthropic does not publish the remaining quota, so the caps here are learned from
// your own limit hits: how much you had used in the 5 hours (session) or 7 days (weekly) before each hit. With no hits
// yet, it compares this week with your own typical week. Everything is an estimate and says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { costOf, listJsonl } from './tokens.js';

const H = 3600e3, DAY = 24 * H;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (n) => Math.round(n * 100) / 100;

/** Classify a limit message: session (5-hour), weekly, model-specific, or other. */
export function limitKind(text) {
  const t = String(text).toLowerCase();
  if (/weekly|week/.test(t)) return 'weekly';
  if (/session limit|5-hour|5 hour/.test(t)) return 'session';
  if (/(opus|fable|sonnet|haiku) limit/.test(t)) return 'model';
  return 'other';
}
/** "resets 2:10pm (America/New_York)" -> the next such time after `at` (local clock of this machine). */
export function resetTime(text, at) {
  const m = /resets\s+(?:([A-Z][a-z]{2})\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(String(text));
  if (!m) return null;
  let h = Number(m[2]) % 12; if (/pm/i.test(m[4])) h += 12;
  const d = new Date(at); d.setHours(h, Number(m[3] || 0), 0, 0);
  if (m[1]) { const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1].toLowerCase()); if (wd >= 0) while (d.getDay() !== wd || d.getTime() <= at) d.setTime(d.getTime() + DAY); }
  while (d.getTime() <= at) d.setTime(d.getTime() + DAY);
  return d.getTime();
}

/** Turns (time, cost, tokens, model) and limit hits from the logs since `since`. */
export async function scan({ logs = path.join(os.homedir(), '.claude', 'projects'), since = Date.now() - 35 * DAY } = {}) {
  const turns = [], hits = [], seen = new Set();
  for (const f of listJsonl(logs)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"') && !line.includes('rate_limit')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const t = Date.parse(r.timestamp || '');
      if (!(t >= since) || r.type !== 'assistant') continue;
      if (r.error === 'rate_limit' || (r.isApiErrorMessage && /limit/i.test(JSON.stringify(r.message?.content || '')))) {
        const c = r.message?.content; const text = Array.isArray(c) ? c.map((x) => x?.text || '').join(' ') : String(c || '');
        const k = `${Math.round(t / 60e3)}|${text.slice(0, 60)}`;
        if (!seen.has(k)) { seen.add(k); hits.push({ time: t, kind: limitKind(text), text: text.slice(0, 160), resets: resetTime(text, t) }); }
        continue;
      }
      const u = r.message?.usage; if (!u || r.message?.model === '<synthetic>') continue;
      const id = r.message.id && r.requestId ? `${r.message.id}:${r.requestId}` : r.uuid;
      if (seen.has(id)) continue; seen.add(id);
      const usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
      turns.push({ time: t, cost: costOf(usage, r.message.model), model: r.message.model, headless: /^sdk/.test(r.entrypoint || '') });
    }
  }
  turns.sort((a, b) => a.time - b.time); hits.sort((a, b) => a.time - b.time);
  return { turns, hits };
}

const sumIn = (turns, a, b) => turns.reduce((s, x) => (x.time >= a && x.time < b ? s + x.cost : s), 0);

/** Pace for the 5-hour window and the 7-day window, with caps learned from your own limit hits. */
export function pace({ turns, hits }, { now = Date.now(), weeklyCap = null, sessionCap = null } = {}) {
  const learned = (kind, span) => { const xs = hits.filter((h) => h.kind === kind).map((h) => sumIn(turns, h.time - span, h.time + 1)).filter((x) => x > 0); return xs.length ? { value: r2(median(xs)), from: xs.length } : null; };
  const wCap = weeklyCap ? { value: weeklyCap, from: 'you' } : learned('weekly', 7 * DAY);
  const sCap = sessionCap ? { value: sessionCap, from: 'you' } : learned('session', 5 * H);
  const week = r2(sumIn(turns, now - 7 * DAY, now + 1));
  const window = r2(sumIn(turns, now - 5 * H, now + 1));
  const prevWeeks = [1, 2, 3, 4].map((i) => sumIn(turns, now - (i + 1) * 7 * DAY, now - i * 7 * DAY)).filter((x) => x > 0);
  const typical = prevWeeks.length ? r2(median(prevWeeks)) : null;
  const last24 = sumIn(turns, now - DAY, now + 1);
  const out = { now, week, window, typicalWeek: typical, last24: r2(last24), weeklyCap: wCap, sessionCap: sCap, hits: hits.filter((h) => h.time >= now - 28 * DAY) };
  if (wCap) {
    out.weekPct = Math.round((100 * week) / wCap.value);
    out.daysLeftAtPace = last24 > 0 ? r2(Math.max(0, wCap.value - week) / last24) : null;
  }
  if (sCap) out.windowPct = Math.round((100 * window) / sCap.value);
  const lastHit = hits.at(-1);
  out.limitedNow = !!(lastHit && lastHit.resets && lastHit.resets > now);
  out.resetsAt = out.limitedNow ? lastHit.resets : null;
  return out;
}

const fmtT = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
export function render(p) {
  const L = ['skillhawk usage: will your subscription last? (estimates from local logs; units are API list-price dollars, not a bill)'];
  if (p.limitedNow) L.push(`  LIMITED NOW: resets ${fmtT(p.resetsAt)}`);
  L.push(`  last 5 hours: $${p.window}${p.sessionCap ? ` of about $${p.sessionCap.value} (${p.windowPct}%)` : ''}`);
  L.push(`  last 7 days:  $${p.week}${p.weeklyCap ? ` of about $${p.weeklyCap.value} (${p.weekPct}%)` : ''}${p.typicalWeek ? ` · your typical week: $${p.typicalWeek}` : ''}`);
  if (p.daysLeftAtPace != null) L.push(`  at the last 24 hours' pace ($${p.last24}/day) the weekly cap is ${p.daysLeftAtPace >= 7 ? 'not in reach this week' : `about ${p.daysLeftAtPace} days away`}`);
  else if (p.typicalWeek && !p.weeklyCap) L.push(`  this week is ${Math.round((100 * p.week) / p.typicalWeek)}% of your typical week`);
  const cap = (c, n) => (c ? `${n}: about $${c.value} (${c.from === 'you' ? 'your setting' : `learned from ${c.from} limit hit${c.from === 1 ? '' : 's'}`})` : `${n}: unknown until you hit it once, or set --${n === 'weekly cap' ? 'weekly' : 'session'}-cap`);
  L.push(`  ${cap(p.weeklyCap, 'weekly cap')} · ${cap(p.sessionCap, 'session cap')}`);
  if (p.hits.length) L.push(`  limit hits in 4 weeks: ${p.hits.length} (${Object.entries(p.hits.reduce((a, h) => ({ ...a, [h.kind]: (a[h.kind] || 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(', ')}); last ${fmtT(p.hits.at(-1).time)}`);
  return L.join('\n');
}

export async function run(args, flags = {}) {
  const logs = typeof flags.logs === 'string' ? path.resolve(flags.logs) : undefined;
  const p = pace(await scan({ logs }), { weeklyCap: Number(flags['weekly-cap']) || null, sessionCap: Number(flags['session-cap']) || null });
  if (flags.json) return void console.log(JSON.stringify(p, null, 1));
  console.log(render(p));
}
