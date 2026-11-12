---
name: skillyard-create
description: Creates a new agent skill with the skillyard CLI from the user's know-how, a runbook or doc, or corrections made in past sessions, then reviews, secures and tests it. Use when the user says "make a skill for", "turn this runbook into a skill", "create a skill from this doc", "capture how we do this", or "write a skill from my corrections".
license: MIT
---

# Create a skill with skillyard

One command makes the skill, its trigger tests and its first review. Do not hand-write SKILL.md first.

## Steps

1. Ask what kind of know-how it is, in plain words: steps in a fixed order (procedure), things to check before shipping (checklist), how the team writes (voice), a customer or sales situation (playbook), who may approve what (decision), or how a number is defined (metric).
2. Ask for three example requests that should use the skill, and one or two similar requests that should not. These become the description's when-to-use sentence and `tests/cases.yaml`.
3. Pick the source:
   - A document the user has: `npx skillyard create --from runbook.md --generator procedure --out <dir>`. Steps and rules are lifted in document order without a model.
   - Past session corrections: `npx skillyard review --chats --yes`, then `npx skillyard create --from-chats --out <dir>`.
   - Anything else: write the answers to a JSON file (keys are the generator's fields plus `should_fire` and `should_not_fire`) and run `npx skillyard create --answers answers.json --out <dir>`.
4. Read the three result lines: review grade, secure findings, static trigger test. A grade below B prints the findings; apply `skillyard review <dir> --fix` for the mechanical ones and propose edits for the rest.
5. Show the user the finished SKILL.md and cases.yaml. Offer `skillyard install <dir> --agent claude` only after they approve.

## Rules

- Never invent steps, thresholds or names. If the source does not say it, ask the user or leave it out.
- Add `--allow-model` only when the user agrees to a model call; it fills only fields the document left empty.
- Keep the description about when to use the skill. Put "do not use for" text in the body.

## Example

```
$ skillyard create --answers refunds.json --out skills
review: A (98/100), 1 finding
secure: no high findings (0 medium, 0 low)
test: 4 passed, 0 failed (static trigger cases)
```
