// skillhawk brain: a Second Brain on your machine, built from the sources you choose (brain init asks): agent sessions,
// this repo's docs, git history, any folders of notes, transcripts or specs. Everything is searchable (brain search,
// and the brain_search MCP tool if you allow agents). It pulls out only the kinds you asked for (repeated corrections,
// decisions, preferences, open questions, definitions, facts), each with where it came from.
// For sessions: it groups the corrections you keep making into lessons and keeps the decisions you stated. A lesson is proposed only when it is backed by
// evidence (a repeated correction across sessions, or an explicit decision); you adopt it, and it is written to the
// repo's AGENTS.md (CLAUDE.md imports it). Then it measures whether the lesson stuck: how often the same correction
// comes back per 100 prompts before and after you adopted it. Lessons that do not stick get a stronger fix suggested;
// lessons that stuck long ago can be retired to keep the rules short.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanSession, repoOf, TYPE_LABELS, SOURCES } from './studio/capture.js';
import { hasConsent, grant, excluder } from './review-chats.js';
import { readFolder, readGit, extract, buildIndex, search, snippet, KINDS } from './corpus.js';
import { LEGACY, loadConfig, saveConfig, toConfig, interview, describe, QUESTIONS, brainHome } from './brain-config.js';

const START = '<!-- skillhawk:brain start -->', END = '<!-- skillhawk:brain end -->';
const DAY = 86400e3;
const STOP = new Set('this that with from have your when what then than they them were will would should could about into just also only some more make made please dont didnt doesnt isnt cant wont need want like really still again said told asked know think here there where which while because being been does done going thing things okay sure right well very much the and for not you are was but all any can use yes its has had did got get let now one two why how who out too see say way new own off our her his him she may try put ask set run lot bit'.split(' '));

export function tokens(text) {
  return new Set(String(text).toLowerCase().replace(/\[[^\]]*\]/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length >= 3));
}
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const SIM = 0.3;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const ts = (t) => (t ? Date.parse(t) : NaN);

/** Group items (corrections or decisions) of one project into clusters of similar text. Earliest first. */
export function cluster(items) {
  const out = [];
  for (const it of [...items].sort((a, b) => (ts(a.time) || 0) - (ts(b.time) || 0))) {
    const tk = tokens(it.said);
    if (!tk.size) continue;
    let best = null, bestSim = 0;
    for (const c of out) { const s = Math.max(...c.members.map((m) => jaccard(tk, m.tk))); if (s > bestSim) { best = c; bestSim = s; } }
    if (best && bestSim >= SIM) { best.members.push({ ...it, tk }); for (const x of tk) best.tk.add(x); }
    else out.push({ members: [{ ...it, tk }], tk: new Set(tk) });
  }
  return out;
}

/** Lessons for one project: repeated corrections (2+ in 2+ sessions) and stated decisions. */
export function lessons(project, corrections, decisions, { minTimes = 2, minSessions = 2 } = {}) {
  const L = [];
  for (const c of cluster(corrections)) {
    const sessions = new Set(c.members.map((m) => m.session));
    const first = c.members[0];
    L.push({
      id: sha(`${project}:c:${first.id || first.said}`).slice(0, 6), kind: 'correction', project,
      text: `${TYPE_LABELS[first.type] || 'Correction'}: ${first.said.replace(/\s+/g, ' ').slice(0, 220)}`,
      evidence: c.members.length, sessions: sessions.size, firstAt: first.time, lastAt: c.members.at(-1).time,
      examples: c.members.slice(0, 3).map((m) => m.said.slice(0, 160)), tokens: [...c.tk],
      proposed: c.members.length >= minTimes && sessions.size >= minSessions,
    });
  }
  for (const c of cluster(decisions)) {
    const first = c.members[0];
    L.push({
      id: sha(`${project}:d:${first.said}`).slice(0, 6), kind: 'decision', project,
      text: `Decision: ${first.said.replace(/\s+/g, ' ').slice(0, 220)}`, evidence: c.members.length,
      sessions: new Set(c.members.map((m) => m.session)).size, firstAt: first.time, lastAt: c.members.at(-1).time,
      examples: c.members.slice(0, 2).map((m) => m.said.slice(0, 160)), tokens: [...c.tk], proposed: true,
    });
  }
  return L.sort((a, b) => b.evidence - a.evidence);
}

