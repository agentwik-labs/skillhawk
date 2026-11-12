// Fake Claude Code logs for tests. Not a test file (no .test.js suffix).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tmp = (p = 'sy-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
let n = 0;
/** Write one session. opts: id, cwd, day, prompts[], skill, corrections[], tokens */
export function session(root, o) {
  const cwd = o.cwd || '/fake/shop';
  const dir = path.join(root, cwd.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const day = o.day || '2026-11-10';
  const recs = [];
  let t = 0;
  const ts = () => `${day}T10:${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t++ % 60).padStart(2, '0')}.000Z`;
  const asst = (content) => ({ type: 'assistant', cwd, timestamp: ts(), requestId: `r${n}`, message: { id: `m${n++}`, model: 'claude-sonnet-4-5', content, usage: { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: o.tokens ?? 1000 } } });
  const user = (text) => ({ type: 'user', cwd, timestamp: ts(), message: { role: 'user', content: text } });
  (o.prompts || ['do the task']).forEach((p, i) => {
    recs.push(user(p));
    recs.push(asst(i === 0 && o.skill ? [{ type: 'tool_use', name: 'Skill', input: { skill: o.skill } }] : [{ type: 'text', text: 'done' }]));
  });
  for (const c of o.corrections || []) { recs.push(user(c)); recs.push(asst([{ type: 'text', text: 'fixed' }])); }
  fs.writeFileSync(path.join(dir, `${o.id}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
