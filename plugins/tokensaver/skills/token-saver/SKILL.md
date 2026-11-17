---
name: token-saver
description: Looks things up in the skillhawk repo map before opening files, and reads one section of a skill instead of the whole SKILL.md. Use at the start of work in a repo, when asked "where is X", when exploring unfamiliar code, or when about to open several files to find something.
license: MIT
---

# Token Saver

Reading files is the biggest token cost in most sessions. Ask the map first; open only what it points to.

## Steps

1. If `.skillyard/map/MAP.md` exists, read it once (it is a short overview). If not, run `npx skillhawk map .` (no model calls, a few seconds).
2. To find code, run `npx skillhawk map query "<keywords>"` or call the `map_query` MCP tool. It returns `file:line` hits. Open those line ranges, not whole files.
3. To use a skill, call `skill_section` with the skill name and no heading to get its outline, then again with the one heading you need. Load the full skill only when the task truly needs all of it.
4. After you add or move many files, run `npx skillhawk map . --update` (re-reads only changed files).
5. Check spend with `npx skillhawk tokens --days 7`.

## Rules

- Do not open more than two files before querying the map.
- If a query returns nothing useful, rephrase with names that would appear in the code (function, file or heading words) before falling back to a broad search.
