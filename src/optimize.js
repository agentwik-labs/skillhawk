// skillhawk optimize: cut a skill's tokens without losing meaning, and keep only candidates that are not worse.
// Static pass (always, no model): deterministic text cuts. Model pass (--allow-model): shorter rewrites scored by lift.
// A candidate is kept only if the review grade/score hold, the trigger cases (tests/cases.yaml) still pass,
// code blocks and frontmatter survive, and tokens drop.
import fs from 'node:fs';
import path from 'node:path';
import { readSkillDir, validateFiles } from './skill.js';
import { estimateTokens, findSkillDirs, reviewFiles, locateFrontmatter, fencedSet, instructionLines, nearDuplicate } from './review.js';
import { staticTest, loadCases, behaviourToEvalCases } from './devloop.js';

const GRADES = 'ABCDF';
export const DEFAULT_OUT = path.join('.skillyard', 'optimized');

// ---- line classification ------------------------------------------------------

function protectedLines(lines) {
  const fm = locateFrontmatter(lines.join('\n'));
  const fenced = fencedSet(lines);
  const fmEnd = fm.endLine >= 0 ? fm.endLine : -1;
  return lines.map((l, i) => i <= fmEnd || fenced.has(i) || /^\s*#{1,6}\s/.test(l) || /^\s*\|/.test(l) || /^( {4}|\t)/.test(l));
}

/** Apply fn to the text outside `inline code` spans. */
const outsideCode = (line, fn) => line.split(/(`[^`]*`)/).map((seg, i) => (i % 2 ? seg : fn(seg))).join('');

// ---- static transforms: (lines) => lines --------------------------------------

export function tidyWhitespace(lines) {
  const prot = protectedLines(lines);
  const out = [];
  let blank = 0;
  lines.forEach((l, i) => {
    const line = prot[i] ? l : l.replace(/[ \t]+$/, '').replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ');
    if (!prot[i] && !line.trim()) { if (++blank > 1) return; } else blank = 0;
    out.push(line);
  });
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return [...out, ''];
}

export function dropBoilerplate(lines) {
  const prot = protectedLines(lines);
  return lines.filter((l, i) => prot[i] || !(/^\s*<!--.*-->\s*$/.test(l) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)));
}

const FILLER_SENTENCE = /(^|(?<=[.!?]\s))(?:please\s+)?(?:be thorough|be careful|use (?:good|your best|sound|common) (?:judge?ment|sense)|(?:follow|use|apply) (?:industry )?best practices?|keep it (?:simple|clean|short)|make it (?:better|nice|good|clean|professional))\.?\s*/gi;
const FILLER_PHRASES = [
  /,?\s+as (?:appropriate|needed|necessary|required)(?=[\s.,;:)]|$)/gi,
  /,?\s+(?:if|where) (?:possible|appropriate|applicable)(?=[\s.,;:)]|$)/gi,
  /,?\s+when (?:necessary|appropriate|relevant)(?=[\s.,;:)]|$)/gi,
];
const FILLER_WORDS = /\b(?:please|basically|simply|really|actually|essentially|you (?:might|may) want to|(?:try|trying) to|try and)\s+/gi;

function stripFiller(seg) {
  let s = seg.replace(FILLER_SENTENCE, '');
  for (const re of FILLER_PHRASES) s = s.replace(re, '');
  s = s.replace(FILLER_WORDS, (m, off, str) => {
    const before = str.slice(0, off);
    return /(^|[.!?]\s+|^\s*(?:[-*+]|\d+[.)])\s+)$/.test(before) ? '\u0001' : '';
  });
  s = s.replace(/\u0001([a-z])/g, (_, c) => c.toUpperCase()).replace(/\u0001/g, '');
  s = s.replace(/,?\s+(?:etc|and so on|and more)\b\.?/gi, (m, off, str) => (m.endsWith('.') && !str.slice(off + m.length).trim() ? '.' : ''));
  return s;
}

export function dropFiller(lines) {
  const prot = protectedLines(lines);
  const out = [];
  lines.forEach((l, i) => {
    if (prot[i]) { out.push(l); return; }
    const n = outsideCode(l, stripFiller);
    // a bullet or paragraph that held only filler disappears; never leave an empty bullet behind
    if (n !== l && !n.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim()) return;
    out.push(n);
  });
  return out;
}

export function dropDuplicates(lines) {
  const prot = protectedLines(lines);
  const ins = instructionLines(lines, fencedSet(lines), locateFrontmatter(lines.join('\n')).endLine + 1);
  const byLine = new Map();
  for (const x of ins) byLine.set(x.line, [...(byLine.get(x.line) || []), x]);
  const kept = [];
  const drop = new Set();
  for (const [line, xs] of [...byLine].sort((a, b) => a[0] - b[0])) {
    if (xs.length !== 1 || prot[line - 1] || !/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[line - 1])) { kept.push(...xs); continue; }
    if (kept.some((k) => k.line !== line && nearDuplicate(k, xs[0]))) drop.add(line - 1);
    else kept.push(...xs);
  }
  return lines.filter((_, i) => !drop.has(i));
}

export function shortenBloat(lines) {
  const text = lines.join('\n');
  const prot = protectedLines(lines);
  const heads = lines.map((l, i) => (/^#{1,6}\s/.test(l) && !prot.slice(0, i).length ? -1 : (/^#{1,6}\s/.test(l) && !fencedSet(lines).has(i) ? i : -1))).filter((i) => i >= 0);
  const long = new Set();
  heads.forEach((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
    if (end - h > 120 || estimateTokens(lines.slice(h, end).join('\n')) > 1500) for (let i = h; i < end; i++) long.add(i);
  });
  const whole = estimateTokens(text) > 3000;
  return lines.map((l, i) => (prot[i] || !(whole || long.has(i)) ? l : outsideCode(l, (s) => s.replace(/\*\*([^*\n]+)\*\*/g, '$1'))));
}

export const STAGES = [
  ['trim whitespace', tidyWhitespace], ['drop rules and comments', dropBoilerplate], ['remove filler and hedging', dropFiller],
  ['collapse repeated rules', dropDuplicates], ['shorten bloated sections', shortenBloat],
];

// ---- vetting -------------------------------------------------------------------

const fencedBlocks = (text) => { const l = text.split('\n'); const f = fencedSet(l); return l.filter((_, i) => f.has(i)).join('\n'); };
const frontLines = (text) => { const l = text.split('\n'); const fm = locateFrontmatter(text); return fm.endLine >= 0 ? l.slice(0, fm.endLine + 1).join('\n') : ''; };
const skillText = (files) => files['SKILL.md'].toString('utf8');

export function measure(files, dir) {
  const rv = reviewFiles(files, dir);
  const st = staticTest(dir, { files });
  const key = (r) => `${r.kind}|${r.prompt}`;
  return { review: rv, tokens: estimateTokens(skillText(files)), trigger: { pass: st.pass, fail: st.fail, errors: st.errors.length, hasCases: st.hasCases, passing: new Set(st.results.filter((r) => r.ok).map(key)), key } };
}

/** Is `files` an acceptable replacement for the original? Returns { ok, reason, m } (m = measurements of the candidate). */
export function vet(dir, base, files, { requireFewerTokens = true, keepFrontmatter = true } = {}) {
  const v = validateFiles(files);
  if (!v.ok) return { ok: false, reason: `invalid skill: ${v.errors[0]}` };
  const before = skillText(base.files);
  const after = skillText(files);
  if (fencedBlocks(before) !== fencedBlocks(after)) return { ok: false, reason: 'changed or dropped a code block' };
  if (keepFrontmatter && frontLines(before) !== frontLines(after)) return { ok: false, reason: 'changed the frontmatter' };
  if (v.manifest.name !== base.manifest.name) return { ok: false, reason: 'changed the skill name' };
  const m = measure(files, dir);
  if (requireFewerTokens && m.tokens >= base.m.tokens) return { ok: false, reason: 'no token saving', m };
  if (GRADES.indexOf(m.review.grade) > GRADES.indexOf(base.m.review.grade) || m.review.score < base.m.review.score) return { ok: false, reason: `review ${base.m.review.grade} -> ${m.review.grade}`, m };
  if (m.trigger.errors > base.m.trigger.errors) return { ok: false, reason: 'trigger cases no longer load', m };
  const broke = [...base.m.trigger.passing].filter((k) => !m.trigger.passing.has(k));
  if (broke.length || m.trigger.fail > base.m.trigger.fail) return { ok: false, reason: `breaks ${broke.length || m.trigger.fail - base.m.trigger.fail} trigger case(s): ${broke[0]?.split('|')[1] ?? ''}`.trim(), m };
  return { ok: true, reason: '', m };
}

const withSkillMd = (files, text) => ({ ...files, 'SKILL.md': Buffer.from(text) });

// ---- passes --------------------------------------------------------------------

export function staticPass(dir, base) {
  let best = base;
  const steps = [];
  for (const [label, fn] of STAGES) {
    const text = skillText(best.files);
    const next = fn(text.split('\n')).join('\n');
    if (next === text) continue;
    const cand = withSkillMd(best.files, next);
    const r = vet(dir, base, cand);
    if (r.ok) {
      steps.push({ label, saved: best.m.tokens - r.m.tokens, accepted: true });
      best = { ...base, files: cand, m: r.m };
    } else steps.push({ label, accepted: false, reason: r.reason });
  }
  return { best, steps };
}

const REWRITE_PROMPT = (text) => [
  'Rewrite this agent skill (SKILL.md) to be shorter while keeping exactly the same behaviour.',
  'Keep every rule, every code block and command verbatim, and the frontmatter name and description unchanged.',
  'Cut filler, repetition, hedging and explanation the model already knows. Do not add anything new.',
  'Reply with only the full new SKILL.md, no commentary and no wrapping code fence.',
  '<<<', text, '>>>',
].join('\n');

const unwrap = (s) => { const m = /^```(?:markdown|md)?\n([\s\S]*)\n```\s*$/.exec(s.trim()); return `${(m ? m[1] : s).trimEnd()}\n`; };

function evalCasesFor(dir) {
  const loaded = loadCases(dir);
  const fromCases = loaded ? behaviourToEvalCases(loaded.cases) : [];
  if (fromCases.length) return fromCases;
  return null; // evalSkill falls back to evals/evals.json
}

export async function modelPass(dir, start, { rounds = 3, model = 'haiku', rewrite, evalFn, log = () => {} } = {}) {
  if (!rewrite) { const { ask } = await import('./studio/llm.js'); rewrite = (text) => ask(REWRITE_PROMPT(text), { model }); }
  if (!evalFn) { const { evalSkill } = await import('./eval.js'); evalFn = evalSkill; }
  const cases = evalCasesFor(dir);
  const evalOpts = { agent: 'claude', model, ...(cases ? { cases } : {}), log };
  const orig = await evalFn(dir, { ...evalOpts, conditions: ['without', 'with'] });
  const origLift = orig.lift;
  let best = start;
  let bestLift = origLift;
  const tries = [];
  for (let round = 1; round <= rounds; round++) {
    const text = unwrap(await rewrite(skillText(best.files), { round, model }));
    const cand = withSkillMd(best.files, text);
    const r = vet(dir, start, cand, { keepFrontmatter: !start.m.trigger.hasCases });
    if (!r.ok || r.m.tokens >= best.m.tokens) { tries.push({ round, accepted: false, reason: r.ok ? 'no token saving' : r.reason }); continue; }
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'skillyard-opt-'));
    const cdir = path.join(tmp, path.basename(path.resolve(dir)));
    try {
      writeFiles(cdir, cand);
      const rep = await evalFn(cdir, { ...evalOpts, conditions: ['with'] });
      const lift = rep.withSkill - orig.baseline;
      if (lift >= origLift - 1e-9) { best = { ...start, files: cand, m: r.m }; bestLift = lift; tries.push({ round, accepted: true, lift, saved: start.m.tokens - r.m.tokens }); }
      else tries.push({ round, accepted: false, reason: `lift ${fmtPct(origLift)} -> ${fmtPct(lift)}` });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { best, origLift, bestLift, tries };
}

// ---- output --------------------------------------------------------------------

const fmtPct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)} pts`;

function writeFiles(dir, files) {
  for (const [rel, buf] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
}

/** Unified diff of two texts (line LCS, 3 lines of context). */
export function unifiedDiff(a, b, nameA = 'a/SKILL.md', nameB = 'b/SKILL.md') {
  const x = a.split('\n'); const y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0; let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push([' ', x[i]]); i++; j++; } else if (j < y.length && (i >= x.length || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['+', y[j]]); j++; } else { ops.push(['-', x[i]]); i++; }
  }
  if (!ops.some((o) => o[0] !== ' ')) return '';
  const out = [`--- ${nameA}`, `+++ ${nameB}`];
  const C = 3;
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k][0] === ' ') k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - C);
    let end = k; let lastChange = k;
    while (end < ops.length && end - lastChange <= C * 2) { if (ops[end][0] !== ' ') lastChange = end; end++; }
    end = Math.min(ops.length, lastChange + C + 1);
    const hunk = ops.slice(start, end);
    const oa = ops.slice(0, start).filter((o) => o[0] !== '+').length + 1;
    const ob = ops.slice(0, start).filter((o) => o[0] !== '-').length + 1;
    out.push(`@@ -${oa},${hunk.filter((o) => o[0] !== '+').length} +${ob},${hunk.filter((o) => o[0] !== '-').length} @@`, ...hunk.map(([t, l]) => t + l));
    k = end;
  }
  return out.join('\n');
}