/** Did an adopted lesson stick? Matching corrections per 100 prompts before vs after adoption. */
export function stick(lesson, adoptedAt, corrections, promptTimes) {
  const at = ts(adoptedAt);
  const tk = new Set(lesson.tokens);
  const hits = corrections.filter((c) => jaccard(tokens(c.said), tk) >= SIM);
  const before = hits.filter((c) => ts(c.time) < at).length, after = hits.filter((c) => ts(c.time) >= at).length;
  const pb = promptTimes.filter((t) => ts(t) < at).length, pa = promptTimes.filter((t) => ts(t) >= at).length;
  const rb = pb ? (100 * before) / pb : 0, ra = pa ? (100 * after) / pa : 0;
  let verdict;
  if (pa < 20) verdict = 'too early';
  else if (after === 0) verdict = 'stuck';
  else if (ra <= rb * 0.5) verdict = 'improving';
  else verdict = 'not sticking';
  return { before, after, promptsBefore: pb, promptsAfter: pa, rateBefore: +rb.toFixed(2), rateAfter: +ra.toFixed(2), verdict };
}

/** Correction rate per week for the last n weeks (per 100 prompts): is the agent getting better? */
export function trend(corrections, promptTimes, now = Date.now(), weeks = 6) {
  const out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const a = now - (w + 1) * 7 * DAY, b = now - w * 7 * DAY;
    const p = promptTimes.filter((t) => ts(t) >= a && ts(t) < b).length;
    const c = corrections.filter((x) => ts(x.time) >= a && ts(x.time) < b).length;
    out.push({ weekStart: new Date(a).toISOString().slice(0, 10), prompts: p, corrections: c, rate: p ? +((100 * c) / p).toFixed(1) : null });
  }
  return out;
}

