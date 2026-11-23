// skillhawk setup: decide how agents should write code in this repo, then write it where every agent reads it.
// Two ways in: walk through the choices (language, style, format, tests, architecture, commits, UI design, comments),
// each with the option detected from the code as the default; or accept what the code already does (--yes).
// Output: one short rules block in AGENTS.md (Codex, Cursor, Copilot, Gemini read it) and an @AGENTS.md import in
// CLAUDE.md, plus the top health findings as "do not make these worse". Answers saved to .skillhawk/setup.json.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { detectConventions, gitStyle } from './clean.js';
import { health } from './health.js';
import { PARTS, HEALTH_QUESTIONS, FACTORY_QUESTIONS, healthConfig, factoryConfig, saveHealth, saveFactory, loadHealth } from './prefs.js';
import { QUESTIONS as BRAIN_QUESTIONS, parseAnswer, toConfig as brainConfig, saveConfig as saveBrain, describe as describeBrain } from './brain-config.js';

const START = '<!-- skillhawk:setup start -->', END = '<!-- skillhawk:setup end -->';
const plain = (s) => String(s).replace(/ \(detected[^)]*\)/, '').toLowerCase();
const uniq = (a) => { const seen = new Set(); return a.filter(Boolean).filter((x) => { const k = plain(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** The questions, each with options; the first option is the default (detected from the code when possible). */
export function questions(c, h) {
  const lang = c.languages[0]?.name || null;
  const js = /JavaScript|TypeScript/.test(lang || '') || !!c.node;
  const py = lang === 'Python';
  const fmt = c.configs.find((x) => /Prettier|Biome|Black|Ruff|rustfmt|gofmt|golangci/.test(x));
  const ui = Object.keys(h?.design?.stack || {}).includes('web framework') || (h?.design?.stack?.['web framework'] || []).some((x) => /next|nuxt|remix|astro/.test(x));
  const q = [];
  const add = (id, question, options, why = '') => q.push({ id, question, options: uniq(options), why });
  add('language', 'Main language for new code?', [lang && `${lang} (detected)`, 'TypeScript', 'JavaScript', 'Python', 'Go'], lang ? `${c.languages.map((l) => `${l.name} ${l.pct}%`).join(', ')}` : 'no source files yet');
  add('formatter', 'Formatter and linter?', [fmt ? `${fmt} (detected)` : 'None, match the existing code', js && 'Biome', js && 'Prettier + ESLint', py && 'Ruff', py && 'Black + Ruff', lang === 'Go' && 'gofmt + golangci-lint', 'None, match the existing code'], fmt ? `found ${c.configs.join(', ')}` : 'no formatter config found');
  add('indent', 'Indentation?', [c.indent && `${c.indent.kind === 'tabs' ? 'Tabs' : `${c.indent.width} spaces`} (detected, ${c.indent.share}% of lines)`, '2 spaces', '4 spaces', 'Tabs']);
  if (js) {
    add('quotes', 'Quotes?', [c.quotes ? `${c.quotes.style} quotes (detected, ${c.quotes.share}%)` : 'quotes as in the existing code', 'single quotes', 'double quotes']);
    add('semicolons', 'Semicolons?', [c.semicolons ? `${c.semicolons.use ? 'always' : 'never'} (detected, ${c.semicolons.share}%)` : 'as in the existing code', 'always', 'never']);
    add('modules', 'Modules?', [c.modules && `${c.modules.kind} (detected)`, 'ES modules (import/export)', 'CommonJS (require)']);
  }
  add('naming', 'Naming?', [c.functionNaming && `functions ${c.functionNaming.style}, files ${c.fileNaming?.style || 'as they are'} (detected)`, py ? 'functions snake_case, files snake_case' : 'functions camelCase, files kebab-case', 'functions camelCase, files camelCase']);
  const t = c.tests;
  add('tests', 'Tests?', [t?.files && `${t.command || t.pattern} (detected); add or update a test with every behaviour change`, 'Add or update a test with every behaviour change', 'Tests for new logic and every bug fix', 'No test rule'], t?.files ? `${t.files} test files` : 'no tests found');
  add('architecture', 'Architecture for new code?', ['Keep the current layout; put new code next to similar code', 'Feature folders (everything for one feature together)', 'Layers: routes/handlers -> services -> data access', 'Hexagonal: core logic with ports, adapters at the edges'], h ? `${h.codeFiles} source files; ${h.findings.filter((x) => x.section === 'structure').length} structure findings` : '');
  const g = c.git || {};
  add('commits', 'Commit messages?', [!g.count ? 'Short imperative summary, under 72 characters' : (g.conventionalPct >= 50 ? `Conventional commits (detected, ${g.conventionalPct}%)` : `Match the existing style: e.g. "${(g.samples || [])[0] || ''}"`), 'Conventional commits (feat:, fix:, chore:)', 'Short imperative summary, under 72 characters']);
  add('design', 'UI design?', [ui ? 'Reuse existing components and design tokens; no new colours or fonts without asking' : 'No UI in this repo', 'Tailwind with a small set of design tokens', 'CSS modules, one stylesheet per component', 'Accessible by default: labels, focus states, WCAG AA contrast']);
  add('comments', 'Comments and docs?', ['Comment why, not what; keep comments short', 'Doc comments on every exported function', 'Minimal comments']);
  return q;
}

const clean = (s) => String(s).replace(/ \(detected[^)]*\)/, '');
export function rulesBlock(answers, h) {
  const a = (k) => answers[k] && clean(answers[k]);
  const L = [START, '## How to write code here (skillhawk setup)', ''];
  if (a('language')) L.push(`- Language: ${a('language')}.`);
  if (a('formatter')) L.push(/^None/.test(a('formatter')) ? '- Formatting: no formatter is configured; match the surrounding code.' : `- Formatter/linter: ${a('formatter')}. Run it before you finish.`);
  const style = [a('indent') && `${a('indent')} indentation`, a('quotes'), a('semicolons') && (/^as /.test(a('semicolons')) ? 'semicolons as in the existing code' : `semicolons ${a('semicolons')}`), a('modules')].filter(Boolean);
  if (style.length) L.push(`- Style: ${style.join(', ')}.`);
  if (a('naming')) L.push(`- Naming: ${a('naming')}.`);
  if (a('tests')) L.push(`- Tests: ${a('tests')}.`);
  if (a('architecture')) L.push(`- Architecture: ${a('architecture')}.`);
  if (a('commits')) L.push(`- Commits: ${a('commits')}.`);
  if (a('design') && !/^No UI/.test(a('design'))) L.push(`- UI: ${a('design')}.`);
  if (a('comments')) L.push(`- Comments: ${a('comments')}.`);
  const level = answers.inRules || 'medium'; // from the health settings; 'none' keeps findings out of the rules
  const known = level === 'none' ? [] : (h?.findings || []).filter((x) => x.severity === 'high' || (level === 'medium' && x.severity === 'medium')).slice(0, 5);
  if (known.length) { L.push('', 'Known problems (from `skillhawk health`); do not make these worse, and fix them when you touch that code:'); for (const x of known) L.push(`- ${x.title}: ${x.evidence.slice(0, 140)}`); }
  L.push(END);
  return L.join('\n');
}

/** Insert or replace the block in AGENTS.md; make CLAUDE.md import AGENTS.md. Returns the files written. */
export function writeRules(root, block) {
  const written = [];
  const agents = path.join(root, 'AGENTS.md');
  let t = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : '# AGENTS.md\n';
  t = t.includes(START) ? t.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block) : `${t.replace(/\s*$/, '')}\n\n${block}\n`;
  fs.writeFileSync(agents, t); written.push('AGENTS.md');
  const claude = path.join(root, 'CLAUDE.md');
  const c = fs.existsSync(claude) ? fs.readFileSync(claude, 'utf8') : '';
  if (!/^@AGENTS\.md\s*$/m.test(c)) { fs.writeFileSync(claude, c ? `${c.replace(/\s*$/, '')}\n\n@AGENTS.md\n` : '@AGENTS.md\n'); written.push('CLAUDE.md'); }
  return written;
}

export async function setup(root = '.', { answers = null, yes = false, ask = null, only = null } = {}) {
  root = path.resolve(root);
  const given = answers || {};
  const parts = only ? [only] : given.parts ? parseAnswer(PARTS, given.parts) : (yes || !ask ? PARTS.default : parseAnswer(PARTS, await ask(PARTS)));
  const out = { parts, written: [] };
  if (parts.includes('health')) {
    const a = await interviewOf(HEALTH_QUESTIONS, async (q) => (yes || !ask ? undefined : ask(q)), given.health || {});
    out.healthConfig = healthConfig(a);
    out.written.push(path.relative(root, saveHealth(root, out.healthConfig)));
  }
  if (parts.includes('factory')) {
    const a = await interviewOf(FACTORY_QUESTIONS, async (q) => (yes || !ask ? undefined : ask(q)), given.factory || {});
    out.factoryConfig = factoryConfig(a);
    out.written.push(path.relative(root, saveFactory(root, out.factoryConfig)));
  }
  if (parts.includes('brain')) {
    const a = await interviewOf(BRAIN_QUESTIONS, async (q) => (yes || !ask ? undefined : ask(q)), given.brain || {});
    out.brainConfig = brainConfig(a, root);
    out.written.push(saveBrain(out.brainConfig, root).replace(`${root}${path.sep}`, ''));
  }
  if (parts.includes('rules')) {
    const c = detectConventions(root); try { c.git = c.git || gitStyle(root); } catch { /* not a git repo */ }
    let h = null; try { h = health(root); } catch { /* still useful without it */ }
    const qs = questions(c, h);
    const chosen = {};
    for (const q of qs) chosen[q.id] = given[q.id] ?? (yes || !ask ? q.options[0] : await ask(q));
    const hc = out.healthConfig || loadHealth(root);
    const block = rulesBlock({ ...chosen, inRules: hc?.inRules }, h);
    out.written.push(...writeRules(root, block));
    fs.mkdirSync(path.join(root, '.skillhawk'), { recursive: true });
    fs.writeFileSync(path.join(root, '.skillhawk', 'setup.json'), `${JSON.stringify({ answers: chosen, at: new Date().toISOString() }, null, 2)}\n`);
    Object.assign(out, { chosen, block, health: h && { grade: h.grade, score: h.score, counts: h.counts } });
  }
  return out;
}

/** Same as brain-config interview, for any list of questions. */
async function interviewOf(qs, ask, given) {
  const a = {};
  for (const q of qs) { if (q.when && !q.when(a)) continue; a[q.id] = parseAnswer(q, given[q.id] !== undefined ? given[q.id] : await ask(q)); }
  return a;
}

async function ttyAsk(rl, q) {
  const label = (x) => (typeof x === 'string' ? x : x.label);
  const opts = (q.options || []).map((x, i) => `  ${i + 1}. ${label(x)}`).join('\n');
  const hint = q.text ? '' : q.multi ? '  numbers, comma-separated. Enter = the defaults' : `  or type your own${q.free ? ` (${q.free.replace(/^or type /, '')})` : ''}. Enter = 1`;
  const a = (await rl.question(`\n${q.question}${q.why ? `  (${q.why})` : ''}\n${opts}${opts ? '\n' : ''}${hint}: `)).trim();
  if (q.text || q.multi || typeof (q.options || [])[0] !== 'string') return a || undefined;
  if (!a) return q.options[0];
  const n = Number(a); return Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1] : a;
}

const plainQ = ({ when, ...q }) => ({ ...q, ...(when ? { askIf: String(when).replace(/^\(a\) => /, '') } : {}) });

export async function run(args, flags = {}) {
  // `--yes <dir>` and `--detect <dir>`: the parser hands the folder to the flag; take it back.
  const root = args[0] || [flags.yes, flags.detect].find((v) => typeof v === 'string') || '.';
  if (flags.detect) { // the questions with detected defaults, for an agent to walk the user through
    const c = detectConventions(path.resolve(root)); try { c.git = c.git || gitStyle(path.resolve(root)); } catch { /* not a git repo */ } let h = null; try { h = health(root); } catch { /* ignore */ }
    const qs = questions(c, h);
    const all = { parts: plainQ(PARTS), rules: qs, health: HEALTH_QUESTIONS.map(plainQ), factory: FACTORY_QUESTIONS.map(plainQ), brain: BRAIN_QUESTIONS.map(plainQ) };
    if (flags.json) return void console.log(JSON.stringify({ questions: qs, groups: all, answersShape: '{"parts":["rules","health"], <rules ids>: "...", "health": {...}, "factory": {...}, "brain": {...}}', health: h && { grade: h.grade, score: h.score, counts: h.counts } }, null, 2));
    for (const q of qs) console.log(`${q.question}\n${q.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}\n`);
    return;
  }
  const answers = typeof flags.answers === 'string' ? JSON.parse(fs.readFileSync(flags.answers, 'utf8')) : null;
  const interactive = !answers && !flags.yes && process.stdin.isTTY;
  let rl = null;
  if (interactive) { rl = readline.createInterface({ input: process.stdin, output: process.stdout }); console.log('skillhawk setup: your choices, nothing assumed. Where an option says "(detected)" it is what your code already does.'); }
  const only = typeof flags.only === 'string' ? flags.only : null;
  if (only && !PARTS.options.some((x) => x.value === only)) throw new Error(`--only takes one of: ${PARTS.options.map((x) => x.value).join(', ')}`);
  try {
    const r = await setup(root, { answers, only, yes: !!flags.yes || !interactive, ask: rl ? (q) => ttyAsk(rl, q) : null });
    if (r.block) console.log(`\n${r.block.replace(/<!--.*?-->\n?/g, '').trim()}\n`);
    if (r.healthConfig) { const c = r.healthConfig; console.log(`health: checks ${c.sections.join(', ')}; files over ${c.limits.fileLines} lines, functions over ${c.limits.fnLines}, nesting over ${c.limits.nesting}${c.ignore.length ? `; skips ${c.ignore.join(', ')}` : ''}; grade ${c.grade ? 'shown' : 'hidden'}`); }
    if (r.factoryConfig) { const c = r.factoryConfig; console.log(`factory: a workflow is ${c.minCount} times in ${c.minSessions} sessions; ${{ agent: 'drafted by your agent CLI', template: 'drafted as a template you fill in', list: 'listed, never drafted' }[c.draft]}${c.draft !== 'list' ? `; install gate: ${c.gate}; installs to ${c.install}${c.compile ? ' + other agents' : ''}` : ''}`); }
    if (r.brainConfig) console.log(`brain:\n${describeBrain(r.brainConfig).replace(/^/gm, '  ')}`);
    console.log(`\nwrote ${r.written.join(', ')}${r.written.includes('CLAUDE.md') ? ' (CLAUDE.md imports AGENTS.md)' : ''}. Change any part later: skillhawk setup --only <${PARTS.options.map((x) => x.value).join('|')}>`);
    if (r.health) console.log(`health: ${r.health.grade} (${r.health.score}/100), ${r.health.counts.high} high, ${r.health.counts.medium} medium. Details: skillhawk health`);
  } finally { rl?.close(); }
}
