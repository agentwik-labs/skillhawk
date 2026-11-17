// skillyard command-line interface.
import { parseArgs } from './args.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createServer } from './server.js';
import { createMcpHandler } from './mcp.js';
import { AGENTS, detectAgents, installBundle, listInstalled, resolveAgents, uninstall, writeAgentsIndex } from './agents.js';
import { loadConfig, RemoteRegistry, saveConfig } from './client.js';
import { scanFiles } from './scan.js';
import { secureCmd, secureScan, formatFinding } from './secure.js';
import { evalSkill, evalMarkdown } from './eval.js';
import { prerenderSite } from './prerender.js';
import { checksum, parseSkillRef, readSkillDir, titleCase, validateFiles, NAME_RE } from './skill.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skillyard.js');
const REPO_ROOT = path.resolve(path.dirname(BIN), '..');
const ADMIN = { admin: true, org: null, scopes: ['read', 'publish', 'admin'], tokenId: 'cli' };

const HELP = `skillyard — a skill registry for AI agents (Claude Code, Codex, Cursor, any AGENTS.md agent)

Using skills
  search [query] [--scope org] [--category c]   Find skills
  info <skill>                                   Show a skill's details and instructions
  install <skill...> [--agent a,b|all] [-g]      Install into agents (default: detected agents, else claude);
                                                 a skill can also be a local folder: ./skills/deploy
                     [--save] [--force]          --save records it in ./skills.json
  uninstall <name...> [--agent a,b|all] [-g]     Remove installed skills
  list [--agent a,b|all] [-g]                    Show installed skills
  update [--agent a,b|all] [-g]                  Reinstall the newest version of every installed skill
  init                                           Create ./skills.json (a project's skill manifest)
  sync [--quiet]                                 Install everything in ./skills.json for its agents
  hooks install [--claude] | hooks remove        Keep skills in sync automatically: git post-merge/post-checkout,
                                                 and with --claude a Claude Code SessionStart hook
  ci [dirs...] [--compare <base-ref>]            Format check + security scan for CI; writes a PR summary;
                                                 --compare adds a review/test table of changed skills vs the base ref
  secure [dir...] [--json out.json] [--gate high|medium]  Audit skills plus MCP configs, hooks, dependencies, remote scripts, tool grants

Connecting agents over MCP
  connect <claude|codex|cursor|vscode|gemini|claude-desktop> [--write]
                                                 Print (or write) the MCP config for an agent
  mcp                                            Run a stdio MCP server against the configured registry
  connect <agent> --stream | mcp --stream        Stream skills from the company vault on demand: no files on disk,
                                                 each response marked and audit-logged, revocable mid-session

Offboarding (org admin)
  revoke --user <member> [--org o]               Disable a member's tokens now; their next call is refused
  offboard <member> [--org o] [--out report.md]  Revoke, then list every skill/version they ever pulled
  exit-interview <member> [--answers a.json] [--from-logs dir] [--out skills/]
                                                 Capture what only they know as checked, private draft skills
  (installed copies of private skills carry a lease, default 7 days; sync removes expired ones)

Studio (learns from your agent logs, with your consent)
  studio [--port 7430]                           Open Studio: correction rate, themes, proposed skill fixes to approve
  studio review [--max 3]                        Run a review now (for a schedule); needs consent given in Studio
  studio find [--all]                            Search the skill library for existing skills that fix waiting proposals
  studio --demo [--reset]                        Try Studio on a fictional team's data (reads nothing of yours)

Token Saver
  map [dir] [--out .skillyard/map] [--update] [--engine builtin|graphify]
                                                 Index a repo + its skills (files, symbols, imports, skills) into map.json + MAP.md
  map query "<question>" [--limit 8] [--json]    Top files/symbols with line numbers, no model; read less, ask the map
  tokens [--days 7] [--logs dir] [--json] [--exclude p]
  savings [--days 30] [--logs dir] [--price-table f] [--rate 100] [--json] [--statement out.md]
                                                 Estimated dollars saved per skill (corrections, redo turns, tokens vs comparable sessions without it)
  radar <dir...> [--team] [--min-people 2] [--days 14] [--branch]
                                                 Repeated corrections across people's logs -> drafted, tested skill in .skillyard/radar/<id>/ (counts only, no push)
  ab <skill> --a <dirA> --b <dirB> [--split 50] | ab hook | ab report <skill> | ab promote <skill>
                                                 A/B two versions of a skill across sessions; z-test; promote B only at p<0.05 and n>=30 per arm
                                                 Token and estimated cost dashboard from Claude Code logs: per day, repo, skill, top sessions

Account
  login --registry <url> [--token <token>]       Save registry URL and token (~/.skillyard/config.json)
  whoami                                         Show who the token belongs to

Authoring
  new <name> [--dir .]                           Scaffold a new skill
  generate [generator] [--from doc.md | --answers a.json] [--out .] [--license MIT]
                                                 Build a skill from a generator: procedure, checklist, voice,
                                                 playbook, decision, metric; --from fills it from your own document
  create [name] [--from doc.md] [--from-chats] [--answers a.json] [--out .] [--allow-model]
                                                 One front door: interview (or doc, or a session-log proposal) -> a
                                                 skill with tests/cases.yaml, then review, secure and test it
  clean scripts <skill-dir...> [--json]          Static review of scripts bundled in skills (error handling, set -e, paths)
  clean standards [repo] [--from-git] [--from-reviews f] [--out skills/coding-standards]
                                                 Learn a coding-standards skill from the repo (and PR review comments)
  kit [dir] [--force]                            Copy the team starter kit (guide, session, review checklist,
                                                 data-handling + definition-of-done skills, CI) into a repo
  keys create --out <dir>                        Make an ed25519 key pair for signing skills
  sign <skill-dir> --key <private.pem>           Write .skillyard-signature.json (the vault signs the marked copy it serves)
  verify <skill-dir> --pub <public.pem>          Check a delivered skill against its signature; exit 1 and name changed files
  test <skill-dir> [--static] [--allow-model] [--model haiku]
                                                 Trigger cases (tests/cases.yaml) scored against sibling/installed skills;
                                                 --allow-model also runs behaviour cases in the confined eval runner
  dev <skill-dir> [--agent claude] [--once]      Watch a skill, re-install on change, rerun review + static test
  watch models [--check --models a,b | --from-file f] [--add m] [--save]   Known models per agent; print new ones (no network; --fetch needs ANTHROPIC_API_KEY)
  watch run <dir...> --model <new> [--baseline <old>] [--threshold 10] --allow-model
                                                 Re-run evals on old and new model, report lift drops, draft fixes to .skillyard/watch/<model>/
  badge <skill-dir> [--out badge.svg] [--lift <pts> | --from-report r.json] [--markdown]   Shields-style SVG: grade, lift (only if given), secure
  compile <skill-dir> --to claude,codex,cursor,copilot,gemini|all [--out dir]   Native format per agent, with size/frontmatter/content-kept checks
  validate <dir...>                              Check skill directories (or folders of them)
  scan <dir...> [--json out.json] [--all]        Security-scan every skill found under the given folders
  review <dir...> [--json out.json] [--fix]      Grade skills A-F with line-level findings; library pass for duplicates,
                                                 overlapping triggers and contradictions; --fix applies safe mechanical fixes
  optimize <skill-dir> [--rounds 3] [--allow-model] [--model haiku] [--out dir] [--apply]
                                                 Cut tokens without losing meaning: static pass (no model), gated by review grade + trigger cases;
                                                 --allow-model adds model rewrites kept only if lift holds; --all <dir> = library table
  eval <dir...> [--agent claude|codex] [--model m] [--runs n] [--tools Skill,Read] [--out report.md]
                                                 Measure lift: run evals/evals.json with and without the skill
  publish <dir> --org <org> [--visibility public|private] [--force]   Org publishes must pass review (>= org minimum, default C) + secure; admin --force is logged
  pull [--org o] [--frozen]                      Install an org's skills into your agents and write skillyard.lock (--frozen = exactly the lock)
  versions <skill>                               Full version history (* = current)
  diff <skill> <v1> <v2>                         Line diff between two versions
  rollback <skill> <version>                     Serve an earlier version again (admin/editor; history kept)
  audit [--org o] [--skill s] [--json]           Append-only log of pulls, publishes, rollbacks (admin only)

Leak tracing
  mark <skill-dir> --recipient alice --version 1.0.0 --secret <s> --out <dir> [--marks marks.json] [--layers zw,wording,canary]
                                                 Write a per-person copy (zero-width tag, wording choices, example canary);
                                                 review grade must match the original; appends the fingerprint to --marks
  trace <leaked.md> --marks marks.json --secret <s> [--json]
                                                 Name the recipient of a leaked copy or fragment, with confidence and evidence
  org settings <org> --beacon on|off --i-have-legal-review   Optional per-copy reference link (off by default; read docs/beacon.md)
  alerts [--org o] [--json]                      Beacon hits: time, recipient, skill, ip, user-agent, referer (admin, local data dir)
  evidence <leaked.md> --org o [--out evidence/] Signed evidence pack: trace, pull history, audit chain, draft takedown (admin)
  evidence verify <dir>                          Check an evidence pack's signature
  audit verify [--data dir]                      Verify the audit log's hash chain
  governance export --org o [--framework soc2|iso42001|euaiact|all] [--out dir]
                                                 Auditor bundle: inventory, approval trail, access, integrity, control mapping (admin)

Running a registry
  serve [--port 7420] [--host 127.0.0.1] [--data ./data] [--log] [--plans enforce] [--trust-proxy] [--rate-limit 300]
                                                 --plans enforce (or SKILLYARD_PLANS=enforce): seat limits and plan gates
                                                 for a hosted vault; STRIPE_* env vars turn on checkout (docs/plans-and-seats.md)
  seed [--data ./data] [--community]             Load registry/public and seed/orgs demo content (+ free public skills)
  import <owner/repo...> [--scope community] [--data ./data]
                                                 Import openly licensed skills from public GitHub repos (scanned,
                                                 licence kept, source recorded); no args = sources/community.json
  org create <slug> [--name "Acme"] [--data ./data]
  org key <org> > org.pem                        The org's public key; verify a pulled copy with: verify <dir> --pub org.pem
  org billing <org> [--data ./data] [--json]     Plan, seats used / purchased, billing status, enforcement mode
  org plan <org> --plan pro|team|enterprise [--seats n] [--status active|pilot|past_due|canceled] [--pilot-ends date]
                                                 Operator: set an org's plan (server-admin token, or --data with the server stopped)
  token create --org <org> [--role admin|editor|reader | --scopes read,publish] [--name n] [--service] [--data ./data]
                                                 One seat per distinct --name; --service (CI, bots) takes no seat, reads public skills only
  token list --org <org> | token revoke <id>
  export site --out <dir> [--data ./data] [--site-url u]  Static read-only demo of a registry (for GitHub Pages)
  export claude-marketplace --out <dir> [--from <dir> | --scope <org>]
                                                 Build a Claude Code plugin marketplace from skills

Env: SKILLYARD_REGISTRY, SKILLYARD_TOKEN, SKILLYARD_ADMIN_TOKEN (server), SKILLYARD_DATA (server data dir)
`;

