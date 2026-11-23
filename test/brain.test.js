// skillhawk brain: lessons need evidence; adopted lessons land in AGENTS.md; "did it stick" compares rates before/after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, adopt, retire, render, cluster, stick } from '../src/brain.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DAY = 86400e3;
// one Claude Code session: n plain prompts, then the given human lines (each after an agent turn), at day offset `d`
function session(logs, name, d, humans, plain = 10) {
  const dir = path.join(logs, '-repo'); fs.mkdirSync(dir, { recursive: true });
  const base = Date.parse('2026-10-01T10:00:00Z') + d * DAY; let i = 0;
  const at = () => new Date(base + (i++) * 60e3).toISOString();
  const recs = [];
  for (let k = 0; k < plain; k++) { recs.push({ type: 'user', timestamp: at(), cwd: '/work/shop', message: { content: `please do task ${k} in the checkout module` } }); recs.push({ type: 'assistant', timestamp: at(), message: { content: [{ type: 'text', text: 'done' }] } }); }
  for (const h of humans) { recs.push({ type: 'user', timestamp: at(), cwd: '/work/shop', message: { content: h } }); recs.push({ type: 'assistant', timestamp: at(), message: { content: [{ type: 'text', text: 'ok' }] } }); }
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n'));
}

test('cluster groups the same correction worded differently', () => {
  const c = cluster([{ said: 'no, use pnpm not npm for installs', time: '1' }, { said: 'I said use pnpm instead of npm', time: '2' }, { said: 'the invoice PDF should be landscape', time: '3' }]);
  assert.equal(c.length, 2);
  assert.equal(c[0].members.length, 2);
});

test('brain: repeated corrections and decisions become lessons; once-off ones are watched; adopt writes AGENTS.md; stick measures before/after', async () => {
  process.env.SKILLHAWK_HOME = tmp('sh-brainhome-');
  const logs = tmp('sh-brainlogs-');
  session(logs, 's1', 0, ['no, I said use pnpm not npm for installs', 'from now on always run the linter before committing']);
  session(logs, 's2', 2, ['I told you, use pnpm instead of npm', "that's wrong, the invoice PDF should be landscape"]);
  let b = await build({ logs, project: 'shop', now: Date.parse('2026-10-20T00:00:00Z') });
  const p = b.projects[0];
  assert.equal(p.project, 'shop');
  const pnpm = p.lessons.find((l) => /pnpm/.test(l.text));
  assert.ok(pnpm.proposed && pnpm.evidence === 2 && pnpm.sessions === 2);
  assert.ok(p.lessons.find((l) => l.kind === 'decision' && /linter/.test(l.text)).proposed);
  assert.equal(p.lessons.find((l) => /landscape/.test(l.text)).proposed, false, 'seen once: watched, not proposed');
  assert.match(render(b), /Repeated corrections[\s\S]*pnpm[\s\S]*Watching: 1 correction/);

  const repo = tmp('sh-brainrepo-');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Notes\nkeep me\n');
  adopt(pnpm.id, { repo, brain: b, rule: 'Use pnpm, never npm, for installs.' });
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Notes\nkeep me\n\n<!-- skillhawk:brain start -->\n## Lessons from your sessions[\s\S]*- Use pnpm, never npm, for installs\.\n<!-- skillhawk:brain end -->/);
  assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');

  // stick math on synthetic times: 2 hits in 100 prompts before, 0 in 50 after -> stuck
  const before = Array.from({ length: 100 }, (_, i) => new Date(Date.parse('2026-10-01') + i * 60e3).toISOString());
  const after = Array.from({ length: 50 }, (_, i) => new Date(Date.parse('2026-10-10') + i * 60e3).toISOString());
  const s = stick(pnpm, '2026-10-05T00:00:00Z', [{ said: 'use pnpm not npm', time: before[3] }, { said: 'pnpm please not npm', time: before[9] }], [...before, ...after]);
  assert.deepEqual([s.before, s.after, s.rateBefore, s.rateAfter, s.verdict], [2, 0, 2, 0, 'stuck']);
  const s2 = stick(pnpm, '2026-10-05T00:00:00Z', [{ said: 'use pnpm not npm', time: before[3] }, { said: 'again use pnpm not npm', time: after[4] }, { said: 'pnpm not npm', time: after[9] }], [...before, ...after]);
  assert.equal(s2.verdict, 'not sticking');

  retire(pnpm.id, { repo });
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), /skillhawk:brain/);
  delete process.env.SKILLHAWK_HOME;
});

