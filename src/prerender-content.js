// Answer pages for /learn/<slug>/. One structure feeds the HTML page, the FAQ JSON-LD, the HowTo JSON-LD and llms-full.txt.
// Inline markup: `code` only. Sources are links that appear in the pain-point research; quotes are one short sentence at most.
// Commands named here exist in src/cli.js (check the HELP text before adding one).

const REVIEW_BAD = `$ skillhawk review examples/bad/notes-v2

C  notes-v2  ~ 811 tok  1 finding: description-no-when
     high   SKILL.md:3 [description-no-when] description does not say when to use the skill; agents decide to load a skill from its description alone
            fix: Rewrite as "<what it does>. Use when <the situations and phrases a user would say>."`;

const REVIEW_FIXED = `$ skillhawk review notes-v2   # after the rewrite above

A  notes-v2  ~ 847 tok  no findings`;


const AGENTS_EXAMPLE = `$ npx skillhawk agents
skillhawk agents: 2 need a look (running over 12h, or working with no human input for 2h)

Agent processes (2)
 !    100  claude  up 3d 4h    no terminal  cpu 0.1%  200 MB  1 child process
      200  claude  up 1h 10m   tty ttys003  cpu 2%  300 MB  0 child processes

Dev servers left running (1)
 !    300  up 26d 1h   port 4400  13 MB  node /home/me/studio/server.cjs

Nothing was stopped. To stop the flagged processes yourself: kill 100 300`;