// ---- state and the rules block ----------------------------------------------------------------------------------
const home = brainHome;
const stateFile = () => path.join(home(), 'state.json');
export function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { lessons: {} }; } }
function saveState(s) { fs.mkdirSync(home(), { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile(), JSON.stringify(s, null, 1), { mode: 0o600 }); }

const LABEL = { correction: 'Lessons from your sessions', decision: 'Decisions', preference: 'Preferences', question: 'Open questions', definition: 'Definitions', fact: 'Reference' };
/** Write the approved items into the file the user chose (AGENTS.md by default; CLAUDE.md imports it). */
export function writeBlock(repo, adopted, destination = 'AGENTS.md') {
  if (!destination) return null;
  const file = path.resolve(repo, destination);
  const rel = path.relative(repo, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`the rules file must be inside the repo: ${destination}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : (path.basename(file) === 'AGENTS.md' ? '# AGENTS.md\n' : '');
  const groups = {};
  for (const l of adopted) (groups[l.kind || 'correction'] ||= []).push(`- ${l.rule || l.text.replace(/^[^:]+: /, '')}`);
  const body = Object.entries(groups).flatMap(([k, lines], n) => [...(n ? [''] : []), `## ${LABEL[k] || k} (skillhawk brain)`, '', ...lines]);
  const block = adopted.length ? [START, ...body, END].join('\n') : '';
  if (t.includes(START)) t = t.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), block ? `\n\n${block}\n` : '\n');
  else if (block) t = t.trim() ? `${t.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
  fs.writeFileSync(file, t);
  if (path.basename(file) === 'AGENTS.md' && path.dirname(file) === path.resolve(repo)) {
    const claude = path.join(repo, 'CLAUDE.md');
    const c = fs.existsSync(claude) ? fs.readFileSync(claude, 'utf8') : '';
    if (block && !/^@AGENTS\.md\s*$/m.test(c)) fs.writeFileSync(claude, c ? `${c.replace(/\s*$/, '')}\n\n@AGENTS.md\n` : '@AGENTS.md\n');
  }
  return file;
}

// ---- reading the logs -------------------------------------------------------------------------------------------
const CACHE_V = 1;
async function capture({ logs, excludes = [] }) {
  const excluded = excluder(excludes);
  const cachePath = path.join(home(), 'cache.json');
  let cache = {}; try { const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')); if (c.v === CACHE_V) cache = c.files; } catch { /* first run */ }
  const next = {};
  const roots = logs ? [['claude', logs]] : Object.entries(SOURCES).map(([k, v]) => [k, v.root()]);
  const all = { corrections: [], decisions: [], prompts: [], asks: [], sessions: 0 };
  for (const [source, root] of roots) {
    const files = [];
    const walk = (d, depth) => { let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory() && depth < 5 && x.name !== 'subagents' && !/skillyard-(?:eval|llm|draft)/.test(x.name)) walk(p, depth + 1); else if (x.isFile() && x.name.endsWith('.jsonl')) files.push(p); } };
    walk(root, 0);
    for (const f of files) {
      if (excluded(f)) continue;
      let st; try { st = fs.statSync(f); } catch { continue; }
      const hit = cache[f];
      const r = hit && hit.mtime === st.mtimeMs && hit.size === st.size ? hit.r : await scanSession(f, source);
      next[f] = { mtime: st.mtimeMs, size: st.size, r };
      if (r.cwd && excluded(r.cwd)) continue;
      all.sessions++;
      all.corrections.push(...r.corrections);
      all.decisions.push(...r.decisions);
      all.prompts.push(...r.prompts.map((t) => ({ t, project: r.project })));
      all.asks.push(...r.asks.map((a) => ({ ...a, project: r.project, session: path.basename(f, '.jsonl').slice(0, 8) })));
    }
  }
  try { fs.mkdirSync(home(), { recursive: true, mode: 0o700 }); fs.writeFileSync(cachePath, JSON.stringify({ v: CACHE_V, files: next }), { mode: 0o600 }); } catch { /* cache is optional */ }
  return all;
}

// ---- the corpus: every source the user chose, chunked, redacted and searchable ----------------------------------
const CORPUS_V = 1;
function sessionChunks(cap) {
  const by = {};
  const add = (project, session, time, text) => { const k = `session:${project}/${session}`; (by[k] ||= { file: k, line: 1, heading: '', time, text: [], source: 'sessions', project }).text.push(text); };
  for (const a of cap.asks) add(a.project, a.session, a.time, a.text);
  for (const c of cap.corrections) add(c.project, c.session, c.time, c.said);
  for (const d of cap.decisions) add(d.project, d.session, d.time, d.said);
  return Object.values(by).map((c) => ({ ...c, text: c.text.join('\n') }));
}

/** Chunks from the non-session sources the user chose. Cached per file by mtime. */
export function gather(config, repo) {
  const excluded = excluder(config.exclude || []);
  const cachePath = path.join(home(), 'corpus-cache.json');
  let cache = {}; try { const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')); if (c.v === CORPUS_V) cache = c.files; } catch { /* first run */ }
  const next = {};
  const chunks = [];
  const docExts = config.exts?.length ? config.exts : ['.md', '.txt'];
  if (config.sources.includes('repo-docs') && repo) chunks.push(...readFolder(repo, { exts: ['.md', '.mdx', '.txt', '.rst', '.adoc'].filter((e) => docExts.includes('*') || docExts.includes(e) || e === '.md'), excluded, cache, next, source: 'repo-docs' }));
  if (config.sources.includes('git') && repo) chunks.push(...readGit(repo));
  if (config.sources.includes('folders')) for (const f of config.folders || []) chunks.push(...readFolder(f, { exts: docExts, excluded, cache, next, source: 'folders' }));
  try { fs.mkdirSync(home(), { recursive: true, mode: 0o700 }); fs.writeFileSync(cachePath, JSON.stringify({ v: CORPUS_V, files: { ...cache, ...next } }), { mode: 0o600 }); } catch { /* cache is optional */ }
  return chunks;
}

const usesSessions = (c) => c.sources.includes('sessions');
const rel = (repo, f) => (repo && f.startsWith(`${repo}${path.sep}`) ? path.relative(repo, f) : f.replace(os.homedir(), '~'));

export async function build({ logs, project, all = false, excludes = [], now = Date.now(), withAsks = false, config = null, repo = null } = {}) {
  const cfg = config || LEGACY(repo);
  const cap = usesSessions(cfg) ? await capture({ logs, excludes: [...excludes, ...(cfg.exclude || [])] }) : { corrections: [], decisions: [], prompts: [], asks: [], sessions: 0 };
  const docs = cfg.sources.some((s) => s !== 'sessions') ? gather(cfg, repo) : [];
  const sess = usesSessions(cfg) ? sessionChunks(cap) : [];
  const projects = all ? [...new Set([...cap.prompts.map((p) => p.project), project].filter(Boolean))] : [project];
  const state = loadState();
  const keep = new Set(cfg.keep);
  const docKinds = [...keep].filter((k) => k !== 'correction' && KINDS[k]);
  const out = [];
  for (const pj of projects) {
    const corr = cap.corrections.filter((c) => c.project === pj);
    const dec = keep.has('decision') ? cap.decisions.filter((d) => d.project === pj) : [];
    const prompts = cap.prompts.filter((p) => p.project === pj).map((p) => p.t);
    const ls = lessons(pj, keep.has('correction') ? corr : [], dec, { minTimes: cfg.minTimes, minSessions: cfg.minSessions });
    // other kinds, from the docs/folders/git the user chose (and from session text for kinds other than decisions)
    const mine = [...(pj === project ? docs : []), ...sess.filter((c) => c.project === pj)];
    for (const it of extract(mine, docKinds)) {
      if (it.source === 'sessions' && it.kind === 'decision') continue; // already found above, with session counts
      ls.push({ id: it.id, kind: it.kind, project: pj, text: `${KINDS[it.kind].label.replace(/s(?= and|$)/, '').replace(/ and .*/, '')}: ${it.text}`, evidence: 1, sessions: 0, firstAt: it.time, lastAt: it.time, where: `${rel(repo, it.file)}${/^(session|git):/.test(it.file) ? '' : `:${it.line}`}`, tokens: [...tokens(it.text)], proposed: true });
    }
    for (const l of ls) {
      const s = state.lessons[l.id];
      if (s?.adoptedAt && !s.retiredAt) { l.adoptedAt = s.adoptedAt; l.rule = s.rule; if (cfg.measure && l.kind === 'correction') l.stick = stick(l, s.adoptedAt, corr, prompts); }
      if (s?.retiredAt) l.retiredAt = s.retiredAt;
      if (s?.dismissedAt) l.dismissedAt = s.dismissedAt;
    }
    // adopted lessons whose source no longer appears (logs rotated, file edited) still count
    for (const [id, s] of Object.entries(state.lessons)) if (s.project === pj && s.adoptedAt && !s.retiredAt && !ls.some((l) => l.id === id)) ls.push({ id, kind: s.kind, project: pj, text: s.text, rule: s.rule, tokens: s.tokens, evidence: 0, sessions: 0, adoptedAt: s.adoptedAt, stick: cfg.measure && s.kind === 'correction' ? stick(s, s.adoptedAt, corr, prompts) : undefined, proposed: true });
    const extra = withAsks ? { asks: cap.asks.filter((x) => x.project === pj), correctionList: corr } : {};
    out.push({ ...extra, project: pj, prompts: prompts.length, corrections: corr.length, decisions: dec.length, rate: prompts.length ? +((100 * corr.length) / prompts.length).toFixed(1) : null, trend: trend(corr, prompts, now), lessons: ls });
  }
  const chunks = [...docs, ...sess];
  const b = { sessions: cap.sessions, chunks: chunks.length, files: new Set(chunks.map((c) => c.file)).size, config: cfg, projects: out };
  Object.defineProperty(b, 'index', { enumerable: false, get() { return this._ix || (this._ix = buildIndex(chunks)); } });
  return b;
}

/** Search everything in the brain. Returns hits with where they came from. */
export function find(b, query, limit = 8) {
  return search(b.index, query, { limit }).map((h) => ({ score: h.score, where: `${rel(b.config?.repo, h.file)}${/^(session|git):/.test(h.file) ? '' : `:${h.line}`}`, heading: h.heading, source: h.source, time: h.time || null, text: snippet(h.text, query) }));
}

export function adopt(id, { repo, brain, rule }) {
  const cfg = brain.config || LEGACY(repo);
  if (cfg.review === 'never') throw new Error('this brain is set to never write rules (brain init to change it)');
  const state = loadState();
  const l = brain.projects.flatMap((p) => p.lessons).find((x) => x.id === id);
  if (!l) throw new Error(`no item ${id}; run skillhawk brain to list them`);
  state.lessons[id] = { ...(state.lessons[id] || {}), project: l.project, kind: l.kind, text: l.text, tokens: l.tokens, rule: rule || state.lessons[id]?.rule || null, adoptedAt: state.lessons[id]?.adoptedAt || new Date().toISOString(), retiredAt: null };
  saveState(state);
  state.lessons[id].file = writeBlock(repo, adoptedFor(state, l.project), cfg.destination);
  return state.lessons[id];
}
export function retire(id, { repo, dismiss = false, config = null }) {
  const state = loadState();
  const s = state.lessons[id] || (state.lessons[id] = {});
  if (dismiss) s.dismissedAt = new Date().toISOString(); else s.retiredAt = new Date().toISOString();
  saveState(state);
  const dest = (config || LEGACY(repo)).destination;
  if (s.project && dest) writeBlock(repo, adoptedFor(state, s.project), dest);
  return s;
}
const adoptedFor = (state, project) => Object.values(state.lessons).filter((s) => s.project === project && s.adoptedAt && !s.retiredAt);

// ---- report -----------------------------------------------------------------------------------------------------
const ago = (t) => { const d = Math.floor((Date.now() - ts(t)) / DAY); return Number.isFinite(d) ? (d <= 0 ? 'today' : `${d}d ago`) : ''; };
const VERDICT = { stuck: 'stuck', improving: 'improving', 'not sticking': 'NOT STICKING', 'too early': 'too early to tell' };
const open = (l) => l.proposed && !l.adoptedAt && !l.retiredAt && !l.dismissedAt;
export function render(b) {
  const cfg = b.config || LEGACY();
  const L = [];
  for (const p of b.projects) {
    L.push(`skillhawk brain · ${p.project}${usesSessions(cfg) ? `: ${p.prompts} prompts, ${p.corrections} corrections${p.rate != null ? ` (${p.rate} per 100 prompts)` : ''}, ${p.decisions} stated decisions` : ''}`);
    const tr = p.trend.filter((w) => w.prompts);
    if (usesSessions(cfg) && tr.length) L.push(`  correction rate by week: ${tr.map((w) => `${w.weekStart.slice(5)} ${w.rate}`).join(' · ')}`);
    const adopted = p.lessons.filter((l) => l.adoptedAt && !l.retiredAt);
    if (adopted.length) {
      L.push('', `Approved (in ${cfg.destination || 'your notes'})${adopted.some((l) => l.stick) ? ': did they stick?' : ''}`);
      for (const l of adopted) {
        const s = l.stick;
        if (!s) { L.push(`  [${l.id}] ${l.rule || l.text}`); continue; }
        L.push(`  [${l.id}] ${VERDICT[s.verdict]}: ${l.rule || l.text}`);
        L.push(`         before ${s.rateBefore}/100 prompts (${s.before} in ${s.promptsBefore}) -> after ${s.rateAfter}/100 (${s.after} in ${s.promptsAfter}); adopted ${ago(l.adoptedAt)}`);
        if (s.verdict === 'not sticking') L.push('         a written rule is not holding here. Options: make it a skill step or a hook that checks it, or reword it.');
        if (s.verdict === 'stuck' && s.promptsAfter >= 300) L.push(`         stuck for ${s.promptsAfter} prompts; you can retire it to keep the rules short (skillhawk brain --retire ${l.id})`);
      }
    }
    for (const kind of ['correction', ...Object.keys(KINDS)]) {
      const xs = p.lessons.filter((l) => l.kind === kind && open(l));
      if (!xs.length) continue;
      const head = kind === 'correction' ? `Repeated corrections (${cfg.minTimes}+ times in ${cfg.minSessions}+ sessions)` : KINDS[kind].label;
      L.push('', `${head}: ${xs.length}`);
      for (const l of xs.slice(0, 8)) {
        L.push(`  [${l.id}] ${l.text.replace(/^[^:]+: /, '').slice(0, 200)}`);
        L.push(`         ${l.where || (l.kind === 'decision' ? `stated in ${l.sessions} session${l.sessions === 1 ? '' : 's'}` : `${l.evidence}x in ${l.sessions} sessions`)}${l.lastAt ? ` · ${ago(l.lastAt)}` : ''}`);
      }
      if (xs.length > 8) L.push(`  … ${xs.length - 8} more in the notes`);
    }
    if (cfg.review === 'approve' && p.lessons.some(open)) L.push('', `  approve: skillhawk brain --adopt <id> [--rule "in your words"]   dismiss: skillhawk brain --dismiss <id>`);
    const watching = p.lessons.filter((l) => l.kind === 'correction' && !l.proposed && !l.adoptedAt);
    if (watching.length) L.push('', `Watching: ${watching.length} correction${watching.length > 1 ? 's' : ''} below your threshold; shown if they come back.`);
    L.push('');
  }
  L.push(`Brain holds ${b.chunks} passages from ${b.files} files and sessions${usesSessions(cfg) ? ` (${b.sessions} sessions read)` : ''}. Search: skillhawk brain search "<question>". Nothing was uploaded; secrets, emails and numbers are redacted.`);
  return L.join('\n');
}

export function markdown(b) {
  const cfg = b.config || LEGACY();
  return b.projects.map((p) => {
    const L = [`# Second brain: ${p.project}`, '', `Updated ${new Date().toISOString().slice(0, 10)} by skillhawk brain.`, '', describe(cfg).split('\n').map((x) => `- ${x}`).join('\n'), ''];
    const adopted = p.lessons.filter((l) => l.adoptedAt && !l.retiredAt);
    if (adopted.length) L.push('## Approved', ...adopted.map((l) => `- ${l.rule || l.text}${l.stick ? ` — ${l.stick.verdict}` : ''} (${String(l.adoptedAt).slice(0, 10)})`), '');
    for (const kind of ['correction', ...Object.keys(KINDS)]) {
      const xs = p.lessons.filter((l) => l.kind === kind && !l.retiredAt && !l.dismissedAt && (l.proposed || l.adoptedAt));
      if (xs.length) L.push(`## ${kind === 'correction' ? 'Repeated corrections' : KINDS[kind].label}`, ...xs.map((l) => `- ${l.text.replace(/^[^:]+: /, '')}${l.where ? ` (${l.where})` : kind === 'correction' ? ` (${l.evidence}x)` : ''}`), '');
    }
    if (usesSessions(cfg)) L.push('## Correction rate by week (per 100 prompts)', ...p.trend.map((w) => `- ${w.weekStart}: ${w.rate ?? '—'} (${w.prompts} prompts)`), '');
    return L.join('\n');
  }).join('\n');
}

