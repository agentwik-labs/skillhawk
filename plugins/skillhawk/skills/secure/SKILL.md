---
name: secure
description: Security-scan a repo, skill bundle, plugin or MCP config before trusting it (permission bypasses, hooks that run remote code, broad MCP roots, inlined secrets, unpinned packages). Use when the user asks whether something is safe to install or use.
---

# Is this safe to trust?

1. Call the skillhawk `secure_scan` tool on the folder the user names (default: the current folder). If the tool is not
   available, run `npx -y skillhawk secure <dir>`.
2. Give a verdict first: safe to use, use with changes, or do not use.
3. Then the high-severity findings with `file:line` and the fix, then the rest in one line each.
4. Change nothing until the user asks.
