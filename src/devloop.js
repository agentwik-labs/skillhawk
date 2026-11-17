// Dev loop: trigger/behaviour test cases (tests/cases.yaml), static trigger scoring, `test`, `dev` watch, and the CI lift-diff.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AGENTS, installBundle, listInstalled, resolveAgents } from './agents.js';
import { checksum, parseFrontmatter, readSkillDir, validateFiles } from './skill.js';
import { findSkillDirs, reviewFiles, tokens } from './review.js';

// ---- tiny YAML (maps, lists, "- key: v" items, flow lists, quoted scalars, # comments) --------------------------

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function splitFlow(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\' && q === '"') cur += s[++i] ?? ''; else if (c === q) q = null; } else if (c === '"' || c === "'") { q = c; cur += c; } else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function scalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1)).map(scalar);
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] || c);
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  return v;
}

export function parseYaml(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((raw) => {
    const t = stripComment(raw);
    return { indent: t.length - t.trimStart().length, text: t.trim() };
  }).filter((l) => l.text);
  let i = 0;
  const isDash = (l) => l.text === '-' || l.text.startsWith('- ');
  const block = () => (isDash(lines[i]) ? list(lines[i].indent) : map(lines[i].indent));
  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isDash(lines[i])) {
      const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(lines[i].text);
      if (!m) throw new Error(`cases: cannot parse "${lines[i].text}"`);
      const key = scalar(m[1]);
      i++;
      if (m[2] !== undefined && m[2] !== '') obj[key] = scalar(m[2]);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isDash(lines[i])))) obj[key] = block();
      else obj[key] = null;
    }
    return obj;
  }
  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isDash(lines[i])) {
      const l = lines[i];
      const rest = l.text.replace(/^-\s*/, '');
      if (!rest) { i++; arr.push(i < lines.length && lines[i].indent > indent ? block() : null); continue; }
      if (/^("[^"]*"|'[^']*'|[^\s:"'\[][^:]*?):(\s|$)/.test(rest) && !rest.startsWith('[')) {
        lines[i] = { indent: indent + (l.text.length - rest.length), text: rest };
        arr.push(map(lines[i].indent));
      } else { arr.push(scalar(rest)); i++; }
    }
    return arr;
  }
  return lines.length ? block() : {};
}

// ---- cases ------------------------------------------------------------------

export const CASES_STUB = `# Trigger cases: does an agent pick THIS skill from its description alone?
should_fire:
  - "TODO a prompt a user would type that this skill should handle"
should_not_fire:
  - "TODO a nearby prompt that belongs to a different skill"

# Behaviour cases (run with: skillhawk test <dir> --allow-model): prompt + substrings to expect/forbid, or a rubric line.
behaviour:
  - prompt: "TODO task to give the agent"
    expect: ["TODO text the answer must contain"]
    forbid: ["TODO text the answer must not contain"]
    # rubric: "One sentence a judge model checks the answer against"
`;

export function addCasesStub(skillDir) {
  const p = path.join(skillDir, 'tests', 'cases.yaml');
  if (fs.existsSync(p)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, CASES_STUB);
  return true;
}

export function loadCases(skillDir) {
  for (const n of ['cases.yaml', 'cases.yml', 'cases.json']) {
    const p = path.join(skillDir, 'tests', n);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      return { file: p, cases: n.endsWith('.json') ? JSON.parse(text) : parseYaml(text) };
    }
  }
  return null;
}

const isTodo = (s) => /^TODO\b/.test(s);

/** Returns a list of problems (empty = valid). */
export function validateCases(c) {
  const errs = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['cases file must be a map with should_fire, should_not_fire and/or behaviour'];
  for (const k of ['should_fire', 'should_not_fire']) {
    if (c[k] == null) continue;
    if (!Array.isArray(c[k]) || c[k].some((x) => typeof x !== 'string' || !x.trim())) errs.push(`${k} must be a list of prompt strings`);
  }
  const beh = c.behaviour ?? c.behavior;
  if (beh != null) {
    if (!Array.isArray(beh)) errs.push('behaviour must be a list');
    else beh.forEach((b, n) => {
      if (!b || typeof b.prompt !== 'string' || !b.prompt.trim()) errs.push(`behaviour[${n}] needs a prompt`);
      else if (!(b.expect?.length || b.forbid?.length || b.rubric)) errs.push(`behaviour[${n}] needs expect, forbid or rubric`);
      for (const k of ['expect', 'forbid']) if (b?.[k] != null && !Array.isArray(b[k])) errs.push(`behaviour[${n}].${k} must be a list`);
    });
  }
  const n = (c.should_fire?.length || 0) + (c.should_not_fire?.length || 0) + (beh?.length || 0);
  if (!errs.length && !n) errs.push('no cases defined');
  return errs;
}

