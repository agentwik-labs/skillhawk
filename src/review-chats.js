// skillyard review --chats : improve EXISTING skills from what happened in your agent sessions.
//
// Usage:
//   skillyard review --chats [--yes] [--logs <dir>] [--skills <dir[,dir]>] [--data <dir>] [--exclude <path[,path]>]
//                            [--test] [--allow-model] [--json]
//   skillyard review --chats --list                  show saved proposals
//   skillyard review --chats --apply <id>            apply one proposal (backs up the old SKILL.md first)
//   skillyard review --chats --reject <id>           reject one (it will not be proposed again)
//
// What it does: finds corrections ("no, I said...", "don't...", redo requests), repeated mistakes, and skills that
// should have fired but did not (or fired and were still corrected), then attributes each to an installed skill or to
// "no skill covers this". Each skill gets one proposal: a unified diff to its SKILL.md plus short redacted chat evidence.
// Nothing is changed until you run --apply <id>. No model is called unless you pass --test (and have allowed model
// review); --test runs Studio's with/without tester on the evidence.
// Privacy: all local. Reading logs needs consent (Studio's consent file, or --yes once). Secrets, emails, tokens and
// phone numbers are redacted before anything is stored or sent to a model. Paths under --exclude, SKILLYARD_EXCLUDE
// (comma-separated) or "exclude" in ~/.skillyard/config.json are never read.
//
// Defaults: logs ~/.claude/projects, skills ~/.claude/skills + ./.claude/skills, data ~/.skillyard/studio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanSession, redact, TYPE_LABELS } from './studio/capture.js';
import { parseFrontmatter, validateFiles, readSkillDir } from './skill.js';
import { scanFiles } from './scan.js';

/** Personal exclusions: never part of the code, so private folder names stay on the user's machine. */
export function configuredExcludes() {
  const out = (process.env.SKILLYARD_EXCLUDE || '').split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.skillyard', 'config.json'), 'utf8'));
    if (Array.isArray(cfg.exclude)) out.push(...cfg.exclude.filter((x) => typeof x === 'string' && x));
  } catch { /* no config */ }
  return out;
}
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const list = (v) => (v == null || v === true ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));
const expand = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

// ---- consent (same state.json shape as Studio, so one grant covers both) ----------------------

function statePath(data) { return path.join(data, 'state.json'); }
function loadState(data) {
  try { return JSON.parse(fs.readFileSync(statePath(data), 'utf8')); } catch { return { version: 1, consent: {}, log: [] }; }
}
function saveState(data, s) {
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath(data), JSON.stringify(s, null, 1), { mode: 0o600 });
}
export function grant(data, which, detail) {
  const s = loadState(data);
  s.consent = s.consent || {};
  s.consent[which] = { ...(s.consent[which] || {}), granted: true, at: new Date().toISOString() };
  s.log = [{ at: new Date().toISOString(), action: which === 'readLogs' ? 'Allowed reading agent logs (review --chats)' : 'Allowed model review of redacted excerpts (review --chats)', detail }, ...(s.log || [])].slice(0, 300);
  saveState(data, s);
}
export const hasConsent = (data, which) => !!loadState(data).consent?.[which]?.granted;

// ---- exclusions -------------------------------------------------------------------------------

export function excluder(extra = []) {
  const subs = configuredExcludes().map((x) => x.toLowerCase());
  const abs = extra.map(expand);
  return (p) => {
    const full = path.resolve(p);
    const low = full.toLowerCase();
    // Claude Code stores a project's logs in a folder whose name encodes the path with dashes: "-Users-me-private".
    if (subs.some((s) => low.includes(s) || low.includes(s.replace(/\//g, '-')))) return true;
    return abs.some((a) => full === a || full.startsWith(a + path.sep));
  };
}

function sessionFiles(root, excluded) {
  const out = [];
  const walk = (d, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 5 && e.name !== 'subagents' && !/skillyard-(?:eval|llm|draft)/.test(e.name)) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

// The session's working folder is only known inside the file. Peek at the head so an excluded folder is never parsed.
function peekCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    return m ? m[1].replace(/\\\//g, '/') : null;
  } catch { return null; }
}

// ---- skills -----------------------------------------------------------------------------------

export function loadSkills(dirs) {
  const out = [];
  const seen = new Set();
  for (const root of dirs) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const dir = path.join(root, e.name);
      const md = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(md) || !fs.statSync(dir).isDirectory()) continue;
      const text = fs.readFileSync(md, 'utf8');
      const { data } = parseFrontmatter(text);
      const name = data?.name || e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: data?.description || '', dir, md });
    }
  }
  return out;
}

