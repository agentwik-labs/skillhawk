// What goes into the brain, what it keeps and where it writes are the user's choices, not ours. `skillhawk brain init`
// asks them (or an agent asks them, from `brain init --questions --json`) and saves the answers. Nothing here picks a
// structure for the user; the defaults are only used when the user says "use the defaults" (--yes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const brainHome = () => path.join(process.env.SKILLHAWK_HOME || path.join(os.homedir(), '.skillhawk'), 'brain');
const tilde = (p) => String(p).trim().replace(/^~(?=$|\/)/, os.homedir());

const o = (value, label) => ({ value, label });
export const QUESTIONS = [
  { id: 'sources', multi: true, question: 'What should go into your brain? Pick any.', options: [
    o('sessions', 'Your agent sessions on this machine (Claude Code, Codex)'),
    o('repo-docs', "This repo's docs (README, docs/, ADRs, any .md)"),
    o('git', 'Git history (commit messages)'),
    o('folders', 'Folders you choose: notes, an Obsidian vault, meeting notes, transcripts, specs, research'),
  ], default: ['sessions'] },
  { id: 'folders', text: true, when: (a) => a.sources.includes('folders'), question: 'Which folders or files? Comma-separated paths.', default: '' },
  { id: 'exts', question: 'Which file types should it read from those?', options: [
    o('.md .txt', 'Markdown and plain text (.md .txt)'),
    o('.md .txt .rst .org .adoc .csv .json', 'Most text formats (.md .txt .rst .org .adoc .csv .json)'),
    o('*', 'Every text file (binary files are skipped)'),
  ], free: 'or type extensions, e.g. ".md .vtt .srt"', when: (a) => a.sources.some((s) => s !== 'sessions' && s !== 'git') },
  { id: 'exclude', text: true, question: 'Anything it must never read? Comma-separated paths or folder names (Enter for none). Secret files (.env, keys) are always skipped.', default: '' },
  { id: 'keep', multi: true, question: 'What should it pull out for you? Pick any; everything stays searchable either way.', options: [
    o('correction', 'Corrections you keep repeating to agents (sessions only)'),
    o('decision', 'Decisions ("we decided", "from now on", accepted ADRs)'),
    o('preference', 'Preferences ("I prefer", "please never")'),
    o('question', 'Open questions and to-dos'),
    o('definition', 'Definitions and glossary terms'),
    o('fact', 'Facts and reference: numbers, links, commands'),
    o('none', 'Nothing: just make it searchable'),
  ], default: ['correction', 'decision'] },
  { id: 'repeat', when: (a) => a.keep.includes('correction'), question: 'When does a repeated correction become a suggestion?', options: [
    o('2/2', 'After 2 times in 2 different sessions'),
    o('3/3', 'After 3 times in 3 different sessions'),
    o('1/1', 'Every time, no threshold'),
  ], free: 'or type "times/sessions", e.g. 4/2' },
  { id: 'review', question: 'What happens to what it finds?', options: [
    o('approve', 'Show me; nothing is written until I approve each one'),
    o('auto', 'Write it to my rules file automatically'),
    o('never', 'Never write rules; notes and search only'),
  ] },
  { id: 'destination', when: (a) => a.review !== 'never', question: 'Where do approved items go?', options: [
    o('AGENTS.md', 'AGENTS.md in the repo (Codex, Cursor, Copilot, Gemini read it; CLAUDE.md imports it)'),
    o('CLAUDE.md', 'CLAUDE.md only'),
    o('.skillhawk/brain-rules.md', 'A separate file in the repo: .skillhawk/brain-rules.md'),
  ], free: 'or type a path inside the repo' },
  { id: 'notes', question: 'Where should the brain keep its notes (readable markdown of everything it kept)?', options: [
    o('default', `In ${path.join('~', '.skillhawk', 'brain')}`),
    o('none', 'No notes file'),
  ], free: 'or type a folder, e.g. your Obsidian vault' },
  { id: 'format', when: (a) => a.notes !== 'none', question: 'Notes format?', options: [o('md', 'Markdown'), o('json', 'JSON'), o('both', 'Both')] },
  { id: 'measure', when: (a) => a.keep.includes('correction') && a.review !== 'never', question: 'Measure whether each approved rule stuck (same correction before vs after)?', options: [o('yes', 'Yes'), o('no', 'No')] },
  { id: 'agents', question: 'Can your agents search the brain (MCP tool brain_search)?', options: [o('yes', 'Yes, read-only'), o('no', 'No, only me from the CLI')] },
  { id: 'scope', question: 'Is this brain for this repo or for everything you work on?', options: [
    o('repo', 'This repo only (saved in .skillhawk/brain.json)'),
    o('all', `All my projects (saved in ${path.join('~', '.skillhawk', 'brain', 'config.json')})`),
  ] },
];

const defaultOf = (q) => (q.default !== undefined ? q.default : q.options[0].value);

