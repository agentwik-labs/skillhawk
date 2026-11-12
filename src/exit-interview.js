// Exit interview: capture what only one person knows, draft skills from it, check them, save as private org drafts.
// No model calls. Questions can be seeded from the person's repeated corrections in agent logs (review --chats detection).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createSkill, checkSkill, summary } from './create.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const list = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => (typeof x === 'string' ? clean(x) : x)).filter(Boolean);
const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Repeated corrections from a folder of agent logs: [{said, count}]. Reuses review --chats detection. */
export async function seedFromLogs(dir) {
  const rc = await import('./review-chats.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-exit-'));
  const log = console.log;
  console.log = () => {};
  try {
    const emptySkills = path.join(tmp, 'skills');
    fs.mkdirSync(emptySkills);
    const r = await rc.run([], { chats: true, yes: true, logs: dir, skills: emptySkills, data: path.join(tmp, 'data') });
    const seen = new Map();
    for (const p of r.proposals) for (const e of p.evidence) { const k = clean(e.said); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
    return [...seen].map(([said, count]) => ({ said, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  } finally {
    console.log = log;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const pair = (x, a, b) => (typeof x === 'string' ? x : `${x[a]} -> ${x[b]}`);

/** Interview answers -> procedure-generator answers. */
export function toAnswers(member, a, seeds = []) {
  const systems = list(a.systems);
  const fixes = list(a.recurring_fixes ?? a.fixes).map((x) => (typeof x === 'string' ? x.split(/\s*(?:->|=>)\s*/) : [x.symptom, x.fix])).filter((p) => p[0] && p[1]);
  const people = list(a.people).map((x) => pair(x, 'who', 'when'));
  const gotchas = [...list(a.gotchas), ...seeds.map((s) => `${s.said} — ${member} corrected the agent on this ${s.count} time${s.count === 1 ? '' : 's'}`)];
  if (!systems.length && !fixes.length) throw new Error('need at least one system or recurring fix');
  const triggers = list(a.triggers).length ? list(a.triggers) : [
    ...fixes.slice(0, 3).map(([s]) => `how do we fix ${s}`),
    ...systems.slice(0, 2).map((s) => `who owns ${s}`),
    `what does ${member} know about ${systems[0] || fixes[0][0]}`,
  ].slice(0, 5);
  return {
    generator: 'procedure',
    name: a.name || `${slug(member)}-know-how`,
    job: `What ${member} knows about ${systems.join(', ') || 'their area'} that is written down nowhere else: how to fix recurring problems, who to call, and the traps.`,
    before: systems.map((s) => `System ${member} owned: ${s}`),
    steps: fixes.length ? fixes.map(([s, f]) => `When ${s}: ${f}`) : systems.map((s) => `Check ${s} before changing it, and ask the people listed below if it behaves oddly`),
    rules: gotchas,
    escalate: people.length ? `Call the right person: ${people.join('; ')}.` : '',
    output: 'A short answer: the system involved, the fix steps from this runbook in order, and who to call if the fix does not work.',
    triggers,
    example_request: fixes.length ? `${fixes[0][0]}: what should I do?` : `Who knows about ${systems[0]}?`,
    must_include: fixes.length ? [`gives the fix: ${fixes[0][1]}`, ...(people.length ? ['names who to call'] : [])] : ['names who to call'],
  };
}

async function ask(member, seeds) {
  if (!process.stdin.isTTY) throw new Error('exit-interview needs a terminal; pass --answers answers.json instead');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const many = async (q) => { console.log(`\n${q}\n  One per line, blank line to finish.`); const o = []; for (;;) { const l = clean(await rl.question('> ')); if (!l) break; o.push(l); } return o; };
  try {
    if (seeds.length) {
      console.log(`\nIn their agent logs, ${member} repeatedly corrected the agent:`);
      seeds.forEach((s) => console.log(`  - (${s.count}x) ${s.said}`));
      console.log('Keep these in mind while answering; they are added to the gotchas.');
    }
    return {
      systems: await many('Which systems, jobs or accounts do you own that nobody else fully understands?'),
      recurring_fixes: await many('What breaks again and again, and how do you fix it? Write "symptom -> fix".'),
      people: await many('Which people should someone call, and for what? "Name — when".'),
      gotchas: await many('What are the traps and gotchas (things that look safe but are not)? "trap — why".'),
    };
  } finally { rl.close(); }
}

export async function exitInterviewCmd(args, f) {
  const member = args[0];
  if (!member) throw new Error('usage: skillyard exit-interview <member> [--answers a.json] [--from-logs dir] [--out skills/] [--force]');
  const seeds = f['from-logs'] && f['from-logs'] !== true ? await seedFromLogs(path.resolve(f['from-logs'])) : [];
  const raw = f.answers && f.answers !== true ? JSON.parse(fs.readFileSync(f.answers, 'utf8')) : await ask(member, seeds);
  const sets = Array.isArray(raw.skills) ? raw.skills : [raw];
  const out = path.resolve(f.out && f.out !== true ? f.out : 'skills');
  const drafts = [];
  for (const [i, set] of sets.entries()) {
    const r = createSkill({ generator: 'procedure', answers: toAnswers(member, set, i === 0 ? seeds : []), out, force: !!f.force, license: 'Proprietary', author: member });
    const check = checkSkill(r.dir);
    console.log(`${r.name}: ${summary(check).join(' | ')}`);
    if (!check.ok) throw new Error(`${r.name} did not pass review/secure/test; fix ${r.dir} before publishing`);
    const mf = path.join(r.dir, 'skill.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    fs.writeFileSync(mf, `${JSON.stringify({ ...m, visibility: 'private', draft: true, capturedFrom: member }, null, 2)}\n`);
    drafts.push({ name: r.name, dir: r.dir, grade: check.rev.grade });
  }
  console.log(`\n${drafts.length} private draft${drafts.length === 1 ? '' : 's'} saved in ${out}. Publish with: skillyard publish <dir> --org <org> (the org's normal checks apply).`);
  return { drafts, seeds };
}
