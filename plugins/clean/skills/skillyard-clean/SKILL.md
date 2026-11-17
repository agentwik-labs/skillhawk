---
name: skillyard-clean
description: Cleans up the scripts inside agent skills and learns a coding-standards skill from a repo. Use when the user says "review the scripts in my skills", "are these skill scripts safe", "learn our coding standards", "turn our PR review comments into rules", or before publishing a skill that bundles scripts.
license: MIT
---

# Skillhawk clean

Two deterministic jobs, no model calls and no network.

## Job 1: skill scripts

1. Run `npx skillhawk clean scripts <skill-dir...>` (add `--json` for machine output). `skillhawk review` prints the same findings in a "scripts" section.
2. Report findings by severity with `file:line`, the rule and the fix. High means a missing `set -e` or a hard-coded home path.
3. Offer to apply the fixes, then re-run to confirm. Do not rewrite a script's logic unasked.

Rules checked: unused functions, variables and imports; network, subprocess and file calls without error handling; shell without `set -e` or with unquoted variables; hard-coded absolute and home paths; functions over 60 lines; TODO and FIXME; no usage text; no shebang or exec bit on a script that SKILL.md runs directly.

## Job 2: coding standards

1. Run `npx skillhawk clean standards . --from-git --out skills/coding-standards`.
2. If the user has an export of PR review comments (markdown, text or JSON), add `--from-reviews <file>`. Repeated requests become rules with counts.
3. Read the generated `SKILL.md`, delete any rule the team disagrees with, and keep the examples. It must grade B or better in `skillhawk review`.

## Example

```
$ skillhawk clean standards . --from-git --from-reviews reviews.json
learned conventions from 415 files and 200 commits, 3 rule(s) from review comments
  x7  Add a unit test for the new branch
review: A (no findings)
```
