// Model-release watch: know which models exist, and when a new one appears re-run every skill's evals on old and
// new model, report lift regressions and draft a fix with optimize's model pass. No network unless --fetch.
import fs from 'node:fs';
import path from 'node:path';
import { findSkillDirs } from './review.js';
import { loadBase, modelPass, unifiedDiff } from './optimize.js';

export const SEED_MODELS = { claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] };
export const DEFAULT_STATE = path.join('.skillyard', 'watch.json');
export const DEFAULT_OUT = path.join('.skillyard', 'watch');

export function loadState(file = DEFAULT_STATE) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const models = { ...s.models };
  for (const [a, list] of Object.entries(SEED_MODELS)) models[a] = [...new Set([...(models[a] || []), ...list])];
  return { models };
}
export function saveState(state, file = DEFAULT_STATE) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Models in `provided` that the state does not know. */
export const newModels = (state, agent, provided) => provided.filter((m) => !(state.models[agent] || []).includes(m));

const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);

async function fetchModels() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('--fetch needs ANTHROPIC_API_KEY (or pass --models / --from-file)');
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
  if (!res.ok) throw new Error(`models API returned ${res.status}`);
  return (await res.json()).data.map((m) => m.id);
}

const pts = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)} pts`;

/** Compare lifts of every skill on two models. deps: { evalFn, rewrite }. Returns { rows, regressions }. */
export async function watchRun(dirs, { model, baseline, threshold = 0.1, out = DEFAULT_OUT, rounds = 3, evalFn, rewrite, log = () => {} } = {}) {
  if (!model || !baseline) throw new Error('watch run needs a new model and a baseline model');
  const rows = []; const regressions = [];
  const evalOn = (dir, m) => evalFn(dir, { agent: 'claude', model: m, conditions: ['without', 'with'], log });
  for (const dir of dirs) {
    const name = path.basename(path.resolve(dir));
    let oldR; let newR;
    try { oldR = await evalOn(dir, baseline); newR = await evalOn(dir, model); } catch (e) { rows.push({ name, dir, error: e.message }); continue; }
    const drop = oldR.lift - newR.lift;
    const row = { name, dir, oldLift: oldR.lift, newLift: newR.lift, drop, regressed: drop > threshold + 1e-9 };
    if (row.regressed) {
      const base = loadBase(dir);
      const dest = path.join(out, model, name);
      try {
        const r = await modelPass(dir, base, { rounds, model, rewrite, evalFn, log });
        row.fix = { accepted: r.best !== base, lift: r.bestLift, tries: r.tries };
        fs.mkdirSync(dest, { recursive: true });
        for (const [rel, buf] of Object.entries(r.best.files)) { if (rel.startsWith('evals/')) continue; fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true }); fs.writeFileSync(path.join(dest, rel), buf); }
        row.diff = unifiedDiff(base.files['SKILL.md'].toString('utf8'), r.best.files['SKILL.md'].toString('utf8'), `a/${name}/SKILL.md`, `b/${name}/SKILL.md`);
        row.dest = dest;
      } catch (e) { row.fix = { accepted: false, error: e.message }; }
      regressions.push(row);
    }
    rows.push(row);
  }
  const md = reportMarkdown(rows, { model, baseline, threshold });
  fs.mkdirSync(path.join(out, model), { recursive: true });
  fs.writeFileSync(path.join(out, model, 'REPORT.md'), md);
  return { rows, regressions, report: md };
}

export function reportMarkdown(rows, { model, baseline, threshold }) {
  const reg = rows.filter((r) => r.regressed);
  const o = [`# Skill lift on ${model} vs ${baseline}`, '', `${reg.length} of ${rows.length} skill(s) lost more than ${Math.round(threshold * 100)} pts of lift.`, '',
    `| Skill | Lift on ${baseline} | Lift on ${model} | Change | Status |`, '|---|---|---|---|---|'];
  for (const r of rows) o.push(r.error ? `| ${r.name} | - | - | - | not run: ${r.error} |` : `| ${r.name} | ${pts(r.oldLift)} | ${pts(r.newLift)} | ${pts(-r.drop)} | ${r.regressed ? (r.fix?.accepted ? 'regressed, fix drafted' : 'regressed, no fix found') : 'ok'} |`);
  for (const r of reg) {
    o.push('', `## ${r.name}`, '');
    if (r.fix?.accepted) o.push(`Drafted fix kept (lift ${pts(r.fix.lift)} on ${model}), written to \`${r.dest}\`.`);
    else o.push(`No shorter rewrite held the lift on ${model}${r.fix?.error ? ` (${r.fix.error})` : ''}; review the skill by hand.`);
    for (const t of r.fix?.tries || []) o.push(`- round ${t.round}: ${t.accepted ? `kept (lift ${pts(t.lift)})` : `rejected: ${t.reason}`}`);
    if (r.diff) o.push('', '```diff', r.diff, '```');
  }
  return `${o.join('\n')}\n`;
}

export async function run(args, flags = {}) {
  const sub = args.shift();
  const str = (v, d) => (v && v !== true ? v : d);
  const stateFile = str(flags.state, DEFAULT_STATE);
  const agent = str(flags.agent, 'claude');
  if (sub === 'models') {
    const state = loadState(stateFile);
    let provided = null;
    if (flags.models) provided = list(flags.models);
    else if (flags.fromFile) provided = fs.readFileSync(flags.fromFile, 'utf8').split(/[\n,]/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    else if (flags.fetch) provided = await fetchModels();
    if (flags.add) { provided = [...(provided || []), ...list(flags.add)]; }
    if (flags.check || provided) {
      if (!provided) throw new Error('--check needs --models a,b or --from-file <file> (or --fetch with ANTHROPIC_API_KEY)');
      const fresh = newModels(state, agent, provided);
      console.log(fresh.length ? `new models for ${agent}: ${fresh.join(', ')}` : `no new models for ${agent}`);
      for (const m of fresh) console.log(`  skillhawk watch run <skills> --model ${m} --allow-model`);
      if (flags.save || flags.add) { state.models[agent] = [...state.models[agent], ...fresh]; saveState(state, stateFile); console.log(`saved to ${stateFile}`); }
      return;
    }
    console.log(`known ${agent} models (${stateFile}):\n${state.models[agent].map((m) => `  ${m}`).join('\n')}`);
    return;
  }
  if (sub === 'run') {
    const model = str(flags.model);
    if (!model || !args.length) throw new Error('usage: skillhawk watch run <skill-dir...> --model <new> [--baseline <old>] [--threshold 10] [--out .skillyard/watch] [--allow-model]');
    if (!(flags.allowModel || flags['allow-model'])) throw new Error('watch run calls models for every skill on two models; re-run with --allow-model');
    const state = loadState(stateFile);
    const baseline = str(flags.baseline, state.models[agent].filter((m) => m !== model).pop());
    const { evalSkill } = await import('./eval.js');
    const res = await watchRun(findSkillDirs(args), { model, baseline, threshold: Number(str(flags.threshold, 10)) / 100, out: str(flags.out, DEFAULT_OUT), evalFn: evalSkill, log: (l) => console.log(l) });
    console.log(res.report);
    if (!state.models[agent].includes(model)) { state.models[agent].push(model); saveState(state, stateFile); }
    return;
  }
  throw new Error('usage: skillhawk watch models [--check --models a,b | --from-file f | --fetch] [--add m] [--save] [--state f]  |  watch run <dir...> --model <new> [--baseline <old>] --allow-model');
}
