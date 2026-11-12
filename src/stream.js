// Streaming mode: agents use the vault's MCP server instead of installed files. Nothing is written to the client's disk.
// The server lists the org's skills lean (id + description), and serves each skill's content on demand, marked for
// the caller (finalizePull) and audit-logged. Revoking a member's token ends access on the very next call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.js';
import { finalizePull } from './vault.js';
import { parseSkillRef } from './skill.js';
import { sectionOf } from './map.js';
import { loadConfig } from './client.js';
import { PROTOCOL_VERSIONS } from './mcp.js';

const SERVER_INFO = { name: 'skillyard-stream', title: 'Skillyard company vault (streaming)', version: '0.1.0' };

const TOOLS = [
  { name: 'skill_list', title: 'List the company skills', description: 'List your organization\'s skills: id and one-line description only. Nothing is loaded until you call skill_load.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'skill_load', title: 'Load a skill', description: 'Load a skill\'s full SKILL.md (or one supporting file with path). Call it when a skill in the list matches the task.',
    inputSchema: { type: 'object', properties: { skill: { type: 'string', description: 'Skill id, e.g. "@acme/deploy-runbook"' }, path: { type: 'string', description: 'Supporting file inside the skill (optional)' } }, required: ['skill'] }, annotations: { readOnlyHint: true } },
  { name: 'skill_section', title: 'Read one section of a skill', description: 'Return one heading-section of a skill\'s SKILL.md. Omit heading for the outline first.',
    inputSchema: { type: 'object', properties: { skill: { type: 'string' }, heading: { type: 'string' } }, required: ['skill'] }, annotations: { readOnlyHint: true } },
];

/** Server side: a store bound to one caller. list() is lean; load() returns marked, audited content. */
export class StreamRegistry {
  constructor(store, auth) { this.store = store; this.auth = auth; }

  list() {
    const { store, auth } = this;
    return store.search({ scope: auth.org || undefined, limit: 500 }, auth)
      .filter((s) => !auth.org || s.scope === auth.org)
      .map((s) => ({ id: s.id, description: s.description || s.summary }));
  }

  async load(skill, { path: rel } = {}) {
    const { store, auth } = this;
    const ref = parseSkillRef(skill);
    if (!ref) throw new HttpError(400, `invalid skill "${skill}"`);
    if (rel) {
      const buf = store.readFile(ref.scope, ref.name, ref.version, rel, auth);
      store.audit({ action: 'stream.load', org: ref.scope, skill: `@${ref.scope}/${ref.name}`, version: ref.version, file: rel }, auth);
      return buf.toString('utf8');
    }
    const b = await finalizePull(store, store.bundle(ref.scope, ref.name, ref.version, auth, { audit: false }), auth);
    store.audit({ action: 'stream.load', org: b.scope, skill: b.id, version: b.version, marked: true }, auth);
    const others = Object.keys(b.files).filter((f) => f !== 'SKILL.md' && f !== 'skill.json');
    return `# ${b.id}@${b.version}\nSupporting files (skill_load with path): ${others.join(', ') || 'none'}\n\n---\n\n${Buffer.from(b.files['SKILL.md'], 'base64').toString('utf8')}`;
  }
}

export function createStreamHandler(reg) {
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
  const handlers = {
    initialize: async (p = {}) => {
      const lean = (await reg.list()).map((s) => `- ${s.id}: ${s.description}`).join('\n') || '(no skills)';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `Your company's skills are streamed on demand. When a task matches one, call skill_load (or skill_section for one part) before starting.\nAvailable skills:\n${lean}`,
      };
    },
    ping: () => ({}),
    'tools/list': () => ({ tools: TOOLS }),
    'tools/call': async (p = {}) => {
      const a = p.arguments || {};
      try {
        if (p.name === 'skill_list') {
          const list = await reg.list();
          return { content: [{ type: 'text', text: list.map((s) => `- ${s.id}: ${s.description}`).join('\n') || 'No skills.' }], structuredContent: { skills: list }, isError: false };
        }
        if (p.name === 'skill_load') return text(await reg.load(a.skill, { path: a.path }));
        if (p.name === 'skill_section') {
          const md = (await reg.load(a.skill)).split('\n---\n\n').slice(1).join('\n---\n\n');
          const r = sectionOf(md, a.heading);
          if (r.text) return text(r.text);
          return text(`${r.missing ? `No heading matches "${a.heading}". ` : ''}Outline:\n${r.outline.join('\n')}`, !!r.missing);
        }
      } catch (e) {
        return text(`Error: ${e.message}`, true);
      }
      const err = new Error(`unknown tool: ${p.name}`);
      err.rpc = { code: -32602, message: err.message };
      throw err;
    },
  };
  const one = async (msg) => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return msg && ('result' in msg || 'error' in msg) ? null : { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
    if (!('id' in msg)) return null;
    const fn = handlers[msg.method];
    if (!fn) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    try { return { jsonrpc: '2.0', id: msg.id, result: await fn(msg.params) }; } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, error: e.rpc || { code: -32603, message: e.message } };
    }
  };
  return async (msg) => {
    if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(one))).filter(Boolean); return out.length ? out : null; }
    return one(msg);
  };
}

