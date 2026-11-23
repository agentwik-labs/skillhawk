---
name: skillhawk
description: Check which account unattended coding agents bill (subscription or pay-per-token API key) and grade, security-scan or compile agent skills with the free Skillhawk CLI. Use when the user asks why Claude Code or Codex is charging an API key, what agents are still running, what scheduled or headless agent jobs cost, or wants a SKILL.md reviewed, scanned or converted for another agent.
---

# Skillhawk

Skillhawk is a free, open-source (MIT) command-line tool. Every command below runs locally with `npx`; nothing is
uploaded. Requires Node.js 20 or newer.

## Which account do my agents bill?

Run:

```sh
npx skillhawk agents
```

It lists agent processes, Claude Code sessions still working with no human message (and their cost since a human last
wrote), scheduled agents (cron, launchd, GitHub workflows) with a `bills:` line for each, and API keys the shell
exports. It prints variable names only, never key values. It is read-only.

How to read the `bills:` line:
- `bills: API key, pay per token (ANTHROPIC_API_KEY)`: the job pays per token. Claude Code uses `ANTHROPIC_API_KEY`
  instead of a subscription when it is set, and `claude -p` always does.
- `bills: subscription token (CLAUDE_CODE_OAUTH_TOKEN)`: the job uses the subscription.
- `bills: cloud provider (...)`: billed through Bedrock or Vertex.
- `bills: no key set in the job`: it uses the account the agent is signed in with, unless its environment sets a key.

To fix an unwanted API-key bill, remove the key from that job's environment (or from the shell start-up file the
report names) and re-run the command to confirm. Do not print or copy key values.

Useful flags: `--json report.json`, `--running 12` (hours before a process is flagged), `--idle 2` (hours with no
human message), `--fail-on-flag` (non-zero exit for CI).

## Check skills before an agent runs them

```sh
npx skillhawk review <skills-dir>     # grade each SKILL.md A to F with concrete fixes
npx skillhawk secure <skills-dir>     # security scan: skills, MCP configs, hooks, remote scripts, tool grants
npx skillhawk compile <skill-dir> --to all   # convert one skill for Claude Code, Codex, Cursor, Copilot, Gemini
```

Report the grade and the top findings to the user; fix only what they ask for.

## Use it as an MCP server

`npx skillhawk mcp --local` runs a stdio MCP server with the tools `check_agents`, `review_skill`, `secure_scan`,
`compile_skill`, `map_query` and `skill_section`, and the prompts `billing`, `review-skills` and `secure` (in Claude Code:
`/mcp__skillhawk__billing`). `npx skillhawk connect claude --write` adds it to Claude Code.

## More

- Site and answers: https://skillhawk.ai/ and https://skillhawk.ai/llms.txt
- Source: https://github.com/agentwik-labs/skillhawk
