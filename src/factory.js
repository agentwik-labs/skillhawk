// skillhawk factory: turn the work you keep asking your agents for into tested skills.
//   1. find  (free, instant, no model): requests you repeat across sessions, grouped into workflows, with how often
//      you had to correct the agent while doing them and whether an installed skill already covers them.
//   2. draft (--draft <id>): your own agent CLI writes the skill from the redacted examples and the corrections you
//      made; it refuses to run on a pay-per-token API key unless you allow it. The draft must pass review (A/B grade),
//      the security scan and the trigger tests, or it is not offered.
//   3. prove (--eval): run the skill's cases with and without it and report the lift.
//   4. ship  (--promote <name>): install it for Claude Code; compile it for the other agents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadFactory, factoryConfig, installDir } from './prefs.js';
import { build as brainBuild, cluster, tokens } from './brain.js';
import { hasConsent, grant, loadSkills, matchScore } from './review-chats.js';
import { repoOf } from './studio/capture.js';
import { createSkill, checkSkill, summary } from './create.js';

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const jac = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return a.size + b.size - n ? n / (a.size + b.size - n) : 0; };
// Approvals, nudges and questions are conversation, not work to automate.
const ACK = /^(yes|yeah|yep|ok|okay|sure|proceed|continue|go ahead|go on|do it|lets? (go|do it|proceed|continue)|i like|sounds good|looks good|great|perfect|nice|thanks|thank you|done|good|cool|next|try again|retry|what (do you think|would|could|about|is|are|did)|why|how (do|does|did|would|could)|can you explain|show me|you do it)\b/i;
const outDir = (repo) => path.join(repo, '.skillhawk', 'factory');

