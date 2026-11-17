// skillhawk ab: split sessions between two versions of one skill, compare outcomes from the logs, promote the winner.
//   skillhawk ab <skill> --a <dirA> --b <dirB> [--split 50]   start/replace an experiment (.skillyard/ab/<skill>.json)
//   skillhawk ab hook                                         SessionStart hook: assigns this session and installs its arm
//   skillhawk ab report <skill> [--logs dir]                  correction / redo rate, tokens, z-test, decision
//   skillhawk ab promote <skill> [--to dir] [--arm a|b]       copy the winner (needs a significant result unless --arm)
// Wire the hook yourself, e.g. in .claude/settings.json SessionStart: { "type": "command", "command": "npx --yes skillhawk ab hook" }.
// It reads the hook's JSON on stdin ({session_id, cwd}). Nothing is installed anywhere unless the hook runs; the skills
// folder is --skills-dir, $SKILLYARD_SKILLS_DIR, or ~/.claude/skills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSessions } from './savings.js';

export const MIN_PER_ARM = 30;
export const ALPHA = 0.05;
const abDir = (root) => path.join(path.resolve(root || '.'), '.skillyard', 'ab');
const expFile = (root, skill) => path.join(abDir(root), `${skill}.json`);
const skillsDirOf = (o) => path.resolve((o && o !== true && o) || process.env.SKILLYARD_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills'));

/** Deterministic assignment: hash of the session id (or cwd + date) -> bucket 0..99; below `split` is arm A. */
export function assign(key, split = 50) {
  const h = crypto.createHash('sha1').update(String(key)).digest().readUInt32BE(0);
  return h % 100 < split ? 'a' : 'b';
}
export const keyFor = ({ session, cwd, date }) => session || `${cwd || ''}|${date || new Date().toISOString().slice(0, 10)}`;

export function loadExp(root, skill) {
  try { return JSON.parse(fs.readFileSync(expFile(root, skill), 'utf8')); } catch { return null; }
}
const saveExp = (root, e) => { fs.mkdirSync(abDir(root), { recursive: true }); fs.writeFileSync(expFile(root, e.skill), `${JSON.stringify(e, null, 2)}\n`); };

export function startExperiment({ skill, a, b, split = 50, root = '.' }) {
  for (const [n, d] of [['a', a], ['b', b]]) if (!d || !fs.existsSync(path.join(path.resolve(d), 'SKILL.md'))) throw new Error(`--${n} must be a skill folder containing SKILL.md (got ${d})`);
  if (!(split > 0 && split < 100)) throw new Error('--split must be between 1 and 99 (percent of sessions on A)');
  const prev = loadExp(root, skill);
  const e = { skill, a: path.resolve(a), b: path.resolve(b), split, created: new Date().toISOString(), assignments: prev && prev.a === path.resolve(a) && prev.b === path.resolve(b) ? prev.assignments : [] };
  saveExp(root, e);
  return e;
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

/** SessionStart: assign every running experiment for this session and install the arm's version. */
export function hook({ session, cwd, date, root = '.', skillsDir }) {
  const dir = abDir(root);
  const done = [];
  if (!fs.existsSync(dir)) return done;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (e.promoted) continue;
    const key = keyFor({ session, cwd, date });
    const arm = assign(`${e.skill}:${key}`, e.split);
    copyDir(arm === 'a' ? e.a : e.b, path.join(skillsDir, e.skill));
    if (!e.assignments.some((x) => x.key === key)) e.assignments.push({ key, session: session || null, cwd: cwd || null, day: date || new Date().toISOString().slice(0, 10), arm, at: new Date().toISOString() });
    saveExp(root, e);
    done.push({ skill: e.skill, arm });
  }
  return done;
}

// ---- statistics -----------------------------------------------------------------------------

const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
/** Two-sided p-value of the pooled two-proportion z-test. */
export function twoProportionP(x1, n1, x2, n2) {
  if (!n1 || !n2) return 1;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = (x1 / n1 - x2 / n2) / se;
  return 1 - erf(Math.abs(z) / Math.SQRT2);
}

export async function report({ skill, root = '.', logs, days = 0, now = Date.now() }) {
  const e = loadExp(root, skill);
  if (!e) throw new Error(`no experiment for "${skill}" (start with: skillhawk ab ${skill} --a <dir> --b <dir>)`);
  const sessions = await readSessions({ logs, days, now });
  const arms = { a: [], b: [] };
  const used = new Set();
  for (const s of sessions) {
    const hit = e.assignments.find((x) => !used.has(x) && ((x.session && (x.session === s.id || s.id.startsWith(x.session))) || (!x.session && x.cwd && s.cwd === x.cwd && x.day === s.first?.slice(0, 10))));
    if (!hit) continue;
    used.add(hit);
    arms[hit.arm].push(s);
  }
  const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);
  const stat = (xs) => {
    const tasks = sum(xs, (s) => s.prompts);
    return { n: xs.length, tasks, correctedSessions: xs.filter((s) => s.corrections > 0).length, corrections: sum(xs, (s) => s.corrections), redos: sum(xs, (s) => s.redos),
      correctionRate: tasks ? sum(xs, (s) => s.corrections) / tasks : 0, redoRate: tasks ? sum(xs, (s) => s.redos) / tasks : 0,
      tokensPerSession: xs.length ? sum(xs, (s) => s.tokens) / xs.length : 0, tokensPerTask: tasks ? sum(xs, (s) => s.tokens) / tasks : 0 };
  };
  const A = stat(arms.a);
  const B = stat(arms.b);
  const p = twoProportionP(A.correctedSessions, A.n, B.correctedSessions, B.n);
  const bBetter = B.correctedSessions / (B.n || 1) < A.correctedSessions / (A.n || 1);
  const enough = A.n >= MIN_PER_ARM && B.n >= MIN_PER_ARM;
  let decision = 'keep collecting';
  let reason = enough ? 'difference is not significant' : `need at least ${MIN_PER_ARM} sessions per arm (A ${A.n}, B ${B.n})`;
  if (enough && p < ALPHA) { decision = bBetter ? 'promote B' : 'keep A'; reason = `p=${p.toFixed(4)} on sessions with a correction (${A.correctedSessions}/${A.n} vs ${B.correctedSessions}/${B.n})`; }
  else if (enough) decision = 'no winner';
  return { skill, split: e.split, assigned: e.assignments.length, matched: A.n + B.n, a: A, b: B, p, decision, reason };
}

