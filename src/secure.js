// `skillhawk secure`: skills (via scan.js) plus the packages around them: MCP server configs, hooks,
// dependencies declared by skill scripts, scripts fetched at run time, and over-broad tool grants.
// Every finding: { severity: high|medium|low, rule, file, line, message (why it matters), fix }.

import fs from 'node:fs';
import path from 'node:path';
import { scanFiles } from './scan.js';

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build']);
const SCRIPT_RE = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1)$/;
const RANK = { low: 1, medium: 2, high: 3 };
const MEDIUM_RULES = new Set(['network-call', 'shell-true', 'sudo', 'destructive-rm', 'auto-approve']);
const SECRET_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

const mk = (severity, rule, file, line, message, fix) => ({ severity, rule, file, line: line || 1, message, fix });

function lineOf(text, needle) {
  if (!needle) return 1;
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  return i < 0 ? 1 : i + 1;
}

function walk(root) {
  const out = [];
  const rec = (abs, rel, depth) => {
    if (depth > 10) return;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) rec(path.join(abs, e.name), r, depth + 1); }
      else if (e.isFile()) out.push(r);
    }
  };
  rec(root, '', 0);
  return out;
}

// ---- MCP server configs -----------------------------------------------------------------------

const MCP_FILE = /(?:^|\/)(?:\.mcp\.json|mcp\.json|claude_desktop_config\.json|mcp_config[\w.-]*\.json)$/;
const isLocalHost = (u) => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(u);

