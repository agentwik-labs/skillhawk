// skillhawk health: a local, deterministic health check of a codebase. Five sections, each finding with evidence and a fix:
//   structure (size, layout, import cycles, repo hygiene), tests, clean code, system design (what the system is made of
//   and the gaps a reviewer would raise), and cloud cost (infrastructure-as-code checked against list prices).
// No model, no network. The facts feed an agent's narrative review through MCP (health_check) and /skillhawk:health.
import fs from 'node:fs';
import { loadHealth } from './prefs.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildMap } from './map.js';
import { detectConventions } from './clean.js';

const SKIP = /(^|\/)(node_modules|dist|build|out|vendor|\.git|\.next|\.venv|venv|__pycache__|coverage|target|\.skillyard|graphify-out)\//;
const CONTENT = /(^|\/)(examples?|samples?|fixtures?|testdata|test-data|seed|docs?|demo)\//;
const CODE = /\.(m?js|cjs|jsx|tsx?|py|go|rb|java|kt|rs|php|cs|swift)$/;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|^test_.*\.py$|\/test_[^/]*\.py$|_test\.go$/;
const DEFAULT_LIMITS = { fileLines: 600, fnLines: 80, nesting: 5, flatDir: 40, lineLen: 160, todo: 25 };
let LIMITS = DEFAULT_LIMITS; // set per run from the user's settings (skillhawk setup), else these defaults
let MIN_RATIO = 0.2;

