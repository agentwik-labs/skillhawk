// WebMCP: lets an AI agent in the visitor's browser ask this page for Skillhawk's commands and site summary
// (https://webmachinelearning.github.io/webmcp/). Read-only; does nothing where the browser has no WebMCP API.
(() => {
  const mc = (typeof document !== 'undefined' && document.modelContext) || (typeof navigator !== 'undefined' && navigator.modelContext);
  if (!mc || typeof mc.registerTool !== 'function') return;
  const COMMANDS = {
    billing: ['npx skillhawk agents', 'Lists agents that run without you and which account each scheduled one bills (subscription or API key), plus API keys your shell exports. Read-only; prints variable names, never values.'],
    review: ['npx skillhawk review <skills-dir>', 'Grades each SKILL.md A to F with concrete fixes.'],
    security: ['npx skillhawk secure <skills-dir>', 'Security scan of skills, MCP configs, hooks, remote scripts and tool grants.'],
    compile: ['npx skillhawk compile <skill-dir> --to all', 'Converts one skill for Claude Code, Codex, Cursor, Copilot and Gemini.'],
    mcp: ['npx skillhawk mcp --local', 'Runs a local stdio MCP server with review_skill, secure_scan, compile_skill and check_agents.'],
  };
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const tools = [
    {
      name: 'skillhawk_command',
      description: 'Get the free Skillhawk CLI command for a task: billing (which account unattended coding agents bill), review, security, compile, or mcp.',
      inputSchema: { type: 'object', properties: { task: { type: 'string', enum: Object.keys(COMMANDS) } }, required: ['task'] },
      execute: async ({ task }) => {
        const c = COMMANDS[task];
        return text(c ? `${c[0]}\n${c[1]}\nRuns locally with Node.js 20+. Source: https://github.com/agentwik-labs/skillhawk` : `Unknown task. Use one of: ${Object.keys(COMMANDS).join(', ')}`);
      },
    },
    {
      name: 'skillhawk_site_summary',
      description: "Read Skillhawk's site summary for agents (llms.txt): what it does, key pages, sourced answers and commands.",
      inputSchema: { type: 'object', properties: {} },
      execute: async () => text(await fetch(new URL('llms.txt', document.baseURI)).then((r) => r.text())),
    },
  ];
  for (const t of tools) {
    try { Promise.resolve(mc.registerTool(t)).catch(() => {}); } catch { /* older API shapes: ignore */ }
  }
})();