// ---- client side ---------------------------------------------------------------------------

/** Forward JSON-RPC to the company vault's /mcp?stream=1. HTTP errors (revoked, offline) become JSON-RPC errors. */
export function streamProxy({ registry, token } = loadConfig()) {
  return async (msg) => {
    let res;
    try {
      res = await fetch(`${registry}/mcp?stream=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Skillyard-Host': os.hostname(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(msg),
      });
    } catch (e) {
      return msg?.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: `cannot reach the company vault at ${registry}` } };
    }
    if (res.status === 202) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return msg?.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code: res.status === 401 ? -32001 : -32603, message: data.error || `registry returned ${res.status}` } };
    return data;
  };
}

export async function mcpStdio() {
  const handle = streamProxy();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`); return; }
    const res = await handle(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
  await new Promise((r) => rl.on('close', r));
}

/** `skillyard connect <agent> --stream`: point the agent at the vault's MCP endpoint; no skill files are installed. */
export async function connectStream(args, f) {
  const agent = args[0];
  const cfg = loadConfig();
  const url = `${cfg.registry}/mcp?stream=1`;
  const entry = { type: 'http', url, headers: { Authorization: 'Bearer ${SKILLYARD_TOKEN}' } };
  const merge = (file, keys) => {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
    let o = cur;
    keys.slice(0, -1).forEach((k) => { o = o[k] ||= {}; });
    o[keys.at(-1)] = keys[0] === 'servers' ? entry : keys[0] === 'mcpServers' && agent === 'gemini' ? { httpUrl: url, headers: entry.headers } : entry;
    if (f.write) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(cur, null, 2)}\n`); return `wrote ${file}`; }
    return `Add to ${file}:\n${JSON.stringify({ [keys[0]]: { [keys[1]]: o[keys.at(-1)] } }, null, 2)}`;
  };
  const targets = {
    claude: () => {
      const cmd = ['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'skillyard-vault', url, '--header', 'Authorization: Bearer ${SKILLYARD_TOKEN}'];
      if (f.write) { const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' }); if (r.error) throw new Error('`claude` not found on PATH; run the command by hand'); return 'registered with Claude Code'; }
      return `Run:\n  ${cmd.map((c) => (/[\s$]/.test(c) ? `'${c}'` : c)).join(' ')}`;
    },
    cursor: () => merge(path.join(process.cwd(), '.cursor', 'mcp.json'), ['mcpServers', 'skillyard-vault']),
    vscode: () => merge(path.join(process.cwd(), '.vscode', 'mcp.json'), ['servers', 'skillyard-vault']),
    gemini: () => merge(path.join(os.homedir(), '.gemini', 'settings.json'), ['mcpServers', 'skillyard-vault']),
    codex: () => `Add to ~/.codex/config.toml:\n[mcp_servers.skillyard-vault]\nurl = "${url}"\nbearer_token_env_var = "SKILLYARD_TOKEN"`,
  };
  if (!targets[agent]) throw new Error(`usage: skillyard connect <${Object.keys(targets).join('|')}> --stream [--write]`);
  console.log(targets[agent]());
  console.log(`\nStream mode: the agent reads skills from the vault on demand (skill_list / skill_load / skill_section).\nNothing is installed on this machine, and \`skillyard revoke\` cuts access on the next call.\nSet your token: export SKILLYARD_TOKEN=<your token>   (or over stdio: skillyard mcp --stream)`);
}