export async function main(argv) {
  const { _: args, ...flags } = parseArgs(argv);
  const cmd = args.shift();
  const cmds = {
    serve,
    seed,
    org,
    token,
    login,
    whoami,
    search,
    info,
    install,
    uninstall: uninstallCmd,
    list,
    update,
    init,
    sync: (a, f) => import('./lease.js').then((m) => m.syncWithLeases(a, f, sync)),
    new: async (a, f) => { await scaffold(a, f); (await import('./devloop.js')).addCasesStub(path.resolve(f.dir || '.', a[0])); },
    keys: (a, f) => import('./sign.js').then((m) => m.keysCmd(a, f)),
    sign: (a, f) => import('./sign.js').then((m) => m.signCmd(a, f)),
    verify: (a, f) => import('./sign.js').then((m) => m.verifyCmd(a, f)),
    test: (a, f) => import('./devloop.js').then((m) => m.testCmd(a, f)),
    dev: (a, f) => import('./devloop.js').then((m) => m.devCmd(a, f)),
    kit,
    studio,
    import: importCmd,
    hooks,
    ci,
    secure: secureCmd,
    generate: generateCmd,
    validate,
    scan: scanCmd,
    optimize: (a, f) => import('./optimize.js').then((m) => m.run(a, f)),
    create: (a, f) => import('./create.js').then((m) => m.createCmd(a, f)),
    review: (a, f) => import('./review.js').then((m) => m.run(a, f)),
    eval: evalCmd,
    map: (a, f) => import('./map.js').then((m) => m.run(a, f)),
    tokens: (a, f) => import('./tokens.js').then((m) => m.run(a, f)),
    publish: (a, f) => import('./vault-cli.js').then((m) => m.publish(a, f)),
    pull: (a, f) => import('./vault-cli.js').then((m) => m.pull(a, f)),
    versions: (a, f) => import('./vault-cli.js').then((m) => m.versions(a, f)),
    diff: (a, f) => import('./vault-cli.js').then((m) => m.diff(a, f)),
    rollback: (a, f) => import('./vault-cli.js').then((m) => m.rollback(a, f)),
    audit: (a, f) => (a[0] === 'verify' ? import('./evidence.js').then((m) => m.auditVerifyCmd(a, f)) : import('./vault-cli.js').then((m) => m.audit(a, f))),
    connect: (a, f) => (f.stream ? import('./stream.js').then((m) => m.connectStream(a, f)) : connect(a, f)),
    mcp: (a, f) => (f.stream ? import('./stream.js').then((m) => m.mcpStdio()) : mcp()),
    export: exportCmd,
    watch: (a, f) => import('./watch.js').then((m) => m.run(a, f)),
    badge: (a, f) => import('./badge.js').then((m) => m.run(a, f)),
    compile: (a, f) => import('./compile.js').then((m) => m.run(a, f)),
    savings: (a, f) => import('./savings.js').then((m) => m.run(a, f)),
    radar: (a, f) => import('./radar.js').then((m) => m.run(a, f)),
    ab: (a, f) => import('./ab.js').then((m) => m.run(a, f)),
    governance: (a, f) => import('./governance.js').then((m) => m.governanceCmd(a, f)),
    alerts: (a, f) => import('./beacon.js').then((m) => m.alertsCmd(a, f)),
    offboard: (a, f) => import('./offboard.js').then((m) => m.offboardCmd(a, f)),
    'exit-interview': (a, f) => import('./exit-interview.js').then((m) => m.exitInterviewCmd(a, f)),
    clean: (a, f) => import('./clean.js').then((m) => m.run(a, f)),
    mark: (a, f) => import('./mark.js').then((m) => m.run(a, f)),
    trace: (a, f) => import('./mark.js').then((m) => m.traceCmd(a, f)),
    revoke: (a, f) => import('./offboard.js').then((m) => m.revokeCmd(a, f)),
    evidence: (a, f) => import('./evidence.js').then((m) => m.evidenceCmd(a, f)),
  };
  if (!cmd || cmd === 'help' || flags.help) return void process.stdout.write(HELP);
  if (cmd === '--version' || cmd === 'version') return void console.log('0.1.0');
  if (!cmds[cmd]) throw new Error(`unknown command "${cmd}". Run skillyard help.`);
  await cmds[cmd](args, flags);
}