function checkMcp(file, text) {
  const out = [];
  let json;
  try { json = JSON.parse(text); } catch { return out; }
  const servers = json.mcpServers || json.servers || {};
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') continue;
    const L = (needle) => lineOf(text, needle) > 1 ? lineOf(text, needle) : lineOf(text, `"${name}"`);
    const cmd = path.basename(String(s.command || ''));
    const args = (s.args || []).map(String);
    const pkgArgs = args.filter((a) => !a.startsWith('-'));
    if (/^(?:npx|bunx|pnpx)$/.test(cmd) || (cmd === 'pnpm' && args[0] === 'dlx')) {
      const pkg = pkgArgs.find((a) => a !== 'dlx');
      if (pkg && /^(?:https?:|git\+|github:|[\w.-]+\/[\w.-]+$)/.test(pkg) && !pkg.startsWith('@')) out.push(mk('high', 'mcp-remote-package', file, L(pkg), `MCP server "${name}" runs code from ${pkg}, outside the npm registry`, 'publish and pin it to a registry version, or vendor it'));
      else if (pkg && !/^(?:@[^/]+\/)?[^@]+@(?!latest$|\*$)[\w^~.+-]+$/.test(pkg)) out.push(mk('medium', 'mcp-unpinned', file, L(pkg), `MCP server "${name}" runs ${pkg} unpinned; a new release (or a hijacked one) runs with your permissions the next time the agent starts`, `pin a version, e.g. ${pkg.replace(/@.*$/, '')}@1.2.3`));
    }
    if (/^(?:uvx|pipx)$/.test(cmd)) {
      const pkg = pkgArgs.find((a) => a !== 'run');
      if (pkg && /^(?:git\+|https?:)/.test(pkg)) out.push(mk('high', 'mcp-remote-package', file, L(pkg), `MCP server "${name}" runs code straight from ${pkg}`, 'install a pinned release from a package index'));
      else if (pkg && !/(?:==|@)\d/.test(pkg)) out.push(mk('medium', 'mcp-unpinned', file, L(pkg), `MCP server "${name}" runs ${pkg} unpinned`, `pin a version, e.g. ${pkg}==1.2.3`));
    }
    const urls = [s.url, s.serverUrl, ...args.filter((a) => /^https?:\/\//.test(a))].filter((u) => typeof u === 'string');
    for (const u of urls) if (/^http:\/\//.test(u) && !isLocalHost(u)) out.push(mk('high', 'mcp-plain-http', file, L(u), `MCP server "${name}" talks to ${u} over plain http; tool calls and tokens cross the network readable and alterable`, 'use https'));
    const secrets = [...Object.entries(s.env || {}), ...Object.entries(s.headers || {})];
    for (const [k, v] of secrets) {
      if (typeof v !== 'string' || !v.trim()) continue;
      if (!SECRET_KEY.test(k)) continue;
      if (/^\$\{?[A-Za-z_]\w*\}?$/.test(v.trim()) || /^(?:Bearer\s+)?\$\{[^}]+\}$/.test(v.trim())) continue;
      out.push(mk('high', 'mcp-inline-secret', file, L(`"${k}"`), `MCP server "${name}" has a secret inlined in ${k}; it lands in git, backups and screen shares`, `reference an environment variable (e.g. "${k}": "\${${k}}") and keep the value out of the file`));
    }
    for (const a of args) {
      const m = /^--?(?:api-?key|token|secret|password)=(.+)$/i.exec(a);
      if (m && !/^\$/.test(m[1])) out.push(mk('high', 'mcp-inline-secret', file, L(a), `MCP server "${name}" passes a secret on the command line`, 'read it from an environment variable instead'));
    }
    for (const a of args) {
      if (/^(?:\/|~|~\/|\$HOME\/?|[A-Za-z]:[\\/]?|\/(?:Users|home)\/[^/]+\/?)$/.test(a)) out.push(mk('high', 'mcp-broad-root', file, L(`"${a}"`), `MCP server "${name}" is given ${a} as a root; it can read or write far beyond this project`, 'point it at the project folder only'));
    }
  }
  return out;
}

// ---- remote code / hooks ---------------------------------------------------------------------

// [id, severity, regex, message, fix]
const REMOTE_RULES = [
  ['pipe-to-shell', 'high', /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, 'downloads and runs remote code in one step', 'download, verify a checksum or signature, then run a pinned local copy'],
  ['fetch-and-exec', 'high', /(?:(?:ba|z)?sh|source|\.)\s+<\(\s*(?:curl|wget)|(?:eval|sh -c|bash -c|python3? -c)\s*["']?\$\(\s*(?:curl|wget)|(?:iex|Invoke-Expression)[^\n]*(?:DownloadString|Invoke-WebRequest|iwr)|(?:exec|eval)\s*\([^)\n]*(?:urlopen|requests\.get|fetch\()/i, 'executes a script fetched from the internet at run time', 'vendor the script into the skill and pin it by checksum'],
  ['download-then-run', 'high', /\b(?:curl|wget)\b[^\n]*(?:-o|-O|--output)\s*\S+[^\n]*(?:&&|;)[^\n]*(?:\b(?:ba|z)?sh\b|python3?|node|chmod\s+\+x|\.\/\S)/, 'downloads a file and runs it without verification', 'vendor the file or verify a checksum before running'],
  ['remote-package-run', 'high', /\bnpx\s+(?:-y\s+)?(?:https?:|git\+|github:)|\bpip3?\s+install\b[^\n]*(?:git\+|https?:\/\/)/, 'installs or runs code from a URL or git ref', 'use a pinned registry release'],
  ['dynamic-url-import', 'high', /\bimport\(\s*['"]https?:|\brequire\(\s*['"]https?:/, 'imports code from a URL at run time', 'vendor the module'],
  ['unpinned-npx', 'medium', /\b(?:npx|bunx)\s+(?:-y\s+|--yes\s+)?(?!-)(?:@[\w.-]+\/)?[\w.-]+(?:@latest)?(?=\s|$|")/, 'runs an unpinned npm package at run time', 'pin a version: npx pkg@1.2.3'],
];

const HOOK_RULES = [
  ['hook-network', 'medium', /\b(?:curl|wget|nc|ncat|scp|rsync|ssh)\b|https?:\/\//, 'makes a network call on every matching event', 'remove it, or log locally and review what leaves the machine'],
  ['hook-write-outside', 'medium', /(?:>>?|\btee\b(?:\s+-a)?)\s*(?:~|\$HOME|\/(?!dev\/null)(?!tmp\/)[\w.-])|\b(?:cp|mv|ln)\b[^\n]*\s(?:~\/|\$HOME\/|\/etc\/|\/usr\/)/, 'writes outside the repository', 'write under $CLAUDE_PROJECT_DIR only'],
  ['hook-destructive', 'high', /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME|\*)/, 'deletes broad paths', 'scope the delete to a build folder inside the repo'],
  ['hook-sudo', 'medium', /(?:^|\s)sudo\s/, 'runs with sudo', 'drop sudo; hooks should run with the user\'s normal rights'],
];

function checkCommand(file, text, cmd, kind) {
  const out = [];
  const line = lineOf(text, cmd.slice(0, 60)) || 1;
  const rules = kind === 'hook' ? [...REMOTE_RULES, ...HOOK_RULES] : REMOTE_RULES;
  for (const [rule, sev, re, message, fix] of rules) if (re.test(cmd)) out.push(mk(sev, rule, file, line, `${kind === 'hook' ? 'hook: ' : ''}${message}`, fix));
  return dedupe(out);
}

function dedupe(list) {
  // A curl|sh hook also trips the generic network rule; keep the strongest finding per file:line.
  const best = new Map();
  for (const f of list) {
    const k = `${f.file}:${f.line}:${f.rule === 'hook-network' ? 'net' : f.rule}`;
    best.set(k, f);
  }
  const hasRemote = new Set(list.filter((f) => ['pipe-to-shell', 'fetch-and-exec', 'download-then-run'].includes(f.rule)).map((f) => `${f.file}:${f.line}`));
  return [...best.values()].filter((f) => !(f.rule === 'hook-network' && hasRemote.has(`${f.file}:${f.line}`)));
}

function collectHookCommands(node, out = [], inHooks = false) {
  if (Array.isArray(node)) node.forEach((n) => collectHookCommands(n, out, inHooks));
  else if (node && typeof node === 'object') {
    if (inHooks && typeof node.command === 'string') out.push(node.command);
    for (const [k, v] of Object.entries(node)) collectHookCommands(v, out, inHooks || k === 'hooks');
  }
  return out;
}

const SETTINGS_FILE = /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|hooks\/hooks\.json|\.claude-plugin\/hooks\.json)$/;

function checkSettings(file, text) {
  const out = [];
  let json;
  try { json = JSON.parse(text); } catch { return out; }
  for (const cmd of collectHookCommands(json)) out.push(...checkCommand(file, text, cmd, 'hook'));
  const perm = json.permissions || {};
  if (perm.defaultMode === 'bypassPermissions' || json.skipDangerousModePermissionPrompt === true) out.push(mk('high', 'permission-bypass', file, lineOf(text, 'bypassPermissions') > 1 ? lineOf(text, 'bypassPermissions') : lineOf(text, 'skipDangerous'), 'every tool call runs without asking, so one injected instruction can run anything', 'remove the bypass; allow specific commands instead'));
  for (const rule of perm.allow || []) {
    const r = String(rule).trim();
    if (r === '*' || /^Bash(?:\((?:\*|\*:\*)?\))?$/.test(r)) out.push(mk(r === '*' ? 'high' : 'high', 'broad-tool-grant', file, lineOf(text, `"${rule}"`), `permission "${r}" lets the agent run any shell command unprompted`, 'allow exact commands, e.g. Bash(npm test:*)'));
    else if (/^Bash\((?:curl|wget|sh|bash|sudo|rm|eval|ssh)\b/.test(r)) out.push(mk('medium', 'broad-tool-grant', file, lineOf(text, `"${rule}"`), `permission "${r}" pre-approves a command that can fetch or run arbitrary code`, 'drop it or narrow it to a fixed target'));
  }
  if (json.enableAllProjectMcpServers === true) out.push(mk('medium', 'mcp-auto-enable', file, lineOf(text, 'enableAllProjectMcpServers'), 'every MCP server a cloned repo declares starts without a prompt', 'approve servers one by one'));
  return out;
}

// ---- tool grants in SKILL.md / agent frontmatter ---------------------------------------------

function checkGrants(file, text) {
  const out = [];
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  const fm = m[1].split('\n');
  fm.forEach((l, i) => {
    const ln = i + 2;
    if (/^permissionMode:\s*["']?bypassPermissions/.test(l)) out.push(mk('high', 'permission-bypass', file, ln, 'this agent runs every tool without asking', 'use default or acceptEdits mode'));
    const k = /^(allowed-tools|tools):\s*(.*)$/.exec(l);
    if (!k) return;
    let val = k[2];
    for (let j = i + 1; j < fm.length && /^\s+-\s|^\s+\S/.test(fm[j]); j++) val += ` ${fm[j].replace(/^\s*-\s*/, '')}`;
    const items = val.replace(/[\[\]"']/g, '').split(/,|\s(?=[A-Z*])/).map((x) => x.trim()).filter(Boolean);
    for (const t of items) {
      if (t === '*') out.push(mk('high', 'broad-tool-grant', file, ln, `${k[1]} grants every tool`, 'list only the tools this skill needs'));
      else if (/^Bash(?:\((?:\*|\*:\*)\))?$/.test(t)) out.push(mk('medium', 'broad-tool-grant', file, ln, `${k[1]} grants Bash with no restriction; any instruction the skill reads can run any command`, 'restrict it, e.g. Bash(git status:*), Bash(npm test:*)'));
    }
  });
  return out;
}

// ---- dependencies declared by skill scripts --------------------------------------------------

function checkPackageJson(file, text) {
  const out = [];
  let j;
  try { j = JSON.parse(text); } catch { return out; }
  for (const sect of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [dep, ver] of Object.entries(j[sect] || {})) {
      const v = String(ver).trim();
      const ln = lineOf(text, `"${dep}"`);
      if (/^(?:git\+|git:|github:|https?:|file:|link:|[\w.-]+\/[\w.-]+(?:#.*)?$)/.test(v)) out.push(mk('high', 'dep-remote', file, ln, `${dep} comes from ${v}, not a registry release; the content can change under you`, 'depend on a published version, pinned exactly'));
      else if (v === '' || v === '*' || v === 'latest' || v === 'x') out.push(mk('medium', 'dep-unpinned', file, ln, `${dep} accepts any version ("${v}")`, 'pin an exact version and commit a lockfile'));
      else if (/^[\^~><]/.test(v)) out.push(mk('low', 'dep-range', file, ln, `${dep} uses a range (${v}); installs can differ between machines`, 'pin an exact version and commit a lockfile'));
    }
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    const s = j.scripts?.[hook];
    if (s) out.push(mk(/curl|wget|\|\s*(?:ba)?sh|node\s+-e|https?:/.test(s) ? 'high' : 'medium', 'install-script', file, lineOf(text, `"${hook}"`), `${hook} script runs automatically on install: ${s.slice(0, 80)}`, 'remove the lifecycle script or install with --ignore-scripts'));
  }
  return out;
}

function checkRequirements(file, text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/\s+#.*$/, '').trim();
    if (!l || l.startsWith('#')) return;
    if (/^(?:-e\s|git\+|https?:|.*@\s*(?:git\+|https?:))/.test(l)) out.push(mk('high', 'dep-remote', file, i + 1, `"${l}" installs from a URL or git ref, not a pinned release`, 'depend on a published version: name==1.2.3'));
    else if (/^--(?:extra-)?index-url\s+http:/.test(l)) out.push(mk('high', 'dep-plain-http', file, i + 1, 'package index over plain http', 'use https'));
    else if (/^-/.test(l)) return;
    else if (!/==|===/.test(l)) out.push(mk('medium', 'dep-unpinned', file, i + 1, `"${l}" is not pinned to an exact version`, 'pin it: name==1.2.3 (add --require-hashes where you can)'));
  });
  return out;
}

// ---- driver -----------------------------------------------------------------------------------

/** Scan directories. opts.skills=false skips the skill scanner (used by `ci`, which already ran it). */
export function secureScan(dirs, { skills = true } = {}) {
  const findings = [];
  const roots = [];
  for (const d of dirs) {
    const root = path.resolve(d);
    if (!fs.existsSync(root)) throw new Error(`no such folder: ${d}`);
    roots.push(root);
    const rels = walk(root);
    const skillDirs = rels.filter((r) => path.posix.basename(r) === 'SKILL.md').map((r) => path.posix.dirname(r));
    const inSkill = (r) => skillDirs.find((s) => s === '.' ? true : r.startsWith(`${s}/`));
    const label = (r) => (dirs.length > 1 || path.resolve(d) !== process.cwd() ? path.join(d, r) : r);
    const read = (r) => fs.readFileSync(path.join(root, r), 'utf8');
    for (const r of rels) {
      const name = path.posix.basename(r);
      let text;
      const get = () => (text ??= read(r));
      if (MCP_FILE.test(r)) findings.push(...checkMcp(label(r), get()));
      if (SETTINGS_FILE.test(r)) findings.push(...checkSettings(label(r), get()));
      if (name.endsWith('.md') && (name === 'SKILL.md' || /(?:^|\/)agents\//.test(r))) findings.push(...checkGrants(label(r), get()));
      const sd = inSkill(r);
      if (sd !== undefined) {
        if (name === 'package.json') findings.push(...checkPackageJson(label(r), get()));
        if (/^requirements[\w.-]*\.txt$/.test(name)) findings.push(...checkRequirements(label(r), get()));
        if (SCRIPT_RE.test(name)) {
          get().split('\n').forEach((l, i) => {
            if (/^\s*(?:#|\/\/|\*)/.test(l)) return;
            for (const [rule, sev, re, message, fix] of REMOTE_RULES) {
              if (rule === 'pipe-to-shell') continue; // already reported by the skill scanner
              if (re.test(l)) findings.push(mk(sev, rule, label(r), i + 1, message, fix));
            }
          });
        }
      }
    }
    if (skills) {
      for (const sd of skillDirs) {
        const abs = path.join(root, sd);
        const files = {};
        for (const r of rels) if (sd === '.' || r.startsWith(`${sd}/`)) files[sd === '.' ? r : r.slice(sd.length + 1)] = fs.readFileSync(path.join(root, r));
        for (const f of scanFiles(files).findings) {
          findings.push(mk(f.severity === 'critical' ? 'high' : MEDIUM_RULES.has(f.rule) ? 'medium' : 'low', f.rule, label(path.posix.join(sd === '.' ? '' : sd, f.file)), f.line, f.message,
            f.severity === 'critical' ? 'remove it, or make clear in the text that it is an example' : 'confirm this is intended and documented in SKILL.md'));
        }
        void abs;
      }
    }
  }
  const seen = new Set();
  const unique = findings.filter((f) => { const k = `${f.rule}|${f.file}|${f.line}|${f.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  unique.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const count = (s) => unique.filter((f) => f.severity === s).length;
  return { roots, high: count('high'), medium: count('medium'), low: count('low'), findings: unique };
}

export const atOrAbove = (findings, level) => findings.filter((f) => RANK[f.severity] >= RANK[level]);
export const formatFinding = (f) => `${f.severity.toUpperCase().padEnd(6)} ${f.file}:${f.line}  ${f.message}\n       fix: ${f.fix}`;

/** CLI entry. */
export async function secureCmd(args, f) {
  const dirs = args.length ? args : ['.'];
  const gate = f.gate === undefined ? null : f.gate === true ? 'high' : String(f.gate);
  if (gate && !RANK[gate]) throw new Error('usage: --gate [high|medium]');
  const res = secureScan(dirs);
  if (typeof f.json === 'string') fs.writeFileSync(f.json, `${JSON.stringify(res, null, 2)}\n`);
  for (const x of res.findings) console.log(formatFinding(x));
  const summary = `skillhawk secure: ${res.high} high, ${res.medium} medium, ${res.low} low`;
  if (gate) {
    const hits = atOrAbove(res.findings, gate);
    console.log(`${summary} | gate ${gate}: ${hits.length ? `FAIL (${hits.length} at or above ${gate})` : 'pass'}`);
    if (hits.length) process.exitCode = 1;
  } else console.log(summary);
}
