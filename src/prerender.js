// Static, JS-free pages for search engines and AI answer engines. Called by `export site` after the SPA files are copied.
// Writes /skills/<id>/, /skills/, /tools/<slug>/, /tools/, /proof/*, /learn/<slug>/, sitemap.xml, robots.txt, llms.txt,
// llms-full.txt, and puts the landing's real text into index.html. The hash-router app keeps working on top: app.js
// replaces <main id="app"> as soon as it runs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LEARN } from './prerender-content.js';

export const DEFAULT_SITE_URL = 'https://skillhawk.ai';
// Cloudflare Web Analytics (cookieless, anonymous counts) for the public skillhawk.ai build only. Self-hosted exports
// for any other site URL get no analytics.
const CF_BEACON_TOKEN = '4dca467d2e5844e980e8c97c370470c2';
const beaconTag = (siteUrl) => (siteUrl === DEFAULT_SITE_URL ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${CF_BEACON_TOKEN}"}'></script>` : '');
const BOTS = ['*', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Googlebot', 'Bingbot', 'Applebot-Extended', 'CCBot'];

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const plain = (s) => String(s ?? '').replace(/`/g, '');
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const npx = (cmd) => `npx ${cmd}`;
const LISTINGS = {
  npm: 'https://www.npmjs.com/package/skillhawk',
  registry: 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.agentwik-labs/skillhawk',
  glama: 'https://glama.ai/mcp/servers/agentwik-labs/skillhawk',
};
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const SECURE_LABEL = { clean: 'No security findings', low: 'Low-severity findings', medium: 'Medium-severity findings to review', high: 'High-severity findings' };
const SITE_DESC = "Free, open-source CLI that shows which account your unattended coding agents bill (subscription or pay-per-token API key), and grades, security-checks and compiles AI agent skills.";
// Content Signals (contentsignals.org): search engines, answer engines and model training may all use this site.
const CONTENT_SIGNAL = 'Content-Signal: search=yes, ai-input=yes, ai-train=yes';
// Skills published at /.well-known/agent-skills/ (Agent Skills Discovery RFC v0.2.0).
const AGENT_SKILLS = [{ name: 'skillhawk', dir: fileURLToPath(new URL('../skills/skillhawk/', import.meta.url)) }];

/** Read the landing's journey data out of web/app.js so the static text and the app never disagree. */
export function loadJourney(webDir) {
  const src = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
  const a = src.indexOf('const FREE');
  const b = src.indexOf('\nfunction lpNav');
  if (a < 0 || b < 0) throw new Error('prerender: cannot find the landing data in web/app.js');
  return new Function(`${src.slice(a, b)}\nreturn { JOURNEY, PROTECT, ROADMAP, PRICING: typeof PRICING === 'undefined' ? null : PRICING, WATCH: typeof WATCH === 'undefined' ? null : WATCH };`)();
}

function allTools({ JOURNEY, PROTECT }) {
  const list = [];
  for (const s of JOURNEY) for (const t of s.tools) list.push({ ...t, step: s.step, stepId: s.id, tier: s.tier });
  for (const g of PROTECT.groups) for (const t of g.tools) list.push({ ...t, step: PROTECT.step, stepId: PROTECT.id, tier: PROTECT.tier, group: g.name });
  const seen = new Set();
  for (const t of list) { let s = slugify(t.name); while (seen.has(s)) s += '-2'; seen.add(s); t.slug = s; }
  return list;
}

const parseTable = (md) => {
  const rows = md.split('\n').filter((l) => /^\|/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  return rows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
};
const table = (rows, cls = 'list') => {
  if (!rows.length) return '';
  const [head, ...body] = rows;
  return `<table class="${cls}"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c && c.html !== undefined ? c.html : inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
};

export function prerenderSite({ out, webDir, reportsDir, siteUrl: siteUrlIn, now = new Date() }) {
  const siteUrl = String(siteUrlIn || process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
  const today = now.toISOString().slice(0, 10);
  const journey = loadJourney(webDir);
  const tools = allTools(journey);
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const lib = readJson(path.join(out, 'media', 'library.json'));
  const proof = readJson(path.join(out, 'media', 'proof.json')) || {};
  const libSkills = lib?.skills || [];
  const libDate = (lib?.generatedAt || today).slice(0, 10);
  const urls = []; // { loc, lastmod }
  const texts = {}; // path -> plain text for llms-full.txt

  const write = (rel, content) => { const f = path.join(out, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

  const NAV = (b) => `<header class="top">
    <a class="brand" href="${b}"><span class="mark" aria-hidden="true"></span>skillhawk</a>
    <nav aria-label="Site"><a href="${b}install/">Install</a><a href="${b}skills/">Skills</a><a href="${b}tools/">Tools</a><a href="${b}proof/">Proof</a><a href="${b}learn/">Learn</a><a href="${b}pricing/">Pricing</a><a href="${b}#/teams">For teams</a><a href="${b}#/browse">Open the app</a></nav>
  </header>`;
  const FOOT = (b) => `<footer class="foot"><span>Skillhawk shows which account your unattended agents bill, and checks the skills they run. Open source (MIT). Questions: <a href="mailto:help@skillhawk.ai">help@skillhawk.ai</a></span><span><a href="${b}install/">Install</a> · <a href="${b}tools/">Tools</a> · <a href="${b}skills/">Skills</a> · <a href="${b}proof/">Proof</a> · <a href="${b}learn/">Learn</a> · <a href="${b}llms.txt">llms.txt</a> · <a href="${LISTINGS.npm}">npm</a> · <a href="${LISTINGS.glama}">Glama</a> · <a href="https://github.com/agentwik-labs/skillhawk">GitHub</a></span></footer>`;

  const page = ({ p, title, description, body, ld = [], lastmod = today, type = 'article' }) => {
    // Search results show about 60 characters of a title and 155 of a description; cut at a word, never mid-word.
    const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; const c = t.slice(0, n - 1); return `${c.slice(0, Math.max(c.lastIndexOf(' '), n * 0.6)).replace(/[\s,;:.\u2013\u2014-]+$/, '')}…`; };
    { const m = / \| Skillhawk$/.exec(title || ''); title = m ? `${clip(title.slice(0, m.index), 65 - m[0].length)}${m[0]}` : clip(title, 65); } // keep the brand suffix
    description = clip(description, 158);
    const depth = p.split('/').filter(Boolean).length;
    const b = depth ? '../'.repeat(depth) : '';
    const url = `${siteUrl}${p}`;
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="${type}">
  <meta property="og:site_name" content="Skillhawk">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${siteUrl}/media/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${siteUrl}/media/og.png">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <link rel="icon" href="${b}favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${b}style.css">
  <link rel="stylesheet" href="${b}landing.css">
  <link rel="stylesheet" href="${b}static.css">
  ${ld.map(jsonLd).join('\n  ')}
  ${beaconTag(siteUrl)}
</head>
<body class="sp">
  ${NAV(b)}
  <main class="sp-main">
${body(b)}
  </main>
  ${FOOT(b)}
</body>
</html>
`;
    write(`${p.replace(/^\//, '')}index.html`, html);
    urls.push({ loc: url, lastmod });
  };

  const crumbs = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${siteUrl}${p}` })) });
  const trail = (b, items) => `<nav class="sp-crumbs" aria-label="Breadcrumb">${items.map(([n, p]) => (p ? `<a href="${b}${p.replace(/^\//, '')}">${esc(n)}</a>` : `<span>${esc(n)}</span>`)).join(' / ')}</nav>`;
  const code = (s) => `<pre tabindex="0"><code>${esc(s)}</code></pre>`;

  // ---- static.css ---------------------------------------------------------------------------------------------
  write('static.css', `/* Styles for the pre-rendered pages. Colours, fonts and tables come from style.css. */
.sp-main { max-width: 860px; padding-top: 28px; }
.sp-main h1 { font-size: clamp(1.9rem, 1.3rem + 2vw, 2.7rem); line-height: 1.12; letter-spacing: -0.03em; margin: 8px 0 14px; }
.sp-main h2 { font-size: 1.35rem; letter-spacing: -0.02em; margin: 34px 0 10px; }
.sp-main h3 { font-size: 1.05rem; margin: 22px 0 6px; }
.sp-main p, .sp-main li { font-size: 1.05rem; line-height: 1.6; color: var(--ink-2); max-width: 70ch; }
.sp-main p.sp-answer { color: var(--ink); font-size: 1.2rem; line-height: 1.5; }
.sp-main li { margin: 6px 0; }
.sp-main pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
.sp-main :not(pre) > code { background: var(--code-bg); padding: 1px 6px; border-radius: 5px; }
.sp-main table.list { margin: 12px 0 20px; display: block; overflow-x: auto; }
.sp-crumbs { font-size: 13px; color: var(--muted); }
.sp-crumbs a { color: var(--muted); }
.sp-meta { font-size: 13px; color: var(--muted); }
.sp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; padding: 0; list-style: none; }
.sp-grid li { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin: 0; background: var(--surface); }
.sp-grid li a { font-weight: 600; text-decoration: none; }
.sp-grid li p { margin: 6px 0 0; font-size: 14px; }
.sp-cta { display: inline-block; margin: 8px 8px 0 0; padding: 9px 16px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); text-decoration: none; font-weight: 500; }
.sp-badge { height: 20px; vertical-align: middle; }
.sp-step { margin: 26px 0; }
.sp-quote { border-left: 3px solid var(--line); padding-left: 12px; color: var(--muted); font-style: italic; }
@media (max-width: 600px) { .sp-main { padding: 20px 16px 48px; } .top { flex-wrap: wrap; gap: 10px 18px; padding: 14px 16px; } .top nav { flex-wrap: wrap; gap: 8px 16px; } }
`);

  // ---- tools --------------------------------------------------------------------------------------------------
  const NO_OUT = 'Run the command to see its output; no sample is shown here.';
  const noOutOf = (t) => t.noOut || NO_OUT;
  const toolText = (t) => `${t.name} (${t.step})\n${t.what}\nCommand: ${t.cmd}\n${t.out ? `Example output:\n${t.out}` : noOutOf(t)}\n${t.note ? `${t.note}\n` : ''}`;
  for (const t of tools) {
    const p = `/tools/${t.slug}/`;
    const title = `Skillhawk ${t.name}: ${t.what.split(/(?<=\.)\s/)[0].replace(/\.$/, '')}`;
    const ld = [crumbs([['Skillhawk', '/'], ['Tools', '/tools/'], [t.name, p]]), {
      '@context': 'https://schema.org', '@type': 'HowTo', name: `Use skillyard: ${t.name}`,
      step: [{ '@type': 'HowToStep', name: 'Run the command', text: `Run: ${npx(t.cmd)}` }, { '@type': 'HowToStep', name: 'Read the output', text: t.out || noOutOf(t) }],
    }];
    page({ p, title, description: `${t.what} Command: ${t.cmd}`.slice(0, 300), ld, body: (b) => `${trail(b, [['Skillhawk', ''], ['Tools', 'tools/'], [t.name]])}
    <h1>${esc(t.name)}</h1>
    <p class="sp-answer">${esc(t.what)}</p>
    <p class="sp-meta">${esc(t.step)} step · ${esc(t.tier)}</p>
    <h2>The command</h2>
    ${code(npx(t.cmd))}
    <h2>${t.out ? 'Example output' : 'Output'}</h2>
    ${t.out ? `<p>From a real run on the repository's examples, test fixtures or demo data; long output shortened.</p>${code(t.out)}` : `<p>${esc(noOutOf(t))}</p>`}
    ${t.note ? `<p>${esc(t.note)}</p>` : ''}
    ${(() => { const w = t.cmd.split(' ')[1]; const rel = LEARN.filter((l) => new RegExp(`skillhawk ${w}\\b`).test(l.command?.code || '')); return rel.length ? `<h2>Answers</h2><ul>${rel.map((l) => `<li><a href="${b}learn/${l.slug}/">${esc(l.title)}</a></li>`).join('')}</ul>` : ''; })()}
    <p><a href="${b}tools/">All tools</a> · <a href="${b}#/?s=${t.stepId}">See it in the app</a> · <a href="https://github.com/agentwik-labs/skillhawk">Source on GitHub</a></p>` });
    texts[p] = toolText(t);
  }
  page({ p: '/tools/', title: 'Skillhawk tools: build, check, improve, save and protect AI skills', description: 'Every Skillhawk command with what it does, how to run it and real example output.', ld: [crumbs([['Skillhawk', '/'], ['Tools', '/tools/']])],
    body: (b) => `${trail(b, [['Skillhawk', ''], ['Tools']])}
    <h1>Skillhawk tools</h1>
    <p class="sp-answer">Each tool is a command in the open-source CLI. Free tools run on your machine. The Protect tools are open source too and run on your own server; hosted Pro is planned and not running yet, and team vaults are by request.</p>
    ${[...journey.JOURNEY, journey.PROTECT].map((s) => `<h2>${esc(s.step)}: ${esc(s.h)}</h2><p>${esc(s.promise)}</p><ul class="sp-grid">${tools.filter((t) => t.stepId === s.id).map((t) => `<li><a href="${b}tools/${t.slug}/">${esc(t.name)}</a><p>${esc(t.what)}</p></li>`).join('')}</ul>`).join('\n')}` });

  // ---- pricing ------------------------------------------------------------------------------------------------
  const P = journey.PRICING;
  if (P) {
    const plan = (id) => P.plans.find((x) => x.id === id);
    const [pro, team] = [plan('pro'), plan('team')];
    if (!pro) throw new Error('prerender: PRICING needs a plan with id "pro"');
    const perOf = (x) => (x.per ? ` ${x.per}` : '');
    // Listed prices only: nothing is sold through this page (no checkout), so the offers carry no url or availability.
    const offers = P.plans.filter((x) => typeof x.monthlyUsd === 'number').map((x) => ({ '@type': 'Offer', name: x.name, price: String(x.monthlyUsd), priceCurrency: 'USD', description: `${x.price}${perOf(x)}. ${x.blurb} ${P.note}` }));
    const watch = plan('watch');
    const summary = `Free open-source developer tools.${watch ? ` Watch ${watch.price}${perOf(watch)} (waitlist; built, not on sale yet).` : ''} Pro ${pro.price}${perOf(pro)} for your own private vault (waitlist).${team ? ' Teams by request.' : ''}`;
    page({ p: '/pricing/', title: 'Skillhawk pricing: free checks today, Watch planned at $9 a month', description: `${summary} ${P.note}`,
      ld: [crumbs([['Skillhawk', '/'], ['Pricing', '/pricing/']]), { '@context': 'https://schema.org', '@type': 'Product', name: 'Skillhawk', description: 'Build, check and protect your company\'s AI agent skills.', offers }],
      body: (b) => `${trail(b, [['Skillhawk', ''], ['Pricing']])}
    <h1>${esc(P.heading || 'Skillhawk pricing')}</h1>
    <p class="sp-answer">The developer tools are free and open source. ${watch ? `Watch (${esc(watch.price)}${esc(perOf(watch))} when it goes on sale; built, not on sale yet) is a background guard on your machine: it warns when a scheduled agent starts billing an API key, tracks the cost of each headless job, and can stop a runaway one. ` : ''}Pro (${esc(pro.price)}${esc(perOf(pro))}, waitlist) is a private vault for your skills; the software is built and open source, and the hosted version is not running yet. ${team ? `${esc(team.blurb)} ` : ''}${esc(P.note)}</p>
    ${P.plans.map((x) => `<h2>${esc(x.name)}: ${esc(x.price)}${esc(perOf(x))}</h2><p>${esc(x.blurb)}</p><ul>${x.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`).join('\n')}
    <p><a href="${b}#/?s=pilot">Join the Watch waitlist</a> · <a href="${b}#/teams">Teams: talk to us</a></p>` });
    texts['/pricing/'] = `Pricing\n${P.plans.map((x) => `${x.name}: ${x.price}${perOf(x)}. ${x.blurb} ${x.items.join('; ')}.`).join('\n')}\n${P.note}`;
  }

  // ---- install: where to find Skillhawk in the tools people already use ---------------------------------------
  {
    const mcpJson = (key, extra = {}) => JSON.stringify({ [key]: { skillhawk: { ...extra, command: 'npx', args: ['-y', 'skillhawk', 'mcp'] } } }, null, 2);
    const CLIENTS = [
      ['Claude Code', 'npx skillhawk connect claude --write', 'claude mcp add --scope user skillhawk -- npx -y skillhawk mcp'],
      ['Codex', 'npx skillhawk connect codex --write', '# ~/.codex/config.toml\n[mcp_servers.skillhawk]\ncommand = "npx"\nargs = ["-y", "skillhawk", "mcp"]'],
      ['Cursor', 'npx skillhawk connect cursor --write', `// .cursor/mcp.json\n${mcpJson('mcpServers')}`],
      ['VS Code (Copilot)', 'npx skillhawk connect vscode --write', `// .vscode/mcp.json\n${mcpJson('servers', { type: 'stdio' })}`],
      ['Gemini CLI', 'npx skillhawk connect gemini --write', `// ~/.gemini/settings.json\n${mcpJson('mcpServers')}`],
      ['Claude Desktop', 'npx skillhawk connect claude-desktop --write', `// claude_desktop_config.json\n${mcpJson('mcpServers')}`],
    ];
    const LISTED = [
      ['npm', LISTINGS.npm, 'The package: npx skillhawk, no install needed.'],
      ['Official MCP Registry', LISTINGS.registry, 'Listed as io.github.agentwik-labs/skillhawk (registry entry, JSON).'],
      ['Glama MCP directory', LISTINGS.glama, 'MCP server listing with a build test of the tools.'],
      ['GitHub', 'https://github.com/agentwik-labs/skillhawk', 'Source, issues and releases (MIT).'],
    ];
    const FOR_AGENTS = [
      ['llms.txt', '/llms.txt', 'Site summary for language models.'],
      ['Agent skill', '/.well-known/agent-skills/skillhawk/SKILL.md', 'A SKILL.md your agent can load to use Skillhawk (discovery index at /.well-known/agent-skills/index.json).'],
    ];
    page({ p: '/install/', title: 'Install Skillhawk: CLI, MCP server and where to find it | Skillhawk',
      description: 'Run Skillhawk with npx, add its MCP server to Claude Code, Codex, Cursor, VS Code, Gemini CLI or Claude Desktop, and find it on npm, the MCP Registry and Glama.',
      ld: [crumbs([['Skillhawk', '/'], ['Install', '/install/']])],
      body: (b) => `${trail(b, [['Skillhawk', ''], ['Install']])}
    <h1>Use Skillhawk where you already work</h1>
    <p class="sp-answer">Everything here is free and open source and runs on your machine: no account, no key, nothing uploaded. You need Node.js 20 or newer.</p>
    <h2>1. Run the free check</h2>
    ${code('npx skillhawk agents')}
    <p>Lists agents that run without you and which account each scheduled one bills: your subscription or a pay-per-token API key. It prints variable names only, never key values. More commands on the <a href="${b}tools/">tools</a> page.</p>
    <h2>2. Add the MCP server to your agent</h2>
    <p>Your agent gets four tools: <code>review_skill</code>, <code>secure_scan</code>, <code>compile_skill</code> and <code>check_agents</code>. They run locally over stdio. <code>connect</code> writes the config for you; without <code>--write</code> it prints it so you can check it first.</p>
    ${CLIENTS.map(([n, cmd, manual]) => `<h3>${esc(n)}</h3>${code(cmd)}<details><summary>Or add it by hand</summary>${code(manual)}</details>`).join('\n')}
    <p>Any other MCP client: start the server with <code>npx -y skillhawk mcp</code>.</p>
    <h2>3. Find Skillhawk in directories</h2>
    <ul>${LISTED.map(([n, u, d]) => `<li><a href="${esc(u)}" rel="noopener">${esc(n)}</a>: ${esc(d)}</li>`).join('')}</ul>
    <h2>For agents reading this site</h2>
    <ul>${FOR_AGENTS.map(([n, u, d]) => `<li><a href="${b}${u.replace(/^\//, '')}">${esc(n)}</a>: ${esc(d)}</li>`).join('')}</ul>
    <p>The home page also offers browser agents two read-only WebMCP tools, where the browser supports WebMCP.</p>
    <h2>Questions</h2>
    <p>Email <a href="mailto:help@skillhawk.ai">help@skillhawk.ai</a> or open an issue on <a href="https://github.com/agentwik-labs/skillhawk/issues" rel="noopener">GitHub</a>.</p>` });
    texts['/install/'] = `Install\nRun: npx skillhawk agents\nMCP: ${CLIENTS.map(([n, cmd]) => `${n}: ${cmd}`).join('; ')}. Any client: npx -y skillhawk mcp\nListed on: ${LISTED.map(([n, u]) => `${n} ${u}`).join('; ')}\nContact: help@skillhawk.ai`;
  }

  // ---- skills -------------------------------------------------------------------------------------------------
  const refOf = (s) => (idScope(s) === 'skillyard' ? s.name : s.id);
  const srcUrl = (s) => (s.source?.repo ? (/^https?:/.test(s.source.repo) ? s.source.repo : `https://github.com/${s.source.repo}`) : null);
  const idScope = (s) => s.id.split('/')[0].slice(1);
  const skillPath = (s) => `/skills/${idScope(s)}/${s.name}/`;
  const badgeFile = (s) => `media/badges/${idScope(s)}/${s.name}.svg`;
  const nFind = (f) => (f ? f.high + f.medium + f.low : 0);
  for (const s of libSkills) {
    const p = skillPath(s);
    const title = `${s.title} agent skill: grade ${s.grade}, ${SECURE_LABEL[s.secure].toLowerCase()} | Skillhawk`;
    const n = nFind(s.findings);
    const desc = `${s.title} (${s.id}): ${s.description} Skillhawk grade ${s.grade} (${s.score}/100), ${SECURE_LABEL[s.secure].toLowerCase()}.`.replace(/\s+/g, ' ').slice(0, 300);
    const hasBadge = fs.existsSync(path.join(out, badgeFile(s)));
    const li = (f) => `<li><b>${esc(f.severity)}</b> <code>${esc(f.file)}:${f.line}</code> [${esc(f.rule)}] ${esc(f.message)}</li>`;
    page({ p, title, description: desc, lastmod: libDate, ld: [crumbs([['Skillhawk', '/'], ['Skills', '/skills/'], [s.title, p]])], body: (b) => `${trail(b, [['Skillhawk', ''], ['Skills', 'skills/'], [s.title]])}
    <h1>${esc(s.title)}</h1>
    <p class="sp-answer">${esc(s.description)}</p>
    <p class="sp-meta"><code>${esc(s.id)}</code> · ${esc(s.category)}${hasBadge ? ` · <img class="sp-badge" src="${b}${badgeFile(s)}" alt="Skillhawk badge: grade ${esc(s.grade)}">` : ''}</p>
    <h2>Skillhawk's judgement</h2>
    ${table([['Measure', 'Result'], ['Grade', `${s.grade} (${s.score}/100)`], ['Review findings', n ? `${n} (${s.findings.high} high, ${s.findings.medium} medium, ${s.findings.low} low)` : 'none'], ['Security', `${SECURE_LABEL[s.secure]}${nFind(s.secureFindings) ? ` (${s.secureFindings.high} high, ${s.secureFindings.medium} medium, ${s.secureFindings.low} low)` : ''}`], ['Size', `about ${s.tokens} tokens, paid on every load`], ['Licence', s.source?.licence || 'not stated'], ['Source', srcUrl(s) ? srcUrl(s) : 'Skillhawk community']])}
    ${s.top?.length ? `<h3>Top review findings</h3><ul>${s.top.map(li).join('')}</ul>` : ''}
    ${s.secureTop?.length ? `<h3>Security findings</h3><ul>${s.secureTop.map(li).join('')}</ul>` : ''}
    <p class="sp-meta">Judged ${esc(libDate)} by <code>skillhawk review</code> and <code>skillhawk secure</code>, the same code as the CLI. Method on the <a href="${b}proof/library/">library grades</a> page. Automated checks, not an endorsement.</p>
    <h2>Install</h2>
    ${code(npx(`skillhawk install ${refOf(s)} --agent claude`))}
    <p>Add <code>-g</code> to install for every project. ${srcUrl(s) ? `Original source: <a href="${esc(srcUrl(s))}" rel="noopener">${esc(srcUrl(s).replace('https://github.com/', ''))}</a> (${esc(s.source.licence || 'licence not stated')}).` : 'Maintained in the Skillhawk community registry.'}</p>
    <p><a class="sp-cta" href="${b}#/skill/${esc(s.id)}">Open the full skill in the app</a><a href="${b}skills/">All skills</a></p>` });
  }
  const byGrade = (g) => libSkills.filter((s) => s.grade === g).length;
  page({ p: '/skills/', title: `Agent skill library: ${libSkills.length} skills graded A to F and security-checked | Skillhawk`, description: `${libSkills.length} public agent skills with Skillhawk's grade, findings and security status. Install them from a registry you run yourself (skillhawk serve).`, lastmod: libDate, ld: [crumbs([['Skillhawk', '/'], ['Skills', '/skills/']])],
    body: (b) => `${trail(b, [['Skillhawk', ''], ['Skills']])}
    <h1>Skill library</h1>
    <p class="sp-answer">${libSkills.length} public skills, each graded A to F by <code>skillhawk review</code> and checked by <code>skillhawk secure</code>. Judged ${esc(libDate)}. <a href="${b}proof/library/">How we grade</a>.</p>
    ${table([['Skill', 'Grade', 'Security', 'Category', 'Licence'], ...[...libSkills].sort((a, c) => a.name.localeCompare(c.name)).map((s) => [{ html: `<a href="${b}skills/${idScope(s)}/${s.name}/">${esc(s.title)}</a>` }, s.grade, SECURE_LABEL[s.secure], s.category, s.source?.licence || '-'])])}` });

  // ---- proof --------------------------------------------------------------------------------------------------
  const report = (f) => { try { return fs.readFileSync(path.join(reportsDir, f), 'utf8'); } catch { return ''; } };
  const proofPages = [];
  const proofPage = (slug, title, description, lastmod, body, text) => {
    const p = `/proof/${slug}/`;
    proofPages.push({ slug, title, description, p });
    page({ p, title, description, lastmod, ld: [crumbs([['Skillhawk', '/'], ['Proof', '/proof/'], [title, p]])], body: (b) => `${trail(b, [['Skillhawk', ''], ['Proof', 'proof/'], [title]])}\n${body(b)}` });
    texts[p] = text;
  };
  const sc = proof.scan || {};
  const scanMd = report('2026-10-top-skills-scan.md');
  const scanRows = parseTable((scanMd.match(/\| Flag \|[\s\S]*?(?=\n\n)/) || [''])[0]);
  proofPage('scan', 'We scanned 511 skills from the skills.sh leaderboard repos: what we found', 'Scan of 511 unique skills from 34 GitHub repos (2026-10-29): 96 ship scripts, 85 make network calls, 0 confirmed malicious. Method and limits included.', '2026-10-29', () => `
    <h1>We scanned ${sc.skills || 511} skills from the 34 repositories linked from the skills.sh leaderboard</h1>
    <p class="sp-answer">On 2026-10-29 we scanned ${sc.skills || 511} unique skills from the 34 GitHub repositories linked from the skills.sh all-time leaderboard. ${sc.confirmed_malicious ?? 0} were confirmed malicious after we hand-read every critical flag. ${sc.ship_scripts || 96} ship executable scripts, ${sc.network_calls || 85} make network calls from their scripts, and ${sc.fail_format || 33} fail the Agent Skills format.</p>
    <h2>Numbers</h2>
    ${table([['Measure', 'Count'], ['Unique skills scanned', String(sc.skills || 511)], ['Source repositories', '34'], ['Skills that ship executable scripts', String(sc.ship_scripts || 96)], ['Skills with network calls in scripts', String(sc.network_calls || 85)], ['Skills failing the Agent Skills format', String(sc.fail_format || 33)], ['Confirmed malicious (by this method)', String(sc.confirmed_malicious ?? 0)]])}
    <h2>What the false positives were</h2>
    <p>Our first pass flagged 40 folders as critical; all 40 were false positives. Good skills quote injection attacks to teach the agent to spot them, so a scanner that blocks on the phrase blocks the safest skills.</p>
    ${table(scanRows)}
    <h2>Method</h2>
    <ol><li>Took every repo linked from the skills.sh home page leaderboard on 2026-10-29 (34 repos), shallow-cloned each, ran nothing.</li><li>Found every folder with a <code>SKILL.md</code>, ran the Agent Skills format check and Skillhawk's scanner, and de-duplicated by <code>SKILL.md</code> hash.</li><li>Read every critical finding in context by hand.</li></ol>
    <p><b>Limits.</b> It is pattern matching, not a sandbox. It cannot see what a downloaded binary does, and a careful attacker can write around regexes. Read "0 confirmed" as "0 found by this method", not "safe". Rerun it with <code>npx skillhawk scan &lt;dir&gt;</code>.</p>
    <p><a href="../../learn/are-agent-skills-safe/">Are agent skills safe? What to check before installing one</a></p>`,
  `511-skill scan (2026-10-29): ${sc.skills || 511} unique skills, 34 repos; ${sc.ship_scripts} ship scripts, ${sc.network_calls} network calls, ${sc.fail_format} fail format, ${sc.confirmed_malicious ?? 0} confirmed malicious by hand-review. Pattern matching, not a sandbox.`);

  const liftRows = (proof.lift?.rows || []).map((r) => [r.skill, `${r.without}%`, `${r.with}%`, `${r.with - r.without >= 0 ? '+' : ''}${r.with - r.without} pts`]);
  proofPage('lift', 'Do agent skills help? Lift evals with and without the skill', 'Same task, same model (Claude Haiku), with and without the skill installed: four skills, 2 runs per condition, fixed checks and no AI judge.', '2026-10-29', () => `
    <h1>Do skills actually help? We measured.</h1>
    <p class="sp-answer">Across four skills, the same task on the same model scored higher with the skill installed in three cases and equal in one (the base model already knew database migrations). This is a small sample: one task per skill, 2 runs per condition.</p>
    <h2>Results</h2>
    ${table([['Skill', 'Without skill', 'With skill', 'Lift'], ...liftRows])}
    <h2>Method</h2>
    <p>Claude Code with Claude Haiku, run 2026-10-29. Each task ran twice in an empty folder and twice with the skill installed in <code>.claude/skills/</code>. Each answer is graded by fixed checks in the skill's <code>evals/evals.json</code>; there is no AI judge. Lift is the with-skill score minus the without-skill score. Rerun: <code>npx skillhawk eval &lt;skill-dir&gt; --model haiku --runs 3</code>.</p>
    <p><b>Limit.</b> These runs used the author's normal Claude Code setup, so personal instructions and memory were loaded in both conditions. <code>skillhawk eval</code> now runs locked down, so reruns may differ slightly.</p>
    <p>Source: <code>reports/2026-10-lift-evals.md</code> in the <a href="https://github.com/agentwik-labs/skillhawk">repository</a>.</p>`,
  `Lift evals (2026-10-29, Claude Haiku, 2 runs per condition): ${liftRows.map((r) => `${r[0]} ${r[1]} -> ${r[2]} (${r[3]})`).join('; ')}. Small sample; fixed checks, no AI judge.`);

  const rp = proof.reviewer_precision;
  const rpRows = rp ? rp.skills.map((k, i) => [k, rp.before[i], rp.after[i]]) : [];
  proofPage('reviewer-accuracy', 'How accurate is the Skillhawk reviewer? A false-positive corpus', 'We graded six well-made skills (ibelick/ui-skills, MIT) before and after fixing the reviewer\'s false positives: grades moved from D, C, F to A and B.', today, () => `
    <h1>How accurate is the reviewer?</h1>
    <p class="sp-answer">A reviewer that cries wolf gets ignored. We used six well-made third-party skills (${esc(rp?.source || 'ibelick/ui-skills (MIT)')}) as a false-positive corpus: skills that should grade well. Before we fixed the reviewer's rules they graded ${esc(rp?.before.join(', '))}; after, ${esc(rp?.after.join(', '))}.</p>
    ${table([['Skill', 'Grade before fixes', 'Grade after fixes'], ...rpRows])}
    <h2>Method and limits</h2>
    <p>Grades come from <code>skillhawk review</code> (A to F with line-level findings), run on the same six skills before and after fixing the reviewer's false positives. This tests false positives only. It does not measure how many real problems the reviewer misses, and six skills from one author is a small corpus. The reviewer uses deterministic heuristics, no model calls.</p>`,
  `Reviewer accuracy: false-positive corpus of ${rp?.skills.length} skills. ${rpRows.map((r) => `${r[0]} ${r[1]} -> ${r[2]}`).join('; ')}. Tests false positives only; small corpus.`);

  const g = lib?.grades || {};
  proofPage('library', `Library grades: ${lib?.total || libSkills.length} public skills reviewed and security-checked`, `Grade distribution and security status for ${lib?.total || libSkills.length} public agent skills, judged ${libDate} with skillhawk review and skillhawk secure.`, libDate, (b) => `
    <h1>Library grades</h1>
    <p class="sp-answer">${lib?.total || libSkills.length} public skills judged on ${esc(libDate)}: ${['A', 'B', 'C', 'D', 'F'].map((k) => `${g[k] ?? 0} grade ${k}`).join(', ')}. ${lib?.secure ? `Security: ${lib.secure.clean} clean, ${lib.secure.low} low, ${lib.secure.medium} medium, ${lib.secure.high} high.` : ''}</p>
    <h2>Grades</h2>
    ${table([['Grade', 'Skills'], ...['A', 'B', 'C', 'D', 'F'].map((k) => [k, String(g[k] ?? 0)])])}
    <h2>Security status</h2>
    ${lib?.secure ? table([['Status', 'Skills'], ['Clean', String(lib.secure.clean)], ['Low severity', String(lib.secure.low)], ['Medium severity', String(lib.secure.medium)], ['High severity', String(lib.secure.high)]]) : ''}
    <h2>Method</h2>
    <p>${esc(lib?.method || 'Grade from skillhawk review (A to F, line-level findings). Security from skillhawk secure.')} Sources are public repositories under their own licences; we link each one on its skill page. Grades are automated checks of instruction quality (contradictions, vague wording, size, broken links), not a judgement of the author or a guarantee of safety.</p>
    <p>By scope: ${Object.entries(lib?.scopes || {}).map(([k, v]) => `${v} ${esc(k)}`).join(', ')}. <a href="${b}skills/">Browse all skills</a>.</p>`,
  `Library grades (${libDate}): ${lib?.total} skills; ${['A', 'B', 'C', 'D', 'F'].map((k) => `${k}=${g[k] ?? 0}`).join(' ')}; security clean=${lib?.secure?.clean} low=${lib?.secure?.low} medium=${lib?.secure?.medium} high=${lib?.secure?.high}.`);

  page({ p: '/proof/', title: 'Skillhawk proof: measured results, with method', description: 'Skill scan of 511 skills, lift evals, reviewer accuracy and library grades. Dated, with method and limits.', ld: [crumbs([['Skillhawk', '/'], ['Proof', '/proof/']])],
    body: (b) => `${trail(b, [['Skillhawk', ''], ['Proof']])}
    <h1>Measured, not claimed</h1>
    <p class="sp-answer">The scan, lift, reviewer and library numbers come from runs you can repeat from the repository. The token week on the landing page is one developer's own logs. Small samples are labelled as small.</p>
    <ul class="sp-grid">${proofPages.map((x) => `<li><a href="${b}proof/${x.slug}/">${esc(x.title)}</a><p>${esc(x.description)}</p></li>`).join('')}</ul>` });

  // ---- learn --------------------------------------------------------------------------------------------------
  const learnText = (l) => [`${l.title}`, l.answer, ...l.sections.flatMap((s) => [s.h, ...(s.paras || []), ...(s.list || []).map((x) => `- ${x}`)]), 'Worked example', l.example.intro, l.example.code, 'The Skillhawk command', l.command.intro, l.command.code, l.command.note, 'Sources', ...l.sources.map((x) => `- ${x.label}: ${x.url}`)].map(plain).join('\n');
  for (const l of LEARN) {
    const p = `/learn/${l.slug}/`;
    const ld = [crumbs([['Skillhawk', '/'], ['Learn', '/learn/'], [l.title, p]]), { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: l.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: plain(f.a) } })) }];
    if (l.howto) ld.push({ '@context': 'https://schema.org', '@type': 'HowTo', name: l.howto.name, step: l.howto.steps.map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name, text })) });
    page({ p, title: `${l.title} | Skillhawk`, description: l.desc, ld, body: (b) => `${trail(b, [['Skillhawk', ''], ['Learn', 'learn/'], [l.title]])}
    <h1>${esc(l.title)}</h1>
    <p class="sp-answer">${inline(l.answer)}</p>
    ${l.sections.map((s) => `<h2>${esc(s.h)}</h2>${(s.paras || []).map((x) => `<p>${inline(x)}</p>`).join('')}${s.list ? `<ul>${s.list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}`).join('\n')}
    <h2>A worked example</h2>
    <p>${inline(l.example.intro)}</p>
    ${code(l.example.code)}
    <h2>The Skillhawk command that helps</h2>
    <p>${inline(l.command.intro)}</p>
    ${code(l.command.code)}
    <p>${inline(l.command.note)}</p>
    ${l.proofLink ? `<p>Data behind this: <a href="${b}proof/scan/">the 511-skill scan</a>.</p>` : ''}
    <h2>Questions</h2>
    ${l.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${inline(f.a)}</p>`).join('')}
    <h2>Sources</h2>
    <ul>${l.sources.map((x) => `<li><a href="${esc(x.url)}" rel="noopener">${esc(x.label)}</a>${x.quote ? `<br><span class="sp-quote">"${esc(x.quote)}"</span>` : ''}</li>`).join('')}</ul>
    <p class="sp-meta">Skillhawk is a tool in this space, so weigh our framing accordingly. Last updated ${today}.</p>
    <h2>Related</h2>
    <ul>${l.related.map((r) => { const x = LEARN.find((y) => y.slug === r); return `<li><a href="${b}learn/${r}/">${esc(x.title)}</a></li>`; }).join('')}</ul>
    <p><a class="sp-cta" href="${b}tools/review/">Try skillhawk review</a></p>` });
    texts[p] = learnText(l);
  }
  page({ p: '/learn/', title: 'Learn: answers about agent skills, AGENTS.md and CLAUDE.md | Skillhawk', description: 'Short, sourced answers to common problems with agent skills and instruction files.', ld: [crumbs([['Skillhawk', '/'], ['Learn', '/learn/']])],
    body: (b) => `${trail(b, [['Skillhawk', ''], ['Learn']])}
    <h1>Learn</h1>
    <p class="sp-answer">Direct answers to common problems with agent skills and instruction files, each with a worked example and sources.</p>
    <ul class="sp-grid">${LEARN.map((l) => `<li><a href="${b}learn/${l.slug}/">${esc(l.title)}</a><p>${esc(l.desc)}</p></li>`).join('')}</ul>` });

  // ---- landing (index.html) -----------------------------------------------------------------------------------
  const indexFile = path.join(out, 'index.html');
  const stepHtml = (s) => `<section id="${s.id}-static"><h2>${esc(s.step)}: ${esc(s.h)}</h2><p>${esc(s.promise)} <span class="sp-meta">${esc(s.tier)}</span></p><ul>${tools.filter((t) => t.stepId === s.id).map((t) => `<li><a href="tools/${t.slug}/"><b>${esc(t.name)}</b></a>: ${esc(t.what)} <code>${esc(t.cmd)}</code></li>`).join('')}</ul></section>`;
  const landing = `<div class="sp-landing">
    <h1>Your agents run without you. Know which account they bill.</h1>
    <p class="sp-answer">One free command finds every coding agent that runs without you (cron, launchd, scheduled CI, sessions left working) and shows which account each one bills: your subscription, or an API key that charges per token. The same CLI grades your AI skills, scans them for security problems and compiles them for five agents. Watch, built and not on sale yet, is a background guard on your machine: it warns when a scheduled agent starts billing an API key, tracks the cost of each headless job, and can stop a runaway one.</p>
    <p><code>npx skillhawk agents</code> <a class="sp-cta" href="#/?s=su-hero">Join the Watch waitlist</a></p>
    ${journey.WATCH ? `<section><h2>${esc(journey.WATCH.step)}: ${esc(journey.WATCH.h)}</h2><p>${esc(journey.WATCH.promise)} <span class="sp-meta">${esc(journey.WATCH.tier)}</span></p><ul>${journey.WATCH.tools.map((t) => `<li><b>${esc(t.name)}</b>: ${esc(t.what)}</li>`).join('')}</ul></section>` : ''}
    ${[...journey.JOURNEY, journey.PROTECT].map(stepHtml).join('\n')}
    <section><h2>Measured, not claimed</h2><p>The scan, lift, reviewer and trace numbers come from runs you can repeat from the repository; the token week is one developer's own logs.</p><ul>${proofPages.map((x) => `<li><a href="proof/${x.slug}/">${esc(x.title)}</a></li>`).join('')}</ul></section>
    <section><h2>Skill library</h2><p>${libSkills.length} public skills graded A to F and security-checked: ${['A', 'B', 'C', 'D', 'F'].map((k) => `${g[k] ?? 0} grade ${k}`).join(', ')}. <a href="skills/">Browse the library</a>.</p></section>
    <section><h2>Answers</h2><ul>${LEARN.map((l) => `<li><a href="learn/${l.slug}/">${esc(l.title)}</a></li>`).join('')}</ul></section>
    <section><h2>Planned, not built</h2><p>${journey.ROADMAP.map(esc).join(', ')}.</p></section>
  </div>`;
  if (fs.existsSync(indexFile)) {
    const ldApp = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Skillhawk', applicationCategory: 'DeveloperApplication', operatingSystem: 'macOS, Linux, Windows (Node.js 18+)', description: SITE_DESC, url: `${siteUrl}/`, license: 'https://opensource.org/license/mit', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, codeRepository: 'https://github.com/agentwik-labs/skillhawk' };
    let html = fs.readFileSync(indexFile, 'utf8');
    html = html.replace(/(<link rel="canonical" href=")[^"]*(">)/, `$1${siteUrl}/$2`).replace(/(<meta property="og:url" content=")[^"]*(">)/, `$1${siteUrl}/$2`).replace(/https:\/\/skillhawk\.ai\/media\/og\.png/g, `${siteUrl}/media/og.png`)
      .replace('</head>', `  <link rel="stylesheet" href="static.css">\n  ${jsonLd(ldApp)}\n  ${beaconTag(siteUrl)}\n</head>`)
      .replace(/<main id="app" tabindex="-1"><\/main>/, `<main id="app" tabindex="-1">\n${landing}\n  </main>`);
    html = html.replace('<nav aria-label="The journey">', '<nav aria-label="The journey">').replace(/(<a href="#\/browse">Library<\/a>)/, '$1\n      <a href="tools/">Tools</a>\n      <a href="learn/">Learn</a>');
    fs.writeFileSync(indexFile, html);
  }
  urls.unshift({ loc: `${siteUrl}/`, lastmod: today });
  texts['/'] = `${SITE_DESC}\n${journey.JOURNEY.concat(journey.PROTECT).map((s) => `${s.step}: ${s.h} ${s.promise}`).join('\n')}`;

  // ---- sitemap, robots, llms ----------------------------------------------------------------------------------
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  write('robots.txt', `# Everyone, including AI search and answer crawlers, may read the whole site.\n${BOTS.map((b) => `User-agent: ${b}\n${CONTENT_SIGNAL}\nAllow: /\n`).join('\n')}\nSitemap: ${siteUrl}/sitemap.xml\n`);
  const skillEntries = AGENT_SKILLS.map((k) => {
    const md = fs.readFileSync(path.join(k.dir, 'SKILL.md'));
    const description = /^description:\s*(.+)$/m.exec(md.toString('utf8'))?.[1].trim() ?? '';
    write(`.well-known/agent-skills/${k.name}/SKILL.md`, md);
    return { name: k.name, type: 'skill-md', description, url: `/.well-known/agent-skills/${k.name}/SKILL.md`, digest: `sha256:${crypto.createHash('sha256').update(md).digest('hex')}` };
  });
  write('.well-known/agent-skills/index.json', `${JSON.stringify({ $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills: skillEntries }, null, 2)}\n`);
  const L = (t, p, d) => `- [${t}](${siteUrl}${p}): ${d}`;
  write('llms.txt', `# Skillhawk

> ${SITE_DESC} Open source (MIT) command-line tools: show agents that run without you and the account each scheduled one bills, grade skills A to F, security-check them and the config around them, measure whether they help, compile them for Claude Code, Codex, Cursor, Copilot and Gemini.

## Key pages
${L('Home', '/', 'What Skillhawk does, step by step')}
${L('Install', '/install/', 'The CLI, the MCP server for Claude Code, Codex, Cursor, VS Code, Gemini CLI and Claude Desktop, and where Skillhawk is listed')}
${L('Tools', '/tools/', 'Every command, with real example output')}
${L('Skill library', '/skills/', `${libSkills.length} public skills with grade, findings and security status`)}
${L('Proof', '/proof/', 'Scan of 511 skills, lift evals, reviewer accuracy, library grades, with method')}
${L('Learn', '/learn/', 'Sourced answers about skills and instruction files')}

## Answers
${LEARN.map((l) => L(l.title, `/learn/${l.slug}/`, l.desc)).join('\n')}

## Commands
- npx skillhawk agents
- npx skillhawk review <dir>
- npx skillhawk secure <dir>
- npx skillhawk scan <dir>
- npx skillhawk compile <skill-dir> --to all
- npx skillhawk tokens --days 7 [--logs <dir>]
- npx skillhawk eval <skill-dir>
- npx skillhawk optimize <skill-dir>
- npx skillhawk install <skill> --agent claude

## MCP server
- Any MCP client: npx -y skillhawk mcp (tools: review_skill, secure_scan, compile_skill, check_agents)
- Claude Code: npx skillhawk connect claude --write

## Listings
- [npm](${LISTINGS.npm})
- [Official MCP Registry](${LISTINGS.registry})
- [Glama](${LISTINGS.glama})

## Source
- [GitHub](https://github.com/agentwik-labs/skillhawk)
- Contact: help@skillhawk.ai
- Full text of tools and answers: ${siteUrl}/llms-full.txt
- Agent skill: ${siteUrl}/.well-known/agent-skills/skillhawk/SKILL.md
`);
  write('llms-full.txt', `# Skillhawk (full text)\n\n> ${SITE_DESC}\n\nSite: ${siteUrl}/\n\n# Tools\n\n${tools.map((t) => `## ${t.name}\nURL: ${siteUrl}/tools/${t.slug}/\n${toolText(t)}`).join('\n')}\n# Data pages\n\n${proofPages.map((x) => `## ${x.title}\nURL: ${siteUrl}${x.p}\n${texts[x.p]}\n`).join('\n')}\n# Answers\n\n${LEARN.map((l) => `## ${l.title}\nURL: ${siteUrl}/learn/${l.slug}/\n${texts[`/learn/${l.slug}/`]}\n`).join('\n')}`);

  return { siteUrl, pages: urls.length, skills: libSkills.length, tools: tools.length, learn: LEARN.length };
}
