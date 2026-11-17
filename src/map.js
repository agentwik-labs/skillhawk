// Token Saver: a compact, zero-dependency knowledge map of a repo and its skills, so agents query instead of
// reading many files. No model calls, no network. `--engine graphify` shells out to the graphify CLI if installed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseFrontmatter } from './skill.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.skillyard', '__pycache__', '.venv', 'venv', 'dist', 'build', 'coverage', '.next', '.cache', 'graphify-out']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.md']);
const MAX_BYTES = 400 * 1024;
const MAX_FILES = 5000;
const MAP_VERSION = 1;
export const DEFAULT_OUT = path.join('.skillyard', 'map');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function walk(root) {
  const out = [];
  const go = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) go(p); }
      else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  go(root);
  return out;
}

// ---- per-file extraction ----------------------------------------------------------------

function firstComment(text, lang) {
  const lines = text.split('\n').slice(0, 40);
  const got = [];
  if (lang === 'py') {
    const d = /^\s*(?:#![^\n]*\n)?\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(text);
    if (d) return d[1].trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').slice(0, 160);
    for (const l of lines) { if (/^#!/.test(l)) continue; const m = /^#\s?(.*)/.exec(l); if (m) got.push(m[1]); else if (got.length || l.trim()) break; }
  } else {
    let inBlock = false;
    for (const l of lines) {
      const t = l.trim();
      if (!got.length && (!t || t.startsWith('#!') || /^['"]use strict['"];?$/.test(t))) continue;
      if (inBlock) { if (t.includes('*/')) break; got.push(t.replace(/^\*\s?/, '')); continue; }
      if (t.startsWith('/*')) { inBlock = !t.includes('*/'); got.push(t.replace(/^\/\*+\s?|\*\/$/g, '')); if (!inBlock) break; continue; }
      const m = /^\/\/\s?(.*)/.exec(t);
      if (m) got.push(m[1]); else break;
    }
  }
  return got.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function mdInfo(text) {
  const fm = parseFrontmatter(text);
  const body = fm.body;
  const offset = text.split('\n').length - body.split('\n').length;
  const headings = [];
  let fence = false;
  body.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,4})\s+(.+?)\s*#*$/.exec(l);
    if (m) headings.push({ name: m[2], kind: `h${m[1].length}`, line: i + 1 + offset });
  });
  let summary = fm.data?.description || '';
  if (!summary) {
    const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('```') && !p.startsWith('<'));
    summary = para || '';
  }
  return { fm: fm.data, headings, summary: summary.replace(/\s+/g, ' ').slice(0, 160) };
}

function jsSymbols(text) {
  const syms = [];
  const imports = [];
  text.split('\n').forEach((l, i) => {
    let m;
    if ((m = /^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(l))) syms.push({ name: m[2], kind: m[1].startsWith('function') ? 'function' : m[1], line: i + 1, exported: true });
    else if ((m = /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/.exec(l))) syms.push({ name: m[1], kind: 'function', line: i + 1 });
    else if ((m = /^class\s+([A-Za-z_$][\w$]*)/.exec(l))) syms.push({ name: m[1], kind: 'class', line: i + 1 });
    else if ((m = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/.exec(l))) syms.push({ name: m[1], kind: 'function', line: i + 1 });
    else if ((m = /^export\s*\{([^}]*)\}/.exec(l))) for (const n of m[1].split(',')) { const nm = n.trim().split(/\s+as\s+/).pop(); if (nm) syms.push({ name: nm, kind: 'export', line: i + 1, exported: true }); }
    const re = /(?:^\s*import\s[^'"]*?from\s*|^\s*import\s*|^\s*export\s[^'"]*?from\s*|\brequire\(\s*|\bimport\(\s*)['"]([^'"]+)['"]/g;
    while ((m = re.exec(l))) imports.push(m[1]);
  });
  return { syms, imports };
}

function pySymbols(text) {
  const syms = [];
  const imports = [];
  text.split('\n').forEach((l, i) => {
    let m;
    if ((m = /^(?:async\s+)?def\s+(\w+)/.exec(l))) syms.push({ name: m[1], kind: 'function', line: i + 1 });
    else if ((m = /^class\s+(\w+)/.exec(l))) syms.push({ name: m[1], kind: 'class', line: i + 1 });
    else if ((m = /^from\s+([.\w]+)\s+import\s/.exec(l))) imports.push(m[1]);
    else if ((m = /^import\s+([\w., ]+)/.exec(l))) for (const n of m[1].split(',')) imports.push(n.trim().split(/\s+as\s+/)[0]);
  });
  return { syms, imports };
}

function extract(abs, relPath, text) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.md') {
    const md = mdInfo(text);
    const isSkill = path.basename(relPath) === 'SKILL.md';
    const f = { lang: 'md', summary: md.summary, symbols: md.headings, imports: [] };
    if (isSkill) f.skill = { name: String(md.fm?.name || path.basename(path.dirname(abs))), description: String(md.fm?.description || md.summary) };
    return f;
  }
  const lang = ext === '.py' ? 'py' : 'js';
  const { syms, imports } = lang === 'py' ? pySymbols(text) : jsSymbols(text);
  const seen = new Set();
  const symbols = syms.filter((s) => { const k = `${s.name}:${s.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { lang, summary: firstComment(text, lang), symbols, imports };
}

function resolveImport(files, from, spec, lang) {
  const dir = path.posix.dirname(from);
  let base;
  if (lang === 'py') {
    if (spec.startsWith('.')) { const dots = /^\.+/.exec(spec)[0].length; let d = dir; for (let i = 1; i < dots; i++) d = path.posix.dirname(d); base = path.posix.join(d, spec.slice(dots).replace(/\./g, '/')); }
    else base = spec.replace(/\./g, '/');
    for (const c of [`${base}.py`, `${base}/__init__.py`, path.posix.join(dir, `${base}.py`)]) if (files.has(c)) return c;
    return null;
  }
  if (!spec.startsWith('.')) return null;
  base = path.posix.join(dir, spec);
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}/index.js`, `${base}/index.ts`, base.replace(/\.js$/, '.ts')]) if (files.has(c)) return c;
  return null;
}

// ---- build ----------------------------------------------------------------------------------

/** Build (or incrementally update) the map in memory. prev = previously saved map, used when update is true. */
export function buildMap(root, { prev = null, update = false } = {}) {
  root = path.resolve(root);
  const old = update && prev?.v === MAP_VERSION ? prev.files : {};
  const files = {};
  const stats = { read: 0, reused: 0 };
  for (const abs of walk(root)) {
    const r = rel(root, abs);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    const hit = old[r];
    if (hit && hit.mtime === Math.floor(st.mtimeMs) && hit.size === st.size) { files[r] = hit; stats.reused++; continue; }
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const hash = sha(text);
    if (hit && hit.hash === hash) { files[r] = { ...hit, mtime: Math.floor(st.mtimeMs), size: st.size }; stats.reused++; continue; }
    files[r] = { mtime: Math.floor(st.mtimeMs), size: st.size, hash, lines: text.split('\n').length, ...extract(abs, r, text) };
    stats.read++;
  }
  const names = new Set(Object.keys(files));
  const importedBy = {};
  for (const [r, f] of Object.entries(files)) {
    f.deps = [...new Set((f.imports || []).map((s) => resolveImport(names, r, s, f.lang)).filter(Boolean))];
    for (const d of f.deps) (importedBy[d] ||= []).push(r);
  }
  for (const [r, f] of Object.entries(files)) f.usedBy = importedBy[r] || [];
  const skills = Object.entries(files).filter(([, f]) => f.skill).map(([r, f]) => ({ name: f.skill.name, description: f.skill.description.slice(0, 220), path: r, sections: f.symbols.filter((s) => s.kind === 'h2' || s.kind === 'h1').length }));
  const folders = folderSummaries(files);
  return { map: { v: MAP_VERSION, root: path.basename(root), engine: 'builtin', built: new Date().toISOString(), files, skills, folders }, stats };
}

function folderSummaries(files) {
  const byDir = {};
  for (const [r, f] of Object.entries(files)) (byDir[path.posix.dirname(r)] ||= []).push([r, f]);
  const out = {};
  for (const [d, list] of Object.entries(byDir)) {
    const readme = list.find(([r]) => /(^|\/)readme\.md$/i.test(r));
    const lead = readme?.[1].summary || list.map(([, f]) => f.summary).find(Boolean) || '';
    out[d] = { files: list.length, summary: lead.slice(0, 120) };
  }
  return out;
}

export function overview(map, budgetChars = 7500) {
  const files = Object.entries(map.files);
  const out = [`# Map of ${map.root}`, '', `${files.length} files, ${map.skills.length} skills. Query before opening files: \`skillhawk map query "<question>"\` (or the \`map_query\` MCP tool). Built ${map.built.slice(0, 10)}.`, ''];
  out.push('## Folders');
  const dirs = Object.entries(map.folders).filter(([, v]) => v.summary || v.files > 2).sort((a, b) => a[0].split('/').length - b[0].split('/').length || b[1].files - a[1].files);
  let used = out.join('\n').length;
  const add = (line) => { if (used + line.length > budgetChars) return false; out.push(line); used += line.length + 1; return true; };
  for (const [d, v] of dirs.slice(0, 40)) if (!add(`- ${d}/ (${v.files}) ${v.summary}`.trim())) break;
  add(''); add('## Key files (most imported)');
  const hubs = files.filter(([, f]) => f.usedBy.length).sort((a, b) => b[1].usedBy.length - a[1].usedBy.length).slice(0, 15);
  for (const [r, f] of hubs) if (!add(`- ${r} (used by ${f.usedBy.length}) ${f.summary.slice(0, 80)}`.trim())) break;
  add(''); add('## Skills');
  for (const s of map.skills.slice(0, 60)) if (!add(`- ${s.name} [${s.path}]: ${s.description.slice(0, 90)}`)) { add(`- ... ${map.skills.length - out.length} more; use \`map query\``); break; }
  return out.join('\n') + '\n';
}

// ---- persistence -------------------------------------------------------------------------------

export function loadMap(root, out = DEFAULT_OUT) {
  try { return JSON.parse(fs.readFileSync(path.join(path.resolve(root), out, 'map.json'), 'utf8')); } catch { return null; }
}

export function writeMap(root, out, map) {
  const dir = path.resolve(root, out);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(map));
  fs.writeFileSync(path.join(dir, 'MAP.md'), overview(map));
  return dir;
}

// ---- query (BM25-style, no model) ---------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'is', 'how', 'what', 'where', 'does', 'do', 'with', 'on']);
export function tokenize(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Documents: one per file (path, summary, skill text) and one per symbol (name boosted). */
function docsOf(map) {
  const docs = [];
  for (const [r, f] of Object.entries(map.files)) {
    docs.push({ type: f.skill ? 'skill' : 'file', file: r, line: 1, label: f.skill ? `skill ${f.skill.name}: ${f.skill.description.slice(0, 100)}` : `${r}${f.summary ? ` - ${f.summary.slice(0, 100)}` : ''}`, toks: [...tokenize(r), ...tokenize(r), ...tokenize(f.summary || ''), ...tokenize(f.skill ? `${f.skill.name} ${f.skill.description}` : '')] });
    for (const s of f.symbols) docs.push({ type: 'symbol', file: r, line: s.line, label: `${s.kind} ${s.name}  (${r}:${s.line})`, toks: [...tokenize(s.name), ...tokenize(s.name), ...tokenize(path.posix.basename(r))] });
  }
  return docs;
}

export function queryMap(map, question, limit = 8) {
  const q = [...new Set(tokenize(question))];
  if (!q.length) return [];
  const docs = docsOf(map);
  const N = docs.length || 1;
  const avg = docs.reduce((n, d) => n + d.toks.length, 0) / N || 1;
  const df = {};
  for (const d of docs) for (const t of new Set(d.toks)) df[t] = (df[t] || 0) + 1;
  const k1 = 1.4, b = 0.6;
  const scored = [];
  for (const d of docs) {
    const tf = {};
    for (const t of d.toks) tf[t] = (tf[t] || 0) + 1;
    let score = 0, hit = 0;
    for (const t of q) {
      // prefix match lets "scan" find "scanner"/"scanFiles"
      let f = tf[t] || 0;
      if (!f) for (const k in tf) if ((k.length > t.length && k.startsWith(t) && t.length >= 3) || (k.length >= 5 && t.length >= 5 && k.slice(0, 5) === t.slice(0, 5))) f += 0.5 * tf[k];
      if (!f) continue;
      hit++;
      const idf = Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.toks.length) / avg)));
    }
    if (score > 0) scored.push({ ...d, score: score * (1 + 0.5 * (hit / q.length)) * (d.type === 'symbol' ? 0.9 : 1) });
  }
  scored.sort((a, b) => b.score - a.score);
  // at most 3 hits per file so one big file cannot fill the answer
  const per = {};
  const out = [];
  for (const s of scored) { per[s.file] = (per[s.file] || 0) + 1; if (per[s.file] <= 3) out.push(s); if (out.length >= limit) break; }
  return out.map(({ toks, ...s }) => ({ ...s, score: Math.round(s.score * 100) / 100 }));
}

