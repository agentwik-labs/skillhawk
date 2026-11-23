// usage, snapshot/restore, tidy, stuck, logs-secrets, brief: the free checks Autopilot runs on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
function repo() {
  const d = tmp('sh-auto-repo-');
  git(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(d, '.gitignore'), 'ignored.log\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  return d;
}
const line = (o) => JSON.stringify(o);

test('usage: limit hits teach the cap; pace and reset time come from your own logs', async () => {
  const { scan, pace, limitKind, resetTime } = await import('../src/usage.js');
  assert.equal(limitKind("You've hit your session limit · resets 2:10pm (America/New_York)"), 'session');
  assert.equal(limitKind("You've hit your weekly limit · resets Mon 9am"), 'weekly');
  const at = new Date('2026-11-20T10:00:00').getTime();
  assert.equal(new Date(resetTime('resets 2:10pm', at)).getHours(), 14);
  const logs = tmp('sh-usage-'); fs.mkdirSync(path.join(logs, 'p'));
  const base = Date.parse('2026-11-20T00:00:00Z');
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push({ type: 'assistant', timestamp: new Date(base + i * 60e3).toISOString(), requestId: `r${i}`, message: { id: `m${i}`, model: 'claude-sonnet-4', usage: { input_tokens: 0, output_tokens: 100000 } } }); // $1.50 each
  recs.push({ type: 'assistant', timestamp: new Date(base + 11 * 60e3).toISOString(), error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 4:00am" }] } });
  recs.push(recs[0]); // duplicate streaming record: counted once
  fs.writeFileSync(path.join(logs, 'p', 's.jsonl'), recs.map(line).join('\n'));
  const s = await scan({ logs, since: base - 1 });
  assert.equal(s.turns.length, 10);
  assert.equal(s.hits.length, 1);
  const p = pace(s, { now: base + 20 * 60e3 });
  assert.equal(p.sessionCap.value, 15);
  assert.equal(p.windowPct, 100);
  assert.equal(pace(s, { now: base + 20 * 60e3, weeklyCap: 30 }).weekPct, 50);
});

test('snapshot: saves uncommitted and new files without touching the working tree, index or branches; restore makes a branch', async () => {
  const { snapshotOne, list, restore, pending } = await import('../src/snapshot.js');
  const d = repo();
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(d, 'new.txt'), 'new\n'); fs.writeFileSync(path.join(d, 'ignored.log'), 'x');
  fs.writeFileSync(path.join(d, 'staged.txt'), 's'); git(d, 'add', 'staged.txt');
  const statusBefore = git(d, 'status', '--porcelain');
  assert.equal(pending(d).files, 3, "modified, new and staged; not the ignored file");
  const r = snapshotOne(d, { now: Date.parse('2026-11-20T03:00:00Z') });
  assert.ok(r.ref.startsWith('refs/skillhawk/snapshots/'));
  assert.equal(git(d, 'status', '--porcelain'), statusBefore, 'working tree and index untouched');
  assert.equal(git(d, 'branch', '--list').trim(), '* main');
  const files = git(d, 'ls-tree', '-r', '--name-only', r.commit);
  assert.match(files, /new\.txt/); assert.match(files, /staged\.txt/); assert.doesNotMatch(files, /ignored\.log/);
  assert.equal(snapshotOne(d, { now: Date.parse('2026-11-20T04:00:00Z') }).unchanged, true, 'no duplicate when nothing changed');
  assert.equal(list([d]).length, 1);
  const out = restore([d], r.commit);
  assert.equal(git(d, 'show', `${out.branch}:a.txt`), 'one\ntwo');
});

test('tidy: merged, idle worktrees are listed, snapshotted and removed only on apply; logs are archived and restorable', async () => {
  process.env.SKILLHAWK_HOME = tmp('sh-tidyhome-');
  const { find, apply, restoreLogs } = await import('../src/tidy.js');
  const d = repo();
  const wt = path.join(tmp('sh-wt-'), 'feature');
  git(d, 'worktree', 'add', '-q', '-b', 'feature', wt);
  fs.writeFileSync(path.join(wt, 'f.txt'), 'f'); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'feature');
  git(d, 'merge', '-q', 'feature');
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'unsaved');
  const logs = tmp('sh-tidylogs-'); fs.mkdirSync(path.join(logs, 'p')); fs.writeFileSync(path.join(logs, 'p', 'old.jsonl'), '{"a":1}\n');
  const later = Date.now() + 30 * 86400e3;
  const f = await find({ dirs: [d, wt], now: later, logs, servers: [], rules: { worktreeDays: 14, nodeModulesDays: null, logDays: 20 } });
  assert.deepEqual(f.items.map((x) => x.category).sort(), ['logs', 'worktrees']);
  assert.ok(fs.existsSync(wt), 'find changes nothing');
  const done = apply(f, { now: later, logsRoot: logs });
  assert.ok(done.every((x) => !x.error), JSON.stringify(done));
  assert.ok(!fs.existsSync(wt));
  assert.match(git(d, 'for-each-ref', 'refs/skillhawk/snapshots'), /snapshots/, 'unsaved work was snapshotted first');
  assert.match(git(d, 'branch', '--list', 'feature'), /feature/, 'branch kept');
  assert.ok(!fs.existsSync(path.join(logs, 'p', 'old.jsonl')));
  assert.equal(restoreLogs({ logsRoot: logs }), 1);
  assert.equal(fs.readFileSync(path.join(logs, 'p', 'old.jsonl'), 'utf8'), '{"a":1}\n');
  delete process.env.SKILLHAWK_HOME;
});

