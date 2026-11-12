// Token dashboard: tokens and estimated cost from Claude Code session logs (the `usage` fields), per day, repo,
// skill and session. Reads logs on this machine only. Reuses Studio's repo/worktree resolution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { repoOf, projectName } from './studio/capture.js';
import { excluder } from './review-chats.js';

// USD per million tokens. Estimates only; edit here when prices change.
export const PRICES = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
const priceFor = (model, table = PRICES) => table[/opus/i.test(model || '') ? 'opus' : /haiku/i.test(model || '') ? 'haiku' : 'sonnet'];

export function costOf(u, model, table = PRICES) {
  const p = priceFor(model, table);
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
}
const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, turns: 0 });
const addTo = (t, u, cost) => { t.input += u.input; t.output += u.output; t.cacheWrite += u.cacheWrite; t.cacheRead += u.cacheRead; t.cost += cost; t.turns++; };
export const total = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

export function listJsonl(root) {
  const out = [];
  const go = (d, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 5 && e.name !== 'subagents') go(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  go(root, 0);
  return out;
}

const SKILL_TOOLS = /^(Skill|skill)$/;
const cleanSkill = (s) => String(s || '').trim().replace(/^\//, '').replace(/[^\w:.@/-].*$/s, '') || null;

/** Text of a record's content (string, or text / tool_result parts). */
export function recordText(rec) {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((x) => (typeof x === 'string' ? x : x?.type === 'text' ? x.text : x?.type === 'tool_result' ? (typeof x.content === 'string' ? x.content : Array.isArray(x.content) ? x.content.map((y) => y?.text || '').join(' ') : '') : '')).join('\n');
}

/** Skills invoked in one log record. Handles every shape Claude Code writes:
 *  assistant tool_use "Skill" {skill|command|name}; user `<command-name>/skill</command-name>`;
 *  "Launching skill: <name>"; "Base directory for this skill: .../skills/<name>". */
export function skillsInRecord(rec) {
  const out = [];
  const content = rec?.message?.content;
  if (rec?.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'tool_use' && SKILL_TOOLS.test(c.name || '')) {
        const n = cleanSkill(c.input?.skill ?? c.input?.command ?? c.input?.name);
        if (n) out.push(n);
      }
    }
  } else if (rec?.type === 'user') {
    const t = recordText(rec);
    for (const m of t.matchAll(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/g)) out.push(cleanSkill(m[1]));
    for (const m of t.matchAll(/Launching skill:\s*([^\s]+)/g)) out.push(cleanSkill(m[1]));
    for (const m of t.matchAll(/Base directory for this skill:\s*\S*?\/skills\/([^\s/]+)/g)) out.push(cleanSkill(m[1]));
  }
  return [...new Set(out.filter(Boolean))];
}

async function readSession(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const turns = [];
  const seen = new Set();
  let cwd = null;
  let skill = null; // skill active since the last human prompt
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!cwd && rec.cwd) cwd = rec.cwd;
    if (rec.type === 'user') {
      const found = skillsInRecord(rec);
      if (!rec.isMeta) {
      const c = rec.message?.content;
      const human = typeof c === 'string' ? c.trim() : Array.isArray(c) && !c.some((x) => x?.type === 'tool_result') && c.some((x) => x?.type === 'text');
      if (human && !(typeof c === 'string' && /^<(command-|local-command|system-reminder)/.test(c))) skill = null;
      }
      if (found.length) skill = found[0];
      continue;
    }
    if (rec.type !== 'assistant' || !rec.message?.usage) continue;
    const key = rec.message.id && rec.requestId ? `${rec.message.id}:${rec.requestId}` : rec.uuid;
    if (key && seen.has(key)) continue; // streaming writes the same message more than once
    if (key) seen.add(key);
    const content = Array.isArray(rec.message.content) ? rec.message.content : [];
    const inv = skillsInRecord(rec);
    if (inv.length) skill = inv[0];
    const u = rec.message.usage;
    turns.push({
      time: rec.timestamp || null,
      model: rec.message.model || '',
      skill,
      usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
    });
  }
  return { cwd, turns };
}

