---
name: skillyard-optimize
description: Shrinks agent skills (SKILL.md folders) with the skillyard CLI and reports tokens, grade and trigger results before and after. Use when the user says "optimize this skill", "make my skill shorter", "cut tokens from my skills", "trim skill bloat", or before publishing a long skill.
license: MIT
---

# Skillyard skill optimizer

Run the optimizer; do not hand-edit skills to save tokens. Every candidate is checked against the review grade and the skill's trigger cases, so a cut that costs quality is discarded.

## Steps

1. Static pass first (free, no model): `npx skillyard optimize <skill-dir>`. It trims whitespace, comments and rules, removes filler and hedging, collapses repeated rules and plain-bolds long sections. Frontmatter and code blocks are never touched.
2. Read the report: tokens before and after, grade before and after, trigger cases pass/fail, then the diff. The best candidate is written to `.skillyard/optimized/<name>/`; the skill itself is unchanged.
3. Show the diff to the user. Run with `--apply` only after they agree; it prints the diff again and overwrites `SKILL.md`.
4. For a whole library use `npx skillyard optimize --all <dir>` (static pass only) and report the summary line plus the three biggest savings.
5. Model rewrites cost usage. Offer `--allow-model [--model haiku] [--rounds 3]` only when the skill has behaviour cases in `tests/cases.yaml` or `evals/evals.json`, and run it only after the user says yes. A rewrite is kept only if its lift is at least the original lift and its tokens are lower. The runner is confined: no tools, no MCP servers, default permission mode, temp folder.

## Reading the output

- `rejected <stage>: review B -> C` or `breaks 1 trigger case(s)` means the cut was thrown away. Do not retry it by hand.
- "no cases" means trigger safety was not checked; suggest `skillyard test` stubs (`tests/cases.yaml`) before applying.

## Example

```
$ skillyard optimize ./skills/commit-notes
commit-notes: tokens 412 -> 331 (-20%)  grade B -> A  trigger cases 2 pass / 0 fail -> 2 pass / 0 fail  lift not measured (static pass only)
```

Answer: "Saved 81 tokens per load, grade went up, both trigger cases still pass. Diff below; apply it?"