export function loadBase(dir) {
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`${dir} has no SKILL.md`);
  const files = readSkillDir(dir);
  const v = validateFiles(files);
  if (!v.ok) throw new Error(`invalid skill, fix first: ${v.errors.join('; ')}`);
  return { files, manifest: v.manifest, m: measure(files, dir) };
}

/** Optimize one skill dir. Returns the full result; writes nothing. */
export async function optimizeSkill(dir, opts = {}) {
  const base = loadBase(dir);
  const s = staticPass(dir, base);
  let best = s.best;
  let lift = null;
  let model = null;
  if (opts.allowModel) {
    model = await modelPass(dir, best, opts);
    best = model.best;
    lift = { before: model.origLift, after: model.bestLift };
  }
  const before = skillText(base.files);
  const after = skillText(best.files);
  return { dir, name: base.manifest.name, base, best, steps: s.steps, model, lift, diff: unifiedDiff(before, after, `a/${base.manifest.name}/SKILL.md`, `b/${base.manifest.name}/SKILL.md`), changed: before !== after };
}

export function report(r) {
  const b = r.base.m; const a = r.best.m;
  const trig = (m) => (m.trigger.hasCases ? `${m.trigger.pass} pass / ${m.trigger.fail} fail` : 'no cases');
  const pct = b.tokens ? Math.round((1 - a.tokens / b.tokens) * 100) : 0;
  const o = [
    `${r.name}: tokens ${b.tokens} -> ${a.tokens} (-${pct}%)  grade ${b.review.grade} -> ${a.review.grade}  trigger cases ${trig(b)} -> ${trig(a)}${r.lift ? `  lift ${fmtPct(r.lift.before)} -> ${fmtPct(r.lift.after)}` : '  lift not measured (static pass only)'}`,
    ...r.steps.map((s) => `  ${s.accepted ? `kept     ${s.label} (-${s.saved} tok)` : `rejected ${s.label}: ${s.reason}`}`),
    ...(r.model ? r.model.tries.map((t) => `  model round ${t.round}: ${t.accepted ? `kept (-${t.saved} tok, lift ${fmtPct(t.lift)})` : `rejected: ${t.reason}`}`) : []),
  ];
  if (r.diff) o.push('', r.diff);
  return o.join('\n');
}