const AGENT_PAGES = [
  {
    slug: 'why-is-claude-code-billing-my-api-key-instead-of-my-subscription',
    title: 'Why is Claude Code billing my API key instead of my subscription?',
    desc: 'When ANTHROPIC_API_KEY is set, Claude Code uses it instead of your Pro or Max plan, and claude -p always does. How scheduled agents end up on pay-per-token billing, and how to check.',
    answer: 'Because an API key is in the environment the agent runs in. Claude Code\'s documentation says that when `ANTHROPIC_API_KEY` is set, it is used instead of your Claude Pro, Max, Ultra, Team or Enterprise subscription even if you are logged in; in interactive mode you are asked once, and in non-interactive mode (`claude -p`) the key is always used when present. Scheduled agents (cron, launchd, scripts that load a `.env`, CI) usually run non-interactively, so they bill the key per token without asking.',
    sections: [
      { h: 'Where the key usually comes from', list: [
        'Your shell start-up file (`~/.zshrc`, `~/.bashrc`) exports `ANTHROPIC_API_KEY`, so every `claude -p` started from that shell or its scripts inherits it.',
        'A crontab line or a variable set at the top of the crontab, a launchd `EnvironmentVariables` entry, or a systemd `Environment=` line.',
        'A script that loads a project `.env` (for example `set -a; source .env`) which contains the key.',
        'A GitHub Actions workflow that passes `anthropic_api_key` to `anthropics/claude-code-action`; `claude_code_oauth_token` uses a subscription token instead.',
      ] },
      { h: 'How to switch a run back to your subscription', list: [
        '`unset ANTHROPIC_API_KEY` in the environment the job runs in, then check `/status` in Claude Code, which marks the credential that is not in use.',
        'Remove the key from the job definition or the `.env` it loads, or give the job a subscription token instead.',
        'For headless runs that should bill an API key, cap them with `--max-budget-usd` and a spend limit on the API workspace.',
      ] },
    ],
    example: { intro: 'What `skillhawk agents` prints for scheduled agents (example data):', code: ` ! cron           claude  */30 * * * * cd ~/repo && claude -p "sweep"  (crontab)
     bills: API key, pay per token (ANTHROPIC_API_KEY)
   launchd        claude  com.me.nightly.plist  (~/Library/LaunchAgents/com.me.nightly.plist)
     bills: subscription token (CLAUDE_CODE_OAUTH_TOKEN)

API keys your shell exports (1)
 ! ~/.zshrc: ANTHROPIC_API_KEY. Agents started from this shell, including \`claude -p\` in scripts, bill this key per token, even when you are signed in to a subscription.` },
    command: { intro: 'Read-only; it prints variable names, never their values:',
      code: 'npx skillhawk agents',
      note: 'It reads your crontab, launchd or systemd user jobs, the scripts and `.env` files they load, this repository\'s scheduled GitHub workflows and your shell start-up files.' },
    faq: [
      { q: 'Does claude -p use my Max subscription?', a: 'Only if no API key is present. Claude Code\'s documentation says that in non-interactive mode (-p) an ANTHROPIC_API_KEY in the environment is always used when present, instead of your subscription.' },
      { q: 'How do I know which account a run is using?', a: 'Run /status in Claude Code, which marks the credential not in use. For scheduled jobs, check the environment they run in; npx skillhawk agents lists each scheduled agent with the credential it will use.' },
    ],
    howto: { name: 'Check which account your scheduled agents bill', steps: [
      ['List scheduled agents', 'Run npx skillhawk agents and read the bills line under each scheduled agent.'],
      ['Check your shell', 'Look for an exported ANTHROPIC_API_KEY in your shell start-up files.'],
      ['Fix the environment', 'Unset the key or move it out of the job, then confirm with /status.'],
      ['Cap API runs', 'Use --max-budget-usd and a workspace spend limit for runs that should bill a key.'],
    ] },
    sources: [
      { label: 'Claude Code docs: environment variables (ANTHROPIC_API_KEY)', url: 'https://code.claude.com/docs/en/env-vars', quote: 'this key is used instead of your Claude Pro, Max, Ultra, Team, or Enterprise subscription' },
      { label: 'Claude Code docs: authentication and credentials', url: 'https://code.claude.com/docs/en/iam' },
      { label: 'GitHub issue #37686: scheduled claude -p runs inherited an API key ($1,800+ in two days)', url: 'https://github.com/anthropics/claude-code/issues/37686' },
    ],
    related: ['how-much-is-claude-code-costing-me', 'see-which-ai-coding-agents-are-still-running'],
  },
  {
    slug: 'see-which-ai-coding-agents-are-still-running',
    title: 'How to see which AI coding agents are still running',
    desc: 'Find Claude Code, Codex, Gemini and other coding agents still running on your machine, the sessions working with no human, and the dev servers they left behind.',
    answer: 'List your processes and look for the agent commands (`claude`, `codex`, `gemini`, `aider` and others), note which have no terminal attached and how long they have been up, then check which local ports are still listening. `npx skillhawk agents` does all of this in one read-only command and also finds Claude Code sessions still working with no human message for hours.',
    sections: [
      { h: 'Where agents keep running', list: [
        'Headless runs (`claude -p`, `codex exec`) started by a script, cron, launchd or a CI schedule. They have no terminal, so closing a window does not stop them.',
        'Interactive sessions left open. Claude Code can start new turns while a session sits idle, for example scheduled tasks, messages from your other sessions and goal check-ins; each one sends the full context again.',
        'Child processes an agent started: test watchers, dev servers and sub-agents that outlive the session that started them.',
        'Scheduled agents you set up once and forgot: crontab entries, launchd or systemd user jobs, and GitHub Actions workflows with a `schedule:` trigger.',
      ] },
      { h: 'Doing it by hand', list: [
        '`ps -Ao pid,ppid,etime,tty,command | grep -E "claude|codex|gemini|aider"` lists agent processes with how long each has run (`etime`) and whether it has a terminal (`tty` is `??` when it has none).',
        '`lsof -nP -iTCP -sTCP:LISTEN` lists processes listening on a port, which is how you find a dev server nobody is using.',
        '`crontab -l` and `ls ~/Library/LaunchAgents` (macOS) or `~/.config/systemd/user` (Linux) show what is scheduled.',
      ] },
    ],
    example: { intro: 'Output from example data, in the real output format:', code: AGENTS_EXAMPLE },
    command: { intro: 'One command, read-only; it never stops anything and nothing leaves your machine:',
      code: 'npx skillhawk agents\nnpx skillhawk agents --running 6 --idle 1     # stricter thresholds\nnpx skillhawk agents --notify desktop          # a desktop alert with counts only',
      note: 'It reads `ps`, `lsof`, your crontab, launchd or systemd user jobs, the current repo\'s GitHub workflows and Claude Code\'s local session logs.' },
    faq: [
      { q: 'Does closing the terminal stop a Claude Code agent?', a: 'Closing the terminal ends an interactive session attached to it, but headless runs started by a script or scheduler have no terminal and keep running, as do servers and watchers they started.' },
      { q: 'Is it safe to run skillhawk agents?', a: 'It only reads. It lists processes, ports, schedules and session activity, prints the command to stop each flagged process, and stops nothing itself.' },
    ],
    howto: { name: 'Find AI coding agents still running', steps: [
      ['List agent processes', 'Run ps and look for claude, codex, gemini and similar, with their elapsed time and terminal.'],
      ['Find leftover servers', 'Run lsof to list listening ports and match them to the processes above.'],
      ['Check schedules', 'Look at crontab, launchd or systemd user jobs and scheduled GitHub workflows.'],
      ['Or run one command', 'Run npx skillhawk agents to get all of it, flagged by age and inactivity.'],
    ] },
    sources: [
      { label: 'Claude Code docs: Manage costs effectively (what uses tokens while a session is idle)', url: 'https://code.claude.com/docs/en/costs' },
      { label: 'Claude Code docs: Run Claude Code programmatically (headless)', url: 'https://code.claude.com/docs/en/headless' },
      { label: 'ps(1) manual page', url: 'https://man7.org/linux/man-pages/man1/ps.1.html' },
      { label: 'lsof on macOS (SS64)', url: 'https://ss64.com/mac/lsof.html' },
    ],
    related: ['how-much-is-claude-code-costing-me', 'stop-a-background-ai-agent-safely'],
  },
  {
    slug: 'how-much-is-claude-code-costing-me',
    title: 'How much is Claude Code costing me?',
    desc: 'How to see Claude Code cost per session and per day, what Anthropic reports as typical, and what keeps spending while you are away.',
    answer: 'Run `/usage` in a session to see its token usage and cost estimate. For history across sessions, read the local session logs: `npx skillhawk tokens --days 7` totals tokens and estimated cost per day, repo and session. Anthropic\'s documentation says the average across enterprise deployments is around $13 per developer per active day, and below $30 per active day for 90% of users.',
    sections: [
      { h: 'Ways to see it', list: [
        '`/usage` inside Claude Code: the current session\'s tokens and a dollar figure computed locally at list price. On a Pro, Max or Ultra plan, usage is included in the subscription, so that dollar figure is not your bill.',
        'Your session logs: Claude Code writes each session to a JSONL file under `~/.claude/projects/`, with token counts per response. Tools such as `ccusage` and `skillhawk tokens` read them.',
        '`--max-budget-usd` caps what a headless run may spend.',
      ] },
      { h: 'What spends while you are away', list: [
        'Every new turn re-sends the conversation, so a long session costs more per turn even for a one-line question.',
        'Idle sessions can still start turns: scheduled tasks, messages from your other sessions and goal check-ins each send the full context, according to the Claude Code docs.',
        'Headless agents on a schedule run whether or not anyone reads the result.',
      ] },
    ],
    example: { intro: 'For a session still working with no human message, `skillhawk agents` shows the estimated cost since a human last wrote. The line format, from example data:', code: ' ! aaaaaaaa  repo\n     last human message 5h 0m ago; last activity 5m ago; since then 2 turns, 3 tool calls, about $0.85 (estimate)' },
    command: { intro: 'Read-only, from your own logs; nothing is uploaded:',
      code: 'npx skillhawk tokens --days 7      # per day, repo, skill and session\nnpx skillhawk agents               # sessions still spending with no human',
      note: 'Dollar figures are estimates from token counts at list prices; your plan or contract decides what you actually pay.' },
    faq: [
      { q: 'What does Claude Code cost per day?', a: 'Anthropic\'s documentation reports an average of around $13 per developer per active day across enterprise deployments, with 90% of users below $30 per active day. Your own logs give your number.' },
      { q: 'Why did my cost go up when I was not using it?', a: 'An open session can start turns while idle (scheduled tasks, cross-session messages, goal check-ins), and headless agents on a schedule keep running. Each turn re-sends the conversation.' },
    ],
    howto: { name: 'Check what Claude Code is costing you', steps: [
      ['Check the session', 'Run /usage in Claude Code and read the Session block.'],
      ['Check the week', 'Run npx skillhawk tokens --days 7 to total your local logs per day, repo and session.'],
      ['Find what spends unattended', 'Run npx skillhawk agents to list sessions working with no human and their cost since.'],
      ['Cap headless runs', 'Use --max-budget-usd on scripted runs.'],
    ] },
    sources: [
      { label: 'Claude Code docs: Manage costs effectively', url: 'https://code.claude.com/docs/en/costs', quote: 'the average cost is around $13 per developer per active day' },
      { label: 'Claude Code docs: CLI reference', url: 'https://code.claude.com/docs/en/cli-reference' },
      { label: 'ccusage on GitHub', url: 'https://github.com/ryoppippi/ccusage' },
    ],
    related: ['see-which-ai-coding-agents-are-still-running', 'stop-a-background-ai-agent-safely'],
  },
  {
    slug: 'stop-a-background-ai-agent-safely',
    title: 'How to stop a background AI agent safely',
    desc: 'Stop a Claude Code, Codex or other coding agent that is still running, its leftover servers, and the schedule that keeps starting it.',
    answer: 'Find the process first (`npx skillhawk agents` or `ps`), check its command so you stop the right one, then send it a normal stop signal with `kill <pid>` and use `kill -9` only if it will not exit. If something keeps restarting it, remove the schedule as well: the crontab line, the launchd or systemd job, or the GitHub workflow.',
    sections: [
      { h: 'In order', list: [
        'Interactive session: switch to its terminal and exit it normally, so it can finish writing its log.',
        'Headless or detached process: `kill <pid>` sends SIGTERM, which lets it clean up. Wait a few seconds; `kill -9 <pid>` is the last resort.',
        'Leftover dev servers and watchers: stop them by pid the same way; `lsof -nP -iTCP -sTCP:LISTEN` shows which process holds a port.',
        'Schedules: `crontab -e` to delete the line; `launchctl bootout gui/$(id -u)/<label>` for a launchd job on macOS; `systemctl --user disable --now <unit>` on Linux; `gh workflow disable <workflow>` for a scheduled GitHub Action.',
        'Idle check-ins in Claude Code: the docs say `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0` turns them off.',
      ] },
    ],
    example: { intro: '`skillhawk agents` ends with the exact command for what it flagged (example data):', code: 'Nothing was stopped. To stop the flagged processes yourself: kill 100 300' },
    command: { intro: 'See what is running, then stop it yourself:',
      code: 'npx skillhawk agents\nkill 100 300',
      note: 'skillhawk never stops anything itself; you decide.' },
    faq: [
      { q: 'Is kill -9 safe for an agent?', a: 'Use it last. SIGKILL gives the process no chance to finish writing files or logs; try a plain kill (SIGTERM) first.' },
      { q: 'I stopped it and it came back. Why?', a: 'A scheduler started it again. Check crontab, launchd or systemd user jobs and scheduled GitHub workflows, and remove the entry.' },
    ],
    howto: { name: 'Stop a background AI agent', steps: [
      ['Find it', 'Run npx skillhawk agents or ps and confirm the command line.'],
      ['Stop it gently', 'Run kill <pid>; use kill -9 only if it does not exit.'],
      ['Stop what it left', 'Stop leftover servers and watchers by pid.'],
      ['Remove the schedule', 'Delete the cron line, launchd or systemd job, or disable the GitHub workflow.'],
    ] },
    sources: [
      { label: 'launchctl on macOS (SS64)', url: 'https://ss64.com/mac/launchctl.html' },
      { label: 'GitHub CLI: gh workflow disable', url: 'https://cli.github.com/manual/gh_workflow_disable' },
      { label: 'Claude Code docs: Manage costs effectively (idle check-ins)', url: 'https://code.claude.com/docs/en/costs' },
    ],
    related: ['see-which-ai-coding-agents-are-still-running', 'how-much-is-claude-code-costing-me'],
  },
];