function writeNotes(b) {
  const cfg = b.config;
  if (!cfg?.notes) return null;
  fs.mkdirSync(cfg.notes, { recursive: true });
  for (const p of b.projects) {
    const base = path.join(cfg.notes, `${p.project.replace(/[^\w.-]+/g, '_')}${cfg.notes === home() ? '' : '.skillhawk-brain'}`);
    if (cfg.format !== 'json') fs.writeFileSync(`${base}.md`, markdown({ ...b, projects: [p] }));
    if (cfg.format !== 'md') fs.writeFileSync(`${base}.json`, JSON.stringify({ project: p.project, lessons: p.lessons.map(({ tokens: _, ...l }) => l), trend: p.trend }, null, 1));
  }
  return cfg.notes;
}

async function ttyAsk(rl, q) {
  const opts = (q.options || []).map((x, i) => `  ${i + 1}. ${x.label}`).join('\n');
  const hint = q.text ? '' : q.multi ? '  numbers, comma-separated' : `  Enter = 1${q.free ? `, ${q.free}` : ''}`;
  return (await rl.question(`\n${q.question}\n${opts}${opts ? '\n' : ''}${hint}: `)).trim();
}

/** `brain init`: ask the user (or take answers from a file or an agent), save the config. */
export async function init(repo, flags = {}) {
  if (flags.questions) { // for an agent to walk the user through, one question at a time
    const qs = QUESTIONS.map(({ when, ...q }) => ({ ...q, askIf: when ? String(when).replace(/^\(a\) => /, '') : undefined }));
    if (flags.json) return void console.log(JSON.stringify({ questions: qs, answersFile: 'pass the answers as JSON: skillhawk brain init --answers answers.json' }, null, 2));
    for (const q of qs) console.log(`${q.id}: ${q.question}${q.askIf ? `  (only if ${q.askIf})` : ''}\n${(q.options || []).map((x, i) => `  ${i + 1}. ${x.label}`).join('\n')}\n`);
    return;
  }
  let given = {};
  if (typeof flags.answers === 'string') given = JSON.parse(fs.readFileSync(flags.answers, 'utf8'));
  const interactive = !flags.answers && !flags.yes && process.stdin.isTTY;
  if (!interactive && !flags.answers && !flags.yes) { console.log('skillhawk brain init asks what goes into your brain and what it should do with it.\nRun it in a terminal, or: skillhawk brain init --questions --json (for an agent to ask you), then --answers answers.json. --yes takes the defaults.'); return null; }
  let rl = null;
  if (interactive) { const readline = await import('node:readline/promises'); rl = readline.createInterface({ input: process.stdin, output: process.stdout }); console.log('skillhawk brain init: your brain, your choices. Enter takes option 1.'); }
  try {
    const a = await interview(rl ? (q) => ttyAsk(rl, q) : async () => undefined, given);
    const cfg = toConfig(a, repo);
    const file = saveConfig(cfg, repo);
    console.log(`\n${describe(cfg)}\n\nSaved ${file}. Change it any time: skillhawk brain init. Run it: skillhawk brain`);
    return cfg;
  } finally { rl?.close(); }
}

