// Static skill reviewer: grades each SKILL.md A-F with line-level findings, and checks a whole library for
// duplicates, overlapping triggers and contradictions. Deterministic heuristics only; no model calls.
import fs from 'node:fs';
import path from 'node:path';
import { reviewScripts, renderScripts } from './clean.js';
import { parseFrontmatter, readSkillDir, validateFiles } from './skill.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const SEV_POINTS = { high: 25, medium: 10, low: 2 };
const SEV_ORDER = { high: 0, medium: 1, low: 2 };
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);

// ---- discovery ------------------------------------------------------------

/** Every directory under the given paths (or the paths themselves) that holds a SKILL.md. */
export function findSkillDirs(inputs, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) { out.push(dir); return; }
    if (depth >= maxDepth) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const a of inputs) if (fs.existsSync(a) && fs.statSync(a).isDirectory()) walk(a, 0);
  return out;
}

// ---- text helpers ---------------------------------------------------------

const STOP = new Set(('a an the and or but of to in on for with by at from as is are be been it its this that these those you your we our they them their ' +
  'if then than so not no do does did can could should would will may might must have has had into out up down over under about via per each any all ' +
  'use used using when whenever skill skills user users agent agents ask asked asking task tasks also such other more most only same just like need needs').split(' '));
const NEG = /\b(?:never|don'?t|do not|must not|should not|shouldn'?t|avoid|cannot|can'?t|forbidden|prohibited|no\b[^.]{0,12}\bwithout)\b/i;
const POS = /\b(?:always|must|required|requires?|every|ensure|make sure|only)\b/i;
const POLARITY_WORDS = new Set(['never', 'dont', 'do', 'not', 'must', 'should', 'shouldnt', 'avoid', 'cannot', 'cant', 'without', 'always', 'required', 'require', 'requires', 'every', 'prefer', 'ensure', 'make', 'sure', 'forbidden', 'prohibited']);

const stem = (w) => w.replace(/(?:ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? '' : m));
export function tokens(text) {
  return String(text).toLowerCase().replace(/[`*_#>\[\]()"“”]/g, ' ').replace(/'/g, '').split(/[^a-z0-9%-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}
const setOf = (arr) => new Set(arr);
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}
function shingles(text, n = 3) {
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const s = new Set();
  for (let i = 0; i + n <= t.length; i++) s.add(t.slice(i, i + n).join(' '));
  return s;
}

/** Mark lines that sit inside fenced code blocks. */
export function fencedSet(lines) {
  const set = new Set();
  let open = null;
  lines.forEach((l, i) => {
    const m = /^\s*(```+|~~~+)/.exec(l);
    if (m) { if (!open) open = m[1][0]; else if (m[1][0] === open) { open = null; } set.add(i); return; }
    if (open) set.add(i);
  });
  return set;
}

/** Frontmatter even when a license header sits above it. Returns { data, body, startLine (0-based line of the opening ---), endLine }. */
export function locateFrontmatter(text) {
  const lines = text.replace(/^﻿/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const end = lines.findIndex((l, j) => j > i && l.trim() === '---');
      if (end < 0) return { data: null, body: text, startLine: -1, endLine: -1 };
      const fm = parseFrontmatter(`${lines.slice(i, end + 1).join('\n')}\n`);
      return { data: fm.data, body: lines.slice(end + 1).join('\n'), startLine: i, endLine: end };
    }
    if (i > 40) break;
  }
  return { data: null, body: text, startLine: -1, endLine: -1 };
}

// ---- single-skill review --------------------------------------------------