export const LEARN = [
  ...AGENT_PAGES,
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
    example: { intro: 'A real example from the Skillhawk good-versus-bad gallery. The skill `notes-v2` has the description "Internal notes." and Skillhawk grades it C. After rewriting the description (the rewrite below is ours, for illustration), the same skill grades A.',
      code: `${REVIEW_BAD}\n\n# SKILL.md frontmatter, before\ndescription: Internal notes.\n\n# after\ndescription: Formats meeting notes into the team template with decisions and owners. Use when the user pastes meeting notes, asks for a recap, or says "write up the notes".\n\n${REVIEW_FIXED}` },
    command: { intro: 'Skillhawk cannot see inside a live Claude session, so it cannot tell you why one particular request did not fire. It does check the things above before you ship:',
      code: 'npx skillhawk validate .claude/skills\nnpx skillhawk review .claude/skills      # description-no-when, trigger-hijack, overlapping triggers between skills\nnpx skillhawk test .claude/skills/notes-v2 --static   # your trigger cases scored against sibling skills',
      note: 'A "why didn\'t it fire" replay of a real session is on our list of ideas; it is not built.' },
    faq: [
      { q: 'Why does Claude ignore my skill even when the description looks fine?', a: 'Check that the skill loaded at all, that no other skill has an overlapping description, and that you are not testing in headless mode, where users report skills not triggering. Then make the description name the exact situations and phrases that should trigger it.' },
      { q: 'Does Skillhawk tell me why a skill did not fire?', a: 'Not for a live session. `skillhawk review` flags descriptions that do not say when to use the skill, claim every task, or overlap another skill, which are the common causes you can fix before shipping.' },
    ],
    howto: { name: "Debug a Claude skill that does not trigger", steps: [
      ['Check placement and frontmatter', 'Confirm SKILL.md is in the skills folder and starts with a valid --- frontmatter block.'],
      ['Read the description as the agent does', 'It must say what the skill does and when to use it, in the words a person would type.'],
      ['Look for competition', 'Run skillhawk review on the skills folder to find overlapping triggers and skills that claim every task.'],
      ['Test in the mode you use', 'Compare interactive and headless runs; add trigger cases and run skillhawk test --static.'],
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
    example: { intro: 'Skillhawk\'s `compile` writes the native file each agent expects from one skill and checks size, frontmatter and lost content. This is real output from the landing page for the `release-notes` skill (Copilot\'s code review reads a limited number of characters, which is why that check fails):',
      code: '$ skillhawk compile release-notes --to all\ncopilot: FAIL size (4301/4000 chars read by code review)\ngemini: GEMINI.md  ok size (4385/20000 bytes)' },
    command: { intro: 'What Skillhawk does here, and what it does not:',
      code: 'npx skillhawk compile <skill-dir> --to claude,codex,cursor,copilot,gemini\nnpx skillhawk review <dir>   # contradictions and duplicate rules inside a file',
      note: 'compile works from a skill folder, not from an existing AGENTS.md. Detecting drift between your instruction files across repositories is not a feature yet.' },
    faq: [
      { q: 'Should I use AGENTS.md or CLAUDE.md?', a: 'Use both if you use both kinds of agents: put the shared content in `AGENTS.md` and have `CLAUDE.md` import or link it, so there is one place to edit.' },
      { q: 'Can Skillhawk sync my CLAUDE.md and .cursorrules?', a: 'Not directly. It compiles a skill to native files for Claude Code, Codex, Cursor, Copilot and Gemini and checks each one. It does not yet diff your existing instruction files against each other.' },
    ],
    howto: { name: 'Keep AGENTS.md, CLAUDE.md and Cursor rules in sync', steps: [
      ['Pick one source of truth', 'Write the shared rules in AGENTS.md.'],
      ['Point the other files at it', 'Make CLAUDE.md import AGENTS.md; generate or link the Cursor, Copilot and Gemini files.'],
      ['Clean the source first', 'Run skillhawk review to remove contradictions and duplicate rules before copying them anywhere.'],
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
    example: { intro: 'Skillhawk\'s `secure` command audits the config around skills too. This is trimmed output from the repository\'s own deliberately bad test fixture:',
      code: '$ skillhawk secure test/fixtures/secure-bad\nHIGH   .claude/settings.json:2  permission "Bash(*)" lets the agent run any shell command unprompted\nHIGH   .claude/settings.json:6  hook: downloads and runs remote code in one step\nHIGH   .mcp.json:5  MCP server "db" has a secret inlined in DB_PASSWORD; it lands in git and backups\nMEDIUM .mcp.json:3  MCP server "files" runs @example/server-filesystem unpinned' },
    command: { intro: 'Run these on a skill folder before you install it, and in CI for your own:',
      code: 'npx skillhawk scan <dir>                 # security-scan every skill found under a folder\nnpx skillhawk secure <dir> --gate high   # also MCP configs, hooks, dependencies, remote scripts; non-zero exit fails CI\nnpx skillhawk clean scripts <skill-dir>  # review the scripts a skill ships',
      note: 'These are static checks. They can miss a careful attacker, and they do not watch a skill after you install it.' },
    faq: [
      { q: 'Can an agent skill be malicious?', a: 'Yes. Skills are instructions and scripts the agent acts on with your permissions. Research reports malicious skills in public collections; our own scan of 511 popular skills found none by hand-review, with the limits of pattern matching stated.' },
      { q: 'What should I check before installing a skill?', a: 'Read SKILL.md and everything in scripts/, look for network calls, curl-pipe-shell and hidden Unicode, verify the source repository and commit, and run a scanner such as `skillhawk secure`.' },
    ],
    howto: { name: 'Vet an agent skill before installing it', steps: [
      ['Read the skill', 'Read SKILL.md for hidden actions or instructions to send data elsewhere.'],
      ['Read what it runs', 'Open scripts/ and package.json; look for curl | sh, postinstall scripts, credential reads and network calls.'],
      ['Scan it', 'Run skillhawk secure on the folder and fix or reject anything marked HIGH.'],
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
    example: { intro: 'The same skill before and after (the rewrite is ours; the review lines are real Skillhawk output on the `notes-v2` example):',
      code: `# before\ndescription: Internal notes.\n${REVIEW_BAD.split('\n').slice(2, 3).join('\n')}\n\n# after\ndescription: Formats meeting notes into the team template with decisions and owners. Use when the user pastes meeting notes, asks for a recap, or says "write up the notes".\n${REVIEW_FIXED.split('\n').slice(2).join('\n').trim()}` },
    command: { intro: 'These check the description before you ship:',
      code: 'npx skillhawk review <skill-dir>          # description-no-when, description-length, trigger-hijack\nnpx skillhawk test <skill-dir> --static   # trigger cases (tests/cases.yaml) scored against sibling skills',
      note: 'Passing a static check does not guarantee the model will pick the skill in a real session; it removes the common mistakes.' },
    faq: [
      { q: 'How long can a SKILL.md description be?', a: 'The Agent Skills format limits it to 1024 characters, and Skillhawk flags longer ones. Shorter and specific usually works better than long.' },
      { q: 'What should a skill description contain?', a: 'What the skill does and when to use it, using the words a person would type, scoped to one job.' },
    ],
    howto: { name: 'Write a SKILL.md description that triggers', steps: [
      ['State what the skill does', 'One sentence, concrete.'],
      ['State when to use it', 'Start with "Use when" and list the situations and phrases a person would type.'],
      ['Scope it', 'One job, under 1024 characters, no overlap with neighbouring skills.'],
      ['Check it', 'Run skillhawk review and skillhawk test --static on the skill.'],
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
    desc: 'Long sessions get compacted, and users report rules from CLAUDE.md being ignored afterwards. What is known, what helps, and what Skillhawk does not do.',
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
      code: '$ skillhawk review --chats\n[af240c47] no skill covers this  4 corrections (repeated)  pending' },
    command: { intro: 'What Skillhawk can do about it today:',
      code: 'npx skillhawk review --chats        # repeated corrections in your own sessions -> proposed skill edits\nnpx skillhawk review <dir>          # bloat, contradictions and vague wording in instruction files\nnpx skillhawk tokens --days 7       # where the tokens go, per session',
      note: 'Skillhawk does not detect which rules a compaction dropped, and does not write re-injection hooks. A compaction survival check is an idea we have not built.' },
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
