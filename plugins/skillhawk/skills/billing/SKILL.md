---
name: billing
description: Find coding agents that run without you (cron, launchd, scheduled CI, headless claude -p, sessions with no human) and which account each one bills, subscription or pay-per-token API key. Use when the user asks why Claude Code or Codex is charging an API key, what scheduled agents cost, or what is still running.
---

# Which account do my agents bill?

1. Call the `check_agents` tool from the skillhawk MCP server. If the tool is not available, run `npx -y skillhawk agents`.
2. Report briefly:
   - every scheduled or headless agent and its `bills:` line (API key, subscription token, cloud provider, or no key set);
   - API keys the shell exports (variable names only);
   - Claude Code sessions still working with no human message, and their cost since a human last wrote;
   - agent processes running a long time.
3. For each API-key bill the user did not intend: name the file or job where the key is set and how to remove it
   (Claude Code uses `ANTHROPIC_API_KEY` instead of a subscription whenever it is set; `claude -p` always does).
4. Never print, copy or ask for key values. Change nothing until the user asks.
