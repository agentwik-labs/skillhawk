---
name: secure-agent-setup
description: Audits an agent setup for security with the skillyard CLI - skills, MCP server configs, hooks, skill dependencies, scripts fetched at run time, and over-broad tool grants - then explains each finding and the fix. Use when asked to "secure my agent setup", "audit my MCP config", "are my hooks safe", "check this skill for risk", before installing third-party skills or plugins, or to gate CI on high-risk findings.
license: MIT
---

# Secure Agent Setup

Run the Skillyard security audit, then turn its findings into a short, prioritized fix list.

## Workflow

1. Run `npx skillyard secure . --json /tmp/secure.json` (or `skillyard secure <dir>` if installed). Use the folder the user names; default is the current project.
2. Read the output. Each finding has a severity (high, medium, low), `file:line`, why it matters and a fix.
3. Explain the high findings first, in plain words: what could go wrong, and the exact edit that fixes it. Group repeats (for example three unpinned MCP servers) into one item.
4. Offer to apply safe fixes (pin versions, move inline secrets to environment variables, narrow `allowed-tools`). Never print a secret value back; refer to it by file and line. If a real secret is inlined, say it must be rotated, since removing the line does not un-leak it.
5. For CI, suggest `skillyard secure . --gate high` (fails the build on high findings) or `--gate medium`. `skillyard ci` runs the same package checks.

## What it checks

- MCP configs (`.mcp.json`, `.cursor/mcp.json`, `claude_desktop_config.json`): unpinned `npx`/`uvx` packages, code from git or URLs, plain `http` servers, inlined secrets, filesystem roots like `/` or `~`.
- Hooks (`.claude/settings.json`, plugin `hooks/hooks.json`): `curl | sh`, network calls, writes outside the repo, broad deletes.
- Skill dependencies: git/URL/unpinned packages and install scripts in `package.json`, unpinned or URL lines in `requirements.txt`.
- Run-time fetches: scripts that download and execute code.
- Tool grants: `allowed-tools: Bash` unrestricted, `*`, permission bypass.
- The skill scan itself: prompt injection, hidden Unicode, embedded keys, credential reads.

Findings are heuristics. Say so when a finding looks like a documented example, and do not claim a setup is safe because the scan is clean.