const HAND_WRITTEN_PLUGINS = ['review', 'security', 'create', 'optimize', 'tokensaver', 'clean'];
const dataDir = (f) => f.data || process.env.SKILLYARD_DATA || 'data';
const registry = () => new RemoteRegistry(loadConfig());

// ---- server ---------------------------------------------------------------

async function serve(_args, f) {
  const port = Number(f.port || process.env.PORT || 7420);
  const host = f.host || process.env.HOST || '127.0.0.1';
  const allowedOrigins = (process.env.SKILLYARD_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const server = createServer({
    dataDir: dataDir(f), allowedOrigins, log: !!f.log, plans: f.plans || process.env.SKILLYARD_PLANS || 'off',
    trustProxy: !!f.trustProxy || process.env.SKILLYARD_TRUST_PROXY === '1',
    rateLimit: Number(f.rateLimit ?? process.env.SKILLYARD_RATE_LIMIT ?? 300),
  });
  // Docker stop sends SIGTERM; close cleanly so in-flight writes finish.
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
  const stats = server.store.stats({ admin: true, scopes: ['read'] });
  await new Promise((r) => server.listen(port, host, r));
  console.log(`skillyard registry on http://${host}:${port}  (${stats.skills} skills, data: ${server.store.dataDir})`);
  console.log(`  web: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}   mcp: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/mcp`);
  if (!stats.skills) console.log('  registry is empty: run `skillyard seed` to load the bundled skills');
}

async function seed(_args, f) {
  const store = new Store(dataDir(f));
  const report = [];
  const ensureOrg = (o) => store.getOrg(o.slug) || store.createOrg(o);
  const publishDir = (scope, dir, defaultVisibility) => {
    const files = readSkillDir(dir);
    const v = validateFiles(files);
    if (!v.ok) { report.push(`  skip ${dir}: ${v.errors.join('; ')}`); return 0; }
    const existing = store.db.skills[`@${scope}/${v.manifest.name}`];
    if (existing?.versions[v.manifest.version]) return 0;
    store.publish({ scope, files, visibility: v.manifest.visibility || defaultVisibility, auth: ADMIN, publishedBy: 'seed' });
    return 1;
  };
  const skillDirs = (root) => (fs.existsSync(root) ? fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.existsSync(path.join(d, 'SKILL.md'))) : []);

  ensureOrg({ slug: 'skillyard', name: 'Skillyard Community', description: 'Open-source skills maintained by the community.', website: 'https://github.com/agentwik-labs/skillyard' });
  let n = 0;
  for (const d of skillDirs(path.join(REPO_ROOT, 'registry', 'public'))) n += publishDir('skillyard', d, 'public');
  report.unshift(`@skillyard: ${n} new skill version(s)`);

  const tokens = {};
  const orgRoot = path.join(REPO_ROOT, 'seed', 'orgs');
  for (const slug of fs.existsSync(orgRoot) ? fs.readdirSync(orgRoot) : []) {
    const orgFile = path.join(orgRoot, slug, 'org.json');
    if (!fs.existsSync(orgFile)) continue;
    const meta = JSON.parse(fs.readFileSync(orgFile, 'utf8'));
    const fresh = !store.getOrg(meta.slug);
    ensureOrg(meta);
    let c = 0;
    for (const d of skillDirs(path.join(orgRoot, slug, 'skills'))) c += publishDir(meta.slug, d, 'private');
    report.push(`@${meta.slug}: ${c} new skill version(s)`);
    if (fresh) tokens[meta.slug] = store.createToken({ org: meta.slug, name: 'demo', scopes: ['read', 'publish'] }).token;
  }
  if (Object.keys(tokens).length) {
    const p = path.join(store.dataDir, 'demo-tokens.json');
    const prev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    fs.writeFileSync(p, JSON.stringify({ ...prev, ...tokens }, null, 2), { mode: 0o600 });
    report.push(`demo org tokens (read+publish) saved to ${p}:`);
    for (const [o, t] of Object.entries(tokens)) report.push(`  ${o}: ${t}`);
  }
  console.log(report.join('\n'));
  if (f.community) await importCmd([], f);
}

