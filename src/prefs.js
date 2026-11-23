// The user's settings for health and factory, asked during `skillhawk setup` (or later: setup --only health).
// Skillhawk does not decide what good code is for the user: these questions set what health checks and how strictly,
// and how the factory turns repeated work into skills. With no settings saved, both run on Skillhawk's defaults and
// say so in their output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const o = (value, label) => ({ value, label });

export const PARTS = { id: 'parts', multi: true, question: 'What do you want to set up? Pick any.', options: [
  o('rules', 'Rules for agents: language, style, tests, architecture, commits, UI'),
  o('health', 'Health checks: what to check in your code and how strictly'),
  o('factory', 'Software Factory: when repeated work becomes a skill, and how it is made'),
  o('brain', 'Second Brain: what goes in and what it keeps'),
], default: ['rules'] };

export const HEALTH_QUESTIONS = [
  { id: 'sections', multi: true, question: 'Which areas should health check? Pick any.', options: [
    o('structure', 'Structure: README, .gitignore, committed .env, lockfile, large files, import cycles'),
    o('tests', 'Tests: whether there are tests and whether CI runs them'),
    o('clean-code', 'Clean code: long functions, deep nesting, copied code, debug prints'),
    o('design', 'System design: health checks, rate limits, validation, migrations, webhook signatures'),
    o('cloud-cost', 'Cloud cost: always-on resources in your infrastructure code, at AWS list prices'),
  ], default: ['structure', 'tests', 'clean-code', 'design', 'cloud-cost'] },
  { id: 'limits', when: (a) => a.sections.some((s) => s === 'structure' || s === 'clean-code'), question: 'Size limits: largest file / longest function / deepest nesting before it is flagged?', options: [
    o('600/80/5', '600-line files, 80-line functions, nesting 5'),
    o('300/40/4', '300-line files, 40-line functions, nesting 4'),
    o('1000/150/7', '1000-line files, 150-line functions, nesting 7'),
  ], free: 'or type file/function/nesting, e.g. 500/60/4' },
  { id: 'tests', when: (a) => a.sections.includes('tests'), question: 'When should it flag tests?', options: [
    o('0.2', 'When there are none, or under 1 test file per 5 source files'),
    o('0', 'Only when there are no tests at all'),
    o('0.5', 'When there is under 1 test file per 2 source files'),
  ], free: 'or type a ratio of test files to source files, e.g. 0.3' },
  { id: 'ignore', text: true, question: 'Folders health should never check? Comma-separated (Enter for none).', default: '' },
  { id: 'grade', question: 'Show a letter grade and score?', options: [o('yes', 'Yes, A to F and a score out of 100'), o('no', 'No, just the findings')] },
  { id: 'inRules', when: () => true, question: 'Add current health findings to the agent rules (so agents do not make them worse)?', options: [
    o('none', 'No'), o('high', 'High-severity findings only'), o('medium', 'High and medium'),
  ] },
];

export const FACTORY_QUESTIONS = [
  { id: 'repeat', question: 'When does repeated work count as a workflow worth a skill?', options: [
    o('3/3', 'Asked 3 times in 3 different sessions'),
    o('2/2', 'Asked 2 times in 2 different sessions'),
    o('5/3', 'Asked 5 times in 3 different sessions'),
  ], free: 'or type "times/sessions"' },
  { id: 'draft', question: 'How should a skill be drafted?', options: [
    o('agent', 'By your own agent CLI (claude -p) on your subscription; never on an API key'),
    o('template', 'As a template from your own requests; you write the steps'),
    o('list', 'Do not draft; just list the workflows'),
  ] },
  { id: 'gate', when: (a) => a.draft !== 'list', question: 'What must a drafted skill pass before it can be installed?', options: [
    o('checks', 'The skill checks: grade, security scan, trigger test'),
    o('lift', 'The checks, and an eval that shows it helps (lift above 0)'),
    o('none', 'Nothing; install whatever I approve'),
  ] },
  { id: 'install', when: (a) => a.draft !== 'list', question: 'Where should approved skills be installed?', options: [
    o('repo', 'This repo: .claude/skills'),
    o('user', 'All my projects: ~/.claude/skills'),
  ], free: 'or type a folder' },
  { id: 'compile', when: (a) => a.draft !== 'list', question: 'Also convert installed skills for other agents?', options: [
    o('no', 'No'), o('all', 'Yes: Codex, Cursor, Copilot, Gemini'),
  ] },
];

const file = (repo, name) => path.join(path.resolve(repo), '.skillhawk', `${name}.json`);
const load = (repo, name) => { try { return JSON.parse(fs.readFileSync(file(repo, name), 'utf8')); } catch { return null; } };
const save = (repo, name, v) => { fs.mkdirSync(path.dirname(file(repo, name)), { recursive: true }); fs.writeFileSync(file(repo, name), `${JSON.stringify(v, null, 2)}\n`); return file(repo, name); };

export function healthConfig(a) {
  const [fileLines, fnLines, nesting] = String(a.limits || '600/80/5').split('/').map(Number);
  return {
    answers: a, sections: a.sections, limits: { fileLines: fileLines || 600, fnLines: fnLines || 80, nesting: nesting || 5 },
    minTestRatio: a.tests === undefined ? 0.2 : Number(a.tests) || 0, ignore: String(a.ignore || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    grade: a.grade !== 'no', inRules: a.inRules || 'none', at: new Date().toISOString(),
  };
}
export function factoryConfig(a) {
  const [minCount, minSessions] = String(a.repeat || '3/3').split('/').map(Number);
  const install = !a.install || a.install === 'repo' ? 'repo' : a.install === 'user' ? 'user' : path.resolve(String(a.install).replace(/^~(?=$|\/)/, os.homedir()));
  return { answers: a, minCount: minCount || 3, minSessions: minSessions || 3, draft: a.draft || 'agent', gate: a.gate || 'checks', install, compile: a.compile === 'all', at: new Date().toISOString() };
}
export const loadHealth = (repo) => load(repo, 'health');
export const loadFactory = (repo) => load(repo, 'factory');
export const saveHealth = (repo, c) => save(repo, 'health', c);
export const saveFactory = (repo, c) => save(repo, 'factory', c);
export const installDir = (c, repo) => (c.install === 'user' ? path.join(os.homedir(), '.claude', 'skills') : c.install === 'repo' ? path.join(repo, '.claude', 'skills') : c.install);