// ---- static trigger scoring (BM25 over descriptions) -------------------------------

function skillDoc(files, fallbackName) {
  const md = files['SKILL.md']?.toString('utf8');
  if (!md) return null;
  const d = parseFrontmatter(md).data || {};
  return { name: d.name || fallbackName, description: d.description || '' };
}

/** Descriptions of the other skills a prompt competes with: siblings in the parent folder + installed ones. */
export function competitors(skillDir, { agent, cwd, global = false } = {}) {
  const self = path.resolve(skillDir);
  const out = new Map();
  for (const d of findSkillDirs([path.dirname(self)], 1)) {
    if (path.resolve(d) === self) continue;
    const doc = skillDoc(readSkillDir(d), path.basename(d));
    if (doc) out.set(doc.name, doc);
  }
  if (agent) {
    for (const a of resolveAgents(agent)) {
      for (const s of listInstalled(a, { global, cwd: cwd || process.cwd() })) {
        const doc = skillDoc(readSkillDir(s.dir), s.name);
        if (doc && !out.has(doc.name)) out.set(doc.name, doc);
      }
    }
  }
  return [...out.values()];
}

export function bm25Rank(prompt, docs, { k1 = 1.4, b = 0.75 } = {}) {
  const toks = docs.map((d) => tokens(`${d.name.replace(/-/g, ' ')} ${d.name.replace(/-/g, ' ')} ${d.description}`));
  const avg = toks.reduce((s, t) => s + t.length, 0) / (toks.length || 1) || 1;
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const q = [...new Set(tokens(prompt))];
  return docs.map((d, i) => {
    const tf = new Map();
    for (const w of toks[i]) tf.set(w, (tf.get(w) || 0) + 1);
    let score = 0;
    let matched = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      matched++;
      const n = df.get(w);
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avg)));
    }
    return { name: d.name, score, matched };
  }).sort((x, y) => y.score - x.score);
}

/** Which skill would likely win this prompt: the top scorer, or null when nothing matches. */
export function likelyWinner(prompt, self, others) {
  const ranked = bm25Rank(prompt, [self, ...others.filter((o) => o.name !== self.name)]);
  const top = ranked[0];
  return { winner: top.matched ? top.name : null, ranked };
}

export function staticTest(skillDir, { agent, cwd, global, files: filesOverride } = {}) {
  const files = filesOverride || readSkillDir(skillDir);
  const v = validateFiles(files);
  const res = { dir: skillDir, errors: [], results: [], pass: 0, fail: 0, behaviourCases: 0, competitors: 0, hasCases: false };
  if (!v.ok) { res.errors.push(...v.errors); return res; }
  const loaded = loadCases(skillDir);
  if (!loaded) { res.errors.push('no tests/cases.yaml (create a stub with: skillhawk new, or add tests/cases.yaml)'); return res; }
  res.hasCases = true;
  const bad = validateCases(loaded.cases);
  if (bad.length) { res.errors.push(...bad.map((e) => `${path.relative(skillDir, loaded.file)}: ${e}`)); return res; }
  const self = { name: v.manifest.name, description: v.manifest.description };
  const others = competitors(skillDir, { agent, cwd, global });
  res.competitors = others.length;
  res.behaviourCases = (loaded.cases.behaviour ?? loaded.cases.behavior ?? []).length;
  for (const [kind, want] of [['should_fire', true], ['should_not_fire', false]]) {
    for (const prompt of loaded.cases[kind] || []) {
      if (isTodo(prompt)) continue;
      const { winner } = likelyWinner(prompt, self, others);
      const fires = winner === self.name;
      const ok = fires === want;
      res.results.push({ kind, prompt, winner, ok });
      if (ok) res.pass++; else res.fail++;
    }
  }
  return res;
}

export function formatStatic(r) {
  const o = [];
  for (const e of r.errors) o.push(`  error: ${e}`);
  for (const x of r.results) o.push(`  ${x.ok ? 'pass' : 'FAIL'} ${x.kind.padEnd(15)} "${x.prompt.length > 70 ? `${x.prompt.slice(0, 67)}...` : x.prompt}" → ${x.winner ?? 'no skill'}${x.ok ? '' : ` (expected ${x.kind === 'should_fire' ? 'this skill' : 'another skill'})`}`);
  return o.join('\n');
}