export function renderReport(r) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const row = (n, s) => `${n}  sessions ${String(s.n).padStart(4)}  correction rate ${pct(s.correctionRate).padStart(6)}  redo rate ${pct(s.redoRate).padStart(6)}  tokens/session ${Math.round(s.tokensPerSession).toLocaleString()}  tokens/task ${Math.round(s.tokensPerTask).toLocaleString()}`;
  return [`A/B for ${r.skill}: ${r.matched} of ${r.assigned} assigned sessions found in logs (split ${r.split}/${100 - r.split})`, row('A', r.a), row('B', r.b),
    `Two-proportion z-test (sessions with a correction): p = ${r.p.toFixed(4)}`, `Decision: ${r.decision} (${r.reason})`, 'Rule: promote B only when p < 0.05 and at least 30 sessions per arm.'].join('\n');
}

export async function promote({ skill, root = '.', logs, to, arm, skillsDir }) {
  const e = loadExp(root, skill);
  if (!e) throw new Error(`no experiment for "${skill}"`);
  let winner = arm && arm !== true ? String(arm).toLowerCase() : null;
  if (!winner) {
    const r = await report({ skill, root, logs });
    if (r.decision === 'promote B') winner = 'b';
    else if (r.decision === 'keep A') winner = 'a';
    else throw new Error(`no significant winner yet (${r.decision}: ${r.reason}). Use --arm a|b to override.`);
  }
  if (!['a', 'b'].includes(winner)) throw new Error('--arm must be a or b');
  const dest = path.resolve(to && to !== true ? to : path.join(skillsDir, skill));
  copyDir(winner === 'a' ? e.a : e.b, dest);
  e.promoted = { arm: winner, to: dest, at: new Date().toISOString() };
  saveExp(root, e);
  return e.promoted;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let t = '';
  for await (const c of process.stdin) t += c;
  return t;
}

export async function run(args, flags) {
  const root = flags.root && flags.root !== true ? flags.root : '.';
  const sub = args[0];
  if (sub === 'hook') {
    let p = {};
    try { p = JSON.parse((await readStdin()) || '{}'); } catch { /* not JSON: fall back to cwd+date */ }
    const done = hook({ session: p.session_id || flags.session, cwd: p.cwd || process.cwd(), root: p.cwd && !flags.root ? p.cwd : root, skillsDir: skillsDirOf(flags['skills-dir']) });
    if (!flags.quiet) for (const d of done) console.error(`skillhawk ab: ${d.skill} -> arm ${d.arm.toUpperCase()}`);
    return done;
  }
  if (typeof flags.json === 'string') flags.json = true;
  const logs = flags.logs && flags.logs !== true ? flags.logs : undefined;
  if (sub === 'report') {
    if (!args[1]) throw new Error('usage: skillhawk ab report <skill> [--logs dir]');
    const r = await report({ skill: args[1], root, logs });
    console.log(flags.json ? JSON.stringify(r, null, 2) : renderReport(r));
    return r;
  }
  if (sub === 'promote') {
    if (!args[1]) throw new Error('usage: skillhawk ab promote <skill> [--to dir] [--arm a|b]');
    const r = await promote({ skill: args[1], root, logs, to: flags.to, arm: flags.arm, skillsDir: skillsDirOf(flags['skills-dir']) });
    console.log(`Promoted arm ${r.arm.toUpperCase()} to ${r.to}`);
    return r;
  }
  if (!sub) throw new Error('usage: skillhawk ab <skill> --a <dirA> --b <dirB> [--split 50] | ab hook | ab report <skill> | ab promote <skill>');
  const e = startExperiment({ skill: sub, a: flags.a, b: flags.b, split: flags.split === undefined ? 50 : Number(flags.split), root });
  console.log(`A/B started for ${sub}: ${e.split}% A (${e.a}), ${100 - e.split}% B (${e.b}). Recorded in ${expFile(root, sub)}.\nAdd a SessionStart hook running: skillhawk ab hook`);
  return e;
}