export async function run(args, flags = {}) {
  const sub = ['init', 'search', 'config'].includes(args[0]) ? args.shift() : null;
  const repo = path.resolve(sub === 'search' ? (typeof flags.repo === 'string' ? flags.repo : '.') : (args[0] || (typeof flags.yes === 'string' ? flags.yes : '.')));
  if (sub === 'init') return void await init(repo, flags);
  let cfg = loadConfig(repo);
  if (sub === 'config') return void console.log(cfg ? `${describe(cfg)}\n(${cfg.file})` : 'No brain yet: skillhawk brain init');
  if (!cfg) {
    if (process.stdin.isTTY && !flags.yes && !flags.json && !sub) { console.log('No brain set up for this repo yet. A few questions first.\n'); cfg = await init(repo, flags); if (!cfg) return; }
    else if (flags.yes) cfg = LEGACY(repo); // the defaults, as before brain init existed
    else { console.log('No brain set up yet. Run: skillhawk brain init (it asks what goes in and what to do with it), or --yes for the defaults.'); return; }
  }
  if (usesSessions(cfg)) {
    const data = path.join(os.homedir(), '.skillyard', 'studio');
    if (!hasConsent(data, 'readLogs')) {
      if (flags.yes || cfg.answers?.sources?.includes('sessions')) grant(data, 'readLogs', 'agent session logs, read locally (brain)');
      else { console.log('The brain reads your agent session logs (Claude Code, Codex) on this machine. Nothing is uploaded; secrets, emails and numbers are redacted.\nRe-run with --yes to allow it.'); return; }
    }
  }
  const project = typeof flags.project === 'string' ? flags.project : repoOf(repo);
  const logs = typeof flags.logs === 'string' ? path.resolve(flags.logs) : null;
  const b = await build({ logs, project, repo, config: cfg, all: !!flags.all || cfg.scope === 'all', excludes: typeof flags.exclude === 'string' ? flags.exclude.split(',') : [] });
  if (sub === 'search') {
    const q = args.join(' ').trim();
    if (!q) return void console.log('usage: skillhawk brain search "<question>"');
    const hits = find(b, q, Number(flags.limit) || 8);
    if (flags.json) return void console.log(JSON.stringify({ query: q, hits }, null, 1));
    if (!hits.length) return void console.log(`Nothing in your brain matches "${q}". It holds ${b.chunks} passages; add sources with skillhawk brain init.`);
    for (const h of hits) console.log(`${h.where}${h.heading ? ` · ${h.heading}` : ''}\n  ${h.text}\n`);
    return;
  }
  if (flags.adopt) { const s = adopt(String(flags.adopt), { repo, brain: b, rule: typeof flags.rule === 'string' ? flags.rule : null }); console.log(`Approved [${flags.adopt}] into ${s.file}${path.basename(s.file || '') === 'AGENTS.md' ? ' (CLAUDE.md imports it)' : ''}.${cfg.measure && s.kind === 'correction' ? ' Skillhawk will measure whether it sticks.' : ''}\n  ${s.rule || s.text}`); return; }
  if (flags.retire || flags.dismiss) { const id = String(flags.retire || flags.dismiss); retire(id, { repo, dismiss: !!flags.dismiss, config: cfg }); console.log(`${flags.dismiss ? 'Dismissed' : 'Retired'} [${id}].`); return; }
  if (cfg.review === 'auto') for (const l of b.projects.flatMap((p) => p.lessons).filter(open)) { const s = adopt(l.id, { repo, brain: b }); l.adoptedAt = s.adoptedAt; }
  const notes = writeNotes(b);
  if (flags.json) return void console.log(JSON.stringify(b, (k, v) => (k === 'tokens' ? undefined : v), 1));
  console.log(render(b));
  if (notes) console.log(`Notes: ${notes}`);
}
