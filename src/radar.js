// skillyard radar: across several people's session logs, find corrections that keep coming back, rank them by
// people affected x frequency, and draft a tested skill for the top clusters. Local only: no model, no network, no push.
// Output holds counts of people, never raw chats; the drafted skill uses the same redacted text review --chats stores.
//   skillyard radar <dir...> [--logs dir[,dir]] [--team] [--min-people 2] [--days 14] [--top 3] [--out .skillyard/radar] [--branch]
// Each dir is one person's logs; with --team each immediate subfolder of a dir is a person (a team export).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { scanSession } from './studio/capture.js';
import { excluder } from './review-chats.js';
import { listJsonl } from './tokens.js';
import { answersFromProposal, createSkill, checkSkill, summary } from './create.js';

const STOP = new Set('this that with from have your when what then than they them were will would should could about into just also only some more please there here over under after before while which where being been using used the and for you are not but can let get use now one all any out how why its our dont didnt doesnt isnt wasnt'.split(' '));

/** Word unigrams + bigrams ("shingles") of a correction. */
export function shingles(text) {
  const w = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((x) => x.length >= 3 && !STOP.has(x)).map((x) => x.replace(/(ing|ed|es|s)$/, ''));
  const set = new Set(w);
  for (let i = 0; i < w.length - 1; i++) set.add(`${w[i]} ${w[i + 1]}`);
  return set;
}
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

/** Greedy single-link clustering of corrections by shingle similarity. */
export function cluster(items, threshold = 0.3) {
  const cl = [];
  for (const it of items) {
    const sh = shingles(`${it.said} ${it.asked}`.trim());
    let best = null;
    let bs = 0;
    for (const c of cl) { const s = Math.max(...c.shingles.map((x) => jac(sh, x))); if (s >= threshold && s > bs) { best = c; bs = s; } }
    if (best) { best.items.push(it); best.shingles.push(sh); } else cl.push({ items: [it], shingles: [sh] });
  }
  return cl.map(({ items: its }) => {
    const people = new Set(its.map((i) => i.person));
    const id = crypto.createHash('sha1').update(its.map((i) => i.id).sort().join(',')).digest('hex').slice(0, 8);
    return { id, items: its, people: people.size, count: its.length, score: people.size * its.length, sessions: new Set(its.map((i) => `${i.person}/${i.session}`)).size };
  }).sort((a, b) => b.score - a.score || b.people - a.people);
}

function peopleOf(dirs, team) {
  const out = [];
  for (const d of dirs) {
    const root = path.resolve(d);
    if (!fs.existsSync(root)) throw new Error(`no such logs folder: ${d}`);
    if (team) for (const e of fs.readdirSync(root, { withFileTypes: true })) { if (e.isDirectory()) out.push({ name: e.name, dir: path.join(root, e.name) }); }
    else out.push({ name: path.basename(root), dir: root });
  }
  return out;
}

export async function collectTeam({ people, days = 14, now = Date.now(), exclude = [] }) {
  const ex = excluder(exclude);
  const since = days > 0 ? now - days * 86400e3 : 0;
  const items = [];
  for (const p of people) {
    for (const f of listJsonl(p.dir)) {
      if (ex(f)) continue;
      const r = await scanSession(f, 'claude');
      if (r.cwd && ex(r.cwd)) continue;
      for (const c of r.corrections) {
        const ms = c.time ? Date.parse(c.time) : NaN;
        if (!Number.isNaN(ms) && (ms < since || ms > now + 86400e3)) continue;
        items.push({ ...c, person: p.name });
      }
    }
  }
  return items;
}

function git(cwd, ...a) { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

export async function radar({ dirs, team = false, minPeople = 2, days = 14, top = 3, out = '.skillyard/radar', branch = false, now = Date.now(), cwd = process.cwd() }) {
  const people = peopleOf(dirs, team);
  if (people.length < 1) throw new Error('give at least one logs folder (radar <dir...> or --logs)');
  const items = await collectTeam({ people, days, now });
  const clusters = cluster(items).filter((c) => c.people >= minPeople && c.count >= 2);
  const result = { people: people.length, corrections: items.length, clusters: [] };
  for (const c of clusters.slice(0, top)) {
    const evidence = c.items.slice(0, 6).map((i) => ({ asked: i.asked, said: i.said }));
    const entry = { id: c.id, people: c.people, count: c.count, sessions: c.sessions, score: c.score };
    try {
      const answers = answersFromProposal({ id: c.id, evidence });
      const base = path.resolve(cwd, out, c.id);
      fs.rmSync(base, { recursive: true, force: true });
      const made = createSkill({ generator: 'checklist', answers, out: base, force: true });
      const chk = checkSkill(made.dir);
      Object.assign(entry, { skill: made.name, dir: path.relative(cwd, made.dir), grade: chk.rev.grade, ok: chk.ok, secureHigh: chk.high.length, staticTest: { fail: chk.test.fail, errors: chk.test.errors.length }, summary: summary(chk) });
      if (branch) {
        const name = `skillyard/radar-${c.id}`;
        git(cwd, 'switch', '-c', name);
        git(cwd, 'add', '--', path.relative(cwd, base));
        git(cwd, '-c', 'user.name=skillyard', '-c', 'user.email=skillyard@localhost', 'commit', '-m', `Add drafted skill ${made.name} from team corrections (radar ${c.id})`);
        entry.branch = name;
        git(cwd, 'switch', '-');
      }
    } catch (e) { entry.error = e.message; }
    result.clusters.push(entry);
  }
  result.total = clusters.length;
  return result;
}

export function render(r, minPeople) {
  const o = [`Skill radar: ${r.corrections} corrections from ${r.people} ${r.people === 1 ? 'person' : 'people'}; ${r.total} repeated cluster${r.total === 1 ? '' : 's'} hit by at least ${minPeople} people.`];
  for (const c of r.clusters) {
    o.push('', `Cluster ${c.id}: ${c.people} people, ${c.count} corrections in ${c.sessions} sessions (score ${c.score})`);
    if (c.error) { o.push(`  draft failed: ${c.error}`); continue; }
    o.push(`  Drafted skill "${c.skill}" in ${c.dir} (grade ${c.grade}, secure high findings ${c.secureHigh}, static test ${c.staticTest.fail ? 'FAILED' : 'passed'}, ${c.ok ? 'ready for a PR' : 'needs work'})`);
    if (c.branch) o.push(`  Local branch: ${c.branch} (not pushed)`);
  }
  if (!r.clusters.length) o.push('Nothing repeated across people yet.');
  else o.push('', 'PR-ready: each draft has SKILL.md and tests/cases.yaml. Only counts are shown here; raw chats are never printed. Nothing was pushed.');
  return o.join('\n');
}

export async function run(args, flags) {
  if (typeof flags.json === 'string') flags.json = true;
  const dirs = [...args, ...(flags.logs && flags.logs !== true ? String(flags.logs).split(',') : [])].filter(Boolean);
  const minPeople = flags['min-people'] === undefined ? 2 : Number(flags['min-people']);
  const days = flags.days === undefined ? 14 : Number(flags.days);
  if (Number.isNaN(minPeople) || Number.isNaN(days)) throw new Error('--min-people and --days must be numbers');
  const r = await radar({ dirs, team: !!flags.team, minPeople, days, top: flags.top ? Number(flags.top) : 3, out: flags.out && flags.out !== true ? flags.out : '.skillyard/radar', branch: !!flags.branch, now: flags.now ? Number(flags.now) : Date.now() });
  console.log(flags.json ? JSON.stringify(r, null, 2) : render(r, minPeople));
  return r;
}
