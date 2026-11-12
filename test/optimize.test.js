import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBase, staticPass, optimizeSkill, vet, unifiedDiff, librarySummary, modelPass } from '../src/optimize.js';

const BLOATED = `---
name: commit-notes
description: Writes commit messages in the team format. Use when the user says "write a commit message", "commit this", or asks for a changelog line.
---

# Commit notes

<!-- internal note: keep in sync with the wiki -->

Please be thorough.   

Please write the subject line in the imperative mood, as needed.



- Keep the subject under 50 characters, if possible.
- Try to explain why the change was made, not what changed, etc.
- Never end the subject line with a period.
- Do not end the subject line with a period.

---

## Example

\`\`\`
fix: retry failed uploads   twice
\`\`\`

Basically run \`git log -5\` to match the existing style.
`;
const CASES = `should_fire:
  - write a commit message for my staged changes
  - draft a changelog line for this release
should_not_fire:
  - plot a histogram of response times
`;

function mk(text = BLOATED, cases = CASES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-optimize-'));
  const dir = path.join(root, 'commit-notes');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  if (cases) fs.writeFileSync(path.join(dir, 'tests', 'cases.yaml'), cases);
  return dir;
}
const GRADES = 'ABCDF';

test('static pass cuts tokens on a bloated skill without lowering the grade', async () => {
  const dir = mk();
  const r = await optimizeSkill(dir);
  assert.ok(r.best.m.tokens < r.base.m.tokens, `${r.base.m.tokens} -> ${r.best.m.tokens}`);
  assert.ok(GRADES.indexOf(r.best.m.review.grade) <= GRADES.indexOf(r.base.m.review.grade));
  const out = r.best.files['SKILL.md'].toString();
  assert.match(out, /fix: retry failed uploads   twice/, 'code block untouched');
  assert.match(out, /`git log -5`/);
  assert.match(out, /^name: commit-notes$/m);
  assert.doesNotMatch(out, /be thorough|Please|if possible|etc\.|<!--/i);
  assert.equal((out.match(/end the subject line with a period/gi) || []).length, 1, 'repeated rule collapsed');
  assert.match(r.diff, /^@@ /m);
  assert.equal(r.best.m.trigger.fail, 0);
});

test('a candidate that breaks a trigger case is rejected', () => {
  const dir = mk();
  const base = loadBase(dir);
  assert.equal(base.m.trigger.fail, 0);
  const broken = BLOATED.replace(/description: .*/, 'description: Handles database schema migrations. Use when the user says "migrate the database".');
  const r = vet(dir, base, { ...base.files, 'SKILL.md': Buffer.from(broken) }, { keepFrontmatter: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /trigger case/);
});

test('a candidate that drops a code block or lowers the grade is rejected', () => {
  const dir = mk();
  const base = loadBase(dir);
  const noCode = BLOATED.replace(/```[\s\S]*?```\n/, '');
  assert.match(vet(dir, base, { ...base.files, 'SKILL.md': Buffer.from(noCode) }).reason, /code block/);
  const todo = `${BLOATED.trimEnd().slice(0, -60)}\nTODO fill in\n`;
  assert.equal(vet(dir, base, { ...base.files, 'SKILL.md': Buffer.from(todo) }, {}).ok, false);
});

test('static pass never touches frontmatter or fenced code', () => {
  const dir = mk();
  const base = loadBase(dir);
  const { best } = staticPass(dir, base);
  const fm = (t) => t.split('---')[1];
  assert.equal(fm(best.files['SKILL.md'].toString()), fm(BLOATED));
});

test('model pass keeps a shorter candidate whose lift holds, using an injected runner', async () => {
  const dir = mk();
  const base = loadBase(dir);
  const calls = [];
  const rewrite = async (text, { round }) => {
    calls.push(round);
    if (round === 1) return text.replace(/^- Try to explain.*\n/m, '- Explain why, not what.\n'); // shorter, same rules
    if (round === 2) return text.replace(/Never end the subject line with a period\./, ''); // shorter but lift drops (fake eval below)
    return text; // no saving
  };
  const evalFn = async (d, o) => {
    const text = fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8');
    if (o.conditions.length === 2) return { baseline: 0.25, withSkill: 0.75, lift: 0.5 };
    return { baseline: null, withSkill: /Never end/.test(text) ? 0.75 : 0.5, lift: null };
  };
  const r = await modelPass(dir, base, { rounds: 3, rewrite, evalFn });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(r.tries[0].accepted, true);
  assert.equal(r.tries[1].accepted, false);
  assert.match(r.tries[1].reason, /lift|duplicate|review/);
  assert.equal(r.tries[2].accepted, false);
  assert.ok(r.best.m.tokens < base.m.tokens);
  assert.equal(r.origLift, 0.5);
});

test('model pass rejects a rewrite that changes the description (trigger cases break)', async () => {
  const dir = mk();
  const base = loadBase(dir);
  const rewrite = async (text) => text.replace(/description: .*/, 'description: Handles database migrations. Use when the user says "migrate".').replace(/Please be thorough\./, '');
  const evalFn = async () => ({ baseline: 0, withSkill: 1, lift: 1 });
  const r = await modelPass(dir, base, { rounds: 1, rewrite, evalFn });
  assert.equal(r.tries[0].accepted, false);
  assert.match(r.tries[0].reason, /trigger/);
});

test('unifiedDiff and librarySummary', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  assert.match(unifiedDiff('a\nb\nc\n', 'a\nc\n'), /-b/);
  const s = librarySummary([{ name: 'x', before: 100, after: 80, gradeBefore: 'B', gradeAfter: 'A' }]);
  assert.match(s.summary, /1 skills: 100 -> 80 tokens \(-20\.0%\)/);
});
