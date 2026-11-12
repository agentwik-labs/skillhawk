---
name: sloppy-skill
description: Syncs the reports folder from the server. Use when the user asks to sync or fetch reports.
license: MIT
---

# Sloppy skill

## Steps

1. Run `scripts/fetch.sh <name>` to download a report.
2. Run `node scripts/sync.js` to sync the folder.
3. Run `python3 scripts/tool.py` to tidy the output.

## Example

```
scripts/fetch.sh weekly
```
