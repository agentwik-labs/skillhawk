#!/usr/bin/env node
// 10 marked copies of one skill, then trace each leak scenario. Used for the demo video.
//   node scripts/trace-demo.mjs [--skill code-review] [--llm-rewrite]
// --llm-rewrite asks `claude -p --model haiku` to paraphrase copy #4 and traces that too (needs the claude CLI; makes a model call).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { markSkill, trace } from '../src/mark.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const skill = argv.includes('--skill') ? argv[argv.indexOf('--skill') + 1] : 'code-review';
const SECRET = 'demo-org-secret';
const ZW = /[​-‏⁠-⁤﻿]/g;
const people = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'];
const original = fs.readFileSync(path.join(ROOT, 'registry', 'public', skill, 'SKILL.md'), 'utf8');
const copies = people.map((recipient) => ({ recipient, ...markSkill(original, { recipient, version: '1.0.0', orgSecret: SECRET }) }));
const marks = copies.map((c) => c.fingerprint);
const lines = (t) => t.split('\n');
const fragment = (t) => { const l = lines(t); return l.slice(Math.floor(l.length * 0.3), Math.floor(l.length * 0.6)).join('\n'); };
const paraphrase = (t) => t.replace(ZW, '').split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).join('\n')
  .replace(/\b(Don|Doesn|Isn|Aren)['’]t/g, (m) => `${m.slice(0, -3) === 'Don' ? 'Do' : m.slice(0, -3)} not`).replace(/\bensure\b/g, 'make sure').replace(/\bverify\b/g, 'check');
const verdict = (text, want) => {
  const [a, b] = trace(text, marks, { orgSecret: SECRET });
  const ok = a.recipient === want && a.evidenceBits > 0;
  return `${ok ? 'OK ' : 'MISS'} ${a.evidenceBits > 0 ? a.recipient : '-'} ${a.confidence.toFixed(3)} ${String(Math.round(a.evidenceBits)).padStart(3)} bits (2nd ${Math.round(b.evidenceBits)})`;
};

const rows = copies.map((c) => [c.recipient, verdict(c.text, c.recipient), verdict(c.text.replace(ZW, ''), c.recipient), verdict(fragment(c.text), c.recipient), verdict(paraphrase(c.text), c.recipient)]);
const head = ['recipient', 'full copy', 'zero-width stripped', '30% fragment', 'paraphrased'];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => r.map((x, i) => x.padEnd(w[i])).join('  ');
console.log(`skill: ${skill}   ${marks[0].sites.length} wording sites, ${marks[0].zwPoints} zero-width points, canary in ${marks[0].canary.placement}\n`);
console.log(line(head));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));

const [x, y] = [copies[1], copies[6]];
const merged = lines(x.text).map((l, i) => (Math.floor(i / 2) % 2 === 0 ? l : lines(y.text)[i] ?? l)).join('\n');
console.log(`\ncollusion (${x.recipient} + ${y.recipient} merge their copies): top 2 = ${trace(merged, marks, { orgSecret: SECRET }).slice(0, 2).map((r) => `${r.recipient} ${Math.round(r.evidenceBits)} bits`).join(', ')}`);
const ev = trace(copies[3].text, marks, { orgSecret: SECRET })[0];
console.log(`\nevidence for ${ev.recipient}:\n${ev.evidence.map((e) => `  ${e}`).join('\n')}`);

if (argv.includes('--llm-rewrite')) {
  const prompt = `Rewrite this agent skill in your own words. Keep every instruction and the markdown structure, but reword the sentences freely.\n\n${copies[3].text.replace(ZW, '')}`;
  const r = spawnSync('claude', ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--permission-mode', 'default'], { input: prompt, cwd: fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sy-rewrite-')), encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(`claude -p failed: ${r.stderr}`);
  const res = trace(r.stdout, marks, { orgSecret: SECRET });
  console.log(`\nLLM rewrite of ${copies[3].recipient}'s copy -> top: ${res[0].recipient} confidence ${res[0].confidence.toFixed(4)}\n${res[0].evidence.map((e) => `  ${e}`).join('\n') || '  (no evidence)'}`);
}
