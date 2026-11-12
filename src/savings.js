// skillyard savings: what are skills worth in dollars? Compares sessions where a skill fired with comparable sessions
// (same repo, similar first prompt by keyword overlap) where it did not. Local logs only, no model, no network.
// Method, plainly: per skill, corrections / redo turns / dollars per task in matched sessions with vs without the skill;
// the difference times the number of tasks done with the skill is the estimate. It is a correlation, not an experiment
// (use `skillyard ab` for that), so every row carries its sample size and a confidence label.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { classify, repoOf, projectName } from './studio/capture.js';
import { excluder } from './review-chats.js';
import { PRICES, costOf, listJsonl, skillsInRecord, recordText } from './tokens.js';

// Documented constants; override with flags (--rate, --correction-min, --redo-min, --price-table file.json).
export const DEFAULTS = {
  hourlyRate: 100, // USD per engineer hour
  correctionMinutes: 2, // one correction costs about 2 minutes of attention
  redoMinutes: 3, // one "try again / redo" turn costs about 3 minutes
  minMatch: 2, // shared keywords for two sessions to count as "similar prompts"
  minJaccard: 0.1,
};
const NOISE = /^<(system-reminder|command-|local-command|task-notification|bash-|pasted_content)|^caveat:|^\[image/i;
const REDO = /\b(redo|re-do|try again|do (it|that|this) again|start over|once more|retry)\b/i;
const STOP = new Set('this that with from have your when what then than they them were will would should could about into just also only some more most make made does done need want like please there here over under after before while which where being been using used the and for you are not but can let get use add fix new now one all any out how why its our'.split(' '));
export const keywords = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));

function humanText(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) return null;
  const t = recordText(rec).trim();
  if (!t || NOISE.test(t)) return null;
  return t;
}

/** One pass over one session file: prompts, corrections, redos, skills fired, tokens and cost. */
export async function readStats(file, prices = PRICES) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const s = { file, id: path.basename(file, '.jsonl'), cwd: null, first: null, last: null, prompts: 0, firstPrompt: '', corrections: 0, redos: 0, skills: new Set(), tokens: 0, cost: 0 };
  const seen = new Set();
  let sinceAsk = 0;
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    if (rec.timestamp) { s.first ||= rec.timestamp; s.last = rec.timestamp; }
    skillsInRecord(rec).forEach((k) => s.skills.add(k));
    if (rec.type === 'assistant') {
      if (!rec.isSidechain) sinceAsk++;
      const u = rec.message?.usage;
      if (!u) continue;
      const key = rec.message.id && rec.requestId ? `${rec.message.id}:${rec.requestId}` : rec.uuid;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const x = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
      s.tokens += x.input + x.output + x.cacheWrite + x.cacheRead;
      s.cost += costOf(x, rec.message.model, prices);
      continue;
    }
    const h = humanText(rec);
    if (!h) continue;
    s.prompts++;
    if (s.prompts <= 2) s.firstPrompt += ` ${h.slice(0, 400)}`;
    const corrected = sinceAsk && h.length < 2000 ? classify(h) : null;
    if (corrected) s.corrections++;
    else if (sinceAsk && REDO.test(h)) s.redos++;
    sinceAsk = 0;
  }
  s.repo = (s.cwd && repoOf(s.cwd)) || projectName(path.basename(path.dirname(file)));
  s.day = s.last ? s.last.slice(0, 10) : null;
  s.words = keywords(s.firstPrompt);
  return s;
}

/** Read all sessions under `logs` within `days` (0 = all). Configured exclusions and `exclude` paths are never read. */
export async function readSessions({ logs, days = 30, now = Date.now(), prices = PRICES, exclude = [] } = {}) {
  const root = logs || path.join(os.homedir(), '.claude', 'projects');
  const ex = excluder(exclude);
  const since = days > 0 ? now - days * 86400e3 : 0;
  const out = [];
  for (const f of listJsonl(root)) {
    if (ex(f)) continue;
    const s = await readStats(f, prices);
    if (s.cwd && ex(s.cwd)) continue;
    const ms = s.last ? Date.parse(s.last) : NaN;
    if (Number.isNaN(ms) || ms < since || ms > now + 86400e3 || !s.prompts) continue;
    out.push(s);
  }
  return out;
}

const jaccard = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return { i, j: i / (a.size + b.size - i || 1) }; };
export const confidence = (n) => (n < 10 ? 'low' : n < 30 ? 'medium' : 'high');
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