async function generateCmd(args, f) {
  const { GENERATORS, answersFromDocument, buildSkill } = await import('./generate.js');
  const id = args[0];
  if (!id) {
    console.log('Generators:\n');
    for (const g of GENERATORS) console.log(`  ${g.id.padEnd(10)} ${g.title}\n             ${g.summary}\n`);
    console.log('skillyard generate <generator> --from <document.md>   or   --answers <answers.json>');
    return;
  }
  if (!GENERATORS.some((g) => g.id === id)) throw new Error(`unknown generator "${id}" (run skillyard generate to list them)`);
  let answers;
  if (f.answers) answers = JSON.parse(fs.readFileSync(f.answers, 'utf8'));
  else if (f.from) {
    console.log(`reading ${f.from} and filling the ${id} generator…`);
    answers = await answersFromDocument(id, fs.readFileSync(f.from, 'utf8'), { model: f.model || 'sonnet', hint: f.hint });
  } else throw new Error('give --from <document> or --answers <file.json>');
  const r = buildSkill(id, answers, { license: f.license || 'Proprietary', author: f.author || '' });
  const dir = path.resolve(f.out || '.', r.name);
  if (fs.existsSync(dir) && !f.force) throw new Error(`${dir} exists (use --force)`);
  for (const [rel, text] of Object.entries(r.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.writeFileSync(path.join(dir, 'generator-answers.json'), `${JSON.stringify(answers, null, 2)}\n`);
  const notes = [...r.errors, ...r.missing.map((m) => `missing: ${m}`), ...r.scan.map((x) => `${x.severity}: ${x.message}`), ...r.warnings];
  console.log(`${r.valid ? 'created' : 'created with problems'} ${tilde(dir)}${notes.map((n) => `\n  - ${n}`).join('')}`);
  console.log(`\nnext:\n  read ${tilde(path.join(dir, 'SKILL.md'))}\n${r.files['evals/evals.json'] ? `  skillyard eval ${tilde(dir)} --model haiku --runs 2\n` : ''}  skillyard install ${tilde(dir)} --agent claude,codex`);
}

async function hooks(args, f) {
  const { installHooks, removeHooks } = await import('./hooks.js');
  if (args[0] === 'install') {
    const done = installHooks({ claude: !!f.claude });
    console.log(`installed: ${done.join(', ')}\nskills now re-sync after git pull and branch switches${f.claude ? ', and when a Claude Code session starts' : ''}`);
  } else if (args[0] === 'remove') {
    const done = removeHooks();
    console.log(done.length ? `removed skillyard from: ${done.join(', ')}` : 'nothing to remove');
  } else throw new Error('usage: skillyard hooks install [--claude] | hooks remove');
}

/** CI gate: validate + scan every skill under the given folders; markdown summary to $GITHUB_STEP_SUMMARY. */
async function ci(args, f = {}) {
  const roots = args.length ? args : ['skills', '.claude/skills'].filter((d) => fs.existsSync(d));
  const dirs = [];
  const walk = (d, depth) => {
    if (depth > 6 || !fs.existsSync(d)) return;
    if (fs.existsSync(path.join(d, 'SKILL.md'))) { dirs.push(d); return; }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  const rows = [];
  let failed = 0;
  for (const d of dirs) {
    const files = readSkillDir(d);
    const v = validateFiles(files);
    const s = scanFiles(files);
    const bad = !v.ok || s.critical > 0;
    if (bad) failed++;
    const notes = [...v.errors, ...s.findings.map((x) => `${x.severity}: ${x.file}:${x.line} ${x.message}`), ...v.warnings].slice(0, 4);
    rows.push(`| ${bad ? '❌' : notes.length ? '⚠️' : '✅'} | \`${d}\` | ${notes.map((n) => n.replace(/\|/g, '\\|')).join('<br>') || 'clean'} |`);
    console.log(`${bad ? 'FAIL' : notes.length ? 'warn' : 'ok  '} ${d}${notes.map((n) => `\n     - ${n}`).join('')}`);
  }
  const pk = secureScan(args.length ? args : ['.'], { skills: false });
  for (const x of pk.findings.filter((x) => x.severity !== 'low')) console.log(`${x.severity === 'high' ? 'FAIL' : 'warn'} ${formatFinding(x).replace(/\n\s+/, ' ')}`);
  if (pk.high) failed += pk.high;
  const md = [`### Skillyard: ${dirs.length} skill(s) checked, ${failed} failing${pk.findings.length ? `; packages: ${pk.high} high, ${pk.medium} medium` : ''}`, '', '| | Skill | Findings |', '|---|---|---|', ...rows, ''].join('\n');
  let out = md;
  if (f.compare && f.compare !== true) {
    const cmp = (await import('./devloop.js')).compareMarkdown(dirs, f.compare);
    console.log(`\n${cmp}`);
    out += `\n${cmp}`;
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
  if (!dirs.length) console.log('no skills found');
  if (failed) process.exitCode = 1;
}

async function importCmd(args, f) {
  const { importSource } = await import('./importer.js');
  const store = new Store(dataDir(f));
  const scope = f.scope || 'community';
  if (!store.getOrg(scope)) store.createOrg({ slug: scope, name: scope === 'community' ? 'Community (imported)' : scope, description: 'Openly licensed skills imported from public repositories, with their licences and sources.' });
  const list = args.length ? args : JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'sources', 'community.json'), 'utf8')).sources;
  let total = 0;
  for (const src of list) {
    try {
      const r = importSource(store, src, { scope, auth: ADMIN });
      total += r.imported.length;
      const reasons = {};
      for (const x of r.skipped) { const k = x.reason.replace(/ of .*| from .*/, ''); reasons[k] = (reasons[k] || 0) + 1; }
      console.log(`${src}: ${r.imported.length} imported, ${r.unchanged} unchanged, ${r.skipped.length} skipped${r.skipped.length ? ` (${Object.entries(reasons).map(([k, n]) => `${n} ${k}`).join('; ')})` : ''}`);
    } catch (e) {
      console.log(`${src}: failed (${e.message})`);
    }
  }
  console.log(`\n${total} skill version(s) imported into @${scope}`);
}

async function org(args, f) {
  const sub = args.shift();
  if (sub === 'settings') return (await import('./beacon.js')).orgSettings(args, f);
  if (sub === 'billing' || sub === 'plan') return orgPlan(sub, args, f);
  if (sub === 'key') {
    // Public key that signs every copy the vault serves: skillyard org key acme > org.pem; skillyard verify <dir> --pub org.pem
    if (!args[0]) throw new Error('usage: skillyard org key <org> > org.pem');
    const { RemoteRegistry, loadConfig } = await import('./client.js');
    const cfg = loadConfig();
    const o = f.data ? new Store(dataDir(f)).getOrg(args[0]) : await new RemoteRegistry({ registry: f.registry || process.env.SKILLYARD_REGISTRY || cfg.registry, token: cfg.token }).request('GET', `/api/orgs/${args[0]}`);
    if (!o?.publicKey) throw new Error(`@${args[0]} has no public key`);
    return process.stdout.write(o.publicKey);
  }
  if (sub !== 'create' || !args[0]) throw new Error('usage: skillyard org create <slug> [--name "Acme"] [--description ...]');
  const store = new Store(dataDir(f));
  const o = store.createOrg({ slug: args[0], name: f.name, description: f.description || '', website: f.website || '' });
  const t = store.createToken({ org: o.slug, name: 'owner', role: 'admin' });
  console.log(`created org @${o.slug}\nowner token (admin), shown once:\n  ${t.token}`);
}

/**
 * org billing <org> | org plan <org> --plan team --seats 7 [--status active] [--pilot-ends <date>] [--period-end <date>]
 * With --data: edits that data dir directly (stop the server first, or it overwrites the change on its next save).
 * Otherwise: calls the configured registry (skillyard login) with a server-admin token.
 */
async function orgPlan(sub, args, f) {
  const slug = args[0];
  if (!slug) throw new Error(`usage: skillyard org ${sub} <org>${sub === 'plan' ? ' --plan free|pro|team|enterprise [--seats n] [--status pilot|active|past_due|canceled] [--pilot-ends <date>]' : ''}`);
  const patch = { plan: f.plan, seats: f.seats === undefined ? undefined : Number(f.seats), status: f.status, pilotEndsAt: f.pilotEnds, periodEnd: f.periodEnd };
  let st;
  if (f.data) {
    const store = new Store(dataDir(f));
    st = sub === 'plan' ? store.setPlan(slug, patch, { name: 'cli' }) : store.billingState(slug);
  } else {
    const { RemoteRegistry, loadConfig } = await import('./client.js');
    const cfg = loadConfig();
    const reg = new RemoteRegistry({ registry: f.registry || process.env.SKILLYARD_REGISTRY || cfg.registry, token: f.token || process.env.SKILLYARD_TOKEN || cfg.token });
    st = sub === 'plan' ? await reg.request('PATCH', `/api/orgs/${slug}/plan`, patch) : await reg.request('GET', `/api/orgs/${slug}/billing`);
  }
  if (f.json) return console.log(JSON.stringify(st, null, 2));
  const price = st.monthlyUsd === null ? 'custom price' : `$${st.monthlyUsd}/month`;
  console.log(`@${st.org}: ${st.planName}, ${st.seatsUsed} of ${st.seats} seats used, ${price}`);
  console.log(`billing: ${st.status || 'none'}${st.pilotEndsAt ? `, pilot ends ${st.pilotEndsAt.slice(0, 10)}` : ''}${st.periodEnd ? `, period ends ${st.periodEnd.slice(0, 10)}` : ''}; access ${st.access}; enforcement ${st.enforcement}`);
  if (st.seatsUsed > st.seats) console.log('over the limit: new members are blocked until seats are added or members revoked');
}

async function token(args, f) {
  const sub = args.shift();
  const store = new Store(dataDir(f));
  if (sub === 'create') {
    if (!f.org && !f.admin) throw new Error('usage: skillyard token create --org <org> [--scopes read,publish] | --admin');
    const scopes = f.admin ? ['admin', 'read', 'publish'] : String(f.scopes || 'read').split(',');
    const t = store.createToken({ org: f.admin ? null : f.org, name: f.name || 'token', kind: f.service ? 'service' : 'member', ...(f.role ? { role: f.role } : { scopes }) }, { name: 'cli' });
    console.log(`token ${t.id} (${t.scopes.join(',')}${t.org ? ` for @${t.org}` : ', admin'}${t.kind === 'service' ? ', service: no seat, public skills only' : ''}), shown once:\n  ${t.token}`);
  } else if (sub === 'list') {
    for (const t of store.listTokens(f.org || null)) console.log(`${t.id}  ${t.name.padEnd(16)} ${t.scopes.join(',').padEnd(14)} created ${t.createdAt.slice(0, 10)}  last used ${t.lastUsedAt?.slice(0, 10) || 'never'}`);
  } else if (sub === 'revoke' && args[0]) {
    store.revokeToken(args[0]);
    console.log(`revoked ${args[0]}`);
  } else throw new Error('usage: skillyard token create|list|revoke');
}

// ---- account --------------------------------------------------------------

async function login(_args, f) {
  const cur = loadConfig();
  const cfg = { registry: (f.registry || cur.registry).replace(/\/+$/, ''), token: f.token === true ? null : (f.token || cur.token) };
  const who = await new RemoteRegistry(cfg).request('GET', '/api/whoami');
  const p = saveConfig(cfg);
  console.log(`saved ${p}\nregistry ${cfg.registry} — ${describeAuth(who)}`);
}

async function whoami() {
  const cfg = loadConfig();
  const who = await new RemoteRegistry(cfg).request('GET', '/api/whoami');
  console.log(`registry ${cfg.registry} — ${describeAuth(who)}`);
}

const describeAuth = (w) => (w.anonymous ? 'anonymous (public skills only)' : w.admin ? 'admin' : `@${w.org} (${w.scopes.join(', ')})`);

// ---- browsing -------------------------------------------------------------

async function search(args, f) {
  const results = await registry().search({ q: args.join(' '), scope: f.scope, category: f.category, limit: f.limit || 50 });
  if (!results.length) return console.log('no skills found');
  const w = Math.max(...results.map((r) => r.id.length));
  for (const s of results) console.log(`${s.id.padEnd(w)}  ${s.visibility === 'private' ? 'private ' : '        '}${s.category.padEnd(12)} ${s.summary}`);
}

async function info(args) {
  const ref = mustRef(args[0]);
  const s = await registry().get(ref.scope, ref.name, ref.version);
  console.log(`${s.id}@${s.version}  ${s.visibility}  ${s.category}  ${s.license || ''}
${s.title} — ${s.summary}
tags: ${s.tags.join(', ') || '-'}   versions: ${s.versions.join(', ')}   downloads: ${s.downloads}
files: ${s.files.join(', ')}
install: npx skillyard install ${s.scope === 'skillyard' ? s.name : s.id}

${s.skillMd}`);
}

function mustRef(r) {
  const ref = parseSkillRef(r);
  if (!ref) throw new Error(`invalid skill "${r || ''}" (use name, @org/name or @org/name@version)`);
  return ref;
}

// ---- install --------------------------------------------------------------

function pickAgents(f) {
  if (f.agent) return resolveAgents(f.agent);
  const detected = detectAgents(process.cwd());
  return detected.length ? detected : ['claude'];
}

async function install(args, f) {
  if (!args.length) throw new Error('usage: skillyard install <skill...> [--agent claude,codex,cursor,agents|all] [-g]');
  const agents = pickAgents(f);
  const reg = registry();
  for (const r of args) {
    if (isLocalSkill(r)) {
      const b = localBundle(r);
      for (const a of agents) console.log(`installed ${b.name}@${b.version} (local) for ${AGENTS[a].label} → ${tilde(installBundle(a, b, { global: !!f.global, force: !!f.force }))}`);
      continue;
    }
    const ref = mustRef(r);
    const b = await reg.bundle(ref.scope, ref.name, ref.version);
    for (const a of agents) {
      const dir = installBundle(a, b, { global: !!f.global, force: !!f.force });
      console.log(`installed ${b.id}@${b.version} for ${AGENTS[a].label} → ${tilde(dir)}`);
    }
    if (f.save) {
      const m = readManifest() || newManifest(agents);
      m.skills[ref.scope === 'skillyard' ? ref.name : `@${ref.scope}/${ref.name}`] = ref.version === 'latest' ? `^${b.version}` : ref.version;
      writeManifest(m);
    }
  }
}

const isLocalSkill = (p) => /^[./~]/.test(p) && fs.existsSync(path.join(p, 'SKILL.md'));

/** Build an install bundle from a skill folder on disk (validated and scanned like a publish). */
function localBundle(dir) {
  const files = readSkillDir(dir);
  for (const k of Object.keys(files)) if (k.startsWith('evals/')) delete files[k];
  const v = validateFiles(files);
  const s = scanFiles(files);
  if (!v.ok) throw new Error(`${dir}: ${v.errors.join('; ')}`);
  if (s.critical) throw new Error(`${dir}: security scan blocked install: ${s.findings.filter((x) => x.severity === 'critical').map((x) => `${x.file}:${x.line} ${x.message}`).join('; ')}`);
  const scope = 'local';
  return {
    id: `@${scope}/${v.manifest.name}`, scope, name: v.manifest.name, version: v.manifest.version, checksum: checksum(files),
    files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, b.toString('base64')])),
  };
}

