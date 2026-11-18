// `skillhawk agents`: find agents nobody is watching. Read-only; nothing is stopped or changed.
//   1. Agent processes (Claude Code, Codex, Cursor agent, Gemini, aider, ...): age, CPU, memory, attached terminal.
//   2. Claude Code sessions still working while no human has written for a while, with tokens and estimated cost
//      spent since a human last wrote.
//   3. Scheduled agents: crontab, launchd / systemd user jobs and GitHub Actions schedules that start an agent.
//   4. Leftover dev servers: interpreter processes listening on a port, detached, running for a long time.
//   5. Which account each scheduled agent bills (API key, subscription token, cloud) and API keys your shell exports.
// Prompts and file contents are never printed or sent; commands are shortened and secrets redacted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { listJsonl, costOf } from './tokens.js';
import { redact } from './studio/capture.js';

const AGENT_RE = /(?:^|[\s/'"`])(claude|codex|cursor-agent|gemini|aider|opencode|goose|amp)(?:[\s'"`]|$)|@anthropic-ai\/claude-code|@openai\/codex|@google\/gemini-cli/;
const SERVER_COMM = /(?:^|\/)(node|nodejs|python\d*(?:\.\d+)?|tsx|ts-node|deno|bun|ruby|php|postgres|uvicorn|gunicorn|vite|next-server|java)$/;
const SELF_RE = /skillhawk|skillyard\.js/;

export const DEFAULTS = { runningHours: 12, idleHours: 2, activeMinutes: 30, days: 2 };

/** "[[dd-]hh:]mm:ss" (ps etime) -> seconds. */
export function etimeSeconds(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
}

/** Parse `ps -Ao pid=,ppid=,etime=,pcpu=,rss=,tty=,command=`. */
export function parsePs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const secs = etimeSeconds(m[3]);
    if (secs === null) continue;
    out.push({ pid: +m[1], ppid: +m[2], seconds: secs, cpu: +m[4], rssMb: Math.round(+m[5] / 1024), tty: m[6], command: m[7].trim() });
  }
  return out;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` into [{pid, comm, ports[]}]. */
export function parseLsof(text) {
  const byPid = new Map();
  let cur = null;
  for (const line of String(text).split('\n')) {
    const k = line[0];
    const v = line.slice(1);
    if (k === 'p') { cur = byPid.get(+v) || { pid: +v, comm: '', ports: [] }; byPid.set(+v, cur); }
    else if (k === 'c' && cur) cur.comm = v;
    else if (k === 'n' && cur) { const port = /:(\d+)$/.exec(v)?.[1]; if (port && !cur.ports.includes(+port)) cur.ports.push(+port); }
  }
  return [...byPid.values()];
}

const detached = (tty) => !tty || tty === '??' || tty === '?' || tty === '-';
const short = (cmd, n = 90) => { const r = redact(cmd).replace(/\s+/g, ' '); return r.length > n ? `${r.slice(0, n - 1)}…` : r; };
const agentName = (cmd) => { const m = AGENT_RE.exec(cmd); if (!m) return null; return m[1] || (/codex/.test(m[0]) ? 'codex' : /gemini/.test(m[0]) ? 'gemini' : 'claude'); };

/** Agent processes, outermost only, with how many processes they started. */
export function findAgentProcesses(procs, { selfPid = process.pid } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const isAgent = (p) => p.pid !== selfPid && !SELF_RE.test(p.command) && agentName(p.command);
  const roots = procs.filter((p) => isAgent(p) && !(byPid.get(p.ppid) && isAgent(byPid.get(p.ppid))));
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const count = (pid, seen = new Set()) => (kids.get(pid) || []).reduce((n, c) => (seen.has(c) ? n : (seen.add(c), n + 1 + count(c, seen))), 0);
  return roots.map((p) => ({ ...p, agent: agentName(p.command), detached: detached(p.tty), children: count(p.pid), command: short(p.command) }));
}

/** Long-running, detached interpreter processes that listen on a port (dev servers left behind). */
export function findLeftoverServers(procs, listeners, { runningHours = DEFAULTS.runningHours } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = [];
  for (const l of listeners) {
    const p = byPid.get(l.pid);
    if (!p || !detached(p.tty) || p.seconds < runningHours * 3600) continue;
    const exe = p.command.split(/\s+/)[0];
    if (!SERVER_COMM.test(exe) && !SERVER_COMM.test(l.comm)) continue;
    if (/^\/(Applications|System)\//.test(exe)) continue;
    out.push({ pid: p.pid, seconds: p.seconds, cpu: p.cpu, rssMb: p.rssMb, ports: l.ports.sort((a, b) => a - b), command: short(p.command) });
  }
  return out.sort((a, b) => b.seconds - a.seconds);
}

const isHuman = (rec) => {
  if (rec?.type !== 'user' || rec.isMeta || rec.isSidechain) return false;
  const c = rec.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
  if (!text.trim()) return false; // tool results only
  return !/^\s*<(task-notification|system-reminder|local-command-stdout|bash-stdout)/.test(text);
};

/** One Claude Code session file -> activity summary. */
export async function readSessionActivity(file) {
  const s = { file, session: path.basename(file, '.jsonl').slice(0, 8), cwd: null, title: null, first: null, last: null, lastHuman: null, since: { tools: 0, turns: 0, cost: 0, tokens: 0 } };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.cwd && !s.cwd) s.cwd = r.cwd;
    if (r.type === 'ai-title' && (r.title || r.aiTitle)) s.title = String(r.title || r.aiTitle).slice(0, 80);
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (Number.isNaN(t)) continue;
    if (s.first === null) s.first = t;
    s.last = Math.max(s.last ?? t, t);
    if (isHuman(r)) { s.lastHuman = t; s.since = { tools: 0, turns: 0, cost: 0, tokens: 0 }; continue; }
    if (r.type === 'assistant' && r.message) {
      const u = r.message.usage || {};
      const usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
      s.since.turns++;
      s.since.tokens += usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
      s.since.cost += costOf(usage, r.message.model);
      if (Array.isArray(r.message.content)) s.since.tools += r.message.content.filter((x) => x?.type === 'tool_use').length;
    }
  }
  return s;
}

/** Sessions that are still active but have had no human input for idleHours. */
export async function findUnattendedSessions({ logs, now = Date.now(), days = DEFAULTS.days, idleHours = DEFAULTS.idleHours, activeMinutes = DEFAULTS.activeMinutes } = {}) {
  const root = logs || path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  for (const file of listJsonl(root)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs > days * 86400e3) continue;
    const s = await readSessionActivity(file);
    if (s.last === null || now - s.last > activeMinutes * 60e3) continue; // not working right now
    const from = s.lastHuman ?? s.first;
    const idle = now - from;
    if (idle < idleHours * 3600e3 || s.since.turns === 0) continue;
    out.push({ session: s.session, project: s.cwd ? path.basename(s.cwd) : path.basename(path.dirname(file)), title: s.title, idleSeconds: Math.round(idle / 1000), lastActivitySeconds: Math.round((now - s.last) / 1000), noHumanEver: s.lastHuman === null, ...s.since });
  }
  return out.sort((a, b) => b.cost - a.cost);
}

/** Scheduled jobs that start an agent: crontab text, launchd/systemd unit dirs, GitHub workflow dirs. */

// ---- which account a run will bill -------------------------------------------------------------
// Names only: values are never read into output. Claude Code docs: when ANTHROPIC_API_KEY is set it is used instead
// of a Claude subscription, and in non-interactive mode (-p) it is always used when present.
const CRED = [
  ['ANTHROPIC_API_KEY', 'api-key'], ['ANTHROPIC_AUTH_TOKEN', 'api-key'], ['OPENAI_API_KEY', 'api-key'], ['CODEX_API_KEY', 'api-key'],
  ['GEMINI_API_KEY', 'api-key'], ['GOOGLE_API_KEY', 'api-key'], ['CLAUDE_CODE_USE_BEDROCK', 'cloud'], ['CLAUDE_CODE_USE_VERTEX', 'cloud'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'subscription'],
];
const ENV_LOAD_RE = /(?:^|[\s;&(])(?:source|\.)\s+[^\s;&|]*\.env\b|dotenv|--env-file|EnvironmentFile\s*=|set\s+-a/;
const RANK = { 'api-key': 3, cloud: 2, subscription: 1 };

function varsIn(text) {
  const t = String(text || '');
  return CRED.filter(([v]) => new RegExp(`\\b${v}\\b`).test(t)).map(([v, kind]) => ({ v, kind }));
}

/** What a job will bill, from its own text plus a .env it loads (names only). */
export function billingOf(texts, { dirs = [] } = {}) {
  const found = new Map();
  const add = (list, via) => { for (const x of list) if (!found.has(x.v)) found.set(x.v, { ...x, via }); };
  for (const t of texts) add(varsIn(t), 'job');
  if (texts.some((t) => ENV_LOAD_RE.test(String(t || '')))) {
    for (const d of dirs) {
      for (const name of ['.env', '.env.local']) {
        try { add(varsIn(fs.readFileSync(path.join(d, name), 'utf8').split('\n').map((l) => l.split('=')[0]).join('\n')), name); } catch { /* none */ }
      }
    }
  }
  // GitHub Actions inputs
  for (const t of texts) {
    if (/claude_code_oauth_token\s*:/.test(t)) add([{ v: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'subscription' }], 'workflow');
    if (/anthropic_api_key\s*:/.test(t)) add([{ v: 'ANTHROPIC_API_KEY', kind: 'api-key' }], 'workflow');
    if (/use_bedrock\s*:\s*['"]?true|use_vertex\s*:\s*['"]?true/.test(t)) add([{ v: 'CLAUDE_CODE_USE_BEDROCK', kind: 'cloud' }], 'workflow');
  }
  const vars = [...found.values()];
  if (!vars.length) return { bills: 'unknown', vars: [] };
  const top = vars.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));
  return { bills: top.kind, vars: vars.map((x) => x.v) };
}

/** API keys exported by shell start-up files: every `claude -p` started from that shell bills the key. */
export function shellCredentials({ files } = {}) {
  const home = os.homedir();
  const list = files || ['.zshenv', '.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish'].map((f) => path.join(home, f));
  const out = [];
  for (const f of list) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const vars = CRED.filter(([v, kind]) => kind === 'api-key' && new RegExp(`^\\s*(?:export\\s+|set\\s+-gx\\s+)${v}\\b`, 'm').test(text)).map(([v]) => v);
    if (vars.length) out.push({ file: f.startsWith(home) ? `~${f.slice(home.length)}` : f, vars });
  }
  return out;
}

const billLabel = (b) => (!b || b.bills === 'unknown' ? 'bills: no key set in the job (it uses the account the agent is signed in with, unless its environment sets a key)'
  : b.bills === 'api-key' ? `bills: API key, pay per token (${b.vars.join(', ')})`
    : b.bills === 'cloud' ? `bills: cloud provider (${b.vars.join(', ')})` : `bills: subscription token (${b.vars.join(', ')})`);

export function findScheduled({ crontab = '', unitDirs = [], workflowDirs = [] } = {}) {
  const out = [];
  const cronEnv = [];
  for (const line of String(crontab).split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)) { cronEnv.push(l.split('=')[0].trim()); continue; }
    const a = agentName(l);
    const dir = /\bcd\s+([^\s;&]+)/.exec(l)?.[1]?.replace(/^~(?=\/|$)/, os.homedir());
    if (a) out.push({ kind: 'cron', agent: a, where: 'crontab', detail: short(l), billing: billingOf([l, cronEnv.join('\n')], { dirs: dir ? [dir] : [] }) });
  }
  for (const dir of unitDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.(plist|service|timer)$/.test(f)); } catch { continue; }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const plain = text.replace(/<[^>]+>/g, ' ');
      let a = agentName(plain);
      let via = '';
      let scriptText = '';
      let scriptDir = '';
      // A job often runs a script that starts the agent: look one level into scripts it names.
      if (!a) for (const p of plain.match(/(?:\/|~\/)[^\s"'<>]+\.(?:sh|bash|zsh|mjs|cjs|js|ts|py)\b/g) || []) {
        const file = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
        try { if (fs.statSync(file).size < 500_000 && (a = agentName(scriptText = fs.readFileSync(file, 'utf8')))) { via = ` via ${path.basename(file)}`; scriptDir = path.dirname(file); break; } } catch { /* missing or unreadable */ }
      }
      const workDir = /WorkingDirectory<\/key>\s*<string>([^<]+)</.exec(text)?.[1] || /^WorkingDirectory\s*=\s*(\S+)/m.exec(text)?.[1];
      if (a) out.push({ kind: f.endsWith('.plist') ? 'launchd' : 'systemd', agent: a, where: redact(path.join(dir, f)), detail: `${f}${via}`,
        billing: billingOf([text, scriptText], { dirs: [workDir, scriptDir].filter(Boolean) }) });
    }
  }
  for (const dir of workflowDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); } catch { continue; }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      if (!/^\s*schedule\s*:/m.test(text)) continue;
      const a = /anthropics\/claude-code-action/.test(text) ? 'claude' : agentName(text);
      if (a) out.push({ kind: 'github-actions', agent: a, where: path.join(dir, f), detail: (/cron:\s*['"]?([^'"\n]+)/.exec(text)?.[1] || 'schedule').trim(), billing: billingOf([text]) });
    }
  }
  return out;
}

const run1 = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }); } catch { return ''; } };

/** Everything, from this machine (or from files, for tests). */
export async function collect(f = {}, now = Date.now()) {
  const th = {
    runningHours: Number(f.runningHours ?? f.running ?? DEFAULTS.runningHours),
    idleHours: Number(f.idleHours ?? f.idle ?? DEFAULTS.idleHours),
    activeMinutes: Number(f.activeMinutes ?? DEFAULTS.activeMinutes),
    days: Number(f.days ?? DEFAULTS.days),
  };
  const psText = f.fromPs ? fs.readFileSync(f.fromPs, 'utf8') : run1('ps', ['-Ao', 'pid=,ppid=,etime=,pcpu=,rss=,tty=,command=']);
  const lsofText = f.fromLsof ? fs.readFileSync(f.fromLsof, 'utf8') : f.fromPs ? '' : run1('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  const procs = parsePs(psText);
  const agents = findAgentProcesses(procs);
  const servers = findLeftoverServers(procs, parseLsof(lsofText), th);
  const sessions = await findUnattendedSessions({ logs: f.logs, now, ...th });
  const home = os.homedir();
  const scheduled = findScheduled({
    crontab: f.noCrontab ? '' : f.crontab !== undefined ? fs.readFileSync(f.crontab, 'utf8') : run1('crontab', ['-l']),
    unitDirs: f.unitDir ? [].concat(f.unitDir) : [path.join(home, 'Library', 'LaunchAgents'), path.join(home, '.config', 'systemd', 'user')],
    workflowDirs: [path.join(f.repo || process.cwd(), '.github', 'workflows')],
  });
  const shell = f.noShell ? [] : shellCredentials(f.shellFile ? { files: [].concat(f.shellFile) } : {});
  const flagged = {
    agents: agents.filter((a) => a.seconds >= th.runningHours * 3600),
    sessions,
    servers,
    billing: scheduled.filter((s) => s.billing?.bills === 'api-key'),
    shell,
  };
  return { thresholds: th, agents, sessions, servers, scheduled, shell, flagged,
    flaggedCount: flagged.agents.length + flagged.sessions.length + flagged.servers.length + flagged.billing.length + flagged.shell.length };
}

export const ago = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.max(0, Math.floor(s / 60))}m`);

