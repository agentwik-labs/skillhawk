import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { reviewScripts, parseReviewComments, clusterComments, detectConventions, learnStandards } from '../src/clean.js';
import { reviewDir } from '../src/review.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'test', 'fixtures', 'clean');
const BIN = path.join(ROOT, 'bin', 'skillyard.js');
const has = (r, rule, file) => r.findings.some((f) => f.rule === rule && (!file || f.file === file) && f.line > 0 && f.severity && f.fix);

function makeRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-repo-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: d, stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(d, 'src')); fs.mkdirSync(path.join(d, 'test'));
  const fn = (n) => `export function ${n}(a, b) {\n  const total = a + b;\n  const label = 'sum';\n  const kind = 'num';\n  const unit = 'int';\n  const mode = 'add';\n  return { label, total };\n}\n`;
  fs.writeFileSync(path.join(d, 'src', 'sum-numbers.js'), fn('sumNumbers') + fn('addPair'));
  fs.writeFileSync(path.join(d, 'src', 'mul-numbers.js'), fn('mulNumbers') + fn('mulPair'));
  fs.writeFileSync(path.join(d, 'test', 'sum.test.js'), "import { test } from 'node:test';\ntest('x', () => {});\n");
  fs.writeFileSync(path.join(d, '.prettierrc'), '{}\n');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'tiny', type: 'module', scripts: { test: 'node --test test/' } }));
  git('add', '-A');
  for (const m of ['feat: add sum', 'fix(math): handle zero', 'feat(api): add mul', 'chore: tidy']) git('commit', '--allow-empty', '-q', '-m', m);
  return d;
}

test('scripts review flags the sloppy shell, js and python script', () => {
  const r = reviewScripts(path.join(FX, 'sloppy-skill'));
  assert.deepEqual(r.scripts, ['scripts/fetch.sh', 'scripts/sync.js', 'scripts/tool.py']);
  for (const [rule, file] of [['shell-no-set-e', 'scripts/fetch.sh'], ['unquoted-variable', 'scripts/fetch.sh'], ['hardcoded-home-path', 'scripts/fetch.sh'], ['hardcoded-absolute-path', 'scripts/fetch.sh'], ['todo-left', 'scripts/fetch.sh'], ['no-usage', 'scripts/fetch.sh'],
    ['unused-function', 'scripts/sync.js'], ['unused-variable', 'scripts/sync.js'], ['unused-import', 'scripts/sync.js'], ['no-error-handling', 'scripts/sync.js'], ['hardcoded-home-path', 'scripts/sync.js'],
    ['unused-function', 'scripts/tool.py'], ['no-error-handling', 'scripts/tool.py'], ['hardcoded-home-path', 'scripts/tool.py'], ['unused-import', 'scripts/tool.py'], ['not-executable', 'scripts/fetch.sh']]) {
    assert.ok(has(r, rule, file), `${rule} in ${file}`);
  }
  assert.ok(!r.findings.some((f) => f.rule === 'unused-import' && /path/.test(f.message) === false && f.file === 'scripts/sync.js' && /fs|execSync/.test(f.message)));
});

test('a tidy script has no findings and long functions are caught', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-ok-'));
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ok\ndescription: x. Use when y.\n---\n# ok\nRun `bash scripts/ok.sh`.\n');
  fs.writeFileSync(path.join(d, 'scripts', 'ok.sh'), '#!/usr/bin/env bash\nset -euo pipefail\nif [ "${1:-}" = "--help" ]; then echo "usage: ok.sh <x>"; exit 0; fi\necho "$1"\n');
  assert.deepEqual(reviewScripts(d).findings, []);
  fs.writeFileSync(path.join(d, 'scripts', 'direct.py'), 'import sys\nprint(sys.argv)  # --help\n');
  fs.appendFileSync(path.join(d, 'SKILL.md'), 'Then run `scripts/direct.py`.\n');
  const direct = reviewScripts(d).findings;
  assert.ok(direct.some((f) => f.rule === 'missing-shebang' && f.file === 'scripts/direct.py'));
  assert.ok(direct.some((f) => f.rule === 'not-executable' && f.file === 'scripts/direct.py'));
  fs.writeFileSync(path.join(d, 'scripts', 'long.py'), `def big():\n${'    x = 1\n'.repeat(70)}\nbig()\n`);
  assert.ok(reviewScripts(d).findings.some((f) => f.rule === 'long-function' && f.file === 'scripts/long.py'));
});

