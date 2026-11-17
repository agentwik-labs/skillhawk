// skillhawk create: one front door to a complete, review-passing skill.
// Sources: an interview (TTY), --answers a.json, --from doc.md (deterministic extraction; --allow-model may fill gaps),
// or --from-chats (a "no skill covers this" proposal from `review --chats` storage or Studio's state).
// Reuses the generators (web/generators.js via generate.js), review, secure and the static trigger test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { GENERATORS, buildSkill } from './generate.js';
import { reviewDir, fixDir } from './review.js';
import { secureScan } from './secure.js';
import { staticTest } from './devloop.js';
import { loadProposals } from './review-chats.js';

// Plain-language choices for the interview, in the order they are shown.
export const KINDS = [
  ['procedure', 'Steps to follow in order, the same way every time'],
  ['checklist', 'Things to check before something ships'],
  ['voice', 'How we write and sound'],
  ['playbook', 'What to do in a particular customer or sales situation'],
  ['decision', 'Who may approve what, and when'],
  ['metric', 'How a number or report is defined'],
];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(clean).filter(Boolean);
const q = (s) => JSON.stringify(String(s));

// ---- deterministic document extraction --------------------------------------------------------

// Which section headings feed which field.
const HEADS = {
  before: /before|prereq|require|access|inputs?\b|preparation/i,
  steps: /steps?|procedure|process|how to|instructions|play\b|runbook|checklist/i,
  rules: /rules?|policy|policies|guidelines?|principles|constraints|must|never|always/i,
  escalate: /escalat|stop|abort|when to call|rollback/i,
  output: /output|deliver|report|produce|result|format/i,
  blockers: /blockers?|must fix|required|critical/i,
  warnings: /should fix|warnings?|nice to have|recommend/i,
  skip: /do not flag|ignore|skip|out of scope/i,
  definitions: /definitions?|formulas?|metrics?/i,
  sources: /data|sources?/i,
  checks: /sanity|checks?|validat/i,
  do: /^always|do\b/i,
  avoid: /never say|avoid|banned/i,
  objections: /objections?/i,
  approvers: /approvers?|limits|authority/i,
  never: /never allowed|never|prohibited/i,
};

