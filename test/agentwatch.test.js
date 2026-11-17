// skillhawk agents: forgotten agent processes, unattended sessions, scheduled agents, leftover dev servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  etimeSeconds, parsePs, parseLsof, findAgentProcesses, findLeftoverServers, findUnattendedSessions, findScheduled,
  collect, summary, notify, render,
} from '../src/agentwatch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skillhawk-agents-'));

const PS = [
  '  100     1 3-04:00:00   0.1  204800 ??       node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p "nightly triage"',
  '  101   100 3-03:59:00   0.0   10240 ??       /bin/zsh -c npm test',
  '  102   100 3-03:58:00   0.0   10240 ??       claude --print sub-agent',
  '  200     1   01:10:00   2.0  307200 ttys003  claude',
  '  300     1 26-01:00:00  0.0   13312 ??       /usr/local/bin/node /home/me/studio/server.cjs',
  '  301     1 26-01:00:00  0.0   13312 ttys001  node dev.js',
  '  302     1    30:00     0.0   13312 ??       node fresh.js',
  '  303     1 9-00:00:00   0.0   13312 ??       /Applications/Some.app/Contents/MacOS/node helper',
  '  400     1 2-00:00:00   0.0   13312 ??       node skillhawk agents',
].join('\n');
const LSOF = ['p300', 'cnode', 'n*:4400', 'n[::1]:4400', 'p301', 'cnode', 'n*:5000', 'p302', 'cnode', 'n*:5001', 'p303', 'cnode', 'n*:6000'].join('\n');

test('etime parses every ps form', () => {
  assert.equal(etimeSeconds('05:07'), 307);
  assert.equal(etimeSeconds('01:02:03'), 3723);
  assert.equal(etimeSeconds('3-04:00:00'), 3 * 86400 + 4 * 3600);
  assert.equal(etimeSeconds('nope'), null);
});

test('agent processes: outermost only, children counted, our own process ignored', () => {
  const a = findAgentProcesses(parsePs(PS), { selfPid: -1 });
  assert.deepEqual(a.map((x) => x.pid), [100, 200]);
  assert.equal(a[0].agent, 'claude');
  assert.equal(a[0].detached, true);
  assert.equal(a[0].children, 2, 'the shell and the nested claude belong to the outer agent');
  assert.equal(a[1].detached, false);
});

test('commands are shortened and secrets in them redacted', () => {
  const [a] = findAgentProcesses(parsePs('  9     1 2-00:00:00 0.0 1024 ?? ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 claude -p x'), { selfPid: -1 });
  assert.doesNotMatch(a.command, /sk-ant-api03/);
  assert.match(a.command, /\[api key\]/);
});

test('leftover servers: detached, long-running interpreters listening on a port; apps and attached ones skipped', () => {
  const s = findLeftoverServers(parsePs(PS), parseLsof(LSOF), { runningHours: 12 });
  assert.deepEqual(s.map((x) => x.pid), [300]);
  assert.deepEqual(s[0].ports, [4400]);
});

function writeSession(dir, name, records) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n'));
}
const at = (now, minutesAgo) => new Date(now - minutesAgo * 60e3).toISOString();
const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000 };

