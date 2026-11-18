# Skillhawk

> Not affiliated with [Berserk-hub150/skillhawk](https://github.com/Berserk-hub150/skillhawk), a separate SKILL.md security scanner with a similar name.

**Your agents run without you. Know which account they bill.** One free command finds every coding agent that runs
without a human (cron, launchd and systemd jobs, scheduled GitHub workflows, Claude Code sessions still working hours
after anyone typed, dev servers left running) and shows which account each scheduled agent bills: your subscription,
or an API key that charges per token. Claude Code uses `ANTHROPIC_API_KEY` instead of your subscription whenever it is
set, and `claude -p` always does ([docs](https://code.claude.com/docs/en/env-vars)), which is how scheduled jobs end up
on pay-per-token billing ([example: $1,800+ in two days](https://github.com/anthropics/claude-code/issues/37686)).

```
npx skillhawk agents        # read-only; prints variable names, never values
```

The same CLI also checks agent skills: grades every `SKILL.md` A-F, scans skills and MCP configs for security problems,
and compiles a skill for Codex, Cursor, Copilot and Gemini. Everything is also available to your agent as a local MCP
server (`npx -y skillhawk mcp`).

The rest of this README covers the skill registry and vault: keep open-source skills and your company's private ones
in one place, install them into **Claude Code, OpenAI Codex, Cursor and any AGENTS.md agent**, or let agents load them
over **MCP**.

A *skill* is a folder with a `SKILL.md` (YAML frontmatter + instructions) and optional `scripts/`, `references/` and
`templates/`, following the [Agent Skills](https://agentskills.io) format. Skillhawk adds what a team needs around
that format: private org scopes with access tokens, immutable versions, a security scan on every publish, one-command
installs for every agent, a project manifest teammates can sync, and an audit log.

```
npx skillhawk install code-review @acme/deploy-runbook --agent claude,codex --save
```

**Live demo:** https://skillhawk.ai/ (read-only; click *Sign in* and type `acme` or `northwind`
to see two fictional companies' private skills).

**Reports:** [We scanned the 34 most-installed skill repos](reports/2026-10-top-skills-scan.md) ·
[Do skills actually help? Lift evals](reports/2026-10-lift-evals.md) ·
[Good skills, bad skills: 12 examples and why](examples/README.md)

## Create skills: builder, generators and skill-writer

Six generators cover the knowledge businesses actually keep: **procedure** (runbooks, month-end close),
**checklist** (review gates), **voice** (brand and writing), **playbook** (sales and customer plays),
**decision** (who approves what) and **metric** (how numbers are defined).

```sh
npx skillhawk generate                                   # list generators
npx skillhawk generate decision --from refund-policy.md  # fill one from your own document, with a test case
```

The same generators run in the [web builder](https://skillhawk.ai/#/create) (answer a few
questions, download a zip; nothing leaves the page) and in Studio's **Create a skill**, where the result is tested and
waits for approval like every other proposal. The `skill-writer` skill does the same from inside Claude Code or Codex.

## Studio: your agents learn from your corrections

```sh
npx skillhawk studio          # http://127.0.0.1:7430, local only
npx skillhawk studio --demo   # try it on a fictional team's data first
```

Every time someone tells an agent "no, we use pnpm here" or "I didn't ask for that", it's a free test case.
Studio turns those moments into skills that stop the mistake from coming back, and proves each one works:

1. **Find.** Reads Claude Code and Codex session logs on your machine and spots corrections. Keeps only the
   redacted moment (emails, keys, tokens, long numbers and your home path removed).
2. **Propose.** Groups corrections that repeat into themes, then drafts a new skill or an edit to one you already
   use, with test cases built from the real requests where the agent went wrong.
3. **Prove.** Runs each draft with and without (or against the current version of the skill) and grades the
   answers. You see the before and after, the diff, and the corrections that led to it.
4. **You decide.** Approve to install into Claude Code and/or Codex, edit first, or reject (it won't be proposed
   again). Every approval keeps a backup and can be undone.

**Consent is the product.** Three separate switches, all off until you turn them on: reading logs, letting a model
review redacted excerpts (through your own Claude Code login; you can see exactly what would be sent), and
reviewing on a schedule. Projects can be left out (work for an employer or client). Turning reading off deletes
everything Studio read. Nothing is ever installed without an explicit approval, and every decision is logged.

The overview tracks the number engineering leads ask for: **corrections per 100 prompts, by week**. Think of it as
your team's defect rate for AI work, with the pipeline from corrections to proven skills next to it.

## What's in the box

| | |
|---|---|
| **Registry server** | REST API, web UI, and an MCP endpoint at `/mcp`. Zero dependencies (Node ≥ 20), file-backed storage. |
| **Private skills** | Every skill lives under a scope (`@acme/…`). Org skills are private by default, visible only to that org's tokens; a company can still publish selected skills publicly. |
| **Security scan** | Every publish is scanned for prompt-injection phrasing, instructions to hide actions from the user, invisible Unicode, embedded secrets, `curl \| sh`, credential-file reads and secret exfiltration. Critical findings block the publish; warnings are shown on the skill page. |
| **Cross-agent install** | `skillhawk install` writes each skill where each agent looks: `.claude/skills/`, `.codex/skills/`, `.cursor/rules/*.mdc` (+ files), and `.agents/skills/` with a managed index in `AGENTS.md`. |
| **MCP server** | `skillhawk mcp` (stdio): local checks `review_skill`, `secure_scan`, `compile_skill`, `check_agents` with no account; plus `search_skills`, `get_skill`, `read_skill_file` and every skill as a prompt and resource when a registry is configured. The registry also serves the skill tools over HTTP at `/mcp`. |
| **Lift evals** | `skillhawk eval <skill>` runs the skill's `evals/evals.json` tasks through Claude Code or Codex with and without the skill, grades both with fixed checks, and reports the lift. Skills that don't help are context you pay for on every task. |
| **Skill reviewer** | `skillhawk review <dir>` grades every skill A-F with line-level findings and fixes, `--fix` applies safe mechanical fixes, and a library pass flags duplicates, overlapping triggers and contradictions; also a Claude Code skill + subagent in `plugins/review`. |
| **Skill optimizer** | `skillhawk optimize <dir>` cuts tokens with a static pass (filler, repeats, whitespace) that must keep the review grade and trigger cases; `--allow-model` adds model rewrites kept only if lift holds; `--all <dir>` summarizes a library; plugin in `plugins/optimize`. |
| **Clean** | `skillhawk clean scripts <skill-dir...>` reviews scripts bundled in skills (error handling, `set -e`, unquoted variables, hard-coded paths, unused code; also shown in `review`); `skillhawk clean standards [repo] [--from-git] [--from-reviews file]` learns a coding-standards skill from the repo and clusters repeated PR review requests into counted rules; skill + subagent in `plugins/clean`. |
| **Token Saver** | `skillhawk map [dir]` builds a zero-dependency index of a repo and its skills (symbols, imports, summaries; `--update` is incremental; `--engine graphify` uses the graphify CLI if installed); `skillhawk map query "<question>"` returns ranked `file:line` hits with no model. `skillhawk mcp` serves it as `map_query` and `skill_section` (one heading of a SKILL.md), and `plugins/tokensaver` teaches agents to use both. |
| **Token dashboard** | `skillhawk tokens [--days 7] [--logs dir] [--json]` totals tokens and estimated cost from Claude Code logs per day, repo, skill and session (folders listed in `exclude` in ~/.skillyard/config.json, SKILLYARD_EXCLUDE or `--exclude` are never read). |
| **Secure the setup** | `skillhawk secure [dir...] [--gate high]` audits skills plus MCP configs, hooks, skill dependencies, run-time downloads and tool grants, with file:line, why and fix; `--gate` fails CI. |
| **Scan any folder** | `skillhawk scan <dir>` finds every skill under a folder (a repo, `~/.claude/skills`) and reports what runs code, talks to the network or hides instructions. |
| **Project manifest** | `skills.json` lists a project's skills and agents; `skillhawk sync` reproduces the set on any machine. |
| **Claude plugin marketplace** | This repo is a Claude Code marketplace of the open-source skills, and `skillhawk export claude-marketplace --scope acme` turns an org's private skills into a marketplace for a private git repo. |
| **Seed content** | 37 open-source skills in [`registry/public`](registry/public), including 12 for running a business (sales calls, outreach, proposals, pricing, investor updates, collections, hiring, SOPs), plus 227 imported community skills and two fictional companies with 13 private skills in [`seed/orgs`](seed/orgs). |

## Quick start

```sh
npm run dev                # loads the bundled skills, then serves http://127.0.0.1:7420
```

`seed` prints a demo token for each fictional company (also saved to `data/demo-tokens.json`). Paste one into
**Sign in** in the web UI to see that company's private skills, or use it from the CLI:

```sh
export SKILLYARD_REGISTRY=http://127.0.0.1:7420
node bin/skillyard.js search review
node bin/skillyard.js login --token sy_…          # an acme token
node bin/skillyard.js search deploy               # now includes @acme/deploy-runbook
node bin/skillyard.js install @acme/deploy-runbook code-review --agent all
```

## Use from your agent

**Install** copies skills into the agent's own folder, so they load automatically and work offline:

```sh
skillhawk install code-review                    # detected agents in this project (default: claude)
skillhawk install @acme/incident-response -g     # user-wide (Claude Code, Codex)
skillhawk install sql-review --agent cursor      # writes .cursor/rules/sql-review.mdc + .cursor/skills/sql-review/
skillhawk list && skillhawk update
```

**MCP, local checks (no account):** give any MCP client the checks as tools: `review_skill`, `secure_scan`,
`compile_skill` and `check_agents`. They run on your machine over stdio; nothing is sent anywhere.

```sh
claude mcp add --scope user skillhawk -- npx -y skillhawk mcp   # or: npx skillhawk connect claude --write
npx skillhawk connect codex|cursor|vscode|gemini|claude-desktop  # prints the config for that agent
```

**MCP, with a registry:** once a registry is configured (`skillhawk login`), the same server also lets the agent
search everything your token can see and pull in a skill when a task calls for it:

```sh
skillhawk connect claude --write    # runs `claude mcp add --transport http skillhawk <registry>/mcp …`
skillhawk connect codex --write     # adds [mcp_servers.skillyard] to ~/.codex/config.toml (registry mode)
skillhawk connect cursor --write    # .cursor/mcp.json (token read from ${env:SKILLYARD_TOKEN})
skillhawk connect vscode | gemini | claude-desktop
```

**Claude Code plugins**: `/plugin marketplace add agentwik-labs/skillhawk`, then `/plugin install skillyard-engineering@skillyard`.

See [docs/agents.md](docs/agents.md) for where each agent reads skills and how each config looks.

## Roll it out to your team

```sh
npx -y skillhawk kit .
```

Copies the [team starter kit](starter-kit/README.md) into your repo: a two-week plan, a 30-minute kickoff agenda,
a skill review checklist, fill-in `data-handling` and `definition-of-done` skills with evals, a new-skill template,
and a CI check. No server needed: `skillhawk install ./skills/* --agent all` installs straight from the folder.

## Run it for a company

```sh
SKILLYARD_ADMIN_TOKEN=$(openssl rand -hex 24) skillhawk serve --host 0.0.0.0 --data /var/lib/skillyard
skillhawk org create acme --name "Acme Cloud"            # prints an owner token (read + publish)
skillhawk token create --org acme --scopes read --name laptop-dana
skillhawk new deploy-runbook && skillhawk publish deploy-runbook --org acme
```

Sign-ups on the public site (the monthly report, audit requests, the Studio waitlist) post to the email-list endpoint in
[`web/config.js`](web/config.js); until one is set, the forms point to the contact link instead.

Or with Docker: `docker build -t skillhawk . && docker run -p 7420:7420 -v skillyard-data:/data skillhawk`.
Put it behind TLS (any reverse proxy). Tokens are stored as SHA-256 hashes; org members manage tokens and see the
activity log on their org page. See [docs/self-hosting.md](docs/self-hosting.md).

## Sign, test and live-reload a skill

- `skillhawk keys create --out keys/`, `skillhawk sign <skill-dir> --key keys/skillyard-private.pem`, `skillhawk verify <skill-dir> --pub keys/skillyard-public.pem` (exit 1, names the changed files). The signature is ed25519 over a sorted path-to-sha256 manifest, stored in `.skillyard-signature.json` (excluded from the manifest). Per-person marked copies differ from the signed original, so the vault signs the marked copy it serves, at serve time, with the org key; `verify` works on whatever was delivered. Library: `generateKeys`, `signFiles`, `verifyFiles` in `src/sign.js`.
- `skillhawk new` adds `tests/cases.yaml` (`should_fire`, `should_not_fire`, `behaviour` with `expect`/`forbid`/`rubric`; `cases.json` also works). `skillhawk test <dir>` scores each trigger prompt against this skill's description and the sibling/installed skills (BM25) and reports which skill would win; `--allow-model` also runs behaviour cases in the confined eval runner.
- `skillhawk dev <dir> [--agent claude]` watches the folder, re-installs on change and prints one status line (review grade, static tests).
- `skillhawk ci skills --compare origin/main` adds a grade before/after and findings-delta table for changed skills to the PR summary (action input `compare`).
## Leak tracing: mark and trace

`skillhawk mark <skill-dir> --recipient alice --version 1.0.0 --secret <s> --out <dir> --marks marks.json` writes a per-person copy and appends its fingerprint to `marks.json`; `skillhawk trace leaked.md --marks marks.json --secret <s>` names the recipient with confidence and evidence, from a full copy or a fragment. Three layers, all keyed by HMAC(secret, recipient|version):

- **zw**: a 32-bit tag as zero-width characters at up to 8 line ends. Easy to strip, which is fine.
- **wording**: meaning-preserving variants (verify/confirm/check, make sure/ensure, before/prior to, e.g./for example, contractions and apostrophe style, Oxford comma, list marker style, order of adjacent independent bullets). Each site carries one bit of a 32-bit code in the parity of the choice, so every bit is repeated across sites; sites are anchored to line content, so fragments and merged copies still match. Never touches frontmatter, code fences, inline code, URLs, paths, headings or tables. Short skills get fewer sites (about 10 to 35).
- **canary**: one line of illustrative sample values (a name, a ticket number, an amount) added to the Example section, or a short "Example (illustrative)" section when there is none. It never alters thresholds or instructions, and survives paraphrase as long as the example is kept. A rewrite that drops the example removes it.

`mark` refuses to record a copy whose `review` grade differs from the original. Collusion: merged copies list both recipients at the top (certain while zero-width tags or the canary survive; with wording alone, both usually rank in the top 2-3 of 10). Tardos-style collusion-resistant codes are on the later list. Demo: `node scripts/trace-demo.mjs`.

## Authoring skills

```
my-skill/
  SKILL.md          # required: frontmatter name + description, then instructions
  skill.json        # optional: version, title, summary, category, tags, visibility
  scripts/          # helpers the agent runs (stdlib-only is kindest)
  references/       # long detail the agent reads on demand
  templates/        # fill-in documents
```

Add `evals/evals.json` (tasks plus pass/fail checks) and run `skillhawk eval <dir> --model haiku --runs 3` to see
whether the skill helps. `skillhawk validate <dir>` checks the format and runs the same security scan as the server. Versions are
immutable; bump `version` in `skill.json` to publish a change. Contribution rules for the open-source set are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## API

| Method | Path | Auth |
|---|---|---|
| GET | `/api/skills?q=&scope=&category=` | optional |
| GET | `/api/skills/@{scope}/{name}?version=` | private: org read |
| GET | `/api/skills/@{scope}/{name}/bundle` · `/files/{path}` | private: org read |
| POST | `/api/skills/@{scope}` `{files: {path: base64}, visibility}` | org publish |
| PATCH / DELETE | `/api/skills/@{scope}/{name}` | org publish |
| GET / POST / DELETE | `/api/orgs/{org}/tokens[/{id}]` | org publish |
| GET | `/api/orgs/{org}/events` | org publish |
| POST | `/api/orgs` | admin |
| POST | `/mcp` (JSON-RPC, MCP 2025-06-18) | optional |

## Development

```sh
npm test           # node:test, no dependencies
npm run validate   # validate + scan every bundled skill
npm run build:marketplace
```

MIT licensed. Skills in `registry/public` are MIT; the `seed/orgs` companies are fictional demo data.

Site built following UI Skills by ibelick, MIT.
