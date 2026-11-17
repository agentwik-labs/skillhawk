// Model Context Protocol (JSON-RPC 2.0) handler. Transport-agnostic: the HTTP server (Streamable HTTP)
// and the stdio command both feed messages through handleMessage().
//
// `registry` is any object with: search(opts), get(scope, name, version), readFile(scope, name, version, path).
// LocalRegistry (server side) and RemoteRegistry (CLI side) both implement it.
import { parseSkillRef } from './skill.js';
import { loadMap, queryMap, formatHits, sectionOf, localSkillText } from './map.js';
import { LOCAL_TOOLS, callLocalTool } from './localtools.js';
import { readFileSync } from 'node:fs';

const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'skillhawk', title: 'Skillhawk', version: PKG_VERSION };
const LOCAL_INSTRUCTIONS = [
  'Skillhawk checks AI agent skills and agent setup on this machine. Nothing leaves the machine.',
  'Call review_skill before installing or publishing a skill, secure_scan on a repo or skill before trusting it,',
  'compile_skill to convert a skill for another agent, and check_agents to find agents and sessions nobody is watching.',
].join(' ');
const INSTRUCTIONS = [
  'Skillhawk holds reusable skills: tested instructions for specific kinds of work, including your organization\'s private',
  'playbooks (deploy runbooks, code standards, compliance rules, brand voice).',
  'Before starting a non-trivial task, call search_skills with a few keywords. If a skill matches, call get_skill and',
  'follow its instructions; use read_skill_file for any references/ templates/ or scripts/ it mentions.',
  'Company skills (@<org>/...) override general community skills when they conflict.',
].join(' ');

const TOOLS = [
  {
    name: 'search_skills',
    title: 'Search skills',
    description: 'Search the skill registry by keywords. Returns matching skills (id, title, summary, category). Use before starting a task to find a relevant playbook.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "deploy rollback" or "code review"' },
        scope: { type: 'string', description: 'Limit to one org, e.g. "acme" (optional)' },
        category: { type: 'string', description: 'Limit to a category, e.g. "security" (optional)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_skill',
    title: 'Get skill instructions',
    description: 'Fetch a skill\'s full SKILL.md instructions and its file list. Pass an id like "@acme/deploy-runbook" or a bare community name like "code-review".',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill id, optionally with a version: "@acme/deploy-runbook@1.0.0"' },
      },
      required: ['skill'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_skill_file',
    title: 'Read a skill file',
    description: 'Read a supporting file (references/, templates/, scripts/) from a skill.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill id, e.g. "@acme/incident-response"' },
        path: { type: 'string', description: 'Relative path inside the skill, e.g. "templates/status-update.md"' },
      },
      required: ['skill', 'path'],
    },
    annotations: { readOnlyHint: true },
  },
];

// Lean loading: ask the repo map and read one section of a skill instead of whole files.
const MAP_TOOL = {
  name: 'map_query',
  title: 'Query the repo map',
  description: 'Find the files and symbols (with line numbers) that match a question, using the local skillhawk map (built by `skillhawk map`). Call this before opening files; then read only the lines it points to.',
  inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'Keywords or a short question, e.g. "where is the security scan"' }, limit: { type: 'number', description: 'Max hits (default 8)' } }, required: ['question'] },
  annotations: { readOnlyHint: true },
};
const SECTION_TOOL = {
  name: 'skill_section',
  title: 'Read one section of a skill',
  description: 'Return one heading-section of a skill\'s SKILL.md instead of the whole file. Omit heading to get the outline (headings with line numbers) first.',
  inputSchema: { type: 'object', properties: { skill: { type: 'string', description: 'Skill id or name' }, heading: { type: 'string', description: 'Heading text (exact or partial); omit for the outline' } }, required: ['skill'] },
  annotations: { readOnlyHint: true },
};

/**
 * opts.root: a local folder holding .skillyard/map (stdio mode); enables map_query and local skill lookup.
 * opts.local: add the local check tools (review_skill, secure_scan, compile_skill, check_agents); stdio only.
 * registry null: no registry tools, prompts or resources (local checks only).
 */