async function kit(args, f) {
  const dest = path.resolve(args[0] || '.');
  const src = path.join(REPO_ROOT, 'starter-kit');
  const copied = [];
  const skipped = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { walk(r); continue; }
      const target = path.join(dest, r === 'README.md' ? 'SKILLS-README.md' : r);
      if (fs.existsSync(target) && !f.force) { skipped.push(r); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(src, r), target);
      copied.push(path.relative(process.cwd(), target) || target);
    }
  };
  walk('');
  console.log(`copied ${copied.length} file(s):\n  ${copied.join('\n  ')}`);
  if (skipped.length) console.log(`kept your existing ${skipped.join(', ')} (use --force to overwrite)`);
  console.log('\nnext: read SKILLS-README.md, run the kickoff in SESSION.md, fill the TODOs in skills/data-handling');
}

async function uninstallCmd(args, f) {
  const agents = f.agent ? resolveAgents(f.agent) : Object.keys(AGENTS);
  for (const name of args) {
    const ref = mustRef(name);
    let any = false;
    for (const a of agents) if (uninstall(a, ref.name, { global: !!f.global })) { any = true; console.log(`removed ${ref.name} from ${AGENTS[a].label}`); }
    if (!any) console.log(`${ref.name} is not installed`);
    const m = readManifest();
    if (m) {
      delete m.skills[name];
      delete m.skills[`@${ref.scope}/${ref.name}`];
      writeManifest(m);
    }
  }
}

async function list(_args, f) {
  const agents = f.agent ? resolveAgents(f.agent) : Object.keys(AGENTS);
  let n = 0;
  for (const a of agents) {
    const items = listInstalled(a, { global: !!f.global });
    if (!items.length) continue;
    console.log(`${AGENTS[a].label}${f.global && !AGENTS[a].projectOnly ? ' (global)' : ''}:`);
    for (const s of items) console.log(`  ${s.id}@${s.version}  ${tilde(s.dir)}`);
    n += items.length;
  }
  if (!n) console.log(`no skills installed${f.global ? ' globally' : ' in this project'} (try -g, or skillyard install <skill>)`);
}

async function update(_args, f) {
  const agents = f.agent ? resolveAgents(f.agent) : Object.keys(AGENTS);
  const reg = registry();
  for (const a of agents) {
    for (const s of listInstalled(a, { global: !!f.global })) {
      const ref = parseSkillRef(s.id);
      const b = await reg.bundle(ref.scope, ref.name, 'latest');
      if (b.checksum === s.checksum) continue;
      installBundle(a, b, { global: !!f.global, force: true });
      console.log(`updated ${s.id} ${s.version} → ${b.version} (${AGENTS[a].label})`);
    }
  }
  console.log('up to date');
}

const MANIFEST = 'skills.json';
const newManifest = (agents) => ({ $schema: 'https://skillyard.dev/schema/skills.json', registry: loadConfig().registry, agents, skills: {} });
const readManifest = () => (fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null);
const writeManifest = (m) => fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);

async function init(_args, f) {
  if (readManifest()) return console.log('skills.json already exists');
  writeManifest(newManifest(pickAgents(f)));
  console.log('created skills.json — add skills with: skillyard install <skill> --save');
}