export function render(r) {
  const L = [];
  const th = r.thresholds;
  L.push(`skillhawk agents: ${r.flaggedCount} need a look (running over ${th.runningHours}h, or working with no human input for ${th.idleHours}h)`);
  L.push('');
  L.push(`Agent processes (${r.agents.length})`);
  if (!r.agents.length) L.push('  none running');
  for (const a of r.agents) {
    const flag = a.seconds >= th.runningHours * 3600 ? '!' : ' ';
    L.push(` ${flag} ${String(a.pid).padStart(6)}  ${a.agent.padEnd(7)} up ${ago(a.seconds).padEnd(8)} ${a.detached ? 'no terminal' : `tty ${a.tty}`.padEnd(11)}  cpu ${a.cpu}%  ${a.rssMb} MB  ${a.children} child process${a.children === 1 ? '' : 'es'}`);
  }
  L.push('');
  L.push(`Claude Code sessions working with no human input (${r.sessions.length})`);
  if (!r.sessions.length) L.push('  none');
  for (const s of r.sessions) {
    L.push(` ! ${s.session}  ${s.project}${s.title ? `  "${s.title}"` : ''}`);
    L.push(`     ${s.noHumanEver ? 'no human message in this session' : `last human message ${ago(s.idleSeconds)} ago`}; last activity ${ago(s.lastActivitySeconds)} ago; since then ${s.turns} turns, ${s.tools} tool calls, about $${s.cost.toFixed(2)} (estimate)`);
  }
  L.push('');
  L.push(`Dev servers left running (${r.servers.length})`);
  if (!r.servers.length) L.push('  none');
  for (const s of r.servers) L.push(` ! ${String(s.pid).padStart(6)}  up ${ago(s.seconds).padEnd(8)} port ${s.ports.join(',')}  ${s.rssMb} MB  ${s.command}`);
  L.push('');
  L.push(`Scheduled agents (${r.scheduled.length})`);
  if (!r.scheduled.length) L.push('  none found in crontab, launchd/systemd user jobs or this repo\'s GitHub workflows');
  for (const s of r.scheduled) {
    L.push(` ${s.billing?.bills === 'api-key' ? '!' : ' '} ${s.kind.padEnd(14)} ${s.agent.padEnd(7)} ${s.detail}  (${s.where})`);
    L.push(`     ${billLabel(s.billing)}`);
  }
  L.push('');
  L.push(`API keys your shell exports (${(r.shell || []).length})`);
  if (!(r.shell || []).length) L.push('  none found in your shell start-up files');
  for (const c of r.shell || []) L.push(` ! ${c.file}: ${c.vars.join(', ')}. Agents started from this shell, including \`claude -p\` in scripts, bill this key per token, even when you are signed in to a subscription.`);
  const pids = [...r.flagged.agents.map((a) => a.pid), ...r.flagged.servers.map((s) => s.pid)];
  if (pids.length) { L.push(''); L.push(`Nothing was stopped. To stop the flagged processes yourself: kill ${pids.join(' ')}`); }
  return L.join('\n');
}