export function formatHits(hits) {
  if (!hits.length) return 'No matches. Try other keywords.';
  return hits.map((h) => `${h.file}:${h.line}  ${h.type === 'symbol' ? h.label.replace(/\s+\(.*\)$/, '') : h.label}`).join('\n');
}

// ---- skill sections (lean loading) ---------------------------------------------------------------------

/** Return one heading-section of a markdown doc, or the outline when heading is empty. */
export function sectionOf(md, heading) {
  const lines = md.split('\n');
  const heads = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*$/.exec(l);
    if (m) heads.push({ level: m[1].length, name: m[2], line: i });
  });
  if (!heading) return { outline: heads.map((h) => `${'  '.repeat(h.level - 1)}${h.name} (line ${h.line + 1})`) };
  const want = heading.trim().toLowerCase();
  const idx = heads.findIndex((h) => h.name.toLowerCase() === want) >= 0 ? heads.findIndex((h) => h.name.toLowerCase() === want) : heads.findIndex((h) => h.name.toLowerCase().includes(want));
  if (idx < 0) return { outline: heads.map((h) => h.name), missing: true };
  const h = heads[idx];
  const end = heads.slice(idx + 1).find((n) => n.level <= h.level);
  return { heading: h.name, text: lines.slice(h.line, end ? end.line : lines.length).join('\n').trim() };
}

