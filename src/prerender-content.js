// Answer pages for /learn/<slug>/. One structure feeds the HTML page, the FAQ JSON-LD, the HowTo JSON-LD and llms-full.txt.
// Inline markup: `code` only. Sources are links that appear in the pain-point research; quotes are one short sentence at most.
// Commands named here exist in src/cli.js (check the HELP text before adding one).

const REVIEW_BAD = `$ skillyard review examples/bad/notes-v2

C  notes-v2  ~ 811 tok  1 finding: description-no-when
     high   SKILL.md:3 [description-no-when] description does not say when to use the skill; agents decide to load a skill from its description alone
            fix: Rewrite as "<what it does>. Use when <the situations and phrases a user would say>."`;

const REVIEW_FIXED = `$ skillyard review notes-v2   # after the rewrite above

A  notes-v2  ~ 847 tok  no findings`;

export const LEARN = [
  {
    slug: 'why-isnt-my-claude-skill-triggering',
    title: "Why isn't my Claude skill triggering?",
    desc: 'The usual causes of a Claude Code skill that never fires, in the order to check them, with a worked example and the commands that find them.',
    answer: "Most of the time the skill's description does not tell Claude when to use it, the skill never loaded, or another skill's description competes with it. The agent decides whether to open a skill from its name and description alone, so a vague description fails silently: nothing errors, the skill is simply never used.",
    sections: [
      { h: 'What to check, in order', list: [
        '`SKILL.md` is where the agent looks (for Claude Code, `.claude/skills/<name>/SKILL.md` or the personal equivalent) and starts with a valid `---` frontmatter block on the first line. Text above it, such as a licence header, can become the description.',
        'The `description` says what the skill does and when to use it, in the words a person would actually type. "Internal notes." gives the agent nothing to match.',
        'The description is not so broad that it claims every task, and not so close to another skill that the two compete for the same request.',
        'Your setup is not crowding out descriptions. One write-up blames a token budget that silently drops skill descriptions when many skills or MCP servers are loaded; treat that as a lead to test, not a settled fact.',
        'You are testing in the same mode you use. Users have reported that skills do not trigger under `claude -p` (headless), so an automated eval loop that uses it can show 0% recall for a skill that works interactively.',
      ] },
    ],
    example: { intro: 'A real example from the Skillyard good-versus-bad gallery. The skill `notes-v2` has the description "Internal notes." and Skillyard grades it C. After rewriting the description (the rewrite below is ours, for illustration), the same skill grades A.',
      code: `${REVIEW_BAD}\n\n# SKILL.md frontmatter, before\ndescription: Internal notes.\n\n# after\ndescription: Formats meeting notes into the team template with decisions and owners. Use when the user pastes meeting notes, asks for a recap, or says "write up the notes".\n\n${REVIEW_FIXED}` },
    command: { intro: 'Skillyard cannot see inside a live Claude session, so it cannot tell you why one particular request did not fire. It does check the things above before you ship:',
      code: 'npx skillyard validate .claude/skills\nnpx skillyard review .claude/skills      # description-no-when, trigger-hijack, overlapping triggers between skills\nnpx skillyard test .claude/skills/notes-v2 --static   # your trigger cases scored against sibling skills',
      note: 'A "why didn\'t it fire" replay of a real session is on our list of ideas; it is not built.' },
    faq: [
      { q: 'Why does Claude ignore my skill even when the description looks fine?', a: 'Check that the skill loaded at all, that no other skill has an overlapping description, and that you are not testing in headless mode, where users report skills not triggering. Then make the description name the exact situations and phrases that should trigger it.' },
      { q: 'Does Skillyard tell me why a skill did not fire?', a: 'Not for a live session. `skillyard review` flags descriptions that do not say when to use the skill, claim every task, or overlap another skill, which are the common causes you can fix before shipping.' },
    ],
    howto: { name: "Debug a Claude skill that does not trigger", steps: [
      ['Check placement and frontmatter', 'Confirm SKILL.md is in the skills folder and starts with a valid --- frontmatter block.'],
      ['Read the description as the agent does', 'It must say what the skill does and when to use it, in the words a person would type.'],
      ['Look for competition', 'Run skillyard review on the skills folder to find overlapping triggers and skills that claim every task.'],
      ['Test in the mode you use', 'Compare interactive and headless runs; add trigger cases and run skillyard test --static.'],
    ] },
    sources: [
      { label: 'DEV Community: Why Claude Code skills don\'t trigger and how to fix them in 2026', url: 'https://dev.to/lizechengnet/why-claude-code-skills-dont-trigger-and-how-to-fix-them-in-2026-o7h', quote: 'a token budget overflow that silently drops your skill descriptions before Claude ever reads them' },
      { label: 'Jesse Vincent: Claude Code skills not triggering (Dec 17, 2025)', url: 'https://blog.fsck.com/2025/12/17/claude-code-skills-not-triggering' },
      { label: 'Cursor forum: alwaysApply: true rules are being completely ignored now', url: 'https://forum.cursor.com/t/alwaysapply-true-rules-are-being-completely-ignored-now/158551' },
    ],
    related: ['how-to-write-a-skill-md-description-that-triggers', 'are-agent-skills-safe'],
  },
  {
    slug: 'agents-md-vs-claude-md-vs-cursor-rules',
    title: 'AGENTS.md vs CLAUDE.md vs Cursor rules: keeping them in sync',
    desc: 'Which agent reads which instruction file, why copies drift apart, and a low-effort way to keep one source of truth.',
    answer: 'Each tool reads its own file: Claude Code reads `CLAUDE.md`, many other agents (including Codex) read `AGENTS.md`, Cursor reads rules under `.cursor/rules`, Copilot reads `.github/copilot-instructions.md` and Gemini CLI reads `GEMINI.md`. Keep the real content in one place and make every other file point at it or be generated from it, because hand-maintained copies drift.',
    sections: [
      { h: 'Why copies drift', paras: [
        'Someone fixes a rule in `CLAUDE.md` and forgets `.cursorrules`. Two months later one agent runs the tests before committing and the other does not. Nothing fails; the agents just behave differently on the same repository.',
        'Syncing does not make a bad rule set good: copies of a rotten file are still rotten. Remove contradictions and stale rules first, then sync.',
      ] },
      { h: 'Options, cheapest first', list: [
        'One real file, others import or link it. Write the shared content in `AGENTS.md`; make `CLAUDE.md` a one-line file that imports it (Claude Code supports `@` imports) or a symlink, where your platform allows.',
        'Keep tool-specific parts small and separate (Cursor rule scoping, Claude-only hooks) and say so at the top of each file.',
        'Generate the native files from one source and check the result. A reviewer in CI catches the drift a human forgets.',
      ] },
    ],
    example: { intro: 'Skillyard\'s `compile` writes the native file each agent expects from one skill and checks size, frontmatter and lost content. This is real output from the landing page for the `release-notes` skill (Copilot\'s code review reads a limited number of characters, which is why that check fails):',
      code: '$ skillyard compile release-notes --to all\ncopilot: FAIL size (4301/4000 chars read by code review)\ngemini: GEMINI.md  ok size (4385/20000 bytes)' },
    command: { intro: 'What Skillyard does here, and what it does not:',
      code: 'npx skillyard compile <skill-dir> --to claude,codex,cursor,copilot,gemini\nnpx skillyard review <dir>   # contradictions and duplicate rules inside a file',
      note: 'compile works from a skill folder, not from an existing AGENTS.md. Detecting drift between your instruction files across repositories is not a feature yet.' },
    faq: [
      { q: 'Should I use AGENTS.md or CLAUDE.md?', a: 'Use both if you use both kinds of agents: put the shared content in `AGENTS.md` and have `CLAUDE.md` import or link it, so there is one place to edit.' },
      { q: 'Can Skillyard sync my CLAUDE.md and .cursorrules?', a: 'Not directly. It compiles a skill to native files for Claude Code, Codex, Cursor, Copilot and Gemini and checks each one. It does not yet diff your existing instruction files against each other.' },
    ],
    howto: { name: 'Keep AGENTS.md, CLAUDE.md and Cursor rules in sync', steps: [
      ['Pick one source of truth', 'Write the shared rules in AGENTS.md.'],
      ['Point the other files at it', 'Make CLAUDE.md import AGENTS.md; generate or link the Cursor, Copilot and Gemini files.'],
      ['Clean the source first', 'Run skillyard review to remove contradictions and duplicate rules before copying them anywhere.'],
      ['Check in CI', 'Fail the build if a generated file is out of date.'],
    ] },
    sources: [
      { label: 'Unblocked: Keeping CLAUDE.md, AGENTS.md and .cursorrules in sync', url: 'https://getunblocked.com/blog/keeping-claude-md-agents-md-cursorrules-in-sync/', quote: 'Multi-file rules drift is the divergence that builds up when several AI coding tools each read their own instruction file.' },
      { label: 'DEV Community: Keep AGENTS.md and CLAUDE.md in sync, 5 user-side fixes', url: 'https://dev.to/yurukusa/keep-agentsmd-and-claudemd-in-sync-5-user-side-fixes-and-where-each-quietly-breaks-35p5' },
      { label: 'DEV Community: One memory to rule them all, taming AI CLI instruction sprawl', url: 'https://dev.to/tawe/one-memory-to-rule-them-all-taming-ai-cli-instruction-sprawl-2m8l' },
    ],
    related: ['why-does-my-agent-forget-rules-after-compaction', 'how-to-write-a-skill-md-description-that-triggers'],
  },
  {
    slug: 'are-agent-skills-safe',
    title: 'Are agent skills safe? What to check before installing one',
    desc: 'A skill is text plus optional scripts that your agent runs with your permissions. What to read, what to scan for, and what our scan of 511 popular skills found.',
    answer: 'Not automatically. A skill is instructions plus optional scripts, and your agent follows and runs them with your permissions, so treat an unfamiliar skill like an unfamiliar dependency: read it, look at what it executes and calls over the network, and pin it to a source you can check. A scanner helps but does not replace reading the `scripts/` folder.',
    sections: [
      { h: 'What to check before you install', list: [
        'Read `SKILL.md` for instructions that hide actions from you or tell the agent to send data somewhere.',
        'Open `scripts/` and any `package.json`. Look for `curl | sh`, postinstall scripts, credential-file reads, and network calls.',
        'Look for invisible characters. Hidden Unicode in rules files has been used to smuggle instructions past reviewers.',
        'Check where it came from: the source repository, the commit, the licence. Install counts and names are not trust signals.',
        'Check what it asks for: tool permissions, MCP servers, hooks.',
        'Re-check after updates. An approval is a point in time; a later version can differ.',
      ] },
      { h: 'What we found in popular skills', paras: [
        'On 2026-10-29 we scanned 511 unique skills from 34 repositories linked from the skills.sh leaderboard: 96 ship executable scripts, 85 make network calls from those scripts, 33 fail the Agent Skills format, and we confirmed 0 malicious ones by hand-reading every critical flag. Read that as "0 found by this method", not "safe": pattern matching is not a sandbox. Full method and numbers are on the proof page linked below.',
        'Outside research is less comfortable. Published work reports malicious skills in large public collections and scanner bypasses, and a hidden-Unicode attack on rules files; see the sources.',
      ] },
    ],
    example: { intro: 'Skillyard\'s `secure` command audits the config around skills too. This is trimmed output from the repository\'s own deliberately bad test fixture:',
      code: '$ skillyard secure test/fixtures/secure-bad\nHIGH   .claude/settings.json:2  permission "Bash(*)" lets the agent run any shell command unprompted\nHIGH   .claude/settings.json:6  hook: downloads and runs remote code in one step\nHIGH   .mcp.json:5  MCP server "db" has a secret inlined in DB_PASSWORD; it lands in git and backups\nMEDIUM .mcp.json:3  MCP server "files" runs @example/server-filesystem unpinned' },
    command: { intro: 'Run these on a skill folder before you install it, and in CI for your own:',
      code: 'npx skillyard scan <dir>                 # security-scan every skill found under a folder\nnpx skillyard secure <dir> --gate high   # also MCP configs, hooks, dependencies, remote scripts; non-zero exit fails CI\nnpx skillyard clean scripts <skill-dir>  # review the scripts a skill ships',
      note: 'These are static checks. They can miss a careful attacker, and they do not watch a skill after you install it.' },
    faq: [
      { q: 'Can an agent skill be malicious?', a: 'Yes. Skills are instructions and scripts the agent acts on with your permissions. Research reports malicious skills in public collections; our own scan of 511 popular skills found none by hand-review, with the limits of pattern matching stated.' },
      { q: 'What should I check before installing a skill?', a: 'Read SKILL.md and everything in scripts/, look for network calls, curl-pipe-shell and hidden Unicode, verify the source repository and commit, and run a scanner such as `skillyard secure`.' },
    ],
    howto: { name: 'Vet an agent skill before installing it', steps: [
      ['Read the skill', 'Read SKILL.md for hidden actions or instructions to send data elsewhere.'],
      ['Read what it runs', 'Open scripts/ and package.json; look for curl | sh, postinstall scripts, credential reads and network calls.'],
      ['Scan it', 'Run skillyard secure on the folder and fix or reject anything marked HIGH.'],
      ['Pin the source', 'Record the repository and commit you reviewed, and re-check on every update.'],
    ] },
    sources: [
      { label: 'ReversingLabs: Weaponizing AI coding (Rules File Backdoor)', url: 'https://www.reversinglabs.com/blog/weaponizing-ai-coding', quote: 'The attack leverages configuration files that are usually trusted and overlooked during code reviews.' },
      { label: 'arXiv 2602.06547: "Do Not Mention This to the User" (large-scale scan of public skills)', url: 'https://arxiv.org/pdf/2602.06547' },
      { label: 'OWASP Agentic Skills Top 10', url: 'https://owasp.org/www-project-agentic-skills-top-10/' },
      { label: 'Cloud Security Alliance: MCP security, tool poisoning', url: 'https://labs.cloudsecurityalliance.org/research-rb/csa-whitepaper-mcp-security-tool-poisoning-20260506-csa-styl/', quote: 'rug pulls exploit the gap between initial approval and ongoing verification' },
    ],
    proofLink: 'scan',
    related: ['why-isnt-my-claude-skill-triggering', 'how-to-write-a-skill-md-description-that-triggers'],
  },
  {
    slug: 'how-to-write-a-skill-md-description-that-triggers',
    title: 'How to write a SKILL.md description that triggers',
    desc: 'The description is the only part of a skill the agent reads before deciding to load it. A formula, a before-and-after, and a check you can run.',
    answer: 'Write the description as what the skill does, then when to use it, in the words a person would actually type: "<what it does>. Use when <the situations and phrases>." Keep it under 1024 characters, scope it to one job, and put detail in the body, because the agent decides whether to open the skill from the description alone.',
    sections: [
      { h: 'Rules that hold up', list: [
        'Say the "when" explicitly. "Use when the user asks for a recap" beats a topic label.',
        'Use the user\'s vocabulary: the phrases they would type, not your internal name for the thing.',
        'One job per skill. A description that claims every task crowds out the skills that should fire.',
        'Do not overlap a neighbour. If two descriptions would fire on the same request, merge them or separate the "when".',
        'Stay under 1024 characters (the Agent Skills limit). Move detail into the body or `references/`.',
        'Re-test after editing. Descriptions regress quietly when someone shortens them.',
      ] },
    ],
    example: { intro: 'The same skill before and after (the rewrite is ours; the review lines are real Skillyard output on the `notes-v2` example):',
      code: `# before\ndescription: Internal notes.\n${REVIEW_BAD.split('\n').slice(2, 3).join('\n')}\n\n# after\ndescription: Formats meeting notes into the team template with decisions and owners. Use when the user pastes meeting notes, asks for a recap, or says "write up the notes".\n${REVIEW_FIXED.split('\n').slice(2).join('\n').trim()}` },
    command: { intro: 'These check the description before you ship:',
      code: 'npx skillyard review <skill-dir>          # description-no-when, description-length, trigger-hijack\nnpx skillyard test <skill-dir> --static   # trigger cases (tests/cases.yaml) scored against sibling skills',
      note: 'Passing a static check does not guarantee the model will pick the skill in a real session; it removes the common mistakes.' },
    faq: [
      { q: 'How long can a SKILL.md description be?', a: 'The Agent Skills format limits it to 1024 characters, and Skillyard flags longer ones. Shorter and specific usually works better than long.' },
      { q: 'What should a skill description contain?', a: 'What the skill does and when to use it, using the words a person would type, scoped to one job.' },
    ],
    howto: { name: 'Write a SKILL.md description that triggers', steps: [
      ['State what the skill does', 'One sentence, concrete.'],
      ['State when to use it', 'Start with "Use when" and list the situations and phrases a person would type.'],
      ['Scope it', 'One job, under 1024 characters, no overlap with neighbouring skills.'],
      ['Check it', 'Run skillyard review and skillyard test --static on the skill.'],
    ] },
    sources: [
      { label: 'DEV Community: Why Claude Code skills don\'t trigger and how to fix them in 2026', url: 'https://dev.to/lizechengnet/why-claude-code-skills-dont-trigger-and-how-to-fix-them-in-2026-o7h' },
      { label: 'Jesse Vincent: Claude Code skills not triggering (Dec 17, 2025)', url: 'https://blog.fsck.com/2025/12/17/claude-code-skills-not-triggering' },
    ],
    related: ['why-isnt-my-claude-skill-triggering', 'agents-md-vs-claude-md-vs-cursor-rules'],
  },
  {
    slug: 'why-does-my-agent-forget-rules-after-compaction',
    title: 'Why does my agent forget rules after compaction?',
    desc: 'Long sessions get compacted, and users report rules from CLAUDE.md being ignored afterwards. What is known, what helps, and what Skillyard does not do.',
    answer: 'When a long session is compacted (summarised to free context), details can be lost, and users have reported that instructions from `CLAUDE.md` stop being followed afterwards. Instruction files are advice the model reads, not rules that are enforced, so the reliable fixes are shorter instruction files, the critical rules stated early and plainly, and deterministic hooks for anything that must never be skipped.',
    sections: [
      { h: 'What helps', list: [
        'Keep the file short. Research on context files found that extra instructions do not generally improve task success and that agents follow them anyway, which costs tokens; every rule you keep should earn its place.',
        'Put the few rules that must survive at the top, as concrete statements, not hedges.',
        'Do not rely on advice for hard requirements. A formatter, a test run or a block on a dangerous command belongs in a hook or CI, which runs every time.',
        'When you compact manually, say what must be kept in the compaction instructions, and start a fresh session between unrelated tasks.',
        'If the same correction keeps coming back, that rule is not sticking. Move it into a skill with a clear trigger or into a hook.',
      ] },
    ],
    example: { intro: 'A way to find the rules that do not stick, using your own session history. `review --chats` reads your agent sessions locally and proposes changes; nothing changes without your approval. Output from the landing page:',
      code: '$ skillyard review --chats\n[af240c47] no skill covers this  4 corrections (repeated)  pending' },
    command: { intro: 'What Skillyard can do about it today:',
      code: 'npx skillyard review --chats        # repeated corrections in your own sessions -> proposed skill edits\nnpx skillyard review <dir>          # bloat, contradictions and vague wording in instruction files\nnpx skillyard tokens --days 7       # where the tokens go, per session',
      note: 'Skillyard does not detect which rules a compaction dropped, and does not write re-injection hooks. A compaction survival check is an idea we have not built.' },
    faq: [
      { q: 'Does Claude Code forget CLAUDE.md after /compact?', a: 'Users have reported exactly that in a Claude Code issue. Treat it as a risk: keep the file short, restate critical rules, and enforce hard requirements with hooks or CI.' },
      { q: 'How do I make an agent follow a rule every time?', a: 'Do not rely on instructions alone. Put the check in a hook or CI so it runs regardless of what the model remembers.' },
    ],
    sources: [
      { label: 'anthropics/claude-code issue #19471', url: 'https://github.com/anthropics/claude-code/issues/19471', quote: 'After compaction, CLAUDE.md is completely ignored without warning' },
      { label: 'Claude Code issue #15465 (mirror): Claude Code ignores claude.md context file before task execution', url: 'https://claudeissues.com/issue/15465-bug-claude-code-ignores-claude-md-context-file-before-task-execution' },
      { label: 'arXiv 2602.11988: evaluating context files for coding agents', url: 'https://arxiv.org/html/2602.11988', quote: 'Surprisingly, we find that providing context files does not generally improve task success rates.' },
    ],
    related: ['agents-md-vs-claude-md-vs-cursor-rules', 'why-isnt-my-claude-skill-triggering'],
  },
];
