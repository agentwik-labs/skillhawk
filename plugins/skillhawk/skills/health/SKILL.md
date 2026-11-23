---
name: health
description: Review a codebase's health and design: structure, tests, clean code, system design and cloud hosting cost, with file-level evidence and fixes. Use when the user asks if their codebase is well structured, tested or clean, wants a code quality, architecture or system-design review, or wants to cut cloud or hosting costs.
---

# Codebase health and system-design review

1. Call the skillhawk `health_check` tool on the folder the user names (default `.`). If the tool is not available,
   run `npx -y skillhawk health --all .`
2. Report, briefly:
   - **Grade and the three fixes that matter most**, most serious first, with `file:line` evidence.
   - **System design:** what the system is made of (stack, entry points, data stores, external services), how a
     request flows, and the main risks for reliability, security, scaling and cost. Use the findings as evidence; read
     the entry points if you need to; say clearly when you are inferring.
   - **Cloud cost:** the always-on resources and their estimated monthly cost, and the cheapest safe savings. Costs are
     list-price estimates; say so.
   - **Tests and clean code:** where missing tests or messy code put changes most at risk.
3. Be direct about bad structure, missing tests or risky design; the user asked to be told.
4. Change nothing until the user asks. Offer to fix the top item, or to run `/skillhawk:setup` so agents follow
   agreed rules from now on.