// ---- skillhawk test ------------------------------------------------------------

export async function testCmd(args, f) {
  const dir = args[0];
  if (!dir || !fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('usage: skillhawk test <skill-dir> [--static] [--allow-model] [--model haiku]');
  const r = staticTest(dir, { agent: f.agent || 'claude', cwd: f.cwd && f.cwd !== true ? f.cwd : undefined, global: !!f.global });
  console.log(`static trigger test: ${dir} (vs ${r.competitors} other skill${r.competitors === 1 ? '' : 's'})\n${formatStatic(r)}`);
  console.log(`${r.pass} passed, ${r.fail} failed${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`);
  let failed = r.fail + r.errors.length;
  if ((f['allow-model'] || f.allowModel) && !f.static) {
    const { evalSkill } = await import('./eval.js');
    const cases = behaviourToEvalCases(loadCases(dir)?.cases || {});
    if (!cases.length) console.log('no behaviour cases to run');
    else {
      const rep = await evalSkill(dir, { agent: 'claude', model: f.model && f.model !== true ? f.model : 'haiku', cases, conditions: ['with'], log: (l) => console.log(l) });
      const bad = rep.cases.filter((c) => c.error || c.score < 1);
      console.log(`behaviour: ${rep.cases.length - bad.length}/${rep.cases.length} cases pass (model-confined runner)`);
      failed += bad.length;
    }
  } else if (r.behaviourCases) console.log(`${r.behaviourCases} behaviour case(s) not run (add --allow-model to run them with a model)`);
  if (failed) process.exitCode = 1;
}

export function behaviourToEvalCases(c) {
  return (c.behaviour ?? c.behavior ?? []).filter((b) => !isTodo(b.prompt || '')).map((b, n) => ({
    name: `case ${n + 1}`,
    prompt: b.prompt,
    checks: [
      ...(b.expect || []).map((v) => ({ type: 'contains', value: v })),
      ...(b.forbid || []).map((v) => ({ type: 'not_contains', value: v })),
      ...(b.rubric ? [{ type: 'judge', value: b.rubric, label: b.rubric }] : []),
    ],
  }));
}

// ---- skillhawk dev -------------------------------------------------------------

const NOT_SHIPPED = (k) => k.startsWith('evals/') || k.startsWith('tests/') || k.startsWith('.skillyard-');

/** One dev cycle: re-install into the agent's skills dir, then review + static test. Returns the status line. */
export function devCycle(dir, { agent = 'claude', cwd = process.cwd(), global = false } = {}) {
  const files = readSkillDir(dir);
  const v = validateFiles(files);
  const time = new Date().toTimeString().slice(0, 8);
  if (!v.ok) return `${time} invalid: ${v.errors[0]}`;
  const shipped = Object.fromEntries(Object.entries(files).filter(([k]) => !NOT_SHIPPED(k)));
  const bundle = {
    id: `@local/${v.manifest.name}`, scope: 'local', name: v.manifest.name, version: v.manifest.version, checksum: checksum(shipped),
    files: Object.fromEntries(Object.entries(shipped).map(([k, b]) => [k, b.toString('base64')])),
  };
  const parts = [];
  for (const a of resolveAgents(agent)) parts.push(`${AGENTS[a].label}: ${path.relative(cwd, installBundle(a, bundle, { global, cwd, force: true })) || '.'}`);
  const rv = reviewFiles(files, dir);
  const st = staticTest(dir, { agent, cwd, global });
  const tests = st.errors.length ? (st.hasCases ? 'tests: invalid cases' : 'tests: none') : `tests ${st.pass}/${st.pass + st.fail} trigger`;
  return `${time} installed ${v.manifest.name}@${v.manifest.version} → ${parts.join(', ')} | review ${rv.grade} (${rv.findings.length} finding${rv.findings.length === 1 ? '' : 's'}) | ${tests}`;
}

export function devWatch(dir, opts = {}, onLine = (l) => console.log(l)) {
  const run = () => { try { onLine(devCycle(dir, opts)); } catch (e) { onLine(`${new Date().toTimeString().slice(0, 8)} error: ${e.message}`); } };
  run();
  let timer = null;
  const watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
    if (name && /(^|[\\/])\.skillyard-/.test(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  return { close: () => { clearTimeout(timer); watcher.close(); } };
}

export async function devCmd(args, f) {
  const dir = args[0];
  if (!dir || !fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('usage: skillhawk dev <skill-dir> [--agent claude] [--cwd project] [-g] [--once]');
  const opts = { agent: f.agent || 'claude', cwd: f.cwd && f.cwd !== true ? path.resolve(f.cwd) : process.cwd(), global: !!f.global };
  if (f.once) return void console.log(devCycle(dir, opts));
  console.log(`watching ${dir} (ctrl-c to stop)`);
  devWatch(dir, opts);
  await new Promise(() => {});
}

// ---- CI lift-diff (ci --compare <base-ref>) ----------------------------------------

const git = (args) => execFileSync('git', args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

function baseFiles(ref, dir) {
  let names;
  try { names = git(['ls-tree', '-r', '--name-only', ref, '--', dir]).toString('utf8').split('\n').filter(Boolean); } catch (e) { throw new Error(`cannot read ${ref}: ${String(e.stderr || e.message).trim()}`); }
  const prefix = git(['rev-parse', '--show-prefix']).toString('utf8').trim();
  const rel = path.posix.join(dir.split(path.sep).join('/'));
  const root = path.posix.normalize(rel).replace(/^\.\//, '');
  const files = {};
  for (const n of names) {
    // ls-tree prints paths relative to the current directory
    const key = root === '.' ? n : n.slice(root.length + 1);
    files[key] = git(['show', `${ref}:${prefix}${n}`]);
  }
  return files;
}

function staticFromFiles(files, siblings) {
  const v = validateFiles(files);
  const cases = (() => { for (const n of ['cases.yaml', 'cases.yml', 'cases.json']) { const b = files[`tests/${n}`]; if (b) return n.endsWith('.json') ? JSON.parse(b.toString('utf8')) : parseYaml(b.toString('utf8')); } return null; })();
  if (!v.ok || !cases || validateCases(cases).length) return null;
  const self = { name: v.manifest.name, description: v.manifest.description };
  let pass = 0;
  let total = 0;
  for (const [k, want] of [['should_fire', true], ['should_not_fire', false]]) {
    for (const p of cases[k] || []) { if (isTodo(p)) continue; total++; if ((likelyWinner(p, self, siblings).winner === self.name) === want) pass++; }
  }
  return total ? { pass, total } : null;
}

const sameFiles = (a, b) => { const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k].equals(b[k])); };
const show = (r) => (r ? `${r.grade} (${r.findings.length})` : 'new');

/** Markdown table: grade before→after and findings delta for every skill whose files differ from <ref>. */
export function compareMarkdown(dirs, ref) {
  const rows = [];
  const all = dirs.map((d) => ({ d, files: readSkillDir(d) }));
  for (const { d, files } of all) {
    const old = baseFiles(ref, d);
    const hadSkill = !!old['SKILL.md'];
    if (hadSkill && sameFiles(old, files)) continue;
    const siblings = (fl) => all.filter((x) => x.d !== d).map((x) => skillDoc(x.files, path.basename(x.d))).filter(Boolean);
    const sib = siblings();
    const before = hadSkill ? reviewFiles(old, d) : null;
    const after = reviewFiles(files, d);
    const tb = hadSkill ? staticFromFiles(old, sib) : null;
    const ta = staticFromFiles(files, sib);
    const delta = before ? after.findings.length - before.findings.length : after.findings.length;
    const arrow = before && before.grade !== after.grade ? (after.grade < before.grade ? '↑' : '↓') : '';
    rows.push(`| \`${d}\` | ${show(before)} → ${show(after)} ${arrow} | ${delta > 0 ? '+' : ''}${delta} | ${tb ? `${tb.pass}/${tb.total}` : '-'} → ${ta ? `${ta.pass}/${ta.total}` : '-'} |`);
  }
  if (!rows.length) return `### Skillhawk lift-diff vs \`${ref}\`\n\nNo skill changed.\n`;
  return ['### Skillhawk lift-diff vs `' + ref + '`', '', '| Skill | Review grade (findings) | Findings delta | Static trigger tests |', '|---|---|---|---|', ...rows, '',
    '_Model-based lift is opt-in: run `skillhawk eval <dir>` or `skillhawk test <dir> --allow-model`._', ''].join('\n');
}