/** Short, content-free summary for a notification. */
export function summary(r) {
  const parts = [];
  if (r.flagged.agents.length) parts.push(`${r.flagged.agents.length} agent process${r.flagged.agents.length === 1 ? '' : 'es'} running over ${r.thresholds.runningHours}h`);
  if (r.flagged.sessions.length) { const c = r.flagged.sessions.reduce((n, s) => n + s.cost, 0); parts.push(`${r.flagged.sessions.length} session${r.flagged.sessions.length === 1 ? '' : 's'} working unattended (~$${c.toFixed(2)} since a human last wrote)`); }
  if (r.flagged.servers.length) parts.push(`${r.flagged.servers.length} dev server${r.flagged.servers.length === 1 ? '' : 's'} left running`);
  if (r.flagged.billing?.length) parts.push(`${r.flagged.billing.length} scheduled agent${r.flagged.billing.length === 1 ? '' : 's'} billing an API key`);
  if (r.flagged.shell?.length) parts.push('an API key exported by your shell');
  return parts.length ? `Skillhawk on ${os.hostname()}: ${parts.join('; ')}. Run \`skillhawk agents\` to see them.` : '';
}

export async function notify(r, how, { webhook = process.env.SKILLHAWK_SLACK_WEBHOOK, fetchImpl = globalThis.fetch } = {}) {
  const text = summary(r);
  if (!text) return 'nothing to report';
  if (how === 'slack') {
    if (!webhook || !/^https:\/\//.test(webhook)) throw new Error('--notify slack needs --webhook <https url> or SKILLHAWK_SLACK_WEBHOOK');
    const res = await fetchImpl(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
    return 'sent to Slack';
  }
  if (how === 'desktop') {
    const msg = text.replace(/["\\]/g, "'");
    if (process.platform === 'darwin') run1('osascript', ['-e', `display notification "${msg}" with title "Skillhawk"`]);
    else run1('notify-send', ['Skillhawk', msg]);
    return 'desktop notification shown';
  }
  throw new Error('--notify takes desktop or slack');
}

export async function run(_args, f = {}) {
  const r = await collect(f);
  if (f.json) {
    const out = JSON.stringify(r, null, 2);
    if (typeof f.json === 'string') fs.writeFileSync(f.json, `${out}\n`); else console.log(out);
  } else console.log(render(r));
  if (f.notify) console.log(await notify(r, f.notify, { webhook: f.webhook || process.env.SKILLHAWK_SLACK_WEBHOOK }));
  if (f.failOnFlag && r.flaggedCount) process.exitCode = 3;
}
