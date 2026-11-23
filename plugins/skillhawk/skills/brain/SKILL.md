---
name: brain
description: Set up and use the user's Second Brain. The user chooses what goes in (agent sessions, repo docs, git history, folders of notes, an Obsidian vault, meeting notes, transcripts, specs), what it pulls out (repeated corrections, decisions, preferences, open questions, definitions, facts) and where approved items are written. Use when the user wants long-term memory, asks what the agent should remember, says the agent keeps making the same mistake, wants to search their notes or past decisions, or asks whether a rule is working.
---

# Second Brain: the user's choices, not yours

This is the user's brain. Do not decide its structure, sources or rules for them. Ask.

## Not set up yet (`npx -y skillhawk brain config .` says "No brain yet")

1. Run `npx -y skillhawk brain init --questions --json` and ask the user the questions one at a time, in order, with
   the listed options. Skip a question when its `askIf` condition does not hold for the answers so far. Accept their
   own words; do not recommend options unless they ask you to.
2. If they pick agent sessions, say: "Skillhawk will read your Claude Code and Codex logs on this machine; nothing is
   uploaded and secrets are redacted." If they pick folders, ask for the paths.
3. Write their answers to a JSON file (`{"sources": ["folders"], "folders": "~/notes", ...}`; option numbers or values
   both work) and run `npx -y skillhawk brain init --answers <file> .`. Show them the summary it prints.

## Using it

- `npx -y skillhawk brain .` shows what it found for each kind the user chose, with the file and line (or session) it
  came from, and, for corrections, whether approved rules stuck.
- `npx -y skillhawk brain search "<question>" .` searches everything in it. Prefer this (or the `brain_search` MCP
  tool) over guessing when the user refers to a past decision, a term or a note.
- To approve an item: write it as one sentence in the user's words, confirm it with them, then run
  `npx -y skillhawk brain --adopt <id> --rule "<sentence>" .`. It goes where they chose at init.
- Never adopt, dismiss or retire an item, or change their brain settings, without the user's yes.