async function sync(_args, f) {
  if (f.quiet) { const log = console.log; console.log = () => {}; try { return await syncInner(f); } finally { console.log = log; } }
  return syncInner(f);
}

async function syncInner(f) {
  const m = readManifest();
  if (!m) throw new Error('no skills.json here (run skillyard init)');
  const cfg = loadConfig();
  const reg = new RemoteRegistry({ registry: process.env.SKILLYARD_REGISTRY || m.registry || cfg.registry, token: cfg.token });
  const agents = f.agent ? resolveAgents(f.agent) : resolveAgents((m.agents || ['claude']).join(','));
  for (const [r, spec] of Object.entries(m.skills || {})) {
    const ref = mustRef(r);
    const b = await reg.bundle(ref.scope, ref.name, spec);
    for (const a of agents) {
      const have = listInstalled(a).find((s) => s.id === b.id);
      if (have?.checksum === b.checksum) continue;
      installBundle(a, b, { force: !!f.force });
      console.log(`installed ${b.id}@${b.version} for ${AGENTS[a].label}`);
    }
  }
  for (const dir of m.local || []) {
    const b = localBundle(dir);
    for (const a of agents) {
      if (listInstalled(a).find((x) => x.id === b.id)?.checksum === b.checksum) continue;
      installBundle(a, b, { force: !!f.force });
      console.log(`installed ${b.name}@${b.version} (local) for ${AGENTS[a].label}`);
    }
  }
  if (agents.includes('agents')) writeAgentsIndex(process.cwd());
  console.log(`synced ${Object.keys(m.skills || {}).length + (m.local || []).length} skill(s) for ${agents.join(", ")}`);
}

// ---- MCP --------------------------------------------------------------------

async function mcp() {
  const handle = createMcpHandler(registry(), { root: process.cwd() });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const res = await handle(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
  await new Promise((r) => rl.on('close', r));
}

async function connect(args, f) {
  const agent = args[0];
  const cfg = loadConfig();
  const url = `${cfg.registry}/mcp`;
  const fromCheckout = !BIN.includes(`${path.sep}node_modules${path.sep}`);
  const stdio = fromCheckout ? { command: 'node', args: [BIN, 'mcp'] } : { command: 'npx', args: ['-y', 'skillyard', 'mcp'] };
  const tokenNote = cfg.token
    ? 'Your token is read from the SKILLYARD_TOKEN environment variable; export it in your shell profile:\n  export SKILLYARD_TOKEN=<your token>'
    : 'No token configured: only public skills will be visible. Run `skillyard login --token ...` for private skills.';
  const configs = {
    claude: () => {
      const cmd = ['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'skillyard', url];
      if (cfg.token) cmd.push('--header', `Authorization: Bearer ${cfg.token}`);
      if (f.write) {
        const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
        if (r.error) throw new Error('`claude` not found on PATH; run the command below by hand');
        return null;
      }
      return `Run:\n  ${cmd.map(shq).join(' ')}\n\nOr, for a project, add to .mcp.json (commit-safe, token from env):\n${JSON.stringify({ mcpServers: { skillyard: { type: 'http', url, headers: { Authorization: 'Bearer ${SKILLYARD_TOKEN}' } } } }, null, 2)}`;
    },
    codex: () => {
      const file = path.join(os.homedir(), '.codex', 'config.toml');
      const block = `\n[mcp_servers.skillyard]\nurl = "${url}"\n${cfg.token ? 'bearer_token_env_var = "SKILLYARD_TOKEN"\n' : ''}`;
      const alt = `\n# or, over stdio:\n# [mcp_servers.skillyard]\n# command = "${stdio.command}"\n# args = ${JSON.stringify(stdio.args)}\n# env = { SKILLYARD_REGISTRY = "${cfg.registry}" }\n`;
      if (f.write) return appendToml(file, block);
      return `Add to ${tilde(file)}:\n${block}${alt}\n${tokenNote}`;
    },
    cursor: () => writeOrPrintJson(path.join(process.cwd(), '.cursor', 'mcp.json'), ['mcpServers', 'skillyard'],
      { url, ...(cfg.token ? { headers: { Authorization: 'Bearer ${env:SKILLYARD_TOKEN}' } } : {}) }, f.write, tokenNote),
    vscode: () => writeOrPrintJson(path.join(process.cwd(), '.vscode', 'mcp.json'), ['servers', 'skillyard'],
      { type: 'http', url, ...(cfg.token ? { headers: { Authorization: 'Bearer ${env:SKILLYARD_TOKEN}' } } : {}) }, f.write, tokenNote),
    gemini: () => writeOrPrintJson(path.join(os.homedir(), '.gemini', 'settings.json'), ['mcpServers', 'skillyard'],
      { httpUrl: url, ...(cfg.token ? { headers: { Authorization: 'Bearer $SKILLYARD_TOKEN' } } : {}) }, f.write, tokenNote),
    'claude-desktop': () => {
      const file = process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
      return writeOrPrintJson(file, ['mcpServers', 'skillyard'],
        { ...stdio, env: { SKILLYARD_REGISTRY: cfg.registry, ...(cfg.token ? { SKILLYARD_TOKEN: cfg.token } : {}) } }, f.write, '');
    },
  };
  if (!configs[agent]) throw new Error(`usage: skillyard connect <${Object.keys(configs).join('|')}> [--write]`);
  const out = configs[agent]();
  if (out) console.log(out);
}

function writeOrPrintJson(file, keyPath, value, write, note) {
  if (!write) {
    const obj = {};
    obj[keyPath[0]] = { [keyPath[1]]: value };
    return `Add to ${tilde(file)}:\n${JSON.stringify(obj, null, 2)}${note ? `\n\n${note}` : ''}`;
  }
  const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
  cur[keyPath[0]] = { ...(cur[keyPath[0]] || {}), [keyPath[1]]: value };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cur, null, 2)}\n`);
  return `wrote skillyard MCP server to ${tilde(file)}${note ? `\n${note}` : ''}`;
}

function appendToml(file, block) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\[mcp_servers\.skillyard\]/m.test(cur)) return `${tilde(file)} already has [mcp_servers.skillyard]; edit it by hand`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, cur + block);
  return `added [mcp_servers.skillyard] to ${tilde(file)}`;
}

// ---- authoring ------------------------------------------------------------

async function scaffold(args, f) {
  const name = args[0];
  if (!name || !NAME_RE.test(name)) throw new Error('usage: skillyard new <lowercase-hyphenated-name>');
  const dir = path.resolve(f.dir || '.', name);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${name}
description: TODO what this skill does and when to use it. Include the phrases a user would say, e.g. "review this", "draft the release notes".
license: MIT
---

# ${titleCase(name)}

TODO one paragraph: the job, and what good looks like.

## Workflow

1. TODO
2. TODO
3. TODO

## Rules

- TODO a rule, and why it exists.

## Output

TODO exactly what the agent should produce. Put long detail in references/ and link it, e.g. [details](references/details.md).
`);
  fs.writeFileSync(path.join(dir, 'references', 'details.md'), '# Details\n\nTODO\n');
  fs.writeFileSync(path.join(dir, 'skill.json'), `${JSON.stringify({
    name, version: '0.1.0', title: titleCase(name), summary: 'TODO one sentence for the registry card', category: 'engineering', tags: [], license: 'MIT', author: '',
  }, null, 2)}\n`);
  console.log(`created ${dir}\nedit SKILL.md, then: skillyard validate ${path.relative(process.cwd(), dir) || '.'} && skillyard publish ${path.relative(process.cwd(), dir) || '.'} --org <org>`);
}

