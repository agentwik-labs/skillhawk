---
name: skillyard-review
description: Reviews agent skills (SKILL.md folders) with the skillhawk CLI and reports grades and fixes. Use when the user says "review my skills", "grade this skill", "are my skills any good", "find duplicate skills", or before publishing or committing a skill.
license: MIT
---

# Skillhawk skill review

Run the static reviewer; do not judge skills by reading them yourself first. It is deterministic and makes no model calls.

## Steps

1. Find the skill folders. Default to `.claude/skills`, `~/.claude/skills` and any path the user names.
2. Run `npx skillhawk review <dir...> --json /tmp/skillyard-review.json` (or `skillhawk review` if installed). Exit code 1 means at least one skill got an F.
3. Report in this order: grade counts, then each skill below B with its top findings (`file:line`, severity, the suggested fix), then the library section (duplicates, overlapping triggers, cross-skill contradictions).
4. Offer `--fix`. It only moves a license header inside the frontmatter, strips a byte-order mark and trims frontmatter whitespace. It never rewrites prose, so apply it when the user agrees, then re-run the review and show the new grades.
5. For findings that need judgement (vague wording, contradictions, duplicates), propose the edit and wait for approval; never edit the instructions of a skill unasked.

## Reading the output

- `description-no-when` and `trigger-hijack` matter most: the description is all an agent sees before deciding to load the skill.
- A contradiction finding is a heuristic. Quote both lines and ask which rule wins.
- Duplicates and overlaps are about the whole set: recommend which skill to keep and which description to narrow.

## Example

```
$ skillhawk review .claude/skills
F  team-notes  ~108 tok  12 findings: license-header-above-frontmatter, description-no-when, ...
     high   SKILL.md:4 [description-no-when] description does not say when to use the skill
```

Answer: "team-notes is an F. Fix the description first (line 4), then resolve the two contradictions on lines 12-14."