const STOP = new Set('this that with from have your when what then than they them were will would should could about into just also only some more most make made does done need want like such each other these those there here over under after before while which where being been using used use user users please skill agent'.split(' '));
const toks = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')));

export function matchScore(skill, text) {
  const t = toks(text);
  const nameT = toks(skill.name);
  const descT = toks(skill.description);
  let score = 0;
  for (const w of t) { if (nameT.has(w)) score += 2; else if (descT.has(w)) score += 1; }
  return score;
}
const THRESHOLD = 3;

/** Attribute a correction to a skill: one that was loaded in that session, one that should have been, or none. */
export function attribute(c, skills) {
  const byName = (n) => skills.find((s) => s.name === n || s.name === n.split(':').pop());
  const loaded = (c.skills || []).map(byName).filter(Boolean);
  const text = `${c.asked} ${c.said}`;
  if (loaded.length) {
    const best = loaded.map((s) => [s, matchScore(s, text)]).sort((a, b) => b[1] - a[1])[0][0];
    return { skill: best, how: 'fired' };
  }
  const ranked = skills.map((s) => [s, matchScore(s, text)]).sort((a, b) => b[1] - a[1]);
  if (ranked[0] && ranked[0][1] >= THRESHOLD) return { skill: ranked[0][0], how: 'missed-fire' };
  return { skill: null, how: 'none' };
}

// ---- diff -------------------------------------------------------------------------------------

function lcsOps(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0; let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]); else ops.push(['+', b[j++]]);
  }
  while (i < m) ops.push(['-', a[i++]]);
  while (j < n) ops.push(['+', b[j++]]);
  return ops;
}

/** Unified diff of two texts (3 lines of context). */
export function unifiedDiff(before, after, label) {
  const ops = lcsOps(before.split('\n'), after.split('\n'));
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o[0] !== ' ') for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) keep[k] = true; });
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let a = 0; let b = 0; let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { if (ops[i][0] !== '+') a++; if (ops[i][0] !== '-') b++; i++; continue; }
    let j = i; let la = 0; let lb = 0;
    const body = [];
    while (j < ops.length && keep[j]) { body.push(ops[j][0] + ops[j][1]); if (ops[j][0] !== '+') la++; if (ops[j][0] !== '-') lb++; j++; }
    out.push(`@@ -${a + 1},${la} +${b + 1},${lb} @@`, ...body);
    a += la; b += lb; i = j;
  }
  return out.join('\n') + '\n';
}

// ---- proposals --------------------------------------------------------------------------------

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s).replace(/\s+/g, ' ');

/** Rule-based edit (no model): add the lessons to SKILL.md, and trigger phrases to the description if the skill missed. */
export function draftEdit(text, items, missed) {
  let after = text;
  const lessons = [];
  const phrases = [];
  for (const c of items) {
    const line = `- ${TYPE_LABELS[c.type] || c.type}: ${clip(c.said, 160)}`;
    if (!after.includes(line)) lessons.push(line);
    if (missed.includes(c.id) && c.asked) phrases.push(clip(c.asked, 70));
  }
  const uniq = (xs) => [...new Set(xs)];
  if (phrases.length) {
    const m = /^(description:[ \t]*)([^"'>|\n][^\n]*)$/m.exec(after);
    const extra = ` Also use when the user asks things like: ${uniq(phrases).slice(0, 3).map((p) => `"${p.replace(/"/g, "'")}"`).join(', ')}.`;
    if (m && !after.includes(extra.trim())) after = after.replace(m[0], `${m[1]}${m[2].trimEnd()}${extra}`);
    else lessons.push(`- Use this skill for requests like: ${uniq(phrases).slice(0, 3).join('; ')}`);
  }
  if (lessons.length) {
    const head = '## Lessons from your sessions';
    if (after.includes(head)) after = after.replace(head, `${head}\n${uniq(lessons).join('\n')}`);
    else after = `${after.replace(/\s*$/, '')}\n\n${head}\n\nYou corrected the agent on these. Follow them.\n\n${uniq(lessons).join('\n')}\n`;
  }
  return after;
}

const evidenceOf = (c) => ({ id: c.id, type: c.type, project: c.project, session: c.session, how: c.how, asked: clip(redact(c.asked), 160), said: clip(redact(c.said), 200) });