async function validate(args) {
  const dirs = [];
  for (const a of args.length ? args : ['.']) {
    if (fs.existsSync(path.join(a, 'SKILL.md'))) dirs.push(a);
    else if (fs.existsSync(a) && fs.statSync(a).isDirectory()) {
      for (const d of fs.readdirSync(a)) if (fs.existsSync(path.join(a, d, 'SKILL.md'))) dirs.push(path.join(a, d));
    }
  }
  if (!dirs.length) throw new Error('no skill directories found');
  let bad = 0;
  for (const d of dirs) {
    const files = readSkillDir(d);
    const v = validateFiles(files);
    const scan = scanFiles(files);
    for (const x of scan.findings) (x.severity === 'critical' ? v.errors : v.warnings).push(`security: ${x.file}:${x.line} ${x.message} [${x.rule}]`);
    if (scan.critical) v.ok = false;
    if (v.manifest && path.basename(path.resolve(d)) !== v.manifest.name) v.warnings.push(`directory name differs from skill name "${v.manifest.name}"`);
    const tag = v.ok ? (v.warnings.length ? 'warn' : 'ok  ') : 'FAIL';
    if (!v.ok) bad++;
    console.log(`${tag} ${d}${[...v.errors, ...v.warnings].map((m) => `\n     - ${m}`).join('')}`);
  }
  console.log(`\n${dirs.length - bad}/${dirs.length} valid`);
  if (bad) process.exitCode = 1;
}

async function scanCmd(args, f) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && e.name === 'SKILL.md')) { found.push(dir); return; }
    for (const e of ents) if (e.isDirectory() && !['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build'].includes(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  for (const a of args.length ? args : ['.']) walk(path.resolve(a), 0);
  const results = found.map((dir) => {
    const files = readSkillDir(dir);
    const v = validateFiles(files);
    const s = scanFiles(files);
    return { dir, name: v.manifest?.name || path.basename(dir), valid: v.ok, errors: v.errors, files: Object.keys(files).length, scripts: Object.keys(files).filter((x) => /\.(py|sh|js|mjs|cjs|ts|rb|ps1)$/.test(x)).length, ...s };
  });
  const sum = {
    skills: results.length,
    withCritical: results.filter((r) => r.critical).length,
    withWarning: results.filter((r) => r.warning).length,
    withScripts: results.filter((r) => r.scripts).length,
    invalid: results.filter((r) => !r.valid).length,
    byRule: {},
  };
  for (const r of results) for (const x of r.findings) sum.byRule[`${x.severity}:${x.rule}`] = (sum.byRule[`${x.severity}:${x.rule}`] || 0) + 1;
  if (f.json) fs.writeFileSync(f.json, JSON.stringify({ scannedAt: new Date().toISOString(), summary: sum, results }, null, 2));
  for (const r of results) {
    if (!r.critical && !(f.all && r.warning)) continue;
    console.log(`${r.critical ? 'CRIT' : 'warn'} ${tilde(r.dir)}`);
    for (const x of r.findings.filter((y) => f.all || y.severity === 'critical')) console.log(`     ${x.severity.padEnd(8)} ${x.file}:${x.line} ${x.message} [${x.rule}]`);
  }
  console.log(`\n${sum.skills} skills scanned: ${sum.withCritical} with critical findings, ${sum.withWarning} with warnings, ${sum.withScripts} ship scripts, ${sum.invalid} fail the format check`);
  if (sum.withCritical) process.exitCode = 1;
}

async function evalCmd(args, f) {
  if (!args.length) throw new Error('usage: skillyard eval <skill-dir...> [--agent claude|codex] [--model haiku] [--runs 1] [--out report.md]');
  const reports = [];
  for (const dir of args) {
    reports.push(await evalSkill(dir, { agent: f.agent || 'claude', model: f.model, tools: f.tools ? String(f.tools).split(',') : undefined, runs: Number(f.runs) || 1, log: (l) => console.log(l) }));
  }
  const md = evalMarkdown(reports);
  console.log(`\n${md.split('\n<details>')[0]}`);
  if (f.out) {
    fs.writeFileSync(f.out, `${md}\n`);
    fs.writeFileSync(f.out.replace(/\.md$/, '') + '.json', JSON.stringify(reports, null, 2));
    console.log(`wrote ${f.out}`);
  }
}

async function publish(args, f) {
  const dir = args[0] || '.';
  if (!f.org) throw new Error('usage: skillyard publish <dir> --org <org> [--visibility public|private]');
  const files = readSkillDir(dir);
  const v = validateFiles(files);
  if (!v.ok) throw new Error(`invalid skill:\n  - ${v.errors.join('\n  - ')}`);
  const r = await registry().publish(f.org, files, f.visibility);
  console.log(`published ${r.id}@${v.manifest.version} (${r.visibility})${r.warnings?.length ? `\nwarnings:\n  - ${r.warnings.join('\n  - ')}` : ''}`);
}

// ---- export ---------------------------------------------------------------

async function exportCmd(args, f) {
  if (args[0] === 'site') return exportSite(f);
  if (args[0] !== 'claude-marketplace' || !f.out) throw new Error('usage: skillyard export claude-marketplace --out <dir> [--from <dir> | --scope <org>] [--name n]');
  const out = path.resolve(f.out);
  const skills = []; // { name, category, version, description, files: {rel: Buffer} }
  if (f.scope) {
    const reg = registry();
    for (const s of await reg.search({ scope: f.scope, limit: 500 })) {
      const b = await reg.bundle(s.scope, s.name, 'latest');
      const files = {};
      for (const [k, v] of Object.entries(b.files)) files[k] = Buffer.from(v, 'base64');
      skills.push({ name: s.name, category: s.category, version: b.version, description: s.description, files });
    }
  } else {
    const from = path.resolve(f.from || path.join(REPO_ROOT, 'registry', 'public'));
    for (const d of fs.readdirSync(from)) {
      const dir = path.join(from, d);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      const files = readSkillDir(dir);
      const v = validateFiles(files);
      if (!v.ok) { console.error(`skip ${d}: ${v.errors.join('; ')}`); continue; }
      skills.push({ name: v.manifest.name, category: v.manifest.category, version: v.manifest.version, description: v.manifest.description, files });
    }
  }
  const name = f.name || (f.scope ? `${f.scope}-skills` : 'skillyard');
  const byCat = {};
  for (const s of skills) (byCat[s.category] ||= []).push(s);
  const pluginsDir = path.join(out, 'plugins');
  // Hand-written plugin folders (not generated from registry skills) survive a regenerate.
  const keep = new Set(HAND_WRITTEN_PLUGINS.filter((d) => fs.existsSync(path.join(pluginsDir, d))));
  if (fs.existsSync(pluginsDir)) {
    for (const d of fs.readdirSync(pluginsDir)) if (!keep.has(d)) fs.rmSync(path.join(pluginsDir, d), { recursive: true, force: true });
  }
  const plugins = [];
  for (const [cat, list] of Object.entries(byCat).sort()) {
    if (keep.has(cat)) continue;
    const pname = `${name}-${cat}`;
    const pdir = path.join(pluginsDir, cat);
    fs.mkdirSync(path.join(pdir, '.claude-plugin'), { recursive: true });
    const description = `${({ ai: "AI", devops: "DevOps" })[cat] || titleCase(cat)} skills: ${list.map((s) => s.name).sort().join(', ')}`;
    fs.writeFileSync(path.join(pdir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: pname, description, version: '1.0.0', author: { name: f.scope ? f.scope : 'Skillyard Community' } }, null, 2)}\n`);
    for (const s of list) {
      for (const [rel, buf] of Object.entries(s.files)) {
        const dest = path.join(pdir, 'skills', s.name, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
      }
    }
    plugins.push({ name: pname, source: `./plugins/${cat}`, description, version: '1.0.0', category: cat });
  }
  fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(out, '.claude-plugin', 'marketplace.json'), 'utf8'));
    for (const e of prev.plugins || []) if (keep.has(path.basename(String(e.source))) && !plugins.some((x) => x.source === e.source)) plugins.push(e);
  } catch { /* no previous marketplace */ }
  fs.writeFileSync(path.join(out, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({
    name,
    owner: { name: f.scope ? f.scope : 'Skillyard Community' },
    metadata: { description: f.scope ? `Private skills for @${f.scope}, exported from Skillyard` : 'Open-source Agent Skills from Skillyard', version: '1.0.0' },
    plugins,
  }, null, 2)}\n`);
  console.log(`wrote ${plugins.length} plugin(s) with ${skills.length} skill(s) to ${tilde(out)}\nadd it in Claude Code: /plugin marketplace add <git repo or path>`);
}

