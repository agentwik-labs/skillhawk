# Skillyard MVP backlog

Direction (2026-11-12): Skillyard = build, check and protect a company's agent skills. No selling of skills.
Free for developers (agents, token saver, dev loop); companies pay for the vault and leak tracing.
Status: [ ] todo · [~] in progress · [x] done. Lane = who builds it. One lane per worktree, merged into `skillyard-mvp`.

## Week 1: checks developers run today
| ID | Item | Lane | Status |
|---|---|---|---|
| R1 | `skillyard review <dir>`: A-F score per skill, line-level findings, `--fix` for safe fixes, `--json` | review | [x] |
| R2 | Library pass: duplicate skills, overlapping triggers, contradictions | review | [x] |
| R3 | Reviewer shipped as a skill + subagent (plugins/) | review | [x] |
| C1 | `skillyard review --chats`: link session corrections and missed fires to existing skills | chats | [x] |
| C2 | Proposed edits with chat evidence, before/after test, approve/reject; nothing changes without approval | chats | [x] |
| C3 | Privacy: local only, secret/PII redaction, folder exclusions | chats | [x] |
| S1 | `skillyard secure`: skills + packages (MCP configs, hooks, dependencies, remote scripts, broad tool grants) | secure | [x] |
| S2 | Gate mode: non-zero exit on high risk, for CI and publish | secure | [x] |
| S3 | Security shipped as a skill + subagent | secure | [x] |

## Week 2: Token Saver
W1 site rebuilt for vault positioning [x]

| ID | Item | Status |
|---|---|---|
| T1 | `skillyard map`: repo + skill-library graph (use graphify when installed, check its licence before bundling; own lightweight index otherwise) | [x] |
| T2 | Lean loading: descriptions in context, sections served on demand via the MCP server | [x] |
| T3 | Token dashboard: spend per session/skill/repo, tokens saved | [x] |
| T4 | Proof run: 20 tasks with vs without Token Saver, tokens and quality | [ ] |

## Week 3: Vault + protection
| ID | Item | Status |
|---|---|---|
| V1 | Org vault: roles, versions, diffs, rollback, audit log of every pull | [x] |
| V2 | `pull` with lockfile; publish requires Reviewer + Security to pass | [x] |
| P1 | `skillyard mark`: per-person copy (invisible chars, wording choices, content canaries), lift-checked | [x] |
| P2 | `skillyard trace leaked.md`: recipient, version, date, confidence; works on fragments | [x] |
| P3 | Demo video: 10 marked copies, LLM rewrites one, trace finds it (script + real Haiku rewrite traced 2026-11-12 via canary; video not recorded) | [~] |
| P4 | Signed skills, verified on pull (`keys create`, `sign`, `verify`; src/sign.js; vault signs the marked copy at serve time) | [x] |

## Week 4: Optimizer, Creator, Clean Code
| ID | Item | Status |
|---|---|---|
| O1 | `skillyard optimize`: rewrite, lift + trigger tests, keep only better, token report | [x] |
| K1 | `skillyard create`: interview, doc, or session-log draft (extends generate + Studio) | [x] |
| L1 | `skillyard clean`: skill scripts + company coding-standards skill learned from PR comments | [x] |
| D1 | `init`/`test`/trigger tests (`tests/cases.yaml`), `dev` live reload, PR lift-diff comment | [x] |

## Later (after design partners ask)
Leak watch crawler · stronger collusion resistance (merged copies already rank both colluders, src/mark.js) · SSO · Slack alerts for vault events (Studio already posts review proposals to a Slack-compatible webhook, src/studio/engine.js) · VS Code extension · site visitor counter

Shipped since this list was written: offboarding report (`skillyard offboard`, src/offboard.js), model-release regression (`skillyard watch`, src/watch.js), self-hosting (`skillyard serve`, docs/self-hosting.md).

## Follow-ups found while integrating
- Marked copies use U+200D/U+200E, which `scan` does not flag; teach `scan`/`secure` to recognise the Skillyard mark pattern and still flag other invisible characters.
- The vault signs the original; the marked copy it serves does not verify against that signature. Sign the marked copy at serve time.
- Wording marks do not survive an LLM rewrite (0 bits); only the canary did. Add more canary types.

## Stretch: worth paying for (added 2026-11-12)
| ID | Item | Lane | Status |
|---|---|---|---|
| X1 | Savings ledger: tokens saved, corrections and redo turns avoided per skill, in dollars; monthly statement (`skillyard savings`) | measure | [x] |
| X2 | Model-release watch: re-run every skill on a new model, report regressions, draft fixes (`skillyard watch`) | portable | [x] |
| X3 | Revocable skills: stream from the vault over MCP, no files on disk, revoke mid-session; exit-interview agent (`skillyard revoke`, `skillyard exit-interview`) | revoke | [x] |
| X4 | Leaks that call home: harmless per-copy canary link; vault records the fetch (legal review before shipping) | govern | [x] |
| X5 | Evidence pack: signed, timestamped leak report with audit-log chain and a drafted takedown notice (`skillyard evidence`) | govern | [x] |
| X6 | Skill radar: team-wide repeated corrections → drafted, tested skill PR to the owner (`skillyard radar`) | measure | [x] |
| X7 | A/B skills: split sessions between versions, compare correction rates, promote the winner (`skillyard ab`) | measure | [x] |
| X8 | Governance pack: SOC 2 / ISO 42001 / EU AI Act evidence export (`skillyard governance export`) | govern | [x] |
| X9 | Skillyard Verified badge: SVG badge with grade, lift and security for READMEs (`skillyard badge`) | portable | [x] |
| X10 | Write once, run everywhere: compile a skill to Claude, Codex AGENTS.md, Cursor rules, Copilot, Gemini with per-target checks (`skillyard compile`) | portable | [x] |
| X11 | Plans and seats: Free, Pro $20 (1 seat), Team $100 (5 seats, +$20 each), Enterprise; feature gates and pilot billing (src/plans.js, [docs/plans-and-seats.md](docs/plans-and-seats.md)) | govern | [x] |