export function buildProposals(corrections, skills) {
  const groups = new Map();
  for (const c of corrections) {
    const a = attribute(c, skills);
    const key = a.skill ? a.skill.name : '';
    if (!groups.has(key)) groups.set(key, { skill: a.skill, items: [] });
    groups.get(key).items.push({ ...c, how: a.how });
  }
  const out = [];
  for (const { skill, items } of groups.values()) {
    const types = new Map();
    for (const c of items) types.set(c.type, (types.get(c.type) || 0) + 1);
    const repeated = [...types.values()].some((n) => n >= 2) || new Set(items.map((c) => c.session)).size >= 2;
    const id = sha(`${skill ? skill.name : 'none'}:${items.map((c) => c.id).sort().join(',')}`).slice(0, 8);
    const base = { id, status: 'pending', created: new Date().toISOString(), count: items.length, repeated, evidence: items.slice(0, 6).map(evidenceOf) };
    if (!skill) { out.push({ ...base, skill: null, kind: 'no-skill', note: 'No installed skill covers these. Run `skillyard studio` to draft a new one.' }); continue; }
    const before = fs.readFileSync(skill.md, 'utf8');
    const missed = items.filter((c) => c.how === 'missed-fire').map((c) => c.id);
    const after = draftEdit(before, items, missed);
    const rel = `${skill.name}/SKILL.md`;
    out.push({
      ...base, skill: skill.name, skillPath: skill.md, kind: missed.length && missed.length === items.length ? 'missed-fire' : missed.length ? 'mixed' : 'fired-wrongly',
      beforeSha: sha(before), after, diff: before === after ? '' : unifiedDiff(before, after, rel), test: null,
    });
  }
  return out;
}

// ---- storage ----------------------------------------------------------------------------------

const storeFile = (data) => path.join(data, 'chat-proposals.json');
export function loadProposals(data) { try { return JSON.parse(fs.readFileSync(storeFile(data), 'utf8')).proposals || []; } catch { return []; } }
export function saveProposals(data, proposals) {
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(storeFile(data), JSON.stringify({ version: 1, proposals }, null, 1), { mode: 0o600 });
}

/** The only code path that changes a skill. Refuses if the file changed since the proposal was made. */
export function applyProposal(data, id) {
  const all = loadProposals(data);
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error(`no proposal ${id}`);
  if (p.status !== 'pending') throw new Error(`proposal ${id} is ${p.status}`);
  if (!p.skillPath || !p.after || !p.diff) throw new Error(`proposal ${id} has no edit to apply${p.note ? `: ${p.note}` : ''}`);
  const current = fs.readFileSync(p.skillPath, 'utf8');
  if (sha(current) !== p.beforeSha) throw new Error(`${p.skillPath} changed since this proposal was made; run the review again`);
  const files = { ...readSkillDir(path.dirname(p.skillPath)), 'SKILL.md': Buffer.from(p.after) };
  const v = validateFiles(files);
  const sc = scanFiles(files);
  if (!v.ok || sc.critical) throw new Error(`edited skill failed checks: ${[...v.errors, ...sc.findings.filter((f) => f.severity === 'critical').map((f) => f.message)].join('; ')}`);
  const backup = path.join(data, 'backups', `${p.skill}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'SKILL.md'), current);
  fs.writeFileSync(p.skillPath, p.after);
  Object.assign(p, { status: 'applied', decidedAt: new Date().toISOString(), backup });
  saveProposals(data, all);
  return p;
}
export function rejectProposal(data, id, reason = '') {
  const all = loadProposals(data);
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error(`no proposal ${id}`);
  if (p.status !== 'pending') throw new Error(`proposal ${id} is ${p.status}`);
  Object.assign(p, { status: 'rejected', decidedAt: new Date().toISOString(), reason });
  saveProposals(data, all);
  return p;
}

// ---- before/after test (model calls; only with --test) ----------------------------------------

export async function testProposal(p) {
  const { evalSkill } = await import('./eval.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-chats-'));
  try {
    const cur = path.join(tmp, 'current', p.skill);
    const nxt = path.join(tmp, 'proposed', p.skill);
    fs.cpSync(path.dirname(p.skillPath), cur, { recursive: true });
    fs.cpSync(path.dirname(p.skillPath), nxt, { recursive: true });
    fs.writeFileSync(path.join(nxt, 'SKILL.md'), p.after);
    const cases = p.evidence.filter((e) => e.asked).slice(0, 3).map((e, i) => ({
      name: `chat-${i + 1}`, prompt: `${e.asked}\n\nAnswer directly, don't ask me questions.`,
      checks: [{ type: 'judge', value: `The answer avoids the problem the developer complained about: "${e.said}"` }],
    }));
    if (!cases.length) return { skipped: 'no usable excerpts' };
    const r = await evalSkill(nxt, { baselineDir: cur, cases });
    return { before: r.baseline, after: r.withSkill, lift: r.lift, cases: cases.length };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---- main -------------------------------------------------------------------------------------