/** Repeated requests -> workflows. Gate: 3+ requests in 3+ sessions. */
export function workflows(asks, corrections, skills = [], { minCount = 3, minSessions = 3 } = {}) {
  const items = asks.filter((a) => !ACK.test(a.text.trim().replace(/^[^a-z]+/i, '')) && !/\?\s*$/.test(a.text.trim()) && tokens(a.text).size >= 3).slice(-1500).map((a) => ({ said: a.text, time: a.time, session: a.session }));
  const out = [];
  for (const c of cluster(items)) {
    const sessions = new Set(c.members.map((m) => m.session));
    if (c.members.length < minCount || sessions.size < minSessions) continue;
    const freq = {};
    for (const m of c.members) for (const t of m.tk) freq[t] = (freq[t] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    const examples = [...new Set(c.members.map((m) => m.said.replace(/\s+/g, ' ').trim()))].slice(0, 6);
    const ctk = new Set(Object.entries(freq).filter(([, n]) => n >= Math.max(2, c.members.length / 3)).map(([t]) => t));
    const fixes = corrections.filter((x) => x.asked && jac(tokens(x.asked), ctk.size ? ctk : c.tk) >= 0.3);
    let covered = null;
    for (const s of skills) { const score = Math.max(...examples.slice(0, 3).map((e) => matchScore(s, e))); if (score >= 3 && (!covered || score > covered.score)) covered = { name: s.name, score }; }
    out.push({ id: sha(examples[0]).slice(0, 6), name: top.join('-'), count: c.members.length, sessions: sessions.size, corrections: fixes.length, examples, correctionsSaid: [...new Set(fixes.map((f) => f.said))].slice(0, 6), covered: covered?.name || null, lastAt: c.members.at(-1).time });
  }
  // most valuable first: often repeated and often corrected
  return out.sort((a, b) => b.count + 3 * b.corrections - (a.count + 3 * a.corrections));
}

export function render(project, wf, prompts, cfg = factoryConfig({})) {
  const L = [`skillhawk factory · ${project}: ${prompts} prompts, ${wf.length} repeated workflow${wf.length === 1 ? '' : 's'}`];
  for (const w of wf.slice(0, 12)) {
    L.push('', `  [${w.id}] ${w.name} · ${w.count}x in ${w.sessions} sessions · ${w.corrections} correction${w.corrections === 1 ? '' : 's'} along the way · ${w.covered ? `covered by skill ${w.covered}` : 'no skill covers it'}`);
    for (const e of w.examples.slice(0, 2)) L.push(`         e.g. "${e.slice(0, 120)}"`);
    L.push(w.covered ? `         improve it with your corrections: skillhawk review --chats` : `         draft a tested skill: skillhawk factory --draft ${w.id}`);
  }
  if (!wf.length) L.push(`  nothing repeated often enough yet (${cfg.minCount}+ times in ${cfg.minSessions}+ sessions${cfg.at ? ', your setting' : ''}).`);
  L.push('', 'Found locally from redacted session logs; no model was used.');
  return L.join('\n');
}

const DRAFT_PROMPT = (w) => `You write agent skills. From these real requests a developer keeps making, and the corrections they had to give the agent, write ONE reusable procedure skill. Return only JSON with keys:
name (kebab-case, 2-4 words), job (one sentence: what the skill does), steps (array of 4-8 concrete steps, each an instruction with the exact command or file where possible), rules (array of 2-6 rules taken from the corrections; each concrete), output (one sentence: what the agent hands back), example_request (one realistic request), must_include (array of 2-4 short things a good answer contains).
Do not invent tools, files or commands that are not implied by the requests. Prefer fewer, concrete steps.

Requests (redacted):
${w.examples.map((e) => `- ${e}`).join('\n')}

Corrections the developer gave while doing this (redacted):
${(w.correctionsSaid.length ? w.correctionsSaid : ['(none)']).map((e) => `- ${e}`).join('\n')}`;

/** Billing guard: drafting runs your agent CLI; never let it bill a pay-per-token key by surprise. */
export function billingGuard(env = process.env, allow = false) {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((k) => env[k]);
  if (keys.length && !allow) throw new Error(`${keys.join(' and ')} ${keys.length > 1 ? 'are' : 'is'} set, so drafting would bill that key per token instead of your subscription. Unset it, or pass --allow-api-key.`);
  return keys;
}

export async function draft(w, { repo, ask, model = 'sonnet' }) {
  const { askJson } = await import('./studio/llm.js');
  const a = await (ask || askJson)(DRAFT_PROMPT(w), { model });
  if (!a || !Array.isArray(a.steps) || !a.steps.length) throw new Error('the model did not return usable steps; try again');
  const answers = { name: a.name || w.name, triggers: w.examples.slice(0, 4), should_fire: w.examples.slice(0, 4), job: a.job, steps: a.steps, rules: a.rules || [], output: a.output, example_request: a.example_request || w.examples[0], must_include: a.must_include || [] };
  const r = createSkill({ generator: 'procedure', answers, out: outDir(repo), force: true, license: 'Proprietary' });
  const check = checkSkill(r.dir);
  return { ...r, check, lines: summary(check) };
}

/** A draft from the user's own requests with the steps left for them to write (draft: template). */
export function templateDraft(w, { repo }) {
  const answers = { name: w.name, triggers: w.examples.slice(0, 4), should_fire: w.examples.slice(0, 4), job: `Handle requests like: "${w.examples[0].slice(0, 120)}"`, steps: ['TODO: write the first step', 'TODO: write the next step'], rules: [], output: 'TODO: what the result looks like', example_request: w.examples[0], must_include: [] };
  const r = createSkill({ generator: 'procedure', answers, out: outDir(repo), force: true, license: 'Proprietary' });
  return { ...r, check: checkSkill(r.dir), lines: ['template written: fill in the steps, the output and the rules, then promote it'] };
}

export function promote(name, { repo, config = loadFactory(repo) || factoryConfig({}) }) {
  const src = path.join(outDir(repo), name);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`no drafted skill ${name} in ${outDir(repo)}`);
  if (config.gate !== 'none') {
    const check = checkSkill(src);
    if (!check.ok) throw new Error(`${name} does not pass the checks yet (${summary(check).join('; ')}); fix the draft first`);
  }
  if (config.gate === 'lift') {
    let ev = null; try { ev = JSON.parse(fs.readFileSync(path.join(src, '.skillhawk-eval.json'), 'utf8')); } catch { /* none yet */ }
    if (!ev || !(ev.lift > 0)) throw new Error(`${name} needs an eval that shows it helps (your setting). Run: skillhawk factory --draft <id> --eval`);
  }
  const dest = path.join(installDir(config, repo), name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true, filter: (f) => !f.endsWith('.skillhawk-eval.json') });
  return dest;
}