/** Estimate per-skill value. `sessions` come from readSessions. */
export function estimate(sessions, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const names = new Set(sessions.flatMap((s) => [...s.skills]));
  const rows = [];
  for (const name of names) {
    const treated = sessions.filter((s) => s.skills.has(name));
    const pool = sessions.filter((s) => !s.skills.has(name));
    const matched = new Set();
    const used = [];
    for (const t of treated) {
      let any = false;
      for (const c of pool) {
        if (c.repo !== t.repo) continue;
        const { i, j } = jaccard(t.words, c.words);
        if (i >= o.minMatch && j >= o.minJaccard) { matched.add(c); any = true; }
      }
      if (any) used.push(t);
    }
    const controls = [...matched];
    const row = { skill: name, sessionsWith: treated.length, matchedWith: used.length, controls: controls.length, tasks: sum(used, (s) => s.prompts) };
    if (!used.length || !controls.length) { Object.assign(row, { confidence: 'low', note: 'no comparable sessions without this skill', correctionsAvoided: 0, redosAvoided: 0, tokensDelta: 0, dollars: 0, parts: { corrections: 0, redos: 0, tokens: 0 } }); rows.push(row); continue; }
    const pT = sum(used, (s) => s.prompts);
    const pC = sum(controls, (s) => s.prompts);
    const rate = (xs, f) => sum(xs, f) / sum(xs, (s) => s.prompts);
    const corr = (rate(controls, (s) => s.corrections) - rate(used, (s) => s.corrections)) * pT;
    const redo = (rate(controls, (s) => s.redos) - rate(used, (s) => s.redos)) * pT;
    const tok = (rate(controls, (s) => s.tokens) - rate(used, (s) => s.tokens)) * pT;
    const usd = (rate(controls, (s) => s.cost) - rate(used, (s) => s.cost)) * pT;
    const per = o.hourlyRate / 60;
    const parts = { corrections: corr * o.correctionMinutes * per, redos: redo * o.redoMinutes * per, tokens: usd };
    Object.assign(row, {
      correctionRateWith: rate(used, (s) => s.corrections), correctionRateWithout: rate(controls, (s) => s.corrections),
      correctionsAvoided: corr, redosAvoided: redo, tokensDelta: tok, parts, dollars: parts.corrections + parts.redos + parts.tokens,
      confidence: confidence(Math.min(used.length, controls.length)), pC,
    });
    rows.push(row);
  }
  rows.sort((a, b) => b.dollars - a.dollars);
  const withoutAny = sessions.filter((s) => !s.skills.size);
  return { constants: o, sessions: sessions.length, sessionsWithoutSkills: withoutAny.length, skills: rows, total: sum(rows, (r) => r.dollars) };
}

const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const METHOD = (c) => `Method: for each skill, sessions where it fired are compared with sessions where it did not, in the same repo with overlapping first-prompt keywords. Differences in corrections per task (${c.correctionMinutes} min each), redo turns per task (${c.redoMinutes} min each) and token cost per task are multiplied by the tasks done with the skill; time is valued at $${c.hourlyRate}/h, tokens at list prices in src/tokens.js. This is a correlation, not an experiment: confidence is low under 10 matched sessions, medium under 30. Run \`skillyard ab\` to prove a specific skill.`;

export function render(r) {
  const out = [`Skill savings (estimate): ${usd(r.total)} across ${r.sessions} sessions (${r.skills.length} skills seen)`, ''];
  if (!r.skills.length) out.push('No skill invocations found in these logs.');
  for (const s of r.skills) {
    out.push(`${s.skill.padEnd(28)} ${usd(s.dollars).padStart(9)}   n=${s.matchedWith} with / ${s.controls} without   confidence: ${s.confidence}${s.confidence === 'low' ? ' (low confidence, fewer than 10 sessions)' : ''}`);
    if (s.note) out.push(`    ${s.note}`);
    else out.push(`    corrections avoided ${s.correctionsAvoided.toFixed(1)} (${usd(s.parts.corrections)}), redo turns avoided ${s.redosAvoided.toFixed(1)} (${usd(s.parts.redos)}), token cost delta ${usd(s.parts.tokens)} (${Math.round(s.tokensDelta).toLocaleString()} tokens)`);
  }
  out.push('', METHOD(r.constants));
  return out.join('\n');
}

export function statement(r, days) {
  const top = r.skills.filter((s) => s.dollars > 0).slice(0, 5);
  const lines = [`# Skillyard savings statement`, '', `Skillyard saved an estimated **${usd(Math.max(0, r.total))}** in the last ${days || 'all'} days across ${r.sessions} sessions.`, ''];
  lines.push('## Top skills', '');
  if (!top.length) lines.push('No skill showed a positive effect yet.');
  else {
    lines.push('| Skill | Estimated value | Sessions (with / without) | Confidence |', '|---|---|---|---|');
    for (const s of top) lines.push(`| ${s.skill} | ${usd(s.dollars)} | ${s.matchedWith} / ${s.controls} | ${s.confidence} |`);
  }
  const bad = r.skills.filter((s) => s.dollars < 0);
  if (bad.length) lines.push('', `Skills with a negative estimate (they cost more than they saved): ${bad.map((s) => `${s.skill} (${usd(s.dollars)})`).join(', ')}.`);
  lines.push('', '## Method', '', METHOD(r.constants), '');
  return lines.join('\n');
}

export async function run(args, flags) {
  if (typeof flags.json === 'string') flags.json = true;
  const num = (v, d) => (v === undefined || v === true ? d : Number(v));
  const days = num(flags.days, 30);
  if (Number.isNaN(days) || days < 0) throw new Error('--days must be a number of days (0 = all)');
  const logs = flags.logs && flags.logs !== true ? flags.logs : null;
  if (logs && !fs.existsSync(logs)) throw new Error(`no such logs folder: ${logs}`);
  let prices = PRICES;
  if (flags['price-table'] && flags['price-table'] !== true) prices = { ...PRICES, ...JSON.parse(fs.readFileSync(flags['price-table'], 'utf8')) };
  const consts = { hourlyRate: num(flags.rate, DEFAULTS.hourlyRate), correctionMinutes: num(flags['correction-min'], DEFAULTS.correctionMinutes), redoMinutes: num(flags['redo-min'], DEFAULTS.redoMinutes) };
  const sessions = await readSessions({ logs, days, prices, now: flags.now ? Number(flags.now) : Date.now() });
  const r = estimate(sessions, consts);
  if (flags.statement && flags.statement !== true) {
    fs.mkdirSync(path.dirname(path.resolve(flags.statement)), { recursive: true });
    fs.writeFileSync(flags.statement, statement(r, days));
    if (!flags.json) console.log(`Wrote ${flags.statement}`);
  }
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  else console.log(render(r));
  return r;
}