/** Split markdown into { title, intro, sections: [{ head, paras, items, numbered }] }. */
export function parseDoc(text) {
  const lines = String(text).replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let title = '';
  const intro = [];
  const sections = [];
  let cur = null;
  let fence = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^```/.test(l.trim())) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      if (h[1].length === 1 && !title) { title = clean(h[2]); continue; }
      cur = { head: clean(h[2]), paras: [], items: [], numbered: 0 };
      sections.push(cur);
      continue;
    }
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(l);
    const bul = /^\s*[-*•]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
    if (!cur && (num || bul || l.trim())) { if (!num && !bul) intro.push(clean(l)); else { cur = { head: '', paras: [], items: [], numbered: 0 }; sections.push(cur); } }
    if (!cur) continue;
    if (num) { cur.items.push(clean(num[1])); cur.numbered++; } else if (bul) cur.items.push(clean(bul[1]));
    else if (l.trim()) { if (/^\s{2,}\S/.test(raw) && cur.items.length) cur.items[cur.items.length - 1] += ` ${clean(l)}`; else cur.paras.push(clean(l)); }
  }
  return { title, intro: intro.join(' '), sections };
}

/** Pick a generator from the document when none was named. */
export function guessKind(doc) {
  const heads = doc.sections.map((s) => s.head).join(' | ');
  const numbered = doc.sections.reduce((n, s) => n + s.numbered, 0);
  if (numbered >= 2) return 'procedure';
  if (/checklist|blockers?|must fix/i.test(`${doc.title} ${heads}`)) return 'checklist';
  if (/tone|voice|never say/i.test(`${doc.title} ${heads}`)) return 'voice';
  if (/approv|discount|refund|policy/i.test(`${doc.title} ${heads}`)) return 'decision';
  if (/definition|metric|formula/i.test(`${doc.title} ${heads}`)) return 'metric';
  if (/objection|playbook|renewal|discovery/i.test(`${doc.title} ${heads}`)) return 'playbook';
  return 'procedure';
}

/** Fill generator answers from a document with no model. Ordered steps stay in document order. */
export function answersFromDoc(genId, text) {
  const g = GENERATORS.find((x) => x.id === genId);
  if (!g) throw new Error(`unknown generator ${genId}`);
  const doc = parseDoc(text);
  const used = new Set();
  const a = {};
  const take = (key, pred) => {
    const s = doc.sections.find((x) => !used.has(x) && pred(x) && (x.items.length || x.paras.length));
    if (!s) return false;
    used.add(s);
    a[key] = s.items.length ? s.items : [s.paras.join(' ')];
    return true;
  };
  const textKeys = new Set(g.fields.filter((f) => f.kind !== 'list').map((f) => f.key));
  for (const f of g.fields) {
    if (!HEADS[f.key] || ['name', 'triggers', 'example_request', 'must_include'].includes(f.key)) continue;
    if (f.key === 'steps') { if (take('steps', (s) => s.numbered >= 1 && HEADS.steps.test(s.head)) || take('steps', (s) => s.numbered >= 2) || take('steps', (s) => HEADS.steps.test(s.head))) continue; }
    else if (take(f.key, (s) => HEADS[f.key].test(s.head))) continue;
  }
  // Required list left empty: fall back to the first unclaimed list in the document.
  for (const f of g.fields.filter((x) => x.required && x.kind === 'list' && !['triggers'].includes(x.key))) {
    if (!asList(a[f.key]).length) take(f.key, (s) => s.items.length >= 2);
  }
  // Text fields come back as one string.
  for (const k of textKeys) if (Array.isArray(a[k])) a[k] = a[k].join(k === 'output' ? ' ' : ' ');
  // Rules written inline ("never ...", "always ...", "must ...") when no rules section exists.
  const ruleField = g.fields.find((f) => ['rules', 'never'].includes(f.key));
  if (ruleField && !asList(a[ruleField.key]).length) {
    const inline = doc.sections.flatMap((s) => [...s.items, ...s.paras]).filter((x) => /\b(never|always|must|do not|don't)\b/i.test(x)).slice(0, 8);
    if (inline.length) a[ruleField.key] = inline;
  }
  const first = (k) => g.fields.some((f) => f.key === k) && !asList(a[k]).length;
  const lead = doc.intro || doc.sections.find((s) => s.paras.length)?.paras[0] || doc.title;
  for (const k of ['job', 'reviews', 'situation', 'decision', 'report', 'audience', 'goal']) if (first(k)) a[k] = k === 'goal' ? `Complete the work described in ${doc.title || 'the document'}.` : lead;
  if (first('output')) a.output = 'A short summary of what was done, what was found and what is left for a person to decide.';
  if (first('company')) a.company = doc.title || 'Our team';
  a.name = slug(doc.title) || 'new-skill';
  a.title = doc.title || undefined;
  if (!a.title) delete a.title;
  return a;
}

/** Model fills ONLY the fields still empty (confined call via generate.js -> studio/llm.js). */
export async function fillGaps(genId, answers, text, opts = {}) {
  const { answersFromDocument } = await import('./generate.js');
  const g = GENERATORS.find((x) => x.id === genId);
  const gaps = g.fields.filter((f) => f.required && !asList(answers[f.key]).length).map((f) => f.key);
  if (!gaps.length) return answers;
  const filled = await (opts.fill || answersFromDocument)(genId, text, { model: opts.model || 'sonnet' });
  const out = { ...answers };
  for (const k of gaps) if (asList(filled?.[k]).length) out[k] = filled[k];
  return out;
}

// ---- chats ---------------------------------------------------------------------------------

/** Newest pending "no skill covers this" proposal from review --chats storage, else Studio's state. */
export function pickNoSkillProposal(data, id) {
  const fromChats = loadProposals(data);
  let studio = [];
  try { studio = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).proposals || []; } catch { /* none */ }
  const all = [...fromChats, ...studio].filter((p) => p.status === 'pending' && (p.kind === 'no-skill' || (p.kind === 'no-skill' && !p.skill)));
  const p = id && id !== true ? all.find((x) => x.id === id) : all.sort((a, b) => String(b.created || b.createdAt).localeCompare(String(a.created || a.createdAt)))[0];
  if (!p) throw new Error(`no pending "no skill covers this" proposal in ${data} (run skillhawk review --chats first)`);
  return p;
}

export function answersFromProposal(p) {
  const ev = (p.evidence || []).filter((e) => clean(e.asked) || clean(e.said));
  const asked = [...new Set(ev.map((e) => clean(e.asked)).filter(Boolean))];
  const said = [...new Set(ev.map((e) => clean(e.said)).filter(Boolean))];
  if (!ev.length) throw new Error(`proposal ${p.id} has no evidence to draft from`);
  return {
    name: slug(asked[0] || said[0]) || `chat-${p.id}`,
    reviews: `Work like "${asked[0] || 'the requests below'}" so it matches how you corrected the agent in past sessions.`,
    blockers: said.map((s) => `Follow what you said before: ${s}`),
    triggers: asked.slice(0, 3),
    should_fire: asked.slice(0, 3),
    output: 'A ranked list of what to fix, where, and the exact change.',
  };
}

// ---- cases + assembly ---------------------------------------------------------------------------

export function casesYaml({ fire = [], notFire = [], request = '', checks = [] }) {
  const o = ['# Trigger cases: does an agent pick THIS skill from its description alone? (skillhawk test <dir>)'];
  o.push('should_fire:', ...fire.map((p) => `  - ${q(p)}`));
  if (notFire.length) o.push('should_not_fire:', ...notFire.map((p) => `  - ${q(p)}`));
  if (request && checks.length) o.push('', 'behaviour:', `  - prompt: ${q(request)}`, `    rubric: ${q(`A good answer: ${checks.join('; ')}`)}`);
  return `${o.join('\n')}\n`;
}

/** Normalise answers: examples become triggers; "not for" becomes the description's last sentence. */
export function shapeAnswers(genId, raw, nameArg) {
  const a = { ...raw };
  const fire = asList(a.should_fire || a.examples || a.triggers).slice(0, 6);
  const notFire = asList(a.should_not_fire || a.not_for);
  a.triggers = fire;
  if (nameArg) a.name = nameArg;
  if (!a.name) a.name = slug(fire[0]) || 'new-skill';
  return { answers: a, fire, notFire };
}

export function createSkill({ generator, answers: raw, name, out = '.', force = false, license = 'Proprietary', author = '' }) {
  const g = generator || raw.generator || 'procedure';
  if (!GENERATORS.some((x) => x.id === g)) throw new Error(`unknown generator "${g}" (${GENERATORS.map((x) => x.id).join(', ')})`);
  const { answers, fire, notFire } = shapeAnswers(g, raw, name);
  if (fire.length < 1) throw new Error('give at least one example request (triggers / should_fire); three is better');
  const r = buildSkill(g, answers, { license, author });
  if (r.missing.length) throw new Error(`missing answers: ${r.missing.join('; ')}`);
  if (!r.valid) throw new Error(`generated skill is invalid: ${[...r.errors, ...r.scan.map((s) => s.message)].join('; ')}`);
  if (notFire.length) {
    // Say when NOT to use it in the body; kept out of the description so those words never attract the wrong requests.
    r.files['SKILL.md'] = r.files['SKILL.md'].replace(/\n+$/, `\n\n## Not for\n\nDo not use this skill for requests like:\n\n${notFire.map((x) => `- ${x}`).join('\n')}\n`);
  }
  r.files['tests/cases.yaml'] = casesYaml({ fire, notFire, request: clean(answers.example_request), checks: asList(answers.must_include) });
  const dir = path.resolve(out, r.name);
  if (fs.existsSync(dir) && !force) throw new Error(`${dir} exists (use --force)`);
  for (const [rel, text] of Object.entries(r.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.writeFileSync(path.join(dir, 'generator-answers.json'), `${JSON.stringify(answers, null, 2)}\n`);
  return { dir, name: r.name, generator: g };
}

// ---- checks after writing ---------------------------------------------------------------------

export const gradeOk = (g) => 'AB'.includes(g);

export function checkSkill(dir) {
  const rev = reviewDir(dir);
  const sec = secureScan([dir]);
  const t = staticTest(dir, {});
  const high = sec.findings.filter((f) => f.severity === 'high');
  const ok = gradeOk(rev.grade) && !high.length && !t.fail && !t.errors.length;
  return { rev, high, secure: sec, test: t, ok };
}

export function summary(c) {
  return [
    `review: ${c.rev.grade} (${c.rev.score}/100)${c.rev.findings.length ? `, ${c.rev.findings.length} finding${c.rev.findings.length === 1 ? '' : 's'}` : ''}`,
    `secure: ${c.high.length ? `${c.high.length} high` : 'no high findings'} (${c.secure.medium} medium, ${c.secure.low} low)`,
    `test: ${c.test.errors.length ? `error: ${c.test.errors[0]}` : `${c.test.pass} passed, ${c.test.fail} failed (static trigger cases)`}`,
  ];
}

// ---- interview ---------------------------------------------------------------------------------

export async function interview(rl, say = (s) => console.log(s)) {
  say('What kind of know-how is this?\n');
  KINDS.forEach(([, label], i) => say(`  ${i + 1}. ${label}`));
  let n = 0;
  while (!(n >= 1 && n <= KINDS.length)) n = Number(clean(await rl.question('\nPick a number: ')));
  const gen = GENERATORS.find((g) => g.id === KINDS[n - 1][0]);
  const a = {};
  const skip = ['name', 'triggers', 'example_request', 'must_include'];
  for (const f of gen.fields) {
    if (skip.includes(f.key)) continue;
    const list = f.kind === 'list';
    say(`\n${f.label}${f.required ? '' : ' (optional, Enter to skip)'}${f.help ? `\n  ${f.help}` : ''}${list ? '\n  One per line, blank line to finish.' : ''}`);
    if (list) {
      const items = [];
      for (;;) { const l = clean(await rl.question('> ')); if (!l) { if (items.length || !f.required) break; continue; } items.push(l); }
      a[f.key] = items;
    } else {
      let l = '';
      do { l = clean(await rl.question('> ')); } while (!l && f.required);
      a[f.key] = l;
    }
  }
  const lines = async (prompt, min) => {
    say(`\n${prompt}\n  One per line, blank line to finish.`);
    const items = [];
    for (;;) { const l = clean(await rl.question('> ')); if (!l) { if (items.length >= min) break; continue; } items.push(l); }
    return items;
  };
  a.should_fire = await lines('When should the agent use this? Give 3 example requests.', 1);
  a.should_not_fire = await lines('When should it NOT? Give an example request that looks similar but belongs elsewhere (optional).', 0);
  say('\nName for the skill (lowercase-with-hyphens)');
  a.name = slug(await rl.question(`> [${slug(a.should_fire[0])}] `)) || slug(a.should_fire[0]);
  say('\nOne realistic request to test it with (optional)');
  a.example_request = clean(await rl.question('> '));
  if (a.example_request) a.must_include = await lines('A good answer must... (one check per line)', 0);
  return { generator: gen.id, answers: a };
}

// ---- command ---------------------------------------------------------------------------------

export async function createCmd(args, f, io = {}) {
  f = { ...f, fromChats: f.fromChats ?? f['from-chats'], allowModel: f.allowModel ?? f['allow-model'] };
  const say = io.say || ((s) => console.log(s));
  const tty = io.tty ?? (process.stdin.isTTY && process.stdout.isTTY);
  const str = (v) => (v && v !== true ? String(v) : '');
  let generator = str(f.generator || f.kind);
  let answers;
  let docText = '';
  const nameArg = args[0];
  let rl = null;
  try {
    if (f.answers) {
      answers = JSON.parse(fs.readFileSync(str(f.answers), 'utf8'));
      generator ||= answers.generator || 'procedure';
    } else if (f.from) {
      docText = fs.readFileSync(str(f.from), 'utf8');
      generator ||= guessKind(parseDoc(docText));
      answers = answersFromDoc(generator, docText);
      if (f.allowModel) answers = await fillGaps(generator, answers, docText, { model: str(f.model) || 'sonnet', fill: io.fill });
      // Examples still have to come from a person.
      answers.should_fire = answers.should_fire || (f.examples ? asList(str(f.examples).split('|')) : []);
      if (!answers.should_fire.length) {
        if (!tty && !io.rl) throw new Error('--from needs example requests: add "should_fire" via --answers, or run in a terminal to be asked');
        rl = io.rl || readline.createInterface({ input: process.stdin, output: process.stdout });
        say('\nWhen should the agent use this? Give 3 example requests.\n  One per line, blank line to finish.');
        answers.should_fire = [];
        for (;;) { const l = clean(await rl.question('> ')); if (!l) { if (answers.should_fire.length) break; continue; } answers.should_fire.push(l); }
        say('\nWhen should it NOT use it? Example requests, optional.');
        answers.should_not_fire = [];
        for (;;) { const l = clean(await rl.question('> ')); if (!l) break; answers.should_not_fire.push(l); }
      }
    } else if (f.fromChats) {
      const data = path.resolve(str(f.data).replace(/^~(?=$|\/)/, os.homedir()) || path.join(os.homedir(), '.skillyard', 'studio'));
      const p = pickNoSkillProposal(data, f.fromChats);
      say(`drafting from proposal ${p.id} (${p.count || p.evidence?.length || 0} correction${(p.count || 1) === 1 ? '' : 's'} no skill covered)`);
      generator ||= 'checklist';
      answers = answersFromProposal(p);
    } else {
      if (!tty && !io.rl) throw new Error('create needs a terminal for the interview, or one of: --answers a.json, --from doc.md, --from-chats');
      rl = io.rl || readline.createInterface({ input: process.stdin, output: process.stdout });
      const r = await interview(rl, say);
      generator = r.generator;
      answers = r.answers;
    }
    const made = createSkill({ generator, answers, name: nameArg, out: str(f.out) || '.', force: !!f.force, license: str(f.license) || 'Proprietary', author: str(f.author) });
    say(`created ${made.dir} (${made.generator})`);
    let c = checkSkill(made.dir);
    if (!gradeOk(c.rev.grade) && (rl || tty)) {
      for (const x of c.rev.findings.slice(0, 6)) say(`  ${x.severity.padEnd(6)} ${x.file}:${x.line} [${x.rule}] ${x.message}`);
      const yes = /^y/i.test(clean(await (rl ||= readline.createInterface({ input: process.stdin, output: process.stdout })).question('Apply the safe mechanical fixes (BOM, license header, frontmatter spacing)? [y/N] ')));
      if (yes) { fixDir(made.dir); c = checkSkill(made.dir); }
    }
    summary(c).forEach((l) => say(l));
    if (!gradeOk(c.rev.grade)) {
      for (const x of c.rev.findings.slice(0, 6)) say(`  ${x.severity.padEnd(6)} ${x.file}:${x.line} [${x.rule}] ${x.message}\n         fix: ${x.fix || 'edit the line'}`);
      say(`fix and re-check: skillhawk review ${made.dir} --fix`);
    }
    if (!c.ok) process.exitCode = 1;
    return { ...made, check: c };
  } finally {
    if (rl && !io.rl) rl.close();
  }
}