export function librarySummary(rows) {
  const tb = rows.reduce((n, r) => n + r.before, 0); const ta = rows.reduce((n, r) => n + r.after, 0);
  const lines = ['| Skill | Tokens | After | Saved | Grade |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.before} | ${r.after} | ${r.before ? Math.round((1 - r.after / r.before) * 100) : 0}% | ${r.gradeBefore}${r.gradeBefore === r.gradeAfter ? '' : ` -> ${r.gradeAfter}`} |`)];
  const summary = `${rows.length} skills: ${tb} -> ${ta} tokens (-${tb ? ((1 - ta / tb) * 100).toFixed(1) : 0}%), ${rows.filter((r) => r.after < r.before).length} trimmed, ${rows.filter((r) => GRADES.indexOf(r.gradeAfter) > GRADES.indexOf(r.gradeBefore)).length} grades lowered`;
  return { table: lines.join('\n'), summary, before: tb, after: ta };
}

export async function run(args, flags = {}) {
  if (flags.all) {
    const root = typeof flags.all === 'string' ? flags.all : args[0];
    if (!root) throw new Error('usage: skillhawk optimize --all <dir>');
    const dirs = findSkillDirs([root]);
    if (!dirs.length) throw new Error(`no skills under ${root}`);
    const rows = [];
    for (const d of dirs) {
      try { const b = loadBase(d); const s = staticPass(d, b); rows.push({ name: b.manifest.name, before: b.m.tokens, after: s.best.m.tokens, gradeBefore: b.m.review.grade, gradeAfter: s.best.m.review.grade }); } catch { /* invalid skills are skipped; validate reports them */ }
    }
    const lib = librarySummary(rows);
    console.log(`${lib.table}\n\n${lib.summary}`);
    return;
  }
  const dir = args[0];
  if (!dir) throw new Error('usage: skillhawk optimize <skill-dir> [--rounds 3] [--allow-model] [--model haiku] [--out dir] [--apply]  |  optimize --all <dir>');
  const str = (v, d) => (v && v !== true ? v : d);
  const r = await optimizeSkill(dir, { allowModel: !!(flags['allow-model'] || flags.allowModel), rounds: Number(str(flags.rounds, 3)), model: str(flags.model, 'haiku'), log: (l) => console.log(l) });
  console.log(report(r));
  const out = path.resolve(str(flags.out, path.join(DEFAULT_OUT, r.name)));
  writeFiles(out, r.best.files);
  console.log(`\nwrote best candidate to ${out}`);
  if (flags.apply) {
    if (!r.changed) console.log('nothing to apply');
    else { fs.writeFileSync(path.join(dir, 'SKILL.md'), r.best.files['SKILL.md']); console.log(`applied to ${path.join(dir, 'SKILL.md')} (diff above)`); }
  } else if (r.changed) console.log('re-run with --apply to overwrite the skill');
}