export async function run(args, flags = {}) {
  const repo = path.resolve(args[0] || '.');
  const cfg = loadFactory(repo) || factoryConfig({});
  if (flags.promote) {
    const dest = promote(String(flags.promote), { repo, config: cfg });
    console.log(`Installed for Claude Code: ${dest}`);
    if (cfg.compile) { const { compileTarget, resolveTargets } = await import('./compile.js'); for (const t of resolveTargets('all')) { const r = compileTarget(t, dest, repo); console.log(`  ${t}: ${r.ok ? 'ok' : 'check failed'} ${r.files.map((f) => path.relative(repo, f)).join(', ')}`); } }
    else console.log(`For Codex, Cursor, Copilot and Gemini: skillhawk compile ${path.relative(process.cwd(), dest) || dest} --to all`);
    return;
  }
  const data = path.join(os.homedir(), '.skillyard', 'studio');
  if (!hasConsent(data, 'readLogs')) {
    if (flags.yes) grant(data, 'readLogs', 'agent session logs, read locally (factory)');
    else { console.log('The factory reads your agent session logs (Claude Code, Codex) on this machine to find work you repeat. Nothing is uploaded; secrets, emails and numbers are redacted.\nRe-run with --yes to allow it.'); return; }
  }
  const project = typeof flags.project === 'string' ? flags.project : repoOf(repo);
  const logs = typeof flags.logs === 'string' ? path.resolve(flags.logs) : null;
  const b = await brainBuild({ logs, project, withAsks: true });
  const p = b.projects[0];
  const skills = loadSkills([path.join(os.homedir(), '.claude', 'skills'), path.join(repo, '.claude', 'skills')]);
  const wf = workflows(p.asks || [], p.correctionList || [], skills, { minCount: cfg.minCount, minSessions: cfg.minSessions });
  if (flags.draft) {
    const w = wf.find((x) => x.id === String(flags.draft));
    if (!w) throw new Error(`no workflow ${flags.draft}; run skillhawk factory to list them`);
    if (cfg.draft === 'list') return void console.log('Your factory settings say: list workflows, do not draft. Change it: skillhawk setup --only factory');
    if (cfg.draft === 'template') { const r = templateDraft(w, { repo }); console.log(`Template for ${r.name} in ${r.dir}\n  ${r.lines.join('\n  ')}\n  then: skillhawk factory --promote ${r.name}`); return; }
    if (!hasConsent(data, 'modelReview')) {
      if (flags['allow-model'] || flags.allowModel) grant(data, 'modelReview', 'redacted requests and corrections, factory --draft');
      else { console.log('Drafting sends the redacted example requests and corrections to your own agent CLI (claude -p) to write the steps. Re-run with --allow-model to allow it.'); return; }
    }
    billingGuard(process.env, !!flags['allow-api-key']);
    const r = await draft(w, { repo, model: typeof flags.model === 'string' ? flags.model : 'sonnet' });
    console.log(`Drafted ${r.name} in ${r.dir}\n  ${r.lines.join('\n  ')}`);
    if (flags.eval) {
      const { evalSkill } = await import('./eval.js');
      const ev = await evalSkill(r.dir, { runs: Number(flags.runs) || 1 });
      try { fs.writeFileSync(path.join(r.dir, '.skillhawk-eval.json'), JSON.stringify({ baseline: ev.baseline, withSkill: ev.withSkill, lift: ev.lift, at: new Date().toISOString() })); } catch { /* informational */ }
      console.log(ev.lift == null ? '  eval: no behaviour cases to run' : `  eval: ${Math.round(ev.baseline * 100)}% without the skill -> ${Math.round(ev.withSkill * 100)}% with it (${ev.lift >= 0 ? '+' : ''}${Math.round(ev.lift * 100)} pts)`);
    }
    console.log(r.check.ok ? `  ready: skillhawk factory --promote ${r.name}` : '  not ready: fix the findings above, then promote.');
    return;
  }
  if (flags.json) return void console.log(JSON.stringify({ project, prompts: p.prompts, workflows: wf }, null, 1));
  console.log(render(project, wf, p.prompts, cfg));
  if (!cfg.at) console.log('Using Skillhawk defaults (3 times in 3 sessions, drafted by your agent CLI). Set your own: skillhawk setup --only factory');
}