const HEDGES = [
  [/\bbe thorough\b/i, 'be thorough'], [/\b(?:follow|use|apply) (?:industry )?best practices?\b/i, 'follow best practices'],
  [/\buse (?:good|your best|sound|common) (?:judge?ment|sense)\b/i, 'use good judgment'], [/\bas (?:appropriate|needed|necessary|required)\b/i, 'as appropriate / as needed'],
  [/\bwhere (?:possible|appropriate|applicable)\b|\bif (?:possible|appropriate|applicable)\b/i, 'if possible'], [/\bwhen (?:necessary|appropriate|relevant)\b/i, 'when necessary'],
  [/\btry (?:to|and)\b/i, 'try to'], [/\b(?:maybe|perhaps|probably|possibly)\b/i, 'maybe'], [/\byou (?:might|may) want to\b|\bconsider (?:adding|using|doing)\b/i, 'you might want to'],
  [/\bbe careful\b/i, 'be careful'], [/\b(?:high|good|top)[- ]quality\b/i, 'high-quality'], [/\betc\.?(?=\s|$|[),])|\band so on\b|\band more\b/i, 'etc. / and so on'],
  [/\bmake it (?:better|nice|good|clean|professional)\b/i, 'make it better'], [/\bkeep it (?:simple|clean|short)\b/i, 'keep it simple'],
  [/\bfollow the other\b/i, 'follow the other docs'],
];

function lineOf(lines, re, from = 0) {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 1;
}

/** Map a validateFiles message onto a rule, severity and line. */
function mapValidation(kind, msg, lines, fmLines) {
  const descLine = lineOf(lines, /^description\s*:/);
  const nameLine = lineOf(lines, /^name\s*:/);
  const f = (rule, severity, line, fix, file = 'SKILL.md') => ({ rule, severity, file, line, message: msg, fix });
  if (/no YAML frontmatter/.test(msg)) return f('frontmatter', 'high', 1, 'Start SKILL.md with a --- block containing name and description.');
  if (/must start on the first line/.test(msg)) return f('license-header-above-frontmatter', 'high', 1, 'Move the header inside the frontmatter as # comments (run with --fix).');
  if (/name is required|name ".*" must be/.test(msg)) return f('frontmatter', 'high', nameLine, 'Set name to a lowercase-hyphenated id of at most 64 characters, matching the folder.');
  if (/description is required/.test(msg)) return f('frontmatter', 'high', descLine, 'Add a description that says what the skill does and when to use it.');
  if (/description must be <= 1024/.test(msg)) return f('description-length', 'high', descLine, 'Shorten the description to 1024 characters; move detail into the body.');
  if (/does not say when/.test(msg)) return f('description-no-when', 'high', descLine, 'Rewrite as "<what it does>. Use when <the situations and phrases a user would say>."');
  if (/claims every task/.test(msg)) return f('trigger-hijack', 'high', descLine, 'Scope the description to one job; a skill that fires on everything crowds out the right one.');
  if (/TODO/.test(msg)) return f('todo', 'medium', lineOf(lines, /\bTODO\b/), 'Replace each TODO with real content, or delete the section.');
  if (/body is very short/.test(msg)) return f('thin-body', 'medium', fmLines + 1, 'Add the concrete rules, steps and an example the agent could not guess.');
  if (/lines; long skills/.test(msg)) return f('bloat', 'medium', 1, 'Move detail into references/ and link it; keep SKILL.md under 500 lines.');
  const ref = /references (\S+), which is not in/.exec(msg);
  if (ref) return f('broken-link', 'medium', lineOf(lines, new RegExp(ref[1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))), `Ship ${ref[1]} in the skill or remove the reference.`);
  if (/directory name differs|category|skill\.json/.test(msg)) return f('metadata', kind === 'error' ? 'high' : 'low', 1, 'Fix the metadata so name, folder and skill.json agree.', /skill\.json/.test(msg) ? 'skill.json' : 'SKILL.md');
  return f('validate', kind === 'error' ? 'high' : 'low', 1, 'Fix per `skillhawk validate`.');
}