test('brain init: the user picks sources, kinds and destination; nothing is assumed', async () => {
  const { interview, toConfig, parseAnswer, QUESTIONS, saveConfig, loadConfig } = await import('../src/brain-config.js');
  // a folder of notes only: no sessions, so no consent and no correction questions are asked
  const asked = [];
  const a = await interview(async (q) => { asked.push(q.id); return { sources: '4', folders: '/notes', exts: '1', exclude: '', keep: '2,5', review: '1', destination: 'docs/RULES.md', notes: '2', agents: '1', scope: '1' }[q.id]; });
  assert.deepEqual(a.sources, ['folders']);
  assert.deepEqual(a.keep, ['decision', 'definition']);
  assert.ok(!asked.includes('repeat') && !asked.includes('measure') && !asked.includes('format'), `asked ${asked}`);
  const c = toConfig(a, '/repo');
  assert.equal(c.destination, 'docs/RULES.md');
  assert.equal(c.notes, null);
  assert.deepEqual(c.folders, ['/notes']);
  assert.deepEqual(parseAnswer(QUESTIONS.find((q) => q.id === 'repeat'), '4/2'), '4/2');
  assert.equal(toConfig({ ...a, keep: ['correction'], repeat: '4/2' }).minTimes, 4);
  const repo = tmp('sh-brainrepo-');
  saveConfig(c, repo);
  assert.equal(loadConfig(repo).destination, 'docs/RULES.md');
});

test('brain corpus: folders, repo docs and search; kinds pulled out with their source line; writes where the user chose', async () => {
  process.env.SKILLHAWK_HOME = tmp('sh-brainhome-');
  const { toConfig } = await import('../src/brain-config.js');
  const { find } = await import('../src/brain.js');
  const notes = tmp('sh-notes-');
  fs.writeFileSync(path.join(notes, 'meeting-2026-10-02.md'), '# Billing sync\n\n- We decided to bill annually by default.\n- Open question: do refunds go through Stripe or by hand?\n\n## Glossary\n\n- **MRR**: monthly recurring revenue\n');
  fs.writeFileSync(path.join(notes, '.env'), 'API_KEY=supersecret');
  fs.writeFileSync(path.join(notes, 'transcript.vtt'), 'WEBVTT\n\nthe churn number was 4% last quarter');
  const repo = tmp('sh-brainrepo-');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Shop\n\nI prefer small pull requests.\n');
  const cfg = toConfig({ sources: ['repo-docs', 'folders'], folders: notes, exts: '.md .vtt', keep: ['decision', 'preference', 'question', 'definition'], review: 'approve', destination: '.skillhawk/brain-rules.md', notes: 'none', agents: 'yes', scope: 'repo' }, repo);
  const b = await build({ project: 'shop', repo, config: cfg });
  const kinds = Object.fromEntries(b.projects[0].lessons.map((l) => [l.kind, l]));
  assert.match(kinds.decision.text, /bill annually/);
  assert.match(kinds.decision.where, /meeting-2026-10-02\.md:3$/);
  assert.match(kinds.question.text, /refunds/);
  assert.match(kinds.definition.text, /MRR/);
  assert.match(kinds.preference.text, /small pull requests/);
  assert.equal(b.sessions, 0, 'sessions were not chosen, so none were read');
  assert.ok(!JSON.stringify(b).includes('supersecret'), '.env is never read');
  assert.match(find(b, 'churn last quarter')[0].where, /transcript\.vtt/);
  assert.match(render(b), /Decisions: 1[\s\S]*Open questions and to-dos: 1/);

  adopt(kinds.decision.id, { repo, brain: b, rule: 'Bill annually by default.' });
  const rules = fs.readFileSync(path.join(repo, '.skillhawk', 'brain-rules.md'), 'utf8');
  assert.match(rules, /## Decisions \(skillhawk brain\)\n\n- Bill annually by default\./);
  assert.ok(!fs.existsSync(path.join(repo, 'AGENTS.md')), 'AGENTS.md untouched: the user chose another file');

  const never = await build({ project: 'shop', repo, config: { ...cfg, review: 'never', destination: null } });
  assert.throws(() => adopt(kinds.question.id, { repo, brain: never }), /never write rules/);
  delete process.env.SKILLHAWK_HOME;
});