function show(p, out) {
  const tag = p.skill ? `${p.skill}  ${p.kind}` : 'no skill covers this';
  out(`[${p.id}] ${tag}  ${p.count} correction${p.count === 1 ? '' : 's'}${p.repeated ? ' (repeated)' : ''}  ${p.status}`);
  for (const e of p.evidence.slice(0, 3)) out(`    evidence (${e.type}): "${e.said}"`);
  if (p.note) out(`    ${p.note}`);
  if (p.diff) out(p.diff.split('\n').map((l) => `    ${l}`).join('\n').trimEnd());
  if (p.test) out(`    test: before ${p.test.before == null ? '?' : Math.round(p.test.before * 100)}% -> after ${p.test.after == null ? '?' : Math.round(p.test.after * 100)}%${p.test.skipped ? ` (skipped: ${p.test.skipped})` : ''}${p.test.error ? ` (failed: ${p.test.error})` : ''}`);
}

export async function run(args = [], flags = {}) {
  const out = flags.json ? () => {} : (s) => console.log(s);
  const data = expand(flags.data || path.join(os.homedir(), '.skillyard', 'studio'));

  if (flags.apply || flags.reject) {
    const id = String(flags.apply === true || flags.reject === true ? args[0] : flags.apply || flags.reject);
    const p = flags.apply ? applyProposal(data, id) : rejectProposal(data, id, flags.reason || '');
    out(flags.apply ? `Applied ${id} to ${p.skillPath}. Previous version saved in ${p.backup}` : `Rejected ${id}. It will not be proposed again.`);
    return p;
  }
  if (flags.list) {
    const all = loadProposals(data);
    all.forEach((p) => show(p, out));
    if (!all.length) out('No saved proposals.');
    return all;
  }

  if (!hasConsent(data, 'readLogs')) {
    if (flags.yes) grant(data, 'readLogs', 'Claude Code sessions, read locally');
    else {
      out('Reading your agent session logs needs your consent. Everything stays on this machine; secrets, emails and phone numbers are redacted.');
      out('Re-run with --yes to allow it (or allow it in Skillyard Studio).');
      return { needsConsent: true, proposals: [] };
    }
  }
  if (flags.test && !hasConsent(data, 'modelReview')) {
    if (flags['allow-model']) grant(data, 'modelReview', 'redacted excerpts, review --chats --test');
    else {
      out('--test sends redacted excerpts to a model. Re-run with --allow-model to allow it, or drop --test.');
      return { needsConsent: true, proposals: [] };
    }
  }

  const logs = expand(flags.logs || path.join(os.homedir(), '.claude', 'projects'));
  const skillDirs = (list(flags.skills).length ? list(flags.skills) : [path.join(os.homedir(), '.claude', 'skills'), path.join(process.cwd(), '.claude', 'skills')]).map(expand);
  const excluded = excluder(list(flags.exclude));
  const skills = loadSkills(skillDirs);
  if (!skills.length) out('No installed skills found; every problem will be reported as uncovered.');

  const files = sessionFiles(logs, excluded);
  let skipped = 0;
  const corrections = [];
  for (const f of files) {
    if (excluded(f)) { skipped++; continue; }
    const cwd = peekCwd(f);
    if (cwd && excluded(cwd)) { skipped++; continue; }
    const r = await scanSession(f, 'claude');
    if (r.cwd && excluded(r.cwd)) { skipped++; continue; }
    corrections.push(...r.corrections);
  }
  out(`Read ${files.length - skipped} session${files.length - skipped === 1 ? '' : 's'} (${skipped} excluded), found ${corrections.length} correction${corrections.length === 1 ? '' : 's'}.`);

  const saved = loadProposals(data);
  const fresh = buildProposals(corrections, skills).filter((p) => !saved.some((s) => s.id === p.id));
  if (flags.test) {
    for (const p of fresh.filter((x) => x.diff)) {
      try { p.test = await testProposal(p); } catch (e) { p.test = { error: e.message }; }
    }
  }
  saveProposals(data, [...fresh, ...saved]);
  const pending = [...fresh, ...saved.filter((s) => s.status === 'pending' && !fresh.includes(s))];
  pending.forEach((p) => show(p, out));
  if (!pending.length) out('Nothing to propose.');
  else out(`\nNothing is changed yet. Apply with: skillyard review --chats --apply <id>   Reject with: --reject <id>`);
  const result = { read: files.length - skipped, excluded: skipped, corrections: corrections.length, proposals: pending };
  if (flags.json) console.log(JSON.stringify(result, null, 1));
  return result;
}
