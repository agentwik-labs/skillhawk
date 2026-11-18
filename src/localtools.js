// Local check tools for `skillhawk mcp` over stdio: the same code as the CLI commands, run on the developer's machine.
// No server, no account, no network. Never exposed by the HTTP server (it would read the server's own disk).
import os from 'node:os';
import path from 'node:path';
import { findSkillDirs, reviewDirs, render as renderReview } from './review.js';
import { secureScan, formatFinding } from './secure.js';
import { compileTarget, resolveTargets, TARGETS } from './compile.js';

const pathArg = (what) => ({ type: 'string', description: `${what} Relative paths resolve from the folder the server was started in. Default "."` });

export const LOCAL_TOOLS = [
  {
    name: 'review_skill',
    title: 'Review skills (grade A-F)',
    description: 'Grade every SKILL.md under a folder A-F with line-level findings and fixes (broken frontmatter, vague triggers, broken links, risky scripts), and check several skills together for duplicates, overlapping triggers and contradictions. Read-only. Use before installing or publishing a skill.',
    inputSchema: { type: 'object', properties: { path: pathArg('A skill folder or a folder holding several.') } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'secure_scan',
    title: 'Security scan for skills and agent config',
    description: 'Scan a folder for risky agent setup: secrets and pipe-to-shell in skills, unpinned or remote-package MCP servers in .mcp.json, broad permissions in .claude/settings.json, risky dependencies in skill scripts. Returns findings by severity with a fix for each. Read-only.',
    inputSchema: { type: 'object', properties: { path: pathArg('The folder to scan.') } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'compile_skill',
    title: 'Compile a skill for other agents',
    description: `Convert one Claude-style skill folder into the format other agents read (${TARGETS.join(', ')}) and check the result: content kept, frontmatter valid, size limits. Writes files under the output folder only.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The skill folder (holding SKILL.md).' },
        targets: { type: 'string', description: `Comma-separated: ${TARGETS.join(', ')}, or "all". Default "all".` },
        out: { type: 'string', description: 'Output folder inside the working folder. Default ".skillyard/compiled".' },
      },
      required: ['path'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'check_agents',
    title: 'Find agents nobody is watching',
    description: 'List coding agents that run without a human on this machine: agent processes (Claude Code, Codex, Gemini, Cursor, Aider...), sessions still working with no human message for hours, scheduled agents (cron, launchd/systemd, GitHub Actions schedules) with the account each one bills (subscription or API key), API keys exported by shell start-up files, and dev servers left running. Prints variable names, never values. Read-only: it never stops anything.',
    inputSchema: {
      type: 'object',
      properties: {
        running_hours: { type: 'number', description: 'Flag agent processes running longer than this. Default 12.' },
        idle_hours: { type: 'number', description: 'Flag sessions with no human message for this long. Default 2.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const text = (t, isError = false, structured) => ({ content: [{ type: 'text', text: t }], isError, ...(structured ? { structuredContent: structured } : {}) });

function within(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Returns an MCP tool result, or undefined when `name` is not a local tool. */
export async function callLocalTool(name, args = {}, { root = process.cwd(), agentsFixtures = {} } = {}) {
  if (!LOCAL_TOOLS.some((t) => t.name === name)) return undefined;
  const at = (p) => path.resolve(root, String(p || '.').replace(/^~(?=$|\/)/, os.homedir()));
  try {
    if (name === 'review_skill') {
      const dirs = findSkillDirs([at(args.path)]);
      if (!dirs.length) return text(`No SKILL.md found under ${at(args.path)}.`, true);
      const { reviews, library, grades } = reviewDirs(dirs);
      return text(renderReview(reviews, library, [], grades), false, { skills: reviews.map(({ name: n, dir, grade, score, tokens, findings }) => ({ name: n, dir, grade, score, tokens, findings })), library, grades });
    }
    if (name === 'secure_scan') {
      const r = secureScan([at(args.path)]);
      const lines = r.findings.map(formatFinding);
      return text(`${lines.join('\n')}${lines.length ? '\n' : ''}skillhawk secure: ${r.high} high, ${r.medium} medium, ${r.low} low`, false, { high: r.high, medium: r.medium, low: r.low, findings: r.findings });
    }
    if (name === 'compile_skill') {
      if (!args.path) return text('path is required: the skill folder to compile.', true);
      const out = at(args.out || path.join('.skillyard', 'compiled'));
      if (!within(root, out)) return text(`out must be inside ${root}; got ${out}.`, true);
      const results = resolveTargets(args.targets || 'all').map((t) => compileTarget(t, at(args.path), out));
      const lines = results.flatMap((r) => [
        `${r.target}: ${r.files[0] ? path.relative(root, r.files[0]) : ''}  ${r.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.name} (${c.detail})`).join('; ')}`,
        ...r.warnings.map((w) => `  warn ${w}`),
      ]);
      return text(lines.join('\n'), results.some((r) => !r.ok), { results: results.map(({ target, files, warnings, checks, ok }) => ({ target, files: files.map((f) => path.relative(root, f)), warnings, checks, ok })) });
    }
    if (name === 'check_agents') {
      const { collect, render } = await import('./agentwatch.js');
      const r = await collect({ running: args.running_hours, idle: args.idle_hours, repo: root, ...agentsFixtures });
      return text(render(r), false, { flaggedCount: r.flaggedCount, agents: r.agents.length, sessions: r.sessions.length, servers: r.servers.length, scheduled: r.scheduled.length });
    }
  } catch (e) {
    return text(`Error: ${e.message}`, true);
  }
  return undefined;
}