test('unattended sessions: working now, no human for idleHours; notifications and tool results are not human; cost counted since the last human', async () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const logs = path.join(tmp(), 'projects', '-repo');
  writeSession(logs, 'aaaaaaaa-unattended', [
    { type: 'user', timestamp: at(now, 600), cwd: '/home/me/repo', message: { content: 'please fix the build' } },
    { type: 'assistant', timestamp: at(now, 599), message: { model: 'claude-sonnet', usage, content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', timestamp: at(now, 300), message: { content: 'actually also run the tests' } },
    { type: 'assistant', timestamp: at(now, 200), message: { model: 'claude-sonnet', usage, content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', timestamp: at(now, 199), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', timestamp: at(now, 100), message: { content: '<task-notification>done</task-notification>' } },
    { type: 'assistant', timestamp: at(now, 5), message: { model: 'claude-sonnet', usage, content: [{ type: 'tool_use', name: 'Edit' }, { type: 'tool_use', name: 'Bash' }] } },
  ]);
  writeSession(logs, 'bbbbbbbb-finished', [
    { type: 'user', timestamp: at(now, 600), message: { content: 'hello' } },
    { type: 'assistant', timestamp: at(now, 590), message: { usage, content: [] } },
  ]);
  writeSession(logs, 'cccccccc-watched', [
    { type: 'user', timestamp: at(now, 20), message: { content: 'go' } },
    { type: 'assistant', timestamp: at(now, 2), message: { usage, content: [] } },
  ]);
  for (const f of fs.readdirSync(logs)) fs.utimesSync(path.join(logs, f), new Date(now), new Date(now));
  const s = await findUnattendedSessions({ logs: path.dirname(logs), now, idleHours: 2, activeMinutes: 30 });
  assert.deepEqual(s.map((x) => x.session), ['aaaaaaaa']);
  assert.equal(s[0].idleSeconds, 300 * 60, 'measured from the last real human message');
  assert.equal(s[0].turns, 2);
  assert.equal(s[0].tools, 3);
  assert.ok(s[0].cost > 0);
  assert.equal(s[0].project, 'repo');
});

test('scheduled agents: crontab, launchd plist, GitHub Actions schedule', () => {
  const d = tmp();
  const units = path.join(d, 'LaunchAgents');
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(units, 'com.me.triage.plist'), '<plist><array><string>/usr/local/bin/codex</string><string>exec</string></array></plist>');
  fs.writeFileSync(path.join(units, 'com.me.backup.plist'), '<plist><string>/usr/bin/rsync</string></plist>');
  const script = path.join(d, 'run-operator.mjs');
  fs.writeFileSync(script, "import { spawn } from 'node:child_process';\nspawn('claude', ['-p', 'engage']);\n");
  fs.writeFileSync(path.join(units, 'com.me.wrapper.plist'), `<plist><array><string>/usr/local/bin/node</string><string>${script}</string></array></plist>`);
  const wf = path.join(d, '.github', 'workflows');
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(path.join(wf, 'nightly.yml'), 'on:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  x:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n');
  fs.writeFileSync(path.join(wf, 'ci.yml'), 'on: push\njobs: {}\n');
  const s = findScheduled({ crontab: '# comment\n*/30 * * * * cd ~/x && claude -p "sweep"\n0 1 * * * backup.sh\n', unitDirs: [units], workflowDirs: [wf] });
  assert.deepEqual(s.map((x) => `${x.kind}:${x.agent}`), ['cron:claude', 'launchd:codex', 'launchd:claude', 'github-actions:claude']);
  assert.match(s[2].detail, /via run-operator\.mjs/);
  assert.equal(s[3].detail, '0 3 * * *');
});

test('summary and notifications carry counts only, never commands or prompts; Slack needs an https webhook', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'ps.txt'), PS);
  fs.writeFileSync(path.join(d, 'lsof.txt'), LSOF);
  const r = await collect({ fromPs: path.join(d, 'ps.txt'), fromLsof: path.join(d, 'lsof.txt'), logs: path.join(d, 'none'), noCrontab: true, unitDir: path.join(d, 'none'), repo: d });
  assert.equal(r.flagged.agents.length, 1);
  assert.equal(r.flagged.servers.length, 1);
  const text = summary(r);
  assert.match(text, /1 agent process running over 12h; 1 dev server left running/);
  assert.doesNotMatch(text, /nightly|server\.cjs|cli\.js/);
  let sent;
  assert.equal(await notify(r, 'slack', { webhook: 'https://hooks.slack.test/x', fetchImpl: async (u, o) => { sent = JSON.parse(o.body); return { ok: true }; } }), 'sent to Slack');
  assert.equal(sent.text, text);
  await assert.rejects(notify(r, 'slack', { webhook: 'http://insecure' }), /https/);
  assert.match(render(r), /Nothing was stopped\. To stop the flagged processes yourself: kill 100 300/);
});

test('CLI: agents --json from fixtures; --fail-on-flag exits 3', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'ps.txt'), PS);
  const args = [path.join(ROOT, 'bin', 'skillyard.js'), 'agents', '--from-ps', path.join(d, 'ps.txt'), '--logs', path.join(d, 'none'), '--no-crontab', '--unit-dir', path.join(d, 'none'), '--repo', d];
  const j = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const r = JSON.parse(j.stdout);
  assert.equal(r.agents.length, 2);
  const f = spawnSync(process.execPath, [...args, '--fail-on-flag'], { encoding: 'utf8' });
  assert.equal(f.status, 3);
  assert.match(f.stdout, /skillhawk agents: 1 need a look/);
});
