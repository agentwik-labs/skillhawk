import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectHint } from '../src/cli.js';

test('connect hint: once after interactive checks; never for json, CI, pipes, opt-out, or when Claude Code already has skillhawk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-hint-'));
  let out = '';
  const o = (x = {}) => ({ env: {}, isTTY: true, home, write: (t) => { out += t; }, ...x });
  assert.equal(connectHint('agents', {}, o()), true);
  assert.match(out, /connect claude --write.*\/mcp__skillhawk__billing.*SKILLHAWK_NO_HINTS/);
  assert.equal(connectHint('agents', { json: 'x.json' }, o()), false);
  assert.equal(connectHint('review', { chats: true }, o()), false);
  assert.equal(connectHint('compile', {}, o()), false);
  assert.equal(connectHint('secure', {}, o({ isTTY: false })), false);
  assert.equal(connectHint('secure', {}, o({ env: { CI: 'true' } })), false);
  assert.equal(connectHint('secure', {}, o({ env: { SKILLHAWK_NO_HINTS: '1' } })), false);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { skillhawk: { command: 'npx' } } }));
  assert.equal(connectHint('agents', {}, o()), false);
});
