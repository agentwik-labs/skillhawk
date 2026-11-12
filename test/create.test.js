import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCmd, answersFromDoc, parseDoc, guessKind, pickNoSkillProposal, answersFromProposal, fillGaps } from '../src/create.js';
import { loadCases, validateCases } from '../src/devloop.js';
import { saveProposals } from '../src/review-chats.js';

const FX = path.resolve('test/fixtures/create');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sy-create-'));
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const run = async (args, f, io = {}) => {
  const r = await quiet(() => createCmd(args, f, { say: () => {}, tty: false, ...io }));
  const failed = process.exitCode; process.exitCode = 0;
  assert.ok(!failed && r.check.ok, `createCmd flagged ${r.name}: ${JSON.stringify(r.check.test.results.filter((x) => !x.ok))}`);
  return r;
};

test('--answers writes a skill that grades B or better, with cases.yaml', async () => {
  const out = tmp();
  const r = await run([], { answers: path.join(FX, 'answers.json'), out });
  assert.ok('AB'.includes(r.check.rev.grade), `grade ${r.check.rev.grade}`);
  assert.equal(r.check.high.length, 0);
  assert.equal(r.check.test.errors.length, 0);
  const md = fs.readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8');
  assert.match(md, /Use when someone says 'check this sales email before I send it'/);
  assert.match(md, /## Not for[\s\S]*write a blog post/);
  assert.doesNotMatch(md.split('---')[1], /blog/);
  const c = loadCases(r.dir);
  assert.deepEqual(validateCases(c.cases), []);
  assert.equal(c.cases.should_fire.length, 3);
  assert.equal(c.cases.should_not_fire.length, 1);
  assert.equal(r.check.test.pass, 4);
});

test('non-TTY without a source refuses', async () => {
  await assert.rejects(run([], { out: tmp() }), /needs a terminal/);
});

test('--from a runbook keeps the steps in order, with no model', async () => {
  const text = fs.readFileSync(path.join(FX, 'runbook.md'), 'utf8');
  assert.equal(guessKind(parseDoc(text)), 'procedure');
  const a = answersFromDoc('procedure', text);
  assert.equal(a.name, 'refund-approval-runbook');
  assert.equal(a.steps.length, 5);
  assert.match(a.steps[0], /Look up the order/);
  assert.match(a.steps[4], /Reply to the customer/);
  assert.equal(a.before.length, 2);
  assert.equal(a.rules.length, 2);
  assert.match(a.escalate, /chargeback/);
  assert.match(a.output, /refund ID/);
  const out = tmp();
  const r = await run([], { from: path.join(FX, 'runbook.md'), out, examples: 'refund this order|can I refund order 4411|customer wants money back', 'should-not': '' });
  const md = fs.readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8');
  const order = [...md.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => m[2]);
  assert.equal(order.length, 5);
  assert.match(order[0], /Look up the order/);
  assert.ok('AB'.includes(r.check.rev.grade), `grade ${r.check.rev.grade}`);
});

test('--allow-model only fills missing required fields (stub, no real call)', async () => {
  const a = await fillGaps('procedure', { name: 'x', steps: ['one', 'two'] }, 'doc', { fill: async () => ({ job: 'Do the job.', steps: ['ignored'], output: 'Text.' }) });
  assert.equal(a.job, 'Do the job.');
  assert.deepEqual(a.steps, ['one', 'two']);
});

test('--from-chats drafts from a pending no-skill proposal', async () => {
  const data = tmp();
  saveProposals(data, [
    { id: 'aa11', status: 'rejected', kind: 'no-skill', skill: null, evidence: [{ asked: 'old', said: 'old' }] },
    { id: 'bb22', status: 'pending', kind: 'no-skill', skill: null, count: 2, created: '2026-11-01', evidence: [
      { asked: 'write the weekly status update for the board', said: 'no, lead with the revenue number and keep it under 100 words' },
      { asked: 'draft this week status update', said: "don't use bullet points in the board update" }] },
  ]);
  assert.equal(pickNoSkillProposal(data).id, 'bb22');
  const a = answersFromProposal(pickNoSkillProposal(data));
  assert.equal(a.blockers.length, 2);
  const out = tmp();
  const r = await run([], { 'from-chats': true, data, out });
  assert.ok('AB'.includes(r.check.rev.grade), `grade ${r.check.rev.grade}`);
  const md = fs.readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8');
  assert.match(md, /lead with the revenue number/);
  assert.equal(loadCases(r.dir).cases.should_fire.length, 2);
  assert.throws(() => pickNoSkillProposal(tmp()), /no pending/);
});

test('interview mode asks for the kind, examples and when not to use it', async () => {
  const replies = ['1', 'Closing the books at month end', '', 'Pull the trial balance', 'Post accruals', '', '', '', 'Month-end summary', 'close the books', 'run month end close', 'start the close', '', 'write a blog post', '', 'month-end-close', ''];
  const rl = { question: async () => { if (!replies.length) throw new Error('interview asked more than scripted'); return replies.shift(); } };
  const r = await run([], { out: tmp() }, { rl });
  assert.equal(r.name, 'month-end-close');
  assert.equal(loadCases(r.dir).cases.should_fire.length, 3);
});