/** Aggregate logs under `logs`. Returns { days, repos, skills, sessions, totals }. */
export async function collect({ logs, days = 7, exclude = [], now = Date.now() } = {}) {
  const excluded = excluder(exclude);
  const root = logs || path.join(os.homedir(), '.claude', 'projects');
  const since = days > 0 ? now - days * 86400e3 : 0;
  const agg = { byDay: {}, byRepo: {}, bySkill: {}, bySession: {}, totals: zero(), files: 0, skippedExcluded: 0 };
  for (const file of listJsonl(root)) {
    const { cwd, turns } = await readSession(file);
    if (excluded(file) || (cwd && excluded(cwd))) { agg.skippedExcluded++; continue; }
    const repo = (cwd && repoOf(cwd)) || projectName(path.basename(path.dirname(file)));
    const sid = path.basename(file, '.jsonl').slice(0, 8);
    let used = false;
    for (const t of turns) {
      const ms = t.time ? Date.parse(t.time) : NaN;
      if (Number.isNaN(ms) || ms < since || ms > now + 86400e3) continue;
      const cost = costOf(t.usage, t.model);
      const day = new Date(ms).toISOString().slice(0, 10);
      addTo(agg.byDay[day] ||= zero(), t.usage, cost);
      addTo(agg.byRepo[repo] ||= zero(), t.usage, cost);
      addTo(agg.bySkill[t.skill || '(no skill)'] ||= zero(), t.usage, cost);
      addTo(agg.bySession[`${repo}/${sid}`] ||= { ...zero(), repo, session: sid, day }, t.usage, cost);
      addTo(agg.totals, t.usage, cost);
      used = true;
    }
    if (used) agg.files++;
  }
  const rows = (o, key) => Object.entries(o).map(([k, v]) => ({ [key]: k, ...v, tokens: total(v) }));
  return {
    days,
    sessionsCounted: agg.files,
    skippedExcluded: agg.skippedExcluded,
    totals: { ...agg.totals, tokens: total(agg.totals) },
    byDay: rows(agg.byDay, 'day').sort((a, b) => a.day.localeCompare(b.day)),
    byRepo: rows(agg.byRepo, 'repo').sort((a, b) => b.cost - a.cost),
    bySkill: rows(agg.bySkill, 'skill').sort((a, b) => b.cost - a.cost),
    topSessions: rows(agg.bySession, 'id').sort((a, b) => b.cost - a.cost).slice(0, 10),
  };
}

const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n) => `$${n.toFixed(2)}`;
function table(title, head, rows) {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  ');
  return [`${title}`, fmt(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(fmt), ''].join('\n');
}

export function render(r) {
  const cols = ['', 'input', 'output', 'cache wr', 'cache rd', 'total', 'est. cost'];
  const row = (name, x) => [name, fmtN(x.input), fmtN(x.output), fmtN(x.cacheWrite), fmtN(x.cacheRead), fmtN(x.tokens ?? total(x)), usd(x.cost)];
  const out = [`Token usage, last ${r.days || 'all'} days: ${fmtN(r.totals.tokens)} tokens, est. ${usd(r.totals.cost)} across ${r.sessionsCounted} sessions${r.skippedExcluded ? ` (${r.skippedExcluded} excluded)` : ''}`, ''];
  out.push(table('Per day', ['day', ...cols.slice(1)], r.byDay.map((x) => row(x.day, x))));
  out.push(table('Per repo', ['repo', ...cols.slice(1)], r.byRepo.slice(0, 15).map((x) => row(x.repo, x))));
  out.push(table('Per skill (turns after a skill is invoked, until your next prompt)', ['skill', ...cols.slice(1)], r.bySkill.slice(0, 15).map((x) => row(x.skill, x))));
  out.push(table('Top sessions', ['session', ...cols.slice(1)], r.topSessions.map((x) => row(`${x.id} ${x.day}`, x))));
  out.push('Cost is an estimate from list prices in src/tokens.js (PRICES); cache reads dominate long sessions.');
  return out.join('\n');
}

export async function run(args, flags) {
  if (typeof flags.json === 'string') flags.json = true;
  const days = flags.days === undefined ? 7 : Number(flags.days);
  if (Number.isNaN(days) || days < 0) throw new Error('--days must be a number of days (0 = all)');
  const logs = flags.logs && flags.logs !== true ? flags.logs : null;
  if (logs && !fs.existsSync(logs)) throw new Error(`no such logs folder: ${logs}`);
  const r = await collect({ logs, days, exclude: String(flags.exclude || '').split(',').filter(Boolean) });
  console.log(flags.json ? JSON.stringify(r, null, 2) : render(r));
}