test('skillyard review prints a scripts section only for skills with scripts', () => {
  const r = reviewDir(path.join(FX, 'sloppy-skill'));
  assert.ok(r.scripts.findings.length > 10);
  const out = execFileSync('node', [BIN, 'review', path.join(FX, 'sloppy-skill')], { encoding: 'utf8' });
  assert.match(out, /scripts: 3 files, \d+ findings/);
  assert.match(out, /scripts\/fetch\.sh:\d+ \[shell-no-set-e\]/);
  assert.equal(reviewDir(path.join(ROOT, 'plugins', 'review', 'skills', 'skillyard-review')).scripts, undefined);
});

test('clean scripts --json prints machine-readable findings', () => {
  let out = '';
  try { execFileSync('node', [BIN, 'clean', 'scripts', path.join(FX, 'sloppy-skill'), '--json'], { encoding: 'utf8' }); } catch (e) { out = e.stdout; }
  const j = JSON.parse(out);
  assert.equal(j.skills[0].scripts.length, 3);
  assert.ok(j.skills[0].findings.every((f) => f.file && f.line && f.severity && f.fix));
});

test('review comments cluster into counted rules', () => {
  const comments = parseReviewComments(fs.readFileSync(path.join(FX, 'review-comments.md'), 'utf8'));
  assert.ok(comments.length >= 10);
  const rules = clusterComments(comments);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].count, 4);
  assert.match(rules[0].rule, /test/i);
  assert.ok(rules.some((r) => r.count === 3 && /log|swallow/i.test(r.rule)));
  assert.ok(rules.some((r) => r.count === 2 && /async/i.test(r.rule)));
  assert.equal(parseReviewComments(JSON.stringify([{ body: 'Please add a docstring here' }, { comment: { text: 'nested one two three' } }]), 'x.json').length, 2);
});

test('standards detects conventions from a tiny git repo', () => {
  const c = detectConventions(makeRepo());
  assert.equal(c.languages[0].name, 'JavaScript');
  assert.deepEqual([c.indent.kind, c.indent.width], ['spaces', 2]);
  assert.equal(c.quotes.style, 'single');
  assert.equal(c.semicolons.use, true);
  assert.equal(c.fileNaming.style, 'kebab-case');
  assert.equal(c.functionNaming.style, 'camelCase');
  assert.ok(c.configs.includes('Prettier (formatter)'));
  assert.equal(c.tests.dir, 'test');
  assert.match(c.tests.command, /npm test/);
  assert.equal(c.git.count, 4);
  assert.equal(c.git.conventionalPct, 100);
});

test('standards writes a skill graded B or better, with cases and review rules', async () => {
  const repo = makeRepo();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clean-out-')), 'coding-standards');
  const r = await learnStandards(repo, { out, fromReviews: path.join(FX, 'review-comments.md'), fromGit: true });
  assert.ok('AB'.includes(r.review.grade), `${r.review.grade}: ${JSON.stringify(r.review.findings)}`);
  const md = fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8');
  assert.match(md, /conventional commits/);
  assert.match(md, /requested 4 times/);
  assert.match(md, /Indent with 2 spaces/);
  assert.match(md, /```js\nexport function/);
  assert.match(fs.readFileSync(path.join(out, 'tests', 'cases.yaml'), 'utf8'), /should_fire/);
});

test('clean standards CLI works end to end and rejects bad input', () => {
  const repo = makeRepo();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clean-cli-')), 'coding-standards');
  const text = execFileSync('node', [BIN, 'clean', 'standards', repo, '--from-git', '--out', out, '--from-reviews', path.join(FX, 'review-comments.md')], { encoding: 'utf8' });
  assert.match(text, /review: [AB]/);
  assert.ok(fs.existsSync(path.join(out, 'SKILL.md')));
  assert.throws(() => execFileSync('node', [BIN, 'clean', 'bogus'], { stdio: 'pipe' }));
});
