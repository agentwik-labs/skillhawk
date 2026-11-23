// skillhawk setup: questions default to what the code does; answers become one rules block in AGENTS.md, imported by CLAUDE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, questions } from '../src/setup.js';
import { detectConventions } from '../src/clean.js';

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-setup-'));
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test' } }));
  for (let i = 0; i < 4; i++) w(`src/mod-${i}.js`, `import { x } from './x.js';\n\nexport function doThing${i}(a) {\n    if (a) {\n        return 'yes';\n    }\n    return 'no';\n}\n`);
  w('test/mod.test.js', "import { doThing0 } from '../src/mod-0.js';\n");
  return d;
}

test('setup: defaults come from the code; one option per choice; --yes writes AGENTS.md and a CLAUDE.md import', async () => {
  const d = project();
  const qs = questions(detectConventions(d), null);
  const lang = qs.find((q) => q.id === 'language');
  assert.match(lang.options[0], /^JavaScript \(detected\)/);
  assert.equal(lang.options.filter((o) => /^JavaScript/.test(o)).length, 1, 'no duplicate of the detected option');
  assert.match(qs.find((q) => q.id === 'indent').options[0], /^4 spaces \(detected/);
  assert.match(qs.find((q) => q.id === 'formatter').options[0], /^None, match/);
  const r = await setup(d, { yes: true });
  const agents = fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8');
  assert.match(agents, /<!-- skillhawk:setup start -->[\s\S]*Style: 4 spaces indentation, single quotes[\s\S]*<!-- skillhawk:setup end -->/);
  assert.equal(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.ok(agents.split('\n').length < 40, 'short: long instruction files lower adherence');
  assert.deepEqual(r.written, ['AGENTS.md', 'CLAUDE.md']);
});

test('setup: chosen answers replace the block in place; existing AGENTS.md and CLAUDE.md text is kept', async () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# Team notes\nKeep this.\n');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# Claude\nAlso keep.\n');
  await setup(d, { yes: true });
  await setup(d, { answers: { architecture: 'Feature folders (everything for one feature together)', commits: 'Conventional commits (feat:, fix:, chore:)' }, yes: true });
  const agents = fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Team notes\nKeep this\./);
  assert.equal(agents.match(/skillhawk:setup start/g).length, 1);
  assert.match(agents, /Architecture: Feature folders/);
  assert.match(agents, /Commits: Conventional commits/);
  const claude = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# Claude\nAlso keep\.\n\n@AGENTS\.md\n$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, '.skillhawk', 'setup.json'), 'utf8')).answers.architecture, 'Feature folders (everything for one feature together)');
});

test('setup: interactive answers go through the ask callback, one question at a time', async () => {
  const d = project();
  const seen = [];
  await setup(d, { ask: async (q) => { seen.push(q.id); return q.id === 'design' ? 'Tailwind with a small set of design tokens' : q.options[0]; } });
  assert.ok(seen.includes('tests') && seen.includes('architecture') && seen.includes('design'));
  assert.match(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), /UI: Tailwind/);
});

test('setup: health, factory and brain are the user\'s settings; health and factory follow them', async () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'src', 'big.js'), Array.from({ length: 120 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
  fs.mkdirSync(path.join(d, 'legacy')); fs.writeFileSync(path.join(d, 'legacy', 'old.js'), Array.from({ length: 900 }, () => 'x();').join('\n'));
  const r = await setup(d, { answers: {
    parts: ['health', 'factory', 'brain'],
    health: { sections: ['structure'], limits: '100/40/3', ignore: 'legacy', grade: 'no', inRules: 'none' },
    factory: { repeat: '2/2', draft: 'template', gate: 'none', install: 'user' },
    brain: { sources: ['repo-docs'], keep: ['decision'], review: 'never', notes: 'none', agents: 'no', scope: 'repo' },
  } });
  assert.deepEqual(r.parts, ['health', 'factory', 'brain']);
  assert.ok(!fs.existsSync(path.join(d, 'AGENTS.md')), 'rules were not chosen, so AGENTS.md is untouched');
  const { health, render } = await import('../src/health.js');
  const h = health(d);
  assert.deepEqual(h.sections, ['structure']);
  assert.ok(h.findings.every((f) => f.section === 'structure'));
  assert.ok(h.findings.some((f) => f.title === 'Very large file' && /src\/big\.js: 120 lines/.test(f.evidence)), 'the user\'s 100-line limit applies');
  assert.ok(!h.findings.some((f) => /legacy/.test(f.evidence)), 'ignored folder is skipped');
  const text = render(h);
  assert.doesNotMatch(text.split('\n')[0], /\([0-9]+\/100\)/, 'grade hidden');
  assert.match(text, /Checked against your settings/);
  assert.match(render(health(d, null)), /Checked against Skillhawk defaults/);
  const { loadFactory, installDir } = await import('../src/prefs.js');
  const f = loadFactory(d);
  assert.deepEqual([f.minCount, f.minSessions, f.draft, f.gate, f.install], [2, 2, 'template', 'none', 'user']);
  assert.equal(installDir(f, d), path.join(os.homedir(), '.claude', 'skills'));
  const { loadConfig } = await import('../src/brain-config.js');
  assert.equal(loadConfig(d).review, 'never');
});

test('factory: the install gate is the user\'s choice', async () => {
  const d = project();
  const { templateDraft, promote } = await import('../src/factory.js');
  const { factoryConfig } = await import('../src/prefs.js');
  const w = { name: 'release-notes', examples: ['write the release notes for this week from the merged pull requests', 'release notes again from merged PRs please', 'draft release notes from the merged pull requests'] };
  const r = templateDraft(w, { repo: d });
  assert.match(fs.readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8'), /TODO: write the first step/);
  assert.throws(() => promote(r.name, { repo: d, config: factoryConfig({ gate: 'lift', install: 'repo' }) }), /eval that shows it helps|does not pass/);
  const dest = promote(r.name, { repo: d, config: factoryConfig({ gate: 'none', install: path.join(d, 'my-skills') }) });
  assert.equal(dest, path.join(d, 'my-skills', r.name));
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
});
