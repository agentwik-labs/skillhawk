// The brain's corpus: whatever the user chose to put in it, made searchable on this machine.
// Sources are the user's choice (see brain init): agent sessions, this repo's docs, git history, any folder of text
// (notes, an Obsidian vault, meeting notes, transcripts, specs). Each source is split into chunks, redacted, and
// indexed with BM25. Nothing is uploaded and nothing is decided for the user: extraction only finds candidates of the
// kinds the user asked to keep, each with its source and line, and the user decides what becomes a rule.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { redact, DECISION } from './studio/capture.js';

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const MAX_BYTES = 1_000_000, MAX_FILES = 20000, CHUNK = 1200;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.skillhawk', '.obsidian', '.trash']);
const SECRET_FILE = /(^\.env|\.pem$|\.key$|id_rsa|credentials|secrets?\.)/i;

export const WORD = (w) => w.replace(/(ing|ed|es|s)$/, '');
export function terms(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && w.length <= 40).map(WORD).filter((w) => w.length >= 2);
}

// ---- reading sources ---------------------------------------------------------------------------------------------
/** Split one text file into chunks at markdown headings (or blank lines), keeping the starting line of each. */
export function chunkText(text, file) {
  const lines = String(text).split('\n');
  const out = [];
  let buf = [], start = 1, heading = '';
  const flush = (end) => { const t = buf.join('\n').trim(); if (t) out.push({ file, line: start, heading, text: t }); buf = []; start = end; };
  lines.forEach((ln, i) => {
    const h = /^#{1,6}\s+(.*)/.exec(ln);
    if (h) { flush(i + 1); heading = h[1].trim(); }
    if (buf.join('\n').length + ln.length > CHUNK && !ln.trim()) flush(i + 2);
    else buf.push(ln);
  });
  flush(lines.length);
  return out;
}

function walkFiles(root, exts, excluded) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= MAX_FILES || depth > 12) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (excluded(p)) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1); }
      else if (e.isFile() && !SECRET_FILE.test(e.name) && (exts.includes('*') || exts.includes(path.extname(e.name).toLowerCase()))) out.push(p);
    }
  };
  let st; try { st = fs.statSync(root); } catch { return out; }
  if (st.isFile()) return excluded(root) ? [] : [root];
  walk(root, 0);
  return out;
}

const isText = (buf) => !buf.subarray(0, 4096).includes(0);

/** Chunks for a folder (or file) of text, using a per-file mtime cache. */
export function readFolder(root, { exts = ['.md', '.txt'], excluded = () => false, cache = {}, next = {}, source = 'folder' } = {}) {
  const chunks = [];
  for (const f of walkFiles(root, exts, excluded)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    const key = `${source}:${f}`;
    const hit = cache[key];
    let cs;
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) cs = hit.chunks;
    else {
      let buf; try { buf = fs.readFileSync(f); } catch { continue; }
      if (!isText(buf)) continue;
      cs = chunkText(redact(buf.toString('utf8')), f).map((c) => ({ ...c, source }));
    }
    next[key] = { mtime: st.mtimeMs, size: st.size, chunks: cs };
    chunks.push(...cs);
  }
  return chunks;
}

/** Commit messages of a repo as chunks (one per commit). */
export function readGit(repo, { limit = 2000, run = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32e6 }) } = {}) {
  let out; try { out = run(['log', `-n${limit}`, '--format=%x1e%h%x1f%aI%x1f%B']); } catch { return []; }
  return out.split('\x1e').filter((x) => x.trim()).map((rec) => {
    const [hash, time, body] = rec.split('\x1f');
    return { file: `git:${path.basename(repo)}@${hash}`, line: 1, heading: '', time, text: redact(body || '').trim(), source: 'git' };
  }).filter((c) => c.text);
}

