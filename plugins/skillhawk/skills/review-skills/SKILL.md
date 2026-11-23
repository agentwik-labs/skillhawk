---
name: review-skills
description: Grade agent skills A to F and security-scan them before an agent uses them, then list what to fix first. Use when the user asks to check, review, audit or clean up SKILL.md files, a skills folder, or skills they are about to install.
---

# Grade and scan skills

1. Use the folder the user names, or `.claude/skills` if none.
2. Call the skillhawk `review_skill` tool, then `secure_scan` on the same folder. If the tools are not available, run
   `npx -y skillhawk review <dir>` and `npx -y skillhawk secure <dir>`.
3. List fixes most serious first: security findings before quality findings, each with `file:line` and the fix.
   A high grade does not mean a skill is safe; say so when the two disagree.
4. Change nothing until the user asks.
