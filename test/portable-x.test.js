import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { badgeFacts, badgeSvg, badgeText } from '../src/badge.js';
import { compileTarget, TARGETS, structure } from '../src/compile.js';
import { loadState, newModels, watchRun, SEED_MODELS } from '../src/watch.js';

const SKILL = path.resolve('registry/public/commit-messages');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sy-x-'));

function makeSkill(root, name = 'demo-skill') {
  const d = path.join(root, name);
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---
name: ${name}
description: Formats widgets. Use when asked to "format a widget" or "tidy widgets".
allowed-tools: Bash, Read
paths: src/**/*.ts, lib/*.ts
---

# Demo

## Workflow

1. Run \`python3 scripts/fmt.py\`.
2. See [the guide](references/guide.md).

\`\`\`bash
python3 scripts/fmt.py --check
\`\`\`
`);
  fs.writeFileSync(path.join(d, 'scripts', 'fmt.py'), 'print(1)\n');
  fs.mkdirSync(path.join(d, 'references'));
  fs.writeFileSync(path.join(d, 'references', 'guide.md'), '# Guide\n');
  return d;
}

test('badge svg is well-formed and text matches inputs', () => {
  const svg = badgeSvg({ grade: 'A', lift: 38, secure: true });
  assert.match(svg, /^<svg [^>]*role="img"/);
  assert.match(svg, /<title>Skillhawk: A · \+38 lift · secure<\/title>/);
  assert.ok(svg.includes('>skillhawk</text>') && svg.includes('>A · +38 lift · secure</text>'));
  for (const t of ['svg', 'title', 'g', 'text']) assert.equal((svg.match(new RegExp(`<${t}[ >]`, 'g')) || []).length, (svg.match(new RegExp(`</${t}>`, 'g')) || []).length, t);
  assert.equal(badgeText({ grade: 'B', lift: null, secure: false }), 'B · security findings');
  assert.ok(!/lift/.test(badgeSvg({ grade: 'C', lift: null, secure: true })), 'lift never invented');
  const f = badgeFacts(SKILL, { lift: '12' });
  assert.equal(f.lift, 12);
  assert.match(f.grade, /^[A-F]$/);
});

test('badge reads lift from an eval report', () => {
  const d = tmp(); const r = path.join(d, 'r.json');
  fs.writeFileSync(r, JSON.stringify([{ lift: 0.38 }]));
  assert.equal(badgeFacts(SKILL, { fromReport: r }).lift, 38);
});

test('compile produces every target with checks and warnings', () => {
  const out = tmp(); const skill = makeSkill(tmp());
  const results = TARGETS.map((t) => compileTarget(t, skill, out));
  for (const r of results) assert.ok(r.ok, `${r.target}: ${JSON.stringify(r.checks)}`);
  const cursor = fs.readFileSync(path.join(out, 'cursor/.cursor/rules/demo-skill.mdc'), 'utf8');
  assert.match(cursor, /^---\ndescription: .*\nglobs: src\/\*\*\/\*\.ts,lib\/\*\.ts\nalwaysApply: false\n---/);
  assert.ok(cursor.includes('](.agents/skills/demo-skill/references/guide.md)'));
  const copilot = fs.readFileSync(path.join(out, 'copilot/.github/instructions/demo-skill.instructions.md'), 'utf8');
  assert.match(copilot, /^---\napplyTo: .*src/);
  assert.ok(fs.existsSync(path.join(out, 'codex/.agents/skills/demo-skill/scripts/fmt.py')));
  assert.ok(fs.readFileSync(path.join(out, 'gemini/GEMINI.md'), 'utf8').includes('python3 scripts/fmt.py --check'));
  assert.ok(fs.existsSync(path.join(out, 'claude/.claude/skills/demo-skill/SKILL.md')));
  assert.ok(results.find((r) => r.target === 'codex').warnings.some((w) => /allowed-tools/.test(w)));
  assert.ok(results.find((r) => r.target === 'cursor').warnings.some((w) => /scripts/.test(w)));
  // recompiling replaces the section, not duplicates it
  compileTarget('codex', skill, out);
  assert.equal((fs.readFileSync(path.join(out, 'codex/AGENTS.md'), 'utf8').match(/skillyard:demo-skill:start/g) || []).length, 1);
});

test('content-kept check catches a dropped block', () => {
  const s = structure('# A\n\n```sh\nx\n```\n\n## B\n');
  assert.deepEqual(s.headings, ['A', 'B']);
  assert.equal(s.blocks.length, 1);
});

test('compile works on the registry skill', () => {
  const out = tmp();
  for (const t of TARGETS) assert.ok(compileTarget(t, SKILL, out).checks.find((c) => c.name === 'content kept').ok);
});

test('watch state seeds models and detects new ones', () => {
  const st = loadState(path.join(tmp(), 'none.json'));
  assert.deepEqual(st.models.claude, SEED_MODELS.claude);
  assert.deepEqual(newModels(st, 'claude', ['claude-sonnet-5-5', 'claude-opus-6']), ['claude-opus-6']);
});

test('watch run reports regressions and drafts a fix with an injected runner', async () => {
  const dir = makeSkill(tmp(), 'widget');
  fs.mkdirSync(path.join(dir, 'evals'));
  fs.writeFileSync(path.join(dir, 'evals', 'evals.json'), '{"cases":[]}');
  const out = tmp();
  const calls = [];
  // lift is 0.5 on the old model; 0.1 on the new model for the original text, 0.5 once the rewrite is shorter
  const evalFn = async (d, o) => {
    calls.push(o.model);
    const short = fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8').includes('SHORT');
    if (o.model === 'old') return { baseline: 0.2, withSkill: 0.7, lift: 0.5 };
    return short ? { baseline: 0.2, withSkill: 0.7, lift: 0.5 } : { baseline: 0.5, withSkill: 0.6, lift: 0.1 };
  };
  const rewrite = async (text) => text.replace('# Demo', '# Demo\n<!-- SHORT -->').replace('2. See [the guide](references/guide.md).\n', '');
  const res = await watchRun([dir], { model: 'new', baseline: 'old', threshold: 0.1, out, rounds: 1, evalFn, rewrite });
  assert.equal(res.regressions.length, 1);
  assert.equal(res.rows[0].name, 'widget');
  assert.ok(res.report.includes('| widget | +50 pts | +10 pts | -40 pts |'));
  assert.ok(fs.existsSync(path.join(out, 'new', 'REPORT.md')));
  assert.ok(fs.existsSync(path.join(out, 'new', 'widget', 'SKILL.md')));
  assert.ok(calls.includes('new') && calls.includes('old'));
});

test('watch run reports no regression when lift holds', async () => {
  const dir = makeSkill(tmp(), 'steady');
  const evalFn = async () => ({ baseline: 0.2, withSkill: 0.7, lift: 0.5 });
  const res = await watchRun([dir], { model: 'n', baseline: 'o', out: tmp(), evalFn, rewrite: async (t) => t });
  assert.equal(res.regressions.length, 0);
});