function listFiles(root) {
  try { return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).split('\n').filter(Boolean); } catch { /* not git */ }
  const out = [];
  const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (SKIP.test(`${r}/`)) continue; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } };
  walk(root);
  return out;
}
const read = (root, f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
const F = (section, severity, title, evidence, fix, extra = {}) => ({ section, severity, title, evidence, fix, ...extra });

// ---- structure -----------------------------------------------------------------------------------------------
function structure(root, files, code, map) {
  const out = [];
  const has = (re) => files.some((f) => re.test(f));
  if (!has(/^README(\.\w+)?$/i)) out.push(F('structure', 'medium', 'No README at the root', 'README missing', 'Add a README: what it is, how to run it, how to test it. Agents read it first too.'));
  if (!has(/^\.gitignore$/)) out.push(F('structure', 'medium', 'No .gitignore', '.gitignore missing', 'Add one so build output, dependencies and .env files stay out of git.'));
  const envs = files.filter((f) => /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.(example|sample|template)$/.test(f));
  for (const f of envs) out.push(F('structure', 'high', 'Environment file committed', f, 'Remove it from git (git rm --cached), rotate any secrets it held, and commit a .env.example instead.'));
  const pkg = json(read(root, 'package.json'));
  if (pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length && !has(/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/)) out.push(F('structure', 'medium', 'No lockfile', 'package.json without a lockfile', 'Commit the lockfile so every install gets the same versions.'));
  const big = code.map((f) => [f, read(root, f).split('\n').length]).filter(([, n]) => n > LIMITS.fileLines).sort((a, b) => b[1] - a[1]);
  for (const [f, n] of big.slice(0, 8)) out.push(F('structure', n > LIMITS.fileLines * 2 ? 'medium' : 'low', 'Very large file', `${f}: ${n} lines`, 'Split by responsibility; files this size are hard to review and costly for agents to read whole.'));
  if (big.length > 8) out.push(F('structure', 'low', `${big.length - 8} more files over ${LIMITS.fileLines} lines`, big.slice(8, 14).map(([f]) => f).join(', '), 'Same fix.'));
  const perDir = {};
  for (const f of code) { const d = path.posix.dirname(f); perDir[d] = (perDir[d] || 0) + 1; }
  for (const [d, n] of Object.entries(perDir)) if (n > LIMITS.flatDir) out.push(F('structure', 'low', 'Flat folder with many source files', `${d}/: ${n} files`, 'Group by feature or layer so related code sits together.'));
  // import cycles from the repo map (JS/TS/Python)
  const deps = new Map(Object.entries(map.files).map(([p, f]) => [p, f.deps || []]));
  const cycles = []; const state = new Map(); const stack = [];
  const visit = (n) => { state.set(n, 1); stack.push(n); for (const d of deps.get(n) || []) { if (state.get(d) === 1) { const c = stack.slice(stack.indexOf(d)); if (c.length > 1) cycles.push(c); } else if (!state.get(d)) visit(d); } stack.pop(); state.set(n, 2); };
  for (const n of deps.keys()) if (!state.get(n)) visit(n);
  const seen = new Set();
  for (const c of cycles) { const k = [...c].sort().join('|'); if (seen.has(k)) continue; seen.add(k); if (seen.size > 5) break; out.push(F('structure', 'medium', 'Import cycle', `${c.join(' -> ')} -> ${c[0]}`, 'Move the shared piece into its own module that both import, or invert one dependency.')); }
  return out;
}

// ---- tests ---------------------------------------------------------------------------------------------------
function tests(root, files, code) {
  const out = [];
  const testFiles = code.filter((f) => TEST.test(f));
  const src = code.filter((f) => !TEST.test(f));
  const pkg = json(read(root, 'package.json'));
  const ci = files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\//.test(f));
  const ciText = ci.map((f) => read(root, f)).join('\n');
  const ratio = src.length ? testFiles.length / src.length : 0;
  const facts = { sourceFiles: src.length, testFiles: testFiles.length, ratio: Math.round(ratio * 100) / 100, ci: ci.length > 0 };
  if (src.length && !testFiles.length) out.push(F('tests', 'high', 'No tests', `${src.length} source files, 0 test files`, 'Start with the code that handles money, auth or data loss; one test per bug you fix from now on.'));
  else if (src.length >= 10 && MIN_RATIO > 0 && ratio < MIN_RATIO) out.push(F('tests', 'medium', 'Few tests for the amount of code', `${testFiles.length} test files for ${src.length} source files`, 'Add tests where changes break things most often (git log shows which files change most).'));
  if (pkg && testFiles.length && !(pkg.scripts && pkg.scripts.test) ) out.push(F('tests', 'medium', 'No test script', 'package.json has no "test" script', 'Add "test" so people and agents can run `npm test` without guessing.'));
  if (pkg?.scripts?.test && /no test specified/.test(pkg.scripts.test)) out.push(F('tests', 'medium', 'Placeholder test script', `"test": "${pkg.scripts.test}"`, 'Point it at the real test runner.'));
  if (testFiles.length && !ci.length) out.push(F('tests', 'medium', 'Tests never run automatically', 'no CI workflow found', 'Add a CI job that runs the tests on every push and pull request.'));
  else if (ci.length && testFiles.length && !/\b(test|pytest|vitest|jest|go test|cargo test|rspec|mocha)\b/.test(ciText)) out.push(F('tests', 'medium', 'CI does not run the tests', ci.join(', '), 'Add the test command to the CI workflow.'));
  // untested modules: source files whose base name appears in no test file name or content
  if (testFiles.length) {
    const testText = testFiles.map((f) => `${f}\n${read(root, f)}`).join('\n');
    const untested = src.filter((f) => { const b = path.posix.basename(f).replace(/\.[^.]+$/, ''); return b.length > 2 && !/^(index|main|__init__|types?|config|constants)$/.test(b) && !testText.includes(b); });
    if (untested.length) out.push(F('tests', 'low', `${untested.length} source files no test mentions`, untested.slice(0, 8).join(', ') + (untested.length > 8 ? ', …' : ''), 'Cover the ones with logic first; skip thin wrappers.'));
  }
  return { findings: out, facts };
}

// ---- clean code ----------------------------------------------------------------------------------------------
function cleanCode(root, code) {
  const out = []; const longFns = []; const deep = []; let todos = 0; const todoAt = []; const debug = []; const longLines = []; const dupes = new Map();
  for (const f of code.filter((x) => !TEST.test(x)).slice(0, 3000)) {
    const text = read(root, f); if (text.length > 400000) continue;
    const lines = text.split('\n'); const py = f.endsWith('.py');
    // functions: count lines until indentation returns (py) or braces balance (others)
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const m = py ? /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(l) : /^(\s*)(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^(\s*)(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/.exec(l);
      if (!m) continue;
      const name = m[2] || m[4]; const ind = (m[1] ?? m[3] ?? '').length; let end = i;
      if (py) { for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim() && lines[j].match(/^\s*/)[0].length <= ind) break; end = j; } }
      else { let depth = 0, started = false; for (let j = i; j < lines.length; j++) { for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; } if (started && depth <= 0) { end = j; break; } end = j; } }
      if (end - i + 1 > LIMITS.fnLines) longFns.push([`${f}:${i + 1}`, name, end - i + 1]);
    }
    let indentUnit = 0;
    for (const [i, l] of lines.entries()) {
      const lead = l.match(/^( +|\t+)/)?.[0] || '';
      if (lead && !indentUnit && !lead.startsWith('\t')) indentUnit = Math.min(lead.length, 4) || 2;
      const level = lead.startsWith('\t') ? lead.length : indentUnit ? Math.floor(lead.length / indentUnit) : 0;
      if (level > LIMITS.nesting + 1 && /\b(if|for|while|switch|try|else)\b/.test(l)) { deep.push(`${f}:${i + 1}`); break; }
    }
    lines.forEach((l, i) => {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(l)) { todos++; if (todoAt.length < 5) todoAt.push(`${f}:${i + 1}`); }
      if (!py && /^\s*console\.(log|debug)\(/.test(l) && !/(^|\/)(bin|scripts?|cli)\b/.test(f) && debug.length < 50) debug.push(`${f}:${i + 1}`);
      if (py && /^\s*print\(/.test(l) && !/(^|\/)(bin|scripts?|cli)\b|__main__/.test(f) && debug.length < 50) debug.push(`${f}:${i + 1}`);
      if (l.length > LIMITS.lineLen && !/https?:\/\/|^\s*(\/\/|#|\*)/.test(l) && longLines.length < 200) longLines.push(`${f}:${i + 1}`);
    });
    // duplicated blocks: 8 consecutive non-trivial lines seen in two places
    const norm = lines.map((l) => l.trim()).map((l) => (l.length > 3 && !/^[})\];,]*$|^(import|from|#|\/\/|\*)/.test(l) ? l : ''));
    for (let i = 0; i + 8 <= norm.length; i++) { const w = norm.slice(i, i + 8); if (w.some((x) => !x)) continue; const k = w.join('\n'); if (!dupes.has(k)) dupes.set(k, []); const at = dupes.get(k); if (at.length < 3) at.push(`${f}:${i + 1}`); }
  }
  longFns.sort((a, b) => b[2] - a[2]);
  for (const [at, name, n] of longFns.slice(0, 6)) out.push(F('clean-code', n > LIMITS.fnLines * 2 ? 'medium' : 'low', 'Long function', `${at} ${name}(): ${n} lines`, 'Extract the steps into named helpers; aim for one job per function.'));
  if (longFns.length > 6) out.push(F('clean-code', 'low', `${longFns.length - 6} more functions over ${LIMITS.fnLines} lines`, longFns.slice(6, 12).map((x) => x[0]).join(', '), 'Same fix.'));
  if (deep.length) out.push(F('clean-code', 'low', 'Deeply nested logic', deep.slice(0, 6).join(', ') + (deep.length > 6 ? ` (+${deep.length - 6})` : ''), 'Return early, and move inner blocks into functions.'));
  const pairs = new Map();
  for (const at of dupes.values()) { if (at.length < 2) continue; const [a, b] = at.map((x) => x.replace(/:\d+$/, '')); if (a === b) continue; const k = [a, b].sort().join(' and '); pairs.set(k, (pairs.get(k) || 0) + 1); }
  const top = [...pairs.entries()].sort((x, y) => y[1] - x[1]);
  if (top.length) out.push(F('clean-code', top.length > 5 ? 'medium' : 'low', `Copied code in ${top.length} pair${top.length > 1 ? 's' : ''} of files`, top.slice(0, 4).map(([k, n]) => `${k} (${n + 7}+ lines)`).join('; '), 'Keep one copy and import it, or generate the copy at build time so the two cannot drift.'));
  if (todos > LIMITS.todo) out.push(F('clean-code', 'low', `${todos} TODO/FIXME comments`, todoAt.join(', '), 'Turn the real ones into issues and delete the rest.'));
  if (debug.length >= 5) out.push(F('clean-code', 'low', `${debug.length}${debug.length >= 50 ? '+' : ''} leftover debug prints`, debug.slice(0, 5).join(', '), 'Use a logger with levels, or remove them.'));
  if (longLines.length >= 20) out.push(F('clean-code', 'low', `${longLines.length}${longLines.length >= 200 ? '+' : ''} lines over ${LIMITS.lineLen} characters`, longLines.slice(0, 4).join(', '), 'Run a formatter with a line limit.'));
  return out;
}

// ---- system design -------------------------------------------------------------------------------------------
const STACK = [
  ['web framework', /\b(express|fastify|koa|hono|@nestjs\/core|next|nuxt|@remix-run|astro|flask|django|fastapi|rails|sinatra|gin-gonic|echo|fiber|spring-boot)\b/i],
  ['database', /\b(pg|postgres|mysql2?|sqlite3?|better-sqlite3|mongodb|mongoose|prisma|@prisma\/client|drizzle-orm|typeorm|sequelize|knex|sqlalchemy|psycopg2?|redis|ioredis|@aws-sdk\/client-dynamodb|dynamodb|supabase|@supabase\/supabase-js|firebase-admin)\b/i],
  ['queue / jobs', /\b(bullmq|bull|bee-queue|celery|rq|sidekiq|@aws-sdk\/client-sqs|amqplib|kafkajs|agenda)\b/i],
  ['payments', /\b(stripe|@stripe\/stripe-js|paddle|lemonsqueezy)\b/i],
  ['auth', /\b(passport|next-auth|@auth\/core|jsonwebtoken|jose|clerk|@clerk\/[\w-]+|auth0|lucia|bcrypt|argon2)\b/i],
  ['AI / LLM', /\b(@anthropic-ai\/sdk|anthropic|openai|@google\/generative-ai|langchain|llamaindex|ollama)\b/i],
  ['email', /\b(nodemailer|@aws-sdk\/client-sesv2?|resend|postmark|@sendgrid\/mail)\b/i],
  ['observability', /\b(pino|winston|bunyan|@sentry\/[\w-]+|sentry-sdk|@opentelemetry\/[\w-]+|datadog|dd-trace|prom-client|structlog|loguru)\b/i],
  ['rate limiting', /\b(express-rate-limit|rate-limiter-flexible|@upstash\/ratelimit|slowapi|django-ratelimit)\b/i],
  ['validation', /\b(zod|joi|yup|ajv|valibot|pydantic|marshmallow|class-validator)\b/i],
  ['migrations', /\b(prisma|drizzle-kit|knex|alembic|flyway|liquibase|django)\b/i],
];
function design(root, files) {
  const out = []; const stack = {};
  const manifests = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Gemfile', 'Cargo.toml', 'pom.xml', 'build.gradle'].filter((f) => files.includes(f));
  const depText = manifests.map((f) => { const t = read(root, f); const j = f === 'package.json' ? json(t) : null; return j ? Object.keys({ ...j.dependencies, ...j.devDependencies }).join('\n') : t; }).join('\n');
  for (const [k, re] of STACK) { const m = depText.match(new RegExp(re.source, 'gi')); if (m) stack[k] = [...new Set(m.map((x) => x.toLowerCase()))].slice(0, 5); }
  const entry = files.filter((f) => /(^|\/)(server|app|main|index|handler|handlers|api)\.(m?js|ts|py|go)$|^cmd\/[^/]+\/main\.go$|(^|\/)wsgi\.py$|(^|\/)manage\.py$/.test(f) && !SKIP.test(f) && !TEST.test(f)).slice(0, 8);
  const code = files.filter((f) => CODE.test(f) && !SKIP.test(f));
  const all = code.slice(0, 1500).map((f) => [f, read(root, f)]);
  const grep = (re) => all.filter(([, t]) => re.test(t)).map(([f]) => f);
  const facts = { stack, entryPoints: entry, manifests, containers: files.filter((f) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f)) };
  const server = !!stack['web framework'];
  if (server && !grep(/['"`]\/(health|healthz|ready|readyz|livez|ping|status)['"`]/).length) out.push(F('design', 'medium', 'No health-check endpoint', 'no /health, /healthz, /ready or /ping route found', 'Add a cheap health route so hosting platforms and load balancers can restart a stuck instance.'));
  if (server && !stack['rate limiting']) out.push(F('design', 'medium', 'No rate limiting', 'no rate-limit library in the dependencies', 'Rate-limit public endpoints (login, signup, anything that sends email or calls a paid API).'));
  if (server && !stack.validation) out.push(F('design', 'low', 'No input validation library', 'no zod, joi, pydantic or similar', 'Validate request bodies at the edge so bad input fails fast with a clear error.'));
  if ((server || stack.database) && !stack.observability) out.push(F('design', 'low', 'No structured logging or error tracking', 'no logger or Sentry/OpenTelemetry dependency', 'Add a structured logger and error tracking so production failures are visible.'));
  if (stack.database && !stack.migrations && !files.some((f) => /(^|\/)(migrations?|alembic)\//.test(f))) out.push(F('design', 'medium', 'Database without migrations', `database: ${stack.database.join(', ')}; no migrations folder or tool`, 'Keep schema changes as versioned migrations so every environment matches.'));
  const URL_RE = /['"`]https?:\/\/(?!localhost|127\.0\.0\.1|example\.|schemas?\.|www\.w3\.org|json-schema)[^'"`\s]+\.(com|io|net|ai|dev|app)\b[^'"`]*['"`]/g;
  const urlHits = all.filter(([f]) => !TEST.test(f) && !CONTENT.test(f) && !/(^|\/)(web|public|site)\//.test(f)).map(([f, t]) => [f, (t.match(URL_RE) || []).length]).filter(([, n]) => n);
  const nUrls = urlHits.reduce((a, [, n]) => a + n, 0);
  if (nUrls >= 3) out.push(F('design', 'low', 'Service URLs hard-coded in source', `${nUrls} URLs in ${urlHits.slice(0, 5).map(([f]) => f).join(', ')}`, 'Read endpoints from configuration so staging and production can differ without code changes.'));
  if (stack.payments && !grep(/constructEvent|webhooks?\.construct|verify.*signature|stripe-signature/i).length) out.push(F('design', 'high', 'Payment webhooks without signature checks', `payments: ${stack.payments.join(', ')}; no signature verification found`, 'Verify every payment webhook signature before acting on it.'));
  if (stack['AI / LLM'] && !grep(/max_tokens|maxTokens|max_output_tokens|timeout/i).length) out.push(F('design', 'medium', 'LLM calls without limits', `AI: ${stack['AI / LLM'].join(', ')}; no max_tokens or timeout found`, 'Set max tokens and a timeout on every model call so one bad loop cannot run up a bill.'));
  if (all.length > 40 && entry.length === 1 && code.length > 80 && !files.some((f) => /\/(services?|domain|core|lib|modules?|features?|routes?|controllers?|handlers?)\//.test(f))) out.push(F('design', 'low', 'No visible layering', `${code.length} source files and no services/, lib/, routes/ or similar folders`, 'Separate request handling, business logic and data access so each can change and be tested alone.'));
  return { findings: out, facts };
}

// ---- cloud cost ------------------------------------------------------------------------------------------------
// Approximate on-demand list prices, us-east-1, USD per month (730 h). Estimates to check against the provider's calculator.
const EC2 = { 't3.micro': 7.6, 't3.small': 15.2, 't3.medium': 30.4, 't3.large': 60.7, 't3.xlarge': 121.5, 'm5.large': 70.1, 'm5.xlarge': 140.2, 'm6i.large': 70.1, 'c5.large': 62.1, 'r5.large': 91.98, 't4g.micro': 6.1, 't4g.small': 12.3, 't4g.medium': 24.5 };
const RDS = { 'db.t3.micro': 12.4, 'db.t3.small': 24.8, 'db.t3.medium': 49.6, 'db.t4g.micro': 11.7, 'db.t4g.small': 23.4, 'db.m5.large': 124.1, 'db.r5.large': 175.2 };
const NAT = 32.9, ALB = 16.4, EIP = 3.65;
function cloud(root, files) {
  const out = []; const iac = [];
  const texts = files.filter((f) => /\.(tf|ya?ml|json)$/.test(f) && !SKIP.test(f) && !/package(-lock)?\.json$|tsconfig|\.github\/|eslint|prettier/.test(f)).map((f) => [f, read(root, f)]).filter(([, t]) => t.length < 500000);
  const isCfn = ([, t]) => /AWSTemplateFormatVersion|Transform:\s*AWS::Serverless|Type:\s*['"]?AWS::/.test(t);
  const isTf = ([f, t]) => f.endsWith('.tf') && /resource\s+"aws_/.test(t);
  const isSls = ([f, t]) => /(^|\/)serverless\.ya?ml$/.test(f) && /provider:/.test(t);
  const lineOf = (t, idx) => t.slice(0, idx).split('\n').length;
  for (const doc of texts.filter((d) => isCfn(d) || isTf(d) || isSls(d))) {
    const [f, t] = doc; iac.push(f);
    const each = (re, fn) => { let m; const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`); while ((m = r.exec(t))) fn(m, lineOf(t, m.index)); };
    // Lambda architecture and memory
    const fnCount = (t.match(/AWS::Serverless::Function|AWS::Lambda::Function|resource\s+"aws_lambda_function"/g) || []).length + (isSls(doc) ? (t.match(/^\s{2}\w[\w-]*:\s*\n\s+handler:/gm) || []).length : 0);
    if (fnCount && !/arm64/.test(t)) out.push(F('cloud-cost', 'low', 'Lambda on x86', `${f}: ${fnCount} function(s), no arm64`, 'Set Architectures: [arm64] (Terraform: architectures = ["arm64"]); Graviton is about 20% cheaper per GB-second for most Node and Python code.', { estSavingPct: 20 }));
    each(/(MemorySize|memory_size|memorySize)\s*[:=]\s*(\d{4,})/, (m, ln) => { if (Number(m[2]) >= 1024) out.push(F('cloud-cost', 'low', 'Large Lambda memory', `${f}:${ln} ${m[1]} ${m[2]} MB`, 'Measure with AWS Lambda Power Tuning; many functions run as fast at 256–512 MB for a fraction of the cost.')); });
    each(/ProvisionedConcurrency\w*|provisioned_concurrent_executions/, (m, ln) => out.push(F('cloud-cost', 'medium', 'Provisioned concurrency', `${f}:${ln}`, 'This bills around the clock. Keep it only for latency-critical paths with steady traffic.')));
    // NAT gateways, load balancers, elastic IPs
    const nat = (t.match(/AWS::EC2::NatGateway|resource\s+"aws_nat_gateway"/g) || []).length;
    if (nat) out.push(F('cloud-cost', 'high', `${nat} NAT gateway(s)`, `${f}: about $${(nat * NAT).toFixed(0)}/month before data processing ($0.045/GB)`, 'Use VPC endpoints for S3/DynamoDB, one NAT for non-production, or keep Lambdas out of the VPC if they only call public APIs.', { estMonthly: nat * NAT }));
    const alb = (t.match(/AWS::ElasticLoadBalancingV2::LoadBalancer|resource\s+"aws_(lb|alb)"/g) || []).length;
    if (alb) out.push(F('cloud-cost', 'low', `${alb} load balancer(s)`, `${f}: about $${(alb * ALB).toFixed(0)}/month each before LCU charges`, 'For low traffic, API Gateway HTTP APIs or a Lambda function URL cost nothing at rest.', { estMonthly: alb * ALB }));
    const eip = (t.match(/AWS::EC2::EIP|resource\s+"aws_eip"/g) || []).length;
    if (eip) out.push(F('cloud-cost', 'low', `${eip} Elastic IP(s)`, `${f}: public IPv4 bills about $${EIP}/month each`, 'Drop ones you do not need; use IPv6 or a load balancer address where you can.', { estMonthly: eip * EIP }));
    // EC2 / RDS sizes
    each(/(InstanceType|instance_type)\s*[:=]\s*['"]?([a-z0-9]+\.[a-z0-9]+)/, (m, ln) => { const p = EC2[m[2]]; if (p) out.push(F('cloud-cost', p > 50 ? 'medium' : 'low', `EC2 ${m[2]}`, `${f}:${ln} about $${p}/month on demand`, `${/^t3\./.test(m[2]) ? `The Graviton equivalent (${m[2].replace('t3', 't4g')}) is about 20% cheaper. ` : ''}A 1-year Savings Plan cuts steady instances by roughly 30–40%; stop dev instances out of hours.`, { estMonthly: p })); });
    each(/(DBInstanceClass|instance_class)\s*[:=]\s*['"]?(db\.[a-z0-9]+\.[a-z0-9]+)/, (m, ln) => { const p = RDS[m[2]]; out.push(F('cloud-cost', p > 50 ? 'medium' : 'low', `RDS ${m[2]}`, `${f}:${ln}${p ? ` about $${p}/month single-AZ` : ''}`, 'Right-size from CloudWatch CPU and memory; for spiky or low traffic consider Aurora Serverless v2 or DynamoDB on-demand.', p ? { estMonthly: p } : {})); });
    each(/(MultiAZ|multi_az)\s*[:=]\s*['"]?true/i, (m, ln) => out.push(F('cloud-cost', 'medium', 'Multi-AZ database', `${f}:${ln} doubles the instance cost`, 'Keep it for production; turn it off for dev and staging.')));
    // storage
    each(/(VolumeType|volume_type|StorageType|storage_type)\s*[:=]\s*['"]?gp2/, (m, ln) => out.push(F('cloud-cost', 'low', 'gp2 storage', `${f}:${ln}`, 'Switch to gp3: about 20% cheaper with better baseline performance, no downtime.', { estSavingPct: 20 })));
    const buckets = (t.match(/AWS::S3::Bucket\b|resource\s+"aws_s3_bucket"/g) || []).length;
    if (buckets && !/LifecycleConfiguration|aws_s3_bucket_lifecycle_configuration|lifecycle_rule/.test(t)) out.push(F('cloud-cost', 'low', `${buckets} S3 bucket(s) without lifecycle rules`, f, 'Expire temporary objects and move old data to Infrequent Access or Glacier automatically.'));
    // logs and tables
    const logGroups = (t.match(/AWS::Logs::LogGroup|resource\s+"aws_cloudwatch_log_group"/g) || []).length;
    if ((fnCount || logGroups) && !/RetentionInDays|retention_in_days|logRetentionInDays/.test(t)) out.push(F('cloud-cost', 'medium', 'Logs kept forever', `${f}: no log retention set`, 'Set retention (e.g. 14 or 30 days); CloudWatch Logs storage otherwise grows every month.'));
    each(/BillingMode\s*:\s*PROVISIONED|billing_mode\s*=\s*"PROVISIONED"/, (m, ln) => out.push(F('cloud-cost', 'low', 'DynamoDB provisioned capacity', `${f}:${ln}`, 'For low or spiky traffic, on-demand (PAY_PER_REQUEST) usually costs less; keep provisioned with auto-scaling for steady high traffic.')));
  }
  // other hosts: just name them, with the most common cost trap
  const hosts = [[/^vercel\.json$/, 'Vercel', 'Watch function duration and image optimisation; both bill per use above the plan.'], [/^fly\.toml$/, 'Fly.io', 'Set auto_stop_machines so idle machines stop billing.'], [/^render\.ya?ml$/, 'Render', 'Free and starter services sleep; paid ones bill all month, so size them to real use.'], [/^netlify\.toml$/, 'Netlify', 'Bandwidth and function invocations bill above the plan.'], [/^app\.ya?ml$/, 'Google App Engine', 'Set max_instances so traffic spikes cannot scale costs without limit.'], [/^railway\.(json|toml)$/, 'Railway', 'Usage-billed: set a spending limit in the project.']];
  const other = [];
  for (const [re, name, tip] of hosts) if (files.some((f) => re.test(path.posix.basename(f)))) { other.push(name); out.push(F('cloud-cost', 'info', `Hosted on ${name}`, files.find((f) => re.test(path.posix.basename(f))), tip)); }
  const k8s = texts.filter(([, t]) => /^kind:\s*(Deployment|StatefulSet)/m.test(t));
  for (const [f, t] of k8s) if (!/resources:\s*\n\s+(requests|limits):/.test(t)) out.push(F('cloud-cost', 'medium', 'Kubernetes workload without resource requests', f, 'Set CPU and memory requests so the scheduler packs nodes and the autoscaler can shrink the cluster.'));
  const est = out.reduce((a, x) => a + (x.estMonthly || 0), 0);
  return { findings: out, facts: { iacFiles: iac, otherHosts: other, knownFixedMonthlyUsd: Math.round(est) } };
}

// ---- run -----------------------------------------------------------------------------------------------------
const ORDER = { high: 0, medium: 1, low: 2, info: 3 };
const SECTIONS = [['structure', 'Structure'], ['tests', 'Tests'], ['clean-code', 'Clean code'], ['design', 'System design'], ['cloud-cost', 'Cloud cost']];
export function health(root = '.', settings = undefined) {
  root = path.resolve(root);
  const cfg = settings === undefined ? loadHealth(root) : settings;
  LIMITS = { ...DEFAULT_LIMITS, ...(cfg?.limits || {}) };
  MIN_RATIO = cfg?.minTestRatio ?? 0.2;
  const ignore = (cfg?.ignore || []).map((d) => `${d.replace(/^\.\//, '')}/`);
  const files = listFiles(root).filter((f) => !SKIP.test(f) && !ignore.some((d) => f.startsWith(d)));
  const code = files.filter((f) => CODE.test(f) && !CONTENT.test(f));
  const { map } = buildMap(root);
  const conv = detectConventions(root);
  const t = tests(root, files, code); const d = design(root, files); const c = cloud(root, files);
  const on = new Set(cfg?.sections || SECTIONS.map(([id]) => id));
  const findings = [...structure(root, files, code, map), ...t.findings, ...cleanCode(root, code), ...d.findings, ...c.findings].filter((x) => on.has(x.section)).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const count = (s) => findings.filter((x) => x.severity === s).length;
  const W = { high: 10, medium: 3, low: 1, info: 0 };
  const penalty = SECTIONS.reduce((a, [id]) => a + Math.min(15, findings.filter((x) => x.section === id).reduce((b, x) => b + W[x.severity], 0)), 0) + Math.max(0, count('high') - 1) * 5;
  const score = Math.max(0, 100 - penalty);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  return {
    root, files: files.length, codeFiles: code.length, score, grade, showGrade: cfg?.grade !== false, sections: [...on],
    settings: cfg ? { file: '.skillhawk/health.json', limits: LIMITS, minTestRatio: MIN_RATIO, ignore: cfg.ignore || [] } : null,
    languages: conv.languages.slice(0, 4), tools: conv.configs,
    tests: t.facts, design: d.facts, cloud: c.facts,
    counts: { high: count('high'), medium: count('medium'), low: count('low'), info: count('info') },
    findings,
  };
}

export function render(r, { all = false } = {}) {
  const L = [];
  L.push(`skillhawk health: ${r.showGrade === false ? '' : `${r.grade} (${r.score}/100) · `}${r.codeFiles} source files · ${r.counts.high} high, ${r.counts.medium} medium, ${r.counts.low} low`);
  if (r.languages.length) L.push(`stack: ${r.languages.map((l) => `${l.name} ${l.pct}%`).join(', ')}${Object.keys(r.design.stack).length ? ` · ${Object.entries(r.design.stack).map(([k, v]) => `${k}: ${v.join('/')}`).join(' · ')}` : ''}`);
  L.push(`tests: ${r.tests.testFiles} test files for ${r.tests.sourceFiles} source files${r.tests.ci ? ', CI present' : ', no CI'}${r.cloud.iacFiles.length ? ` · infrastructure: ${r.cloud.iacFiles.join(', ')}` : ''}${r.cloud.otherHosts.length ? ` · hosted on ${r.cloud.otherHosts.join(', ')}` : ''}`);
  for (const [id, name] of SECTIONS.filter(([id]) => !r.sections || r.sections.includes(id))) {
    const fs_ = r.findings.filter((x) => x.section === id);
    L.push('', `${name} (${fs_.length ? `${fs_.length} finding${fs_.length > 1 ? 's' : ''}` : 'no findings'})`);
    for (const x of (all ? fs_ : fs_.slice(0, 6))) { L.push(`  ${x.severity.toUpperCase().padEnd(6)} ${x.title}: ${x.evidence}`); L.push(`         fix: ${x.fix}`); }
    if (!all && fs_.length > 6) L.push(`  … ${fs_.length - 6} more (--all)`);
  }
  if (r.cloud.knownFixedMonthlyUsd) L.push('', `Cloud: about $${r.cloud.knownFixedMonthlyUsd}/month in always-on resources found in your infrastructure code (list prices, us-east-1, estimate).`);
  L.push('', r.settings ? `Checked against your settings (${r.settings.file}): files over ${r.settings.limits.fileLines} lines, functions over ${r.settings.limits.fnLines}, nesting over ${r.settings.limits.nesting}${r.settings.ignore.length ? `; skipped ${r.settings.ignore.join(', ')}` : ''}. Change them: skillhawk setup --only health` : 'Checked against Skillhawk defaults (600-line files, 80-line functions, nesting 5). Set your own: skillhawk setup --only health');
  L.push('Heuristic, local checks: nothing was uploaded. For a written system-design review, ask your agent to run /skillhawk:health.');
  return L.join('\n');
}

export async function run(args, flags = {}) {
  const r = health(args[0] || '.');
  if (flags.json) { const s = JSON.stringify(r, null, 2); if (typeof flags.json === 'string') fs.writeFileSync(flags.json, `${s}\n`); else console.log(s); }
  else console.log(render(r, { all: !!flags.all }));
  if (flags.failOn || flags['fail-on']) { const lvl = flags.failOn || flags['fail-on']; if (r.findings.some((x) => ORDER[x.severity] <= ORDER[lvl])) process.exitCode = 3; }
}