async function exportSite(f) {
  if (!f.out) throw new Error('usage: skillyard export site --out <dir> [--data ./data] [--site-url https://example.com/base]');
  const store = new Store(dataDir(f));
  const out = path.resolve(f.out);
  const webDir = path.join(REPO_ROOT, 'web');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'api'), { recursive: true });
  for (const file of fs.readdirSync(webDir)) if (fs.statSync(path.join(webDir, file)).isFile()) fs.copyFileSync(path.join(webDir, file), path.join(out, file));
  // Page media (launch video, poster, proof data) lives in web/media/.
  if (fs.existsSync(path.join(webDir, 'media'))) fs.cpSync(path.join(webDir, 'media'), path.join(out, 'media'), { recursive: true });
  fs.writeFileSync(path.join(out, 'static.js'), 'window.SKILLYARD_STATIC = true;\n');
  // Stamp asset URLs with the build so browsers fetch the new CSS and JS after every deploy.
  const v = Date.now().toString(36);
  const idx = path.join(out, 'index.html');
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/(href|src)="((?:style|landing)\.css|(?:app|static|config)\.js)"/g, `$1="$2?v=${v}"`));
  // The read-only Studio demo, if a snapshot has been exported.
  const studioSrc = path.join(REPO_ROOT, 'studio');
  if (fs.existsSync(path.join(studioSrc, 'demo-snapshot.json'))) {
    fs.cpSync(studioSrc, path.join(out, 'studio'), { recursive: true });
    fs.writeFileSync(path.join(out, 'studio', 'static.js'), 'window.STUDIO_STATIC = true;\n');
    fs.copyFileSync(path.join(webDir, 'generators.js'), path.join(out, 'studio', 'generators.js'));
    const sidx = path.join(out, 'studio', 'index.html');
    fs.writeFileSync(sidx, fs.readFileSync(sidx, 'utf8').replace(/(href|src)="((?:studio)\.css|(?:studio|charts|static)\.js)"/g, `$1="$2?v=${Date.now().toString(36)}"`));
  }
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  const all = store.search({ limit: 10000 }, ADMIN).map(({ score, ...s }) => s);
  const orgs = Object.values(store.db.orgs).map(({ slug, name, description, website }) => ({ slug, name, description, website }));
  fs.writeFileSync(path.join(out, 'api', 'index.json'), JSON.stringify({ exportedAt: new Date().toISOString(), orgs, skills: all }));
  for (const s of all) {
    const info = store.get(s.scope, s.name, 'latest', ADMIN);
    const dir = path.join(out, 'api', 'skills', `@${s.scope}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.name}.json`), JSON.stringify(info));
    for (const rel of info.files) {
      const dest = path.join(dir, s.name, 'files', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, store.readFile(s.scope, s.name, 'latest', rel, ADMIN));
    }
  }
  const pre = prerenderSite({ out, webDir, reportsDir: path.join(REPO_ROOT, 'reports'), siteUrl: f['site-url'] || process.env.SITE_URL });
  console.log(`wrote static site with ${all.length} skills to ${tilde(out)}`);
  console.log(`  pre-rendered ${pre.pages} pages for search and AI engines (${pre.skills} skill pages, ${pre.tools} tools, ${pre.learn} answers) at ${pre.siteUrl}`);
}

async function studio(args, f) {
  if (f.demo) {
    process.env.SKILLYARD_STUDIO_DEMO = '1';
    const { seedDemo } = await import('./studio/demo.js');
    const dir = seedDemo({ reset: !!f.reset });
    console.log(`demo mode: a fictional team's data in ${tilde(dir)}; your own logs are not read`);
  }
  if (args[0] === 'export') {
    // Snapshot the demo workspace for a read-only public page. Only the fictional team's data; no local paths.
    process.env.SKILLYARD_STUDIO_DEMO = '1';
    const engine = await import('./studio/engine.js');
    const out = path.resolve(f.out || path.join(REPO_ROOT, 'studio', 'demo-snapshot.json'));
    const state = engine.stats();
    state.job = null;
    const scrub = (p) => {
      const { draftDir, target, installed, ...rest } = p;
      return { ...rest, alternatives: (p.alternatives || []).map(({ dir, ...a }) => a), target: target ? { where: target.where, managed: target.managed } : null };
    };
    state.proposals = state.proposals.map(scrub);
    const diffs = Object.fromEntries(state.proposals.filter((p) => p.before).map((p) => [p.id, engine.diffLines(p.before, p.after)]));
    const skills = engine.installedSkills().map(({ dir, ...k }) => k);
    // Agents mention their own temp folders in answers; those are machine details too.
    const json = JSON.stringify({ state, skills, diffs, preview: engine.preview() })
      .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[^\s"`'()\\]+/g, '<temp folder>')
      .replace(/-private-var-folders-[^\s"`'()\\]+/g, '<temp folder>');
    // A public demo must never carry anything from the machine it was made on.
    const leaks = [os.homedir(), '/var/folders/', '/private/var/', '/private/tmp/', 'var-folders', os.userInfo().username].filter((x) => x && json.includes(x));
    if (leaks.length) throw new Error(`snapshot contains local details (${leaks.length}); not writing a public demo`);
    fs.writeFileSync(out, json);
    console.log(`wrote read-only Studio demo snapshot to ${tilde(out)}`);
    return;
  }
  if (args[0] === 'find') {
    // Search the library for skills that already fix the waiting proposals; keeps the proposals.
    const engine = await import('./studio/engine.js');
    for (const p of engine.loadState().proposals.filter((x) => x.status === 'pending' && (f.all || !x.searchedAt))) {
      const alts = await engine.findAlternatives(p.id, { runs: Number(f.runs) || 2, onStep: (t) => console.log(t) });
      console.log(`${p.skill}: ${alts.length ? alts.map((a) => `${a.id} ${a.eval ? `${Math.round(a.eval.candidate * 100)}% (draft ${Math.round(p.eval.candidate * 100)}%)` : 'untested'}`).join(', ') : 'nothing in the library fits'}`);
    }
    return;
  }
  if (args[0] === 'review') {
    const engine = await import('./studio/engine.js');
    await engine.review({ maxProposals: Number(f.max) || 3, runs: Number(f.runs) || 2, fresh: !!f.fresh, onStep: (t) => console.log(t) });
    const s = engine.stats();
    console.log(`${s.pipeline.pending} proposal(s) waiting for review in Studio`);
    return;
  }
  const { createStudioServer } = await import('./studio/server.js');
  const port = Number(f.port || 7430);
  const server = createStudioServer({ port });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  console.log(`Skillyard Studio on http://127.0.0.1:${port}  (local only; nothing is read until you allow it)`);
}

// ---- helpers --------------------------------------------------------------

function tilde(p) {
  const h = os.homedir();
  const rel = path.relative(process.cwd(), p);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel || '.';
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