export function createMcpHandler(registry, opts = {}) {
  const tools = [...(registry ? TOOLS : []), ...(opts.root ? [MAP_TOOL, SECTION_TOOL] : []), ...(opts.local ? LOCAL_TOOLS : [])];
  const instructions = registry ? (opts.local ? `${INSTRUCTIONS} ${LOCAL_INSTRUCTIONS}` : INSTRUCTIONS) : LOCAL_INSTRUCTIONS;
  const handlers = {
    initialize: (params = {}) => ({
      protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions,
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools }),
    'tools/call': (params = {}) => callTool(registry, params.name, params.arguments || {}, opts),
    'prompts/list': async () => {
      if (!registry) return { prompts: [] };
      const skills = await registry.search({ limit: 500 });
      return {
        prompts: skills.map((s) => ({
          name: promptName(s.id),
          title: `${s.title} (${s.id})`,
          description: s.summary,
        })),
      };
    },
    'prompts/get': async (params = {}) => {
      const ref = fromPromptName(params.name);
      const info = await registry.get(ref.scope, ref.name, 'latest');
      const task = params.arguments?.task ? `\n\nTask: ${params.arguments.task}` : '';
      return {
        description: info.summary,
        messages: [{ role: 'user', content: { type: 'text', text: `${skillText(info)}${task}` } }],
      };
    },
    'resources/list': async () => {
      if (!registry) return { resources: [] };
      const skills = await registry.search({ limit: 500 });
      return {
        resources: skills.map((s) => ({
          uri: `skill://${s.id}/SKILL.md`,
          name: s.id,
          title: s.title,
          description: s.summary,
          mimeType: 'text/markdown',
        })),
      };
    },
    'resources/templates/list': () => (!registry ? { resourceTemplates: [] } : {
      resourceTemplates: [{ uriTemplate: 'skill://@{scope}/{name}/{path}', name: 'skill-file', title: 'A file inside a skill', mimeType: 'text/plain' }],
    }),
    'resources/read': async (params = {}) => {
      const m = /^skill:\/\/@([a-z0-9-]+)\/([a-z0-9-]+)\/(.+)$/.exec(params.uri || '');
      if (!m) throw rpcError(-32602, 'unknown resource uri');
      const text = await registry.readFile(m[1], m[2], 'latest', m[3]);
      return { contents: [{ uri: params.uri, mimeType: m[3].endsWith('.md') ? 'text/markdown' : 'text/plain', text }] };
    },
  };

  /** Handle one parsed JSON-RPC message or batch. Returns the response (or null for notifications). */
  return async function handleMessage(msg) {
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handleOne))).filter(Boolean);
      return out.length ? out : null;
    }
    return handleOne(msg);
  };

  async function handleOne(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && ('result' in msg || 'error' in msg)) return null; // a response from the client; nothing to do
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
    }
    const isNotification = !('id' in msg);
    const fn = handlers[msg.method];
    if (isNotification) return null;
    if (!fn) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    try {
      return { jsonrpc: '2.0', id: msg.id, result: await fn(msg.params) };
    } catch (e) {
      if (e.rpc) return { jsonrpc: '2.0', id: msg.id, error: e.rpc };
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } };
    }
  }
}

async function callTool(registry, name, args, opts = {}) {
  if (opts.local) {
    const local = await callLocalTool(name, args, { root: opts.root || process.cwd(), agentsFixtures: opts.agentsFixtures });
    if (local) return local;
  }
  if (!registry && name !== 'map_query' && name !== 'skill_section') throw rpcError(-32602, `unknown tool: ${name}`);
  try {
    if (name === 'map_query' && opts.root) {
      const map = loadMap(opts.root);
      if (!map) return text('No map found. Run `skillhawk map` in the repo first.', true);
      return text(formatHits(queryMap(map, args.question || '', Math.min(Number(args.limit) || 8, 30))));
    }
    if (name === 'skill_section') {
      let md = opts.root ? localSkillText(opts.root, args.skill) : null;
      if (!md && !registry) return text(`No local skill "${args.skill}" found under ${opts.root}.`, true);
      if (!md) {
        const ref = parseSkillRef(args.skill);
        if (!ref) return text(`Invalid skill id "${args.skill}".`, true);
        md = (await registry.get(ref.scope, ref.name, ref.version)).skillMd;
      }
      const r = sectionOf(md, args.heading);
      if (r.text) return text(r.text);
      return text(`${r.missing ? `No heading matches "${args.heading}". ` : ''}Outline:\n${r.outline.join('\n')}`, !!r.missing);
    }
    if (name === 'search_skills') {
      const results = await registry.search({ q: args.query || '', scope: args.scope, category: args.category, limit: Math.min(Number(args.limit) || 10, 50) });
      if (!results.length) return text(`No skills match "${args.query || ''}".`);
      const lines = results.map((s) => `- ${s.id} — ${s.title} [${s.category}${s.visibility === 'private' ? ', private' : ''}]: ${s.summary}`);
      return {
        content: [{ type: 'text', text: `${results.length} skill(s):\n${lines.join('\n')}\n\nCall get_skill with an id to load its instructions.` }],
        structuredContent: { results: results.map(({ score, ...s }) => s) },
      };
    }
    if (name === 'get_skill') {
      const ref = parseSkillRef(args.skill);
      if (!ref) return text(`Invalid skill id "${args.skill}". Use "@org/name" or a bare community name.`, true);
      const info = await registry.get(ref.scope, ref.name, ref.version);
      return text(skillText(info));
    }
    if (name === 'read_skill_file') {
      const ref = parseSkillRef(args.skill);
      if (!ref) return text(`Invalid skill id "${args.skill}".`, true);
      return text(await registry.readFile(ref.scope, ref.name, ref.version, args.path));
    }
    throw rpcError(-32602, `unknown tool: ${name}`);
  } catch (e) {
    if (e.rpc) throw e;
    return text(`Error: ${e.message}`, true);
  }
}

function skillText(info) {
  const others = info.files.filter((f) => f !== 'SKILL.md' && f !== 'skill.json');
  const header = [
    `# Skill ${info.id}@${info.version}`,
    `Supporting files${others.length ? ` (read with read_skill_file): ${others.join(', ')}` : ': none'}`,
    'Scripts are not executed by the registry. To run one, install the skill locally: npx skillhawk install ' + info.id,
    '',
    '---',
    '',
  ].join('\n');
  return header + info.skillMd;
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
const promptName = (id) => id.slice(1).replace('/', '.');
function fromPromptName(n) {
  const m = /^([a-z0-9-]+)\.([a-z0-9-]+)$/.exec(n || '');
  if (!m) throw rpcError(-32602, `unknown prompt: ${n}`);
  return { scope: m[1], name: m[2] };
}
function rpcError(code, message) {
  const e = new Error(message);
  e.rpc = { code, message };
  return e;
}