test('stuck: a tool call with no result is waiting on you; a limit message waits for the reset', async () => {
  const { findStuck } = await import('../src/stuck.js');
  const logs = tmp('sh-stuck-'); fs.mkdirSync(path.join(logs, 'p'));
  const now = Date.now(); const t = (m) => new Date(now - m * 60e3).toISOString();
  fs.writeFileSync(path.join(logs, 'p', 'aaaaaaaa-1.jsonl'), [
    { type: 'user', timestamp: t(30), cwd: '/work/shop', message: { content: 'deploy it' } },
    { type: 'assistant', timestamp: t(20), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run deploy -- --prod' } }] } },
  ].map(line).join('\n'));
  fs.writeFileSync(path.join(logs, 'p', 'bbbbbbbb-2.jsonl'), [
    { type: 'user', timestamp: t(2), cwd: '/work/busy', message: { content: 'go' } },
    { type: 'assistant', timestamp: t(1), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } },
  ].map(line).join('\n'));
  const xs = findStuck({ logs, now });
  assert.equal(xs.length, 1, 'a tool call 1 minute old is just running');
  assert.equal(xs[0].kind, 'tool');
  assert.match(xs[0].what, /^Bash: npm run deploy/);
});

test('logs-secrets: finds real-looking keys, ignores slugs and placeholders, redacts in place', async () => {
  const { secretsIn, scanLogs, redactLogs } = await import('../src/logsecrets.js');
  const key = 'sk-ant-api03-' + 'Ab3dEf9hIjK1mNoP4qRsTuV7wXyZ0aBcD2eF';
  assert.equal(secretsIn(`export ANTHROPIC_API_KEY=${key}`)[0].kind, 'anthropic');
  assert.equal(secretsIn('branch sk-my-long-feature-branch-name-for-testing-things').length, 0);
  assert.equal(secretsIn('OPENAI_API_KEY=your-key-here-xxxxxxxxxxxxxxxx').length, 0);
  const logs = tmp('sh-sec-'); fs.mkdirSync(path.join(logs, 'p'));
  const f = path.join(logs, 'p', 's.jsonl');
  fs.writeFileSync(f, `${line({ type: 'user', message: { content: `use ${key} please` } })}\n`);
  const old = Date.now() - 3600e3; fs.utimesSync(f, old / 1000, old / 1000);
  const found = scanLogs({ roots: [logs] });
  assert.equal(found.length, 1);
  assert.ok(!JSON.stringify(found.map(({ _value, ...x }) => x)).includes(key), 'value is never in the output');
  redactLogs(found);
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(!after.includes(key)); assert.match(after, /\[redacted:anthropic\]/);
  assert.doesNotThrow(() => JSON.parse(after.trim()));
});

test('brief: counts what needs a human; "Nothing needs you." when nothing does', async () => {
  const { renderBrief } = await import('../src/brief.js');
  assert.match(renderBrief({ usage: { week: 10, typicalWeek: 20 }, stuck: [], unsaved: [], tidy: { bytes: 0 }, secrets: [] }).text, /^Nothing needs you\./);
  const r = renderBrief({ usage: { limitedNow: true, resetsAt: Date.now() + 3600e3 }, stuck: [{ project: 'shop', kind: 'tool', what: 'Bash: npm test' }], unsaved: [{ files: 3 }], tidy: { bytes: 5e9 }, secrets: [] }, ['saved 3 files in shop']);
  assert.equal(r.needsYou, 2);
  assert.match(r.text, /2 things need you[\s\S]*Done for you:\n  saved 3 files in shop[\s\S]*Waiting for you: shop \(Bash\)[\s\S]*5\.0 GB/);
});

test('snapshot: new files are capped (count and size) so build output cannot bloat the repo', async () => {
  const { snapshotOne } = await import('../src/snapshot.js');
  const d = repo();
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(d, `gen-${String(i).padStart(2, '0')}.txt`), 'x'.repeat(10 + i));
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed\n');
  const r = snapshotOne(d, { maxNewFiles: 5 });
  assert.equal(r.skipped, 25);
  const files = git(d, 'ls-tree', '-r', '--name-only', r.commit).split('\n');
  assert.equal(files.filter((f) => f.startsWith('gen-')).length, 5);
  assert.equal(git(d, 'show', `${r.commit}:a.txt`), 'changed', 'tracked changes are always kept');
});