// ---- extraction: candidates of the kinds the user chose ----------------------------------------------------------
export const KINDS = {
  decision: { label: 'Decisions', re: DECISION, also: /\b(we decided|decision:|decided to|status:\s*accepted|we will use|chose .* over)\b/i },
  preference: { label: 'Preferences', re: /\b(i (prefer|like|want|don'?t want|hate|love)|i'?d rather|please (always|never|don'?t))\b/i },
  question: { label: 'Open questions and to-dos', re: /(\bTODO\b|\bFIXME\b|\b[Oo]pen question\b|\b[Uu]nresolved\b|\bnot sure (if|whether)\b|\?\s*$)/ },
  definition: { label: 'Definitions and glossary', re: /^\s*(?:[-*]\s*)?(?:\*\*|`)?([A-Z][\w .\/-]{1,40}?)(?:\*\*|`)?\s*(?::|—|–| - | means | is short for )\s*\S/ },
  fact: { label: 'Facts and reference (numbers, names, links, commands)', re: /(https?:\/\/\S+|`[^`]{3,}`|\b\d+(?:\.\d+)?\s?(?:ms|s|gb|mb|%|usd|\$|users|requests))/i },
};

/** Lines in the chunks that look like the chosen kinds. Each keeps where it came from. */
export function extract(chunks, kinds) {
  const out = [];
  const seen = new Set();
  for (const c of chunks) {
    const lines = c.text.split('\n');
    const glossary = /gloss|terms|definitions|vocab/i.test(c.heading || '');
    let fence = false;
    lines.forEach((raw, i) => {
      if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
      if (fence || /^\s*>/.test(raw) || /^\s{4,}\S/.test(raw) || /^#{1,6}\s/.test(raw) || /^[a-z_-]+:\s/.test(raw)) return; // code and quoted examples are not the user's own words
      const ln = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim();
      if (ln.length < 8 || ln.length > 400) return;
      if (/<[a-z][^>]*>|\.\.\.|…|\[ \]/.test(ln)) return; // templates and placeholders
      for (const k of kinds) {
        const K = KINDS[k]; if (!K) continue;
        let ok = K.re.test(ln) || (K.also && K.also.test(ln));
        if (k === 'definition') ok = ok && (glossary || /\*\*|`/.test(raw));
        if (k === 'question' && /\?\s*$/.test(ln) && (ln.split(/\s+/).length < 4 || /^\*\*/.test(ln))) ok = false;
        if (!ok) continue;
        const key = `${k}:${ln.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: sha(key).slice(0, 6), kind: k, text: ln, file: c.file, line: (c.line || 1) + i, source: c.source, time: c.time || null });
        break;
      }
    });
  }
  return out;
}

// ---- BM25 index and search ---------------------------------------------------------------------------------------
export function buildIndex(chunks) {
  const docs = chunks.map((c) => { const t = terms(`${c.heading} ${c.text}`); const tf = {}; for (const w of t) tf[w] = (tf[w] || 0) + 1; return { tf, len: t.length }; });
  const df = {};
  for (const d of docs) for (const w of Object.keys(d.tf)) df[w] = (df[w] || 0) + 1;
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  return { chunks, docs, df, avg, n: docs.length };
}

export function search(index, query, { limit = 8, k1 = 1.2, b = 0.75 } = {}) {
  const q = [...new Set(terms(query))];
  if (!q.length || !index.n) return [];
  const scored = [];
  index.docs.forEach((d, i) => {
    let s = 0;
    for (const w of q) {
      const f = d.tf[w]; if (!f) continue;
      const idf = Math.log(1 + (index.n - index.df[w] + 0.5) / (index.df[w] + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avg)));
    }
    if (s > 0) scored.push([s, i]);
  });
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map(([score, i]) => ({ score: +score.toFixed(2), ...index.chunks[i] }));
}

export function snippet(text, query, width = 220) {
  const q = terms(query);
  const low = text.toLowerCase();
  let at = -1;
  for (const w of q) { at = low.indexOf(w); if (at >= 0) break; }
  const s = Math.max(0, at - 60);
  return `${s > 0 ? '…' : ''}${text.slice(s, s + width).replace(/\s+/g, ' ').trim()}${s + width < text.length ? '…' : ''}`;
}