/** Contradictory instruction pairs among the given [{line, text, key}] bullets. */
function polarityOf(text) {
  if (NEG.test(text)) return 'neg';
  if (POS.test(text)) return 'pos';
  return null;
}
function lineTokens(text) {
  return setOf(tokens(text).filter((w) => !POLARITY_WORDS.has(w)));
}
const GENERIC = new Set(['unless', 'explicitly', 'requested', 'request', 'user', 'users', 'already', 'exist', 'exists', 'when', 'only', 'also', 'any', 'use', 'using', 'used', 'add', 'one', 'per', 'each', 'other', 'all', 'with', 'for', 'the', 'and', 'that', 'this', 'from', 'into', 'than', 'then', 'them', 'they', 'are', 'its', 'not', 'but', 'new', 'where', 'while', 'there', 'their', 'have', 'has', 'can', 'will', 'should', 'would', 'could', 'make', 'sure', 'ensure', 'keep']);
const SCOPE = /\b(?:unless|except|only (?:if|when|for|after|before|on|in)|if|when|whenever|where|without|provided|otherwise)\b/i;
const isScoped = (x) => SCOPE.test(x.text);
const subjectOf = (x) => new Set([...x.tok].filter((w) => !GENERIC.has(w) && w.length > 2));
/** Near-identical wording (a repeated rule), whatever the polarity words say. */
export function nearDuplicate(a, b) {
  if (a.text.length < 25 || b.text.length < 25) return false;
  const sa = subjectOf(a); const sb = subjectOf(b);
  if (sa.size < 3 || sb.size < 3) return false;
  let n = 0; for (const x of sa) if (sb.has(x)) n++;
  return jaccard(sa, sb) >= 0.8 || (Math.min(sa.size, sb.size) >= 4 && n / Math.min(sa.size, sb.size) >= 0.9);
}
/** 'strong' | 'possible' | null. Same specific subject with opposite polarity; scoped rules count for less. */
function opposed(a, b, minShared) {
  if (!a.pol || !b.pol || a.pol === b.pol) return null;
  const sa = subjectOf(a); const sb = subjectOf(b);
  if (!sa.size || !sb.size) return null;
  let shared = 0; let longest = 0;
  for (const x of sa) if (sb.has(x)) { shared++; longest = Math.max(longest, x.length); }
  if (shared < Math.min(minShared, sa.size, sb.size) || longest < 5) return null;
  const cover = shared / Math.min(sa.size, sb.size);
  if (cover < 0.8) return null;
  if (nearDuplicate(a, b)) return null;
  return cover === 1 && !(isScoped(a) && isScoped(b)) && Math.min(sa.size, sb.size) <= 3 ? 'strong' : 'possible';
}
const TAB_SPACE = [/\btabs?\b/i, /\b(?:\d-)?spaces?\b|\bspace[- ]indent/i];
export function instructionLines(lines, fenced, from) {
  const out = [];
  lines.forEach((l, i) => {
    if (i < from || fenced.has(i) || /^\s*(?:\||#|<!--)/.test(l) || !l.trim()) return;
    const clean = l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim();
    for (const clause of clean.split(/(?<=[.!?;:])\s+|\s+(?:but|however|though)\s+/)) {
      const text = clause.trim().replace(/[;:]$/, '');
      if (text.length < 8) continue;
      const tok = lineTokens(text);
      if (!tok.size) continue;
      out.push({ line: i + 1, text, pol: polarityOf(text), tok, tabs: TAB_SPACE.map((r) => r.test(text)) });
    }
  });
  return out;
}
function tabSpaceClash(a, b) {
  return (a.tabs[0] && !a.tabs[1] && b.tabs[1] && !b.tabs[0]) || (a.tabs[1] && !a.tabs[0] && b.tabs[0] && !b.tabs[1]);
}

export function reviewFiles(files, dir = '.') {
  const findings = [];
  const add = (f) => findings.push(f);
  const raw = files['SKILL.md']?.toString('utf8') ?? '';
  const text = raw.replace(/^﻿/, '');
  const lines = text.split('\n');
  const fm = locateFrontmatter(text);
  const fmLines = fm.endLine >= 0 ? fm.endLine + 1 : 0;
  const fenced = fencedSet(lines);

  let v = validateFiles(files);
  if (!parseFrontmatter(text).data && fm.data) {
    // License header above the frontmatter: report it once, then judge the rest as if it were fixed.
    const fixed = fixText(text).text;
    v = validateFiles({ ...files, 'SKILL.md': Buffer.from(fixed) });
    add({ rule: 'license-header-above-frontmatter', severity: 'high', file: 'SKILL.md', line: 1, message: 'text above the --- block: agents read it as the description and the frontmatter is ignored', fix: 'Move the header inside the frontmatter as # comments (run with --fix).' });
  }
  for (const e of v.errors) add(mapValidation('error', e, lines, fmLines));
  for (const w of v.warnings) add(mapValidation('warning', w, lines, fmLines));

  // Markdown links to files that are not in the skill.
  const known = new Set(findings.filter((f) => f.rule === 'broken-link').map((f) => f.message));
  lines.forEach((l, i) => {
    if (fenced.has(i)) return;
    for (const m of l.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^(?:[a-z]+:|\/|#)/i.test(m[1])) continue;
      const rel = path.posix.normalize(target);
      if (files[rel] || Object.keys(files).some((f) => f.startsWith(`${rel}/`))) continue;
      if ([...known].some((k) => k.includes(rel))) continue;
      add({ rule: 'broken-link', severity: 'medium', file: 'SKILL.md', line: i + 1, message: `link to ${target} points at a file that is not in the skill`, fix: `Ship ${target} in the skill or remove the link.` });
    }
  });

  // Hedging and vague instructions.
  const hedgeSeen = new Set();
  lines.forEach((l, i) => {
    if (i < fmLines || fenced.has(i) || /^\s*(?:#|<!--)/.test(l)) return;
    for (const [re, label] of HEDGES) {
      if (re.test(l) && !hedgeSeen.has(label)) {
        hedgeSeen.add(label);
        add({ rule: 'vague-instruction', severity: 'low', file: 'SKILL.md', line: i + 1, message: `vague or hedging wording ("${label}"): the model already does this, so it costs context and changes nothing`, fix: 'Replace with a concrete rule: a number, a command, a format, or an example of right versus wrong.' });
      }
    }
  });

  // Contradictions inside the skill.
  const ins = instructionLines(lines, fenced, fmLines);
  const seenPair = new Set();
  for (let i = 0; i < ins.length; i++) {
    for (let j = i + 1; j < ins.length; j++) {
      if (ins[i].line === ins[j].line) continue;
      const k = `${ins[i].line}:${ins[j].line}`;
      if (seenPair.has(k) || seenPair.size >= 6) continue;
      const tabs = tabSpaceClash(ins[i], ins[j]);
      if (!tabs && nearDuplicate(ins[i], ins[j])) {
        seenPair.add(k);
        add({ rule: 'duplicate-rule', severity: 'low', file: 'SKILL.md', line: ins[j].line, message: `same rule as line ${ins[i].line}: "${trim(ins[j].text)}"`, fix: 'Say it once.' });
        continue;
      }
      const strength = tabs ? 'strong' : opposed(ins[i], ins[j], 1);
      if (!strength) continue;
      seenPair.add(k);
      add({ rule: 'contradiction', severity: strength === 'strong' ? 'high' : 'medium', heuristic: strength !== 'strong', file: 'SKILL.md', line: ins[j].line, message: `${strength === 'strong' ? 'contradiction' : 'possible contradiction'} with line ${ins[i].line}: "${trim(ins[i].text)}" vs "${trim(ins[j].text)}"`, fix: 'Keep one rule, or state when each applies. Agents resolve a contradiction arbitrarily.' });
    }
  }

  // Bloat.
  const total = estimateTokens(text);
  if (total > 5000) add({ rule: 'bloat', severity: 'high', file: 'SKILL.md', line: 1, message: `SKILL.md is about ${total} tokens, paid on every load`, fix: 'Move reference material to references/ and link it; keep SKILL.md to rules and steps.' });
  else if (total > 3000) add({ rule: 'bloat', severity: 'medium', file: 'SKILL.md', line: 1, message: `SKILL.md is about ${total} tokens, paid on every load`, fix: 'Move reference material to references/ and link it.' });
  const heads = lines.map((l, i) => (!fenced.has(i) && /^#{1,6}\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  heads.forEach((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
    const sec = lines.slice(h, end).join('\n');
    if (end - h > 120 || estimateTokens(sec) > 1500) add({ rule: 'long-section', severity: 'medium', file: 'SKILL.md', line: h + 1, message: `section "${lines[h].replace(/^#+\s*/, '').trim()}" is ${end - h} lines (about ${estimateTokens(sec)} tokens)`, fix: 'Split it, or move the detail to references/.' });
  });

  // Missing examples.
  const bodyText = fm.body;
  if (bodyText.trim().length > 400 && !/```|^\s*~~~/m.test(bodyText) && !/\bexamples?\b|\be\.g\.|\bfor instance\b|\binput:|\boutput:|\bbefore:|\bafter:/i.test(bodyText)) {
    add({ rule: 'no-examples', severity: 'low', file: 'SKILL.md', line: fmLines + 1, message: 'no example or code block anywhere in the skill', fix: 'Add one worked example: an input and the exact output you want, or a right-versus-wrong pair.' });
  }

  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.line - b.line);
  const uniq = [];
  for (const f of findings) if (!uniq.some((u) => u.rule === f.rule && u.line === f.line && u.message === f.message)) uniq.push(f);
  const { score, grade } = gradeOf(uniq, v.ok);
  const name = v.manifest?.name || fm.data?.name || path.basename(path.resolve(dir));
  return { dir, name, description: v.manifest?.description || fm.data?.description || '', grade, score, tokens: total, reason: reasonOf(uniq, grade), findings: uniq, valid: v.ok };
}

const trim = (s) => (s.length > 70 ? `${s.slice(0, 67)}...` : s);

function gradeOf(findings, valid) {
  // Heuristic findings (vague wording, possible contradictions, repeats, missing examples) are capped together,
  // so they alone can never push a skill below B.
  const isHeur = (f) => f.heuristic || ['vague-instruction', 'no-examples', 'duplicate-rule'].includes(f.rule);
  const heur = Math.min(12, findings.filter(isHeur).reduce((n, f) => n + (f.rule === 'duplicate-rule' ? 0 : SEV_POINTS[f.severity]), 0));
  const penalty = heur + findings.filter((f) => !isHeur(f)).reduce((n, f) => n + SEV_POINTS[f.severity], 0);
  const score = Math.max(0, 100 - penalty);
  let grade = penalty <= 3 ? 'A' : penalty <= 12 ? 'B' : penalty <= 30 ? 'C' : penalty <= 50 ? 'D' : 'F';
  if (!valid && 'AB'.includes(grade)) grade = 'C';
  return { score, grade };
}
function reasonOf(findings, grade) {
  if (!findings.length) return 'no findings';
  const rules = [...new Set(findings.map((f) => f.rule))];
  const top = rules.slice(0, 3).join(', ');
  return `${findings.length} finding${findings.length === 1 ? '' : 's'}${grade === 'A' ? '' : `: ${top}${rules.length > 3 ? ', ...' : ''}`}`;
}

export function reviewDir(dir) {
  const r = reviewFiles(readSkillDir(dir), dir);
  try { const s = reviewScripts(dir); if (s.scripts.length) r.scripts = s; } catch { /* script review is best effort */ }
  return r;
}

// ---- safe fixes -----------------------------------------------------------

/** Mechanical fixes only: BOM, leading blank lines, license header above frontmatter, trailing spaces in frontmatter. Never touches prose. */
export function fixText(text) {
  const changes = [];
  let out = text;
  if (out.startsWith('﻿')) { out = out.slice(1); changes.push('removed byte-order mark'); }
  const lines = out.split('\n');
  const first = lines.findIndex((l) => l.trim() === '---');
  const end = first >= 0 ? lines.findIndex((l, j) => j > first && l.trim() === '---') : -1;
  const hasFm = first >= 0 && end > first && lines.slice(first + 1, end).some((l) => /^name\s*:/.test(l));
  if (!hasFm) return { text: out, changes };
  let head = lines.slice(0, first);
  let fmLines = lines.slice(first + 1, end);
  const rest = lines.slice(end + 1);
  const headText = head.join('\n').trim();
  if (headText) {
    const comments = head.map((l) => l.replace(/^\s*<!--\s?/, '').replace(/\s?-->\s*$/, '').replace(/^\s*(?:#|\/\/|\*|\/\*+)\s?/, '').replace(/\s*\*\/\s*$/, '').trimEnd()).filter((l) => l.trim()).map((l) => `# ${l}`);
    fmLines = [...fmLines, ...comments];
    changes.push(`moved ${comments.length} line(s) above the frontmatter (license header) inside it as # comments`);
  } else if (head.length) changes.push('removed blank lines above the frontmatter');
  const trimmed = fmLines.map((l) => l.replace(/[ \t]+$/, ''));
  if (trimmed.some((l, i) => l !== fmLines[i])) changes.push('trimmed trailing whitespace in frontmatter');
  if (!changes.length) return { text: out, changes };
  return { text: ['---', ...trimmed, '---', ...rest].join('\n'), changes };
}

export function fixDir(dir) {
  const p = path.join(dir, 'SKILL.md');
  const before = fs.readFileSync(p, 'utf8');
  const r = fixText(before);
  if (r.text !== before) fs.writeFileSync(p, r.text);
  return r.changes;
}

// ---- library pass ---------------------------------------------------------

const DESC_GENERIC = new Set(['help', 'work', 'code', 'file', 'files', 'project', 'create', 'write', 'review', 'check', 'make', 'run', 'new', 'get', 'set', 'add']);

/** Cross-skill checks. `skills` = [{dir, name, description, body}]. */
export function reviewLibrary(skills) {
  const items = skills.map((s) => {
    const dtok = tokens(s.description).filter((w) => !DESC_GENERIC.has(w));
    const phrases = [...String(s.description).matchAll(/["“']([^"”']{4,50})["”']/g)].map((m) => m[1].toLowerCase());
    return { ...s, dtok: setOf(dtok), phrases: setOf(phrases), sh: shingles(s.body), nameTok: setOf(s.name.split('-')), ins: null };
  });
  const out = { duplicates: [], overlaps: [], contradictions: [] };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]; const b = items[j];
      const bodySim = jaccard(a.sh, b.sh);
      const descSim = jaccard(a.dtok, b.dtok);
      const nameSim = jaccard(a.nameTok, b.nameTok);
      const pair = { a: a.dir, b: b.dir, names: [a.name, b.name] };
      if (a.name === b.name || bodySim >= 0.6) {
        out.duplicates.push({ ...pair, severity: 'high', similarity: round(Math.max(bodySim, a.name === b.name ? 0.99 : 0)), message: a.name === b.name ? `same skill name "${a.name}" in two places (body ${pct(bodySim)} alike)` : `bodies are ${pct(bodySim)} alike`, fix: 'Keep one, delete or merge the other. Two copies drift apart and both fire.' });
        continue;
      }
      if (bodySim >= 0.35 || (nameSim >= 0.67 && descSim >= 0.5)) {
        out.duplicates.push({ ...pair, severity: 'medium', similarity: round(Math.max(bodySim, descSim)), message: `near-duplicate: bodies ${pct(bodySim)} alike, descriptions ${pct(descSim)} alike`, fix: 'Merge into one skill, or sharpen each description so they cover different requests.' });
        continue;
      }
      const sharedPhrases = [...a.phrases].filter((p) => b.phrases.has(p));
      if (descSim >= 0.4 || sharedPhrases.length) {
        out.overlaps.push({ ...pair, severity: descSim >= 0.55 ? 'high' : 'medium', similarity: round(descSim), message: `descriptions would fire on the same request (${pct(descSim)} shared terms${sharedPhrases.length ? `; both say "${sharedPhrases[0]}"` : ''})`, fix: 'Narrow each description to its own job and trigger phrases, or merge them.' });
      }
      // Contradictions between skills that cover related ground.
      if (descSim >= 0.2 || bodySim >= 0.1) {
        a.ins ||= instructionLines(a.lines, fencedSet(a.lines), a.fm);
        b.ins ||= instructionLines(b.lines, fencedSet(b.lines), b.fm);
        let found = 0;
        for (const x of a.ins) for (const y of b.ins) {
          if (found >= 2) break;
          const st = (tabSpaceClash(x, y) && x.pol && y.pol) ? 'strong' : opposed(x, y, 2);
          if (st) {
            found++;
            out.contradictions.push({ ...pair, severity: st === 'strong' ? 'high' : 'medium', message: `${st === 'strong' ? '' : 'possible: '}${a.name}:${x.line} "${trim(x.text)}" vs ${b.name}:${y.line} "${trim(y.text)}"`, fix: 'Decide which rule wins and remove or scope the other.' });
          }
        }
      }
    }
  }
  return out;
}
const round = (n) => Math.round(n * 100) / 100;
const pct = (n) => `${Math.round(n * 100)}%`;

// ---- command --------------------------------------------------------------

/** Review skill folders and, when there are several, the library as a whole. */
export function reviewDirs(dirs) {
  const reviews = dirs.map(reviewDir);
  const library = reviews.length > 1 ? reviewLibrary(dirs.map((d, i) => {
    const text = fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8').replace(/^﻿/, '');
    const fm = locateFrontmatter(text);
    return { dir: d, name: reviews[i].name, description: reviews[i].description, body: fm.body, lines: text.split('\n'), fm: fm.endLine >= 0 ? fm.endLine + 1 : 0 };
  })) : { duplicates: [], overlaps: [], contradictions: [] };
  const grades = {};
  for (const r of reviews) grades[r.grade] = (grades[r.grade] || 0) + 1;
  return { reviews, library, grades };
}

export async function run(args, flags = {}) {
  if (flags.chats) return (await import('./review-chats.js')).run(args, flags);
  const dirs = findSkillDirs(args.length ? args : ['.']);
  if (!dirs.length) throw new Error('no skill directories found (looking for folders with a SKILL.md)');
  const fixed = [];
  if (flags.fix) {
    for (const d of dirs) {
      const changes = fixDir(d);
      if (changes.length) fixed.push({ dir: d, changes });
    }
  }
  const { reviews, library, grades } = reviewDirs(dirs);
  if (flags.json && flags.json !== true) {
    fs.writeFileSync(flags.json, `${JSON.stringify({ skills: reviews, library, fixed, summary: { skills: reviews.length, grades } }, null, 2)}\n`);
  }
  console.log(render(reviews, library, fixed, grades));
  if (flags.json && flags.json !== true) console.log(`\nwrote ${flags.json}`);
  if (reviews.some((r) => r.grade === 'F')) process.exitCode = 1;
}

export function render(reviews, library, fixed, grades) {
  const o = [];
  o.push(`skillhawk review: ${reviews.length} skill${reviews.length === 1 ? '' : 's'}`);
  if (fixed.length) {
    o.push('', 'fixed (mechanical only, prose untouched):');
    for (const f of fixed) for (const c of f.changes) o.push(`  ${f.dir}: ${c}`);
  }
  o.push('');
  const w = Math.min(34, Math.max(...reviews.map((r) => r.name.length)));
  for (const r of reviews) {
    o.push(`${r.grade}  ${r.name.padEnd(w)}  ~${String(r.tokens).padStart(4)} tok  ${r.reason}   (${r.dir})`);
    if (r.grade !== 'A') {
      for (const f of r.findings) {
        o.push(`     ${f.severity.padEnd(6)} ${f.file}:${f.line} [${f.rule}] ${f.message}`, `            fix: ${f.fix}`);
      }
    }
    if (r.scripts) o.push(...renderScripts(r.scripts));
  }
  const lib = [...library.duplicates.map((x) => ['duplicate', x]), ...library.overlaps.map((x) => ['overlap', x]), ...library.contradictions.map((x) => ['contradiction', x])];
  if (reviews.length > 1) {
    o.push('', `library: ${library.duplicates.length} duplicate(s), ${library.overlaps.length} overlapping trigger(s), ${library.contradictions.length} cross-skill contradiction(s)`);
    for (const [kind, x] of lib) o.push(`     ${x.severity.padEnd(6)} [${kind}] ${x.names[0]} <> ${x.names[1]}: ${x.message}`, `            ${x.a}  |  ${x.b}`, `            fix: ${x.fix}`);
  }
  o.push('', `grades: ${['A', 'B', 'C', 'D', 'F'].map((g) => `${g}=${grades[g] || 0}`).join(' ')}`);
  return o.join('\n');
}
