---
name: factory
description: Find the work the user keeps asking agents to do and turn it into tested skills: repeated requests across sessions, how often they had to correct the agent while doing them, a drafted skill that must pass grade, security and trigger checks, its measured lift, then install. Use when the user asks to automate repeated work, build skills from their history, or asks what they should turn into a skill.
---

# Software Factory

1. Reading session logs needs the user's consent; ask first if they have not said yes in this conversation.
2. Run `npx -y skillhawk factory --yes .` and show the workflows: how often each was asked, the corrections made along
   the way, and whether a skill already covers it.
3. For the workflow the user picks, drafting sends the redacted examples to their own agent CLI (their subscription).
   Ask before running `npx -y skillhawk factory --draft <id> --allow-model .` It refuses to bill a pay-per-token API
   key; do not work around that.
4. Show the draft's review, security and test lines. Offer `--eval` to measure lift (it runs the cases with and
   without the skill and uses more of the subscription).
5. Install only on the user's yes: `npx -y skillhawk factory --promote <name> .` Then offer
   `npx -y skillhawk compile .claude/skills/<name> --to all` for their other agents.