/** Local skill lookup through the map; returns SKILL.md text or null. Paths come from the map only. */
export function localSkillText(root, name, out = DEFAULT_OUT) {
  const map = loadMap(root, out);
  if (!map) return null;
  const n = String(name).replace(/^@[^/]+\//, '').toLowerCase();
  const s = map.skills.find((k) => k.name.toLowerCase() === n);
  if (!s) return null;
  const abs = path.resolve(root, s.path);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

// ---- CLI ------------------------------------------------------------------------------------------------

export async function run(args, flags) {
  // the CLI parser lets a boolean flag swallow the next word (`--update .`); give it back
  for (const k of ['update', 'json']) if (typeof flags[k] === 'string') { if (k === 'update' || args[0] === 'query') args.push(flags[k]); flags[k] = true; }
  if (args[0] === 'query') {
    const q = args.slice(1).join(' ');
    if (!q) throw new Error('usage: skillhawk map query "<question>" [--dir .] [--out .skillyard/map] [--limit 8] [--json]');
    const root = flags.dir || '.';
    const map = loadMap(root, flags.out || DEFAULT_OUT);
    if (!map) throw new Error(`no map in ${path.resolve(root)}. Run: skillhawk map ${root}`);
    const hits = queryMap(map, q, Number(flags.limit) || 8);
    console.log(flags.json ? JSON.stringify(hits, null, 2) : formatHits(hits));
    return;
  }
  const root = args[0] || '.';
  const out = flags.out || DEFAULT_OUT;
  if (!fs.existsSync(root)) throw new Error(`no such folder: ${root}`);
  if (flags.engine === 'graphify') {
    const probe = spawnSync('graphify', ['--help'], { encoding: 'utf8' });
    if (probe.error) throw new Error('graphify is not on PATH. Install it, or omit --engine to use the built-in index.');
    const r = spawnSync('graphify', [path.resolve(root)], { stdio: 'inherit', cwd: path.resolve(root) });
    if (r.status !== 0) throw new Error(`graphify exited with ${r.status}`);
    console.log('graphify finished; its output is in graphify-out/ (skillhawk map query uses the built-in index only).');
    return;
  }
  if (flags.engine && flags.engine !== 'builtin') throw new Error(`unknown engine "${flags.engine}" (builtin, graphify)`);
  const prev = flags.update ? loadMap(root, out) : null;
  const { map, stats } = buildMap(root, { prev, update: !!flags.update });
  const dir = writeMap(root, out, map);
  console.log(`mapped ${Object.keys(map.files).length} files, ${map.skills.length} skills (${stats.read} read, ${stats.reused} reused) -> ${path.relative(process.cwd(), dir) || dir}/{map.json,MAP.md}`);
}