/** Turn one raw answer (numbers, values or free text) into the stored value for a question. */
export function parseAnswer(q, raw) {
  if (raw == null || raw === '') return defaultOf(q);
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) raw = raw.value;
  if (Array.isArray(raw)) raw = raw.map((x) => (x && typeof x === 'object' && 'value' in x ? x.value : x));
  if (q.text) return String(raw).trim();
  const pick = (x) => { const s = String(x).trim(); const n = Number(s); if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1].value; const m = q.options.find((op) => op.value === s || op.label.toLowerCase() === s.toLowerCase()); return m ? m.value : s; };
  if (q.multi) { const xs = (Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/)).filter((x) => String(x).trim()).map(pick).filter((v) => q.options.some((op) => op.value === v)); return xs.length ? [...new Set(xs)] : defaultOf(q); }
  return pick(Array.isArray(raw) ? raw[0] : raw);
}

/** Walk the questions in order; `ask(q)` returns a raw answer (or undefined for the default). */
export async function interview(ask, given = {}) {
  const a = {};
  for (const q of QUESTIONS) {
    if (q.when && !q.when(a)) continue;
    a[q.id] = parseAnswer(q, given[q.id] !== undefined ? given[q.id] : await ask(q));
  }
  return a;
}

/** Answers -> the config the brain runs on. */
export function toConfig(a, repo) {
  const keep = (a.keep || []).filter((k) => k !== 'none');
  const [times, sessions] = String(a.repeat || '2/2').split('/').map((n) => Math.max(1, Number(n) || 1));
  const notes = !a.notes || a.notes === 'default' ? brainHome() : a.notes === 'none' ? null : path.resolve(tilde(a.notes));
  return {
    version: 1, answers: a, repo: repo ? path.resolve(repo) : null,
    sources: a.sources || ['sessions'],
    folders: String(a.folders || '').split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(tilde(p))),
    exts: !a.exts ? ['.md', '.txt'] : a.exts === '*' ? ['*'] : String(a.exts).split(/[\s,]+/).filter(Boolean).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()),
    exclude: String(a.exclude || '').split(',').map((s) => s.trim()).filter(Boolean),
    keep, minTimes: times || 2, minSessions: sessions || 2,
    review: a.review || 'approve', destination: a.review === 'never' ? null : (a.destination || 'AGENTS.md'),
    notes, format: a.format || 'md', measure: a.measure !== 'no', agents: a.agents !== 'no', scope: a.scope || 'repo',
    at: new Date().toISOString(),
  };
}

/** The behaviour before brain init existed: sessions only, corrections and decisions, 2 in 2, approve, AGENTS.md. */
export const LEGACY = (repo) => toConfig({ sources: ['sessions'], keep: ['correction', 'decision'], repeat: '2/2', review: 'approve', destination: 'AGENTS.md', notes: 'default', format: 'md', measure: 'yes', agents: 'yes', scope: 'repo' }, repo);

const repoFile = (repo) => path.join(path.resolve(repo), '.skillhawk', 'brain.json');
const globalFile = () => path.join(brainHome(), 'config.json');
export function loadConfig(repo = '.') {
  for (const f of [repoFile(repo), globalFile()]) { try { return { ...JSON.parse(fs.readFileSync(f, 'utf8')), file: f }; } catch { /* next */ } }
  return null;
}
export function saveConfig(cfg, repo = '.') {
  const f = cfg.scope === 'all' ? globalFile() : repoFile(repo);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const { file, ...rest } = cfg;
  fs.writeFileSync(f, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
  return f;
}

/** One paragraph, in the user's terms, of what the brain will do with these answers. */
export function describe(c) {
  const src = c.sources.map((s) => ({ sessions: 'agent sessions', 'repo-docs': "this repo's docs", git: 'git history', folders: `${c.folders.length} folder${c.folders.length === 1 ? '' : 's'} (${c.folders.map((f) => f.replace(os.homedir(), '~')).join(', ') || 'none given'})` }[s] || s));
  const kinds = c.keep.length ? c.keep.map((k) => (QUESTIONS.find((q) => q.id === 'keep').options.find((x) => x.value === k)?.label || k).split(' (')[0].toLowerCase()).join(', ') : 'nothing (search only)';
  return [
    `Reads: ${src.join(', ')}${c.exclude.length ? `; never: ${c.exclude.join(', ')}` : ''}.`,
    `Pulls out: ${kinds}${c.keep.includes('correction') ? ` (a correction counts after ${c.minTimes} in ${c.minSessions} sessions)` : ''}.`,
    c.review === 'never' ? 'Writes no rules.' : `${c.review === 'auto' ? 'Writes automatically' : 'Writes only what you approve'} to ${c.destination}.`,
    `Notes: ${c.notes ? `${c.notes.replace(os.homedir(), '~')} (${c.format})` : 'none'}. Agents can search it: ${c.agents ? 'yes' : 'no'}.`,
  ].join('\n');
}
