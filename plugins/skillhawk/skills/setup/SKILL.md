---
name: setup
description: Walk the user through setting up Skillhawk for this repo, asking rather than deciding: rules for agents (language, style, tests, architecture, commits, UI), what health checks and how strictly, how the Software Factory turns repeated work into skills, and what goes into their Second Brain. Use when the user asks to set up coding rules, conventions, health checks, the factory or the brain, onboard a new repo, or says "set up skillhawk".
---

# Set up Skillhawk: the user's choices, not yours

1. Run `npx -y skillhawk setup --detect --json .` and read `groups`: `parts`, then `rules`, `health`, `factory`,
   `brain`. Each question has options; "(detected)" means it is what the code already does. A question with `askIf`
   is asked only when that condition holds for the answers so far.
2. Ask `parts` first: which of rules, health, factory and brain they want to set up. Then ask only those groups,
   **one question at a time**, with the options in order, accepting their own words. Do not recommend options or
   skip questions unless they ask you to; if they say "use what's there" or "defaults", stop and use the defaults.
3. Write the answers as JSON: rules answers at the top level (keys = question ids), the others nested, e.g.
   `{"parts": ["rules", "health"], "language": "...", "health": {"sections": ["tests", "structure"], "limits": "300/40/4"}}`.
   Option numbers or values both work. Save to `.skillhawk/answers.json`, then run
   `npx -y skillhawk setup --answers .skillhawk/answers.json .`
4. Show what it printed. Later changes: `npx -y skillhawk setup --only health` (or rules, factory, brain).
5. Do not edit code during setup.
