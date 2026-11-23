// The Claude Code plugin: manifest, marketplace, skills, and the quiet SessionStart hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { message, decide } from '../plugins/skillhawk/hooks/session-start.mjs';

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('plugin manifest and marketplace agree; MCP server runs from npm; version matches package.json', () => {
  const pkg = read('package.json');
  const plugin = read('plugins/skillhawk/.claude-plugin/plugin.json');
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'skillhawk');
  assert.equal(plugin.version, pkg.version, 'bump plugin.json with package.json');
  assert.deepEqual(plugin.mcpServers.skillhawk, { command: 'npx', args: ['-y', 'skillhawk', 'mcp'] });
  assert.deepEqual(market.plugins, [{ name: 'skillhawk', source: './plugins/skillhawk' }]);
  for (const s of ['billing', 'review-skills', 'secure']) assert.match(fs.readFileSync(`plugins/skillhawk/skills/${s}/SKILL.md`, 'utf8'), new RegExp(`^---\\nname: ${s}\\ndescription: .+Use when`, 'm'));
});

test('session-start hook: silent when nothing bills an API key; one line when it does; silent again until it changes', () => {
  assert.equal(message({ flagged: { billing: [], shell: [] } }), null);
  const r = { flagged: { billing: [{ kind: 'cron', where: 'crontab' }], shell: [{ file: '/x/.zshrc', vars: ['ANTHROPIC_API_KEY'] }] } };
  const m = message(r);
  assert.match(m, /^Skillhawk: 1 scheduled agent \(crontab\) bills an API key per token; your shell exports ANTHROPIC_API_KEY.*\/skillhawk:billing/);
  assert.doesNotMatch(m, /sk-ant|\.zshrc/);
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-hook-')), 'state.json');
  assert.equal(decide(r, state), m);
  assert.equal(decide(r, state), null, 'same finding is not repeated');
  assert.equal(decide({ flagged: { billing: [], shell: [] } }, state), null);
  assert.equal(decide(r, state), m, 'shown again after it was fixed and came back');
});
