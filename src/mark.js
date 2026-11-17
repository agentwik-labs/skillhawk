// Leak tracing: per-recipient marked copies of a skill (SKILL.md) and `trace` to identify the recipient of a leak.
//
// Three layers, all derived from HMAC-SHA256(orgSecret, ...) so the same inputs always give the same copy:
//   zw      zero-width characters (U+200D = 0, U+200E = 1) carrying a 32-bit keyed tag, repeated at up to 8 line ends.
//           Easy to strip; that is fine, the other layers remain.
//   wording meaning-preserving variants at "sites" (verify/confirm/check, make sure/ensure, before/prior to, e.g./for
//           example, contractions, Oxford comma, bullet and numbering marker style, order of adjacent independent
//           bullets). Each site carries one bit of a 32-bit keyed code in the parity of the chosen option, so every
//           code bit is repeated across many sites (repetition code). Sites are anchored to their (normalised) line
//           content, not to a position, so fragments and merged copies can still be matched.
//   canary  one clearly-illustrative line of sample values (a name, a reference number, an amount) appended to the
//           skill's Example section (or a short "Example (illustrative)" section when there is none). It never
//           touches thresholds or instructions and survives paraphrase as long as the example is kept.
// Never edited: frontmatter, fenced and indented code, inline code, URLs and link targets, paths, headings, tables.
// Collusion: when two copies are merged, each site still matches one of the two colluders, so both rank at the top.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ZW0 = '‍';
const ZW1 = '‎';
const ZW_ALL = /[​-‏⁠-⁤﻿᠎͏]/g;
const ZW_POINTS = 8;
const TAG_BITS = 32;

const prf = (secret, label) => crypto.createHmac('sha256', String(secret)).update(label).digest();
const h10 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap1 = (s) => s[0].toUpperCase() + s.slice(1);
const bitsOf = (buf, n) => Array.from({ length: n }, (_, i) => (buf[i >> 3] >> (7 - (i & 7))) & 1);
const toHex = (bits) => { let o = ''; for (let i = 0; i < bits.length; i += 4) o += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16); return o; };

// ---- wording variant table ---------------------------------------------------------------------------------------
// A form is a string (matched with either case of its first letter, rest exact, so emphasis like "NOT" is never touched)
// or { pat, out } for custom patterns. `before`/`after` are regex sources (lookarounds) that keep only safe contexts.
const FOLLOW_NOUN = '(?= (?:that|whether|the|each|every|all|there|it|no)\\b)';
const SETS = [
  { id: 'verify', forms: ['verify', 'confirm', 'check'], after: FOLLOW_NOUN },
  { id: 'ensure', forms: ['make sure', 'ensure', 'be sure'], after: '(?= (?:that|the|all|each|every|no|there|it)\\b)' },
  { id: 'before', forms: ['before', 'prior to'], after: '(?= (?:the|any|a|an|each|every|merging|committing|sending|writing|running|publishing|deploying|changing|editing|submitting|starting)\\b)' },
  { id: 'eg', forms: [{ pat: 'e\\.g\\.,?', out: 'e.g.' }, { pat: 'for example,', out: 'for example,' }], before: '(?<![\\w.])', after: '(?=\\s)' },
  { id: 'ie', forms: [{ pat: 'i\\.e\\.,?', out: 'i.e.' }, { pat: 'that is,', out: 'that is,' }], before: '(?<![\\w.])', after: '(?=\\s)' },
  { id: 'donot', forms: ['do not', "don't", 'don’t'], after: '(?=\\s)' },
  { id: 'doesnot', forms: ['does not', "doesn't", 'doesn’t'], after: '(?=\\s)' },
  { id: 'cannot', forms: ['cannot', "can't", 'can’t'], after: '(?=\\s)' },
  { id: 'shouldnot', forms: ['should not', "shouldn't", 'shouldn’t'], after: '(?=\\s)' },
  { id: 'isnot', forms: ['is not', "isn't", 'isn’t'], after: '(?=\\s)' },
  { id: 'arenot', forms: ['are not', "aren't", 'aren’t'], after: '(?=\\s)' },
  { id: 'willnot', forms: ['will not', "won't", 'won’t'], after: '(?=\\s)' },
  { id: 'itis', forms: ['it is', "it's", 'it’s'], after: '(?=\\s)' },
  { id: 'youare', forms: ['you are', "you're", 'you’re'], after: '(?=\\s)' },
  { id: 'didnot', forms: ['did not', "didn't", 'didn’t'], after: '(?=\\s)' },
  { id: 'havenot', forms: ['have not', "haven't", 'haven’t'], after: '(?=\\s)' },
  { id: 'wasnot', forms: ['was not', "wasn't", 'wasn’t'], after: '(?=\\s)' },
  { id: 'dash', forms: [{ pat: ' — ', out: ' — ' }, { pat: ' - ', out: ' - ' }, { pat: ' – ', out: ' – ' }], before: '(?<=[A-Za-z])', after: '(?=[A-Za-z])' },
  { id: 'run', forms: ['run', 'execute'], after: '(?= (?:the|a|an|each|all|every)\\b)' },
  { id: 'show', forms: ['show', 'display'], after: '(?= (?:the|a|an|each|all)\\b)' },
  { id: 'get', forms: ['get', 'retrieve'], after: '(?= (?:the|a|an|each|all)\\b)' },
  { id: 'fix', forms: ['fix', 'resolve'], after: '(?= (?:the|each|any|all)\\b)' },
  { id: 'finish', forms: ['finish', 'complete'], after: '(?= (?:the|each|all)\\b)' },
  { id: 'explain', forms: ['explain', 'describe'], after: '(?= (?:the|why|how|what)\\b)' },
  { id: 'pick', forms: ['pick', 'choose', 'select'], after: '(?= (?:the|a|an|one|each)\\b)' },
  { id: 'lookat', forms: ['look at', 'review'], after: '(?= (?:the|each|every|all|any)\\b)' },
  { id: 'usually', forms: ['usually', 'typically', 'generally', 'normally'], after: '(?=\\s)' },
  { id: 'approx', forms: ['approximately', 'roughly'], after: '(?=\\s\\d)' },
  { id: 'need', forms: ['need to', 'have to'], before: '(?<=\\b(?:[Yy]ou|[Ww]e|[Tt]hey) )' },
  { id: 'due', forms: ['due to', 'because of'], after: '(?=\\s)' },
  { id: 'start', forms: ['start', 'begin'], after: '(?= (?:by|with)\\b)' },
  { id: 'inorder', forms: ['in order to', 'so as to'], after: '(?=\\s)' },
  { id: 'rather', forms: ['rather than', 'instead of'], after: '(?= (?:the|a|an)\\b)' },
  { id: 'whenever', forms: ['whenever', 'each time'], after: '(?= (?:you|a|the|an|someone|it)\\b)' },
  { id: 'also', forms: [{ pat: 'Also,', out: 'Also,' }, { pat: 'Additionally,', out: 'Additionally,' }, { pat: 'In addition,', out: 'In addition,' }], before: '(?<=^|[.!?] )' },
  { id: 'finally', forms: [{ pat: 'Finally,', out: 'Finally,' }, { pat: 'Lastly,', out: 'Lastly,' }], before: '(?<=^|[.!?] )' },
  { id: 'next', forms: [{ pat: 'Next,', out: 'Next,' }, { pat: 'Then,', out: 'Then,' }], before: '(?<=^|[.!?] )' },
  { id: 'however', forms: [{ pat: 'However,', out: 'However,' }, { pat: 'That said,', out: 'That said,' }], before: '(?<=^|[.!?] )' },
  { id: 'note', forms: [{ pat: 'Note that', out: 'Note that' }, { pat: 'Keep in mind that', out: 'Keep in mind that' }], before: '(?<=^|[.!?] )' },
].map((s) => {
  const forms = s.forms.map((f) => (typeof f === 'string' ? { pat: `[${f[0].toUpperCase()}${f[0]}]${esc(f.slice(1))}`, out: f, cap: true } : f));
  const src = `${s.before || '\\b'}(${forms.map((f) => f.pat).join('|')})${s.after || ''}`;
  return { ...s, forms, re: new RegExp(src, 'gm'), formRes: forms.map((f) => new RegExp(`^(?:${f.pat})$`)) };
});
const SET_BY_ID = Object.fromEntries(SETS.map((s) => [s.id, s]));

const CONJ = new Set(['if', 'when', 'then', 'after', 'before', 'once', 'else', 'and', 'but', 'so', 'while', 'unless', 'because', 'otherwise', 'or']);

// ---- document structure ----------------------------------------------------------------------------------------

const BULLET = /^(\s*)([-*])(\s+)(?=\S)/;
const NUMBERED = /^(\s*)(\d+)([.)])(\s+)(?=\S)/;
const norm = (text) => String(text).replace(/\r\n?/g, '\n').replace(ZW_ALL, '').replace(/ /g, ' ');

/** Per-line protection: frontmatter, fenced code, indented code, headings, tables, raw HTML. */
function classify(lines) {
  const prot = new Array(lines.length).fill(false);
  const fence = new Array(lines.length).fill(false);
  const head = new Array(lines.length).fill(false);
  const headerOnly = (to) => lines.slice(0, to).every((l) => !l.trim() || /^(#|\/\/|\/\*|\*|<!--)/.test(l.trim()));
  for (let i = 0; i < Math.min(lines.length, 41); i++) {
    if (lines[i].trim() !== '---') continue;
    if (!headerOnly(i)) break;
    const end = lines.findIndex((l, j) => j > i && l.trim() === '---');
    if (end > 0) for (let j = 0; j <= end; j++) prot[j] = true;
    break;
  }
  let open = null;
  let comment = false;
  lines.forEach((l, i) => {
    if (prot[i]) return;
    const m = /^\s*(```+|~~~+)/.exec(l);
    if (m) { if (!open) open = m[1][0]; else if (m[1][0] === open) open = null; fence[i] = prot[i] = true; return; }
    if (open) { fence[i] = prot[i] = true; return; }
    if (comment || /^\s*<!--/.test(l)) { prot[i] = true; comment = !/-->/.test(l); return; }
    if (/^#{1,6}\s/.test(l)) { head[i] = true; prot[i] = true; return; }
    if (/^\s*\|/.test(l) || /^\s*<[^>]+>/.test(l) || /^\s*(?:\$|>>>|\[[^\]]+\]:\s)/.test(l)) { prot[i] = true; return; }
    if (/^(?: {4}|\t)/.test(l) && !BULLET.test(l) && !NUMBERED.test(l) && (i === 0 || !lines[i - 1].trim() || prot[i - 1])) prot[i] = true;
  });
  return { prot, fence, head, unbalanced: open !== null };
}

const PROTECTED_SPAN = /(`+)[^]*?\1|https?:\/\/[^\s)>\]]+|\]\([^)]*\)|<[^>\s][^>]*>|[\w.~-]*\/[\w./~-]+/g;

/** Editable [start,end) segments of one line (after list marker/blockquote prefix, outside inline code, URLs, paths). */
function segments(line) {
  const pre = /^(\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?)/.exec(line)[1].length;
  const spans = [];
  for (const m of line.matchAll(PROTECTED_SPAN)) spans.push([m.index, m.index + m[0].length]);
  const segs = [];
  let at = pre;
  for (const [s, e] of spans) { if (s > at) segs.push([at, s]); at = Math.max(at, e); }
  if (at < line.length) segs.push([at, line.length]);
  return segs;
}

/** Word-variant sites in one line: { start, len, set, idx }, non-overlapping. */
function wordSites(line) {
  const out = [];
  for (const [a, b] of segments(line)) {
    const seg = line.slice(a, b);
    const found = [];
    for (const set of SETS) {
      set.re.lastIndex = 0;
      for (const m of seg.matchAll(set.re)) {
        const g = m[1];
        const at = m.index + m[0].indexOf(g);
        const idx = set.formRes.findIndex((r) => r.test(g));
        if (idx >= 0) found.push({ start: a + at, len: g.length, set: set.id, idx });
      }
    }
    // Oxford comma: "A, B and C" <-> "A, B, and C" for a plain three-item list of single words.
    for (const m of seg.matchAll(/\b([A-Za-z][\w-]+), ([A-Za-z][\w-]+)(,?) (and|or) ([A-Za-z][\w-]+)(?=[\s.,;:)]|$)/g)) {
      const prefix = seg.slice(0, m.index).replace(/e\.g\.,?|i\.e\.,?|for example,|that is,/g, ' ');
      const sentence = prefix.slice(Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '), -1) + 1);
      const lastWord = (/(\w+)\s*$/.exec(sentence) || [])[1];
      if (sentence.includes(',') || (lastWord && CONJ.has(lastWord.toLowerCase())) || CONJ.has(m[1].toLowerCase()) || CONJ.has(m[2].toLowerCase())) continue;
      found.push({ start: a + m.index + m[1].length + 2 + m[2].length, len: m[3].length, set: 'oxford', idx: m[3] ? 1 : 0 });
    }
    found.sort((x, y) => x.start - y.start || y.len - x.len);
    let end = -1;
    for (const f of found) {
      if (f.start < end || (f.len === 0 && f.start < end)) continue;
      out.push(f);
      end = f.start + f.len;
    }
  }
  return out;
}

const OPTIONS = { oxford: 2 };
for (const s of SETS) OPTIONS[s.id] = s.forms.length;
OPTIONS.marker = 2;
OPTIONS.swap = 2;

function canonLine(line, sites) {
  let s = line;
  for (const x of [...sites].sort((a, b) => b.start - a.start)) s = `${s.slice(0, x.start)}§${x.set}§${s.slice(x.start + x.len)}`;
  return s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const ANAPHORA = /\b(above|below|previous|previously|following|next|same|this|these|those|it|its|they|them|then|also|first|second|third|last|finally|otherwise|instead|again|former|latter|such|both|either|neither|other|another|else)\b/i;

/** Everything markable in a document, with stable content-anchored keys. */
function collect(lines) {
  const { prot, fence, head, unbalanced } = classify(lines);
  const ws = lines.map((l, i) => (prot[i] ? [] : wordSites(l)));
  const cl = lines.map((l, i) => canonLine(l, ws[i]));
  const sites = [];
  lines.forEach((l, i) => {
    const seen = {};
    for (const w of ws[i]) {
      const n = (seen[w.set] = (seen[w.set] || 0) + 1);
      sites.push({ ...w, kind: 'w', line: i, n: OPTIONS[w.set], key: `w:${w.set}:${n}:${h10(cl[i])}` });
    }
  });
  // Marker style: one site per run of consecutive list items of the same kind and indent.
  const item = (i) => {
    if (prot[i]) return null;
    let m = BULLET.exec(lines[i]);
    if (m) return { kind: 'b', indent: m[1].length, ch: m[2] };
    m = NUMBERED.exec(lines[i]);
    if (m) return { kind: 'n', indent: m[1].length, ch: m[3] };
    return null;
  };
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    const it = item(i);
    if (!it) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === i - 1 && last.kind === it.kind && last.indent === it.indent) { last.end = i; last.lines.push(i); } else runs.push({ ...it, start: i, end: i, lines: [i] });
  }
  for (const r of runs) {
    const key = `m:${r.kind}:${r.lines.map((i) => h10(cl[i])).sort()[0]}`;
    sites.push({ kind: 'm', run: r, n: 2, set: 'marker', idx: r.kind === 'b' ? (r.ch === '-' ? 0 : 1) : (r.ch === '.' ? 0 : 1), key });
  }
  // Order of adjacent, independent, single-line bullets (never numbered lists, never anything with a back-reference).
  const eligible = (i) => {
    const it = item(i);
    if (!it || it.kind !== 'b') return false;
    const body = lines[i].replace(BULLET, '');
    if (body.length < 25 || /[:]\s*$/.test(body) || ANAPHORA.test(body) || /\[[^\]]*\]\([^)]*\)|\[ ?[xX]? ?\]/.test(body)) return false;
    const next = lines[i + 1];
    if (next !== undefined && next.trim() && !item(i + 1) && /^\s/.test(next)) return false; // continuation line
    if (next !== undefined && item(i + 1) && item(i + 1).indent > it.indent) return false; // nested children
    return true;
  };
  for (const r of runs) {
    if (r.kind !== 'b') continue;
    const el = [];
    const flush = () => {
      for (let k = 0; k + 1 < el.length; k += 2) {
        const [a, b] = [el[k], el[k + 1]];
        const [ha, hb] = [h10(cl[a]), h10(cl[b])];
        if (ha === hb) continue;
        sites.push({ kind: 's', a, b, n: 2, set: 'swap', idx: ha < hb ? 0 : 1, key: `s:${[ha, hb].sort().join('')}` });
      }
      el.length = 0;
    };
    for (const i of r.lines) { if (eligible(i)) el.push(i); else flush(); }
    flush();
  }
  const count = {};
  for (const s of sites) count[s.key] = (count[s.key] || 0) + 1;
  return { sites: sites.filter((s) => count[s.key] === 1), prot, fence, head, unbalanced, cl };
}

// ---- marking ---------------------------------------------------------------------------------------------------

const FIRST = ['Priya', 'Marcus', 'Elena', 'Tomas', 'Aisha', 'Declan', 'Mei', 'Rafael', 'Ingrid', 'Kofi', 'Saoirse', 'Hiro', 'Leila', 'Oskar', 'Camila', 'Nikhil', 'Astrid', 'Bram', 'Yara', 'Lucian', 'Thandi', 'Anders', 'Noor', 'Mateo', 'Freya', 'Idris', 'Selma', 'Jonas', 'Amara', 'Viktor', 'Zainab', 'Callum', 'Rosa', 'Emre', 'Greta', 'Tariq', 'Marisol', 'Henrik', 'Dalia', 'Ewan', 'Imani', 'Paolo', 'Signe', 'Rohan', 'Lucia', 'Magnus', 'Odalys', 'Felix', 'Nadia', 'Soren', 'Ximena', 'Gideon', 'Wren', 'Anselm', 'Catalina', 'Dmitri', 'Esme', 'Lorcan', 'Mira', 'Quentin', 'Tamsin', 'Ulrich', 'Vera', 'Wilhelm'];
const LAST = ['Okafor', 'Lindqvist', 'Brandt', 'Moreau', 'Castellano', 'Nwosu', 'Halvorsen', 'Iyer', 'Kowalczyk', 'Delacroix', 'Abernathy', 'Tanaka', 'Fontaine', 'Mbeki', 'Radcliffe', 'Vasquez', 'Eriksen', 'Petrovic', 'Whitlock', 'Haddad', 'Sorensen', 'Okonkwo', 'Marchetti', 'Bellamy', 'Yilmaz', 'Hargreaves', 'Duarte', 'Novak', 'Quintero', 'Ashworth', 'Lombardi', 'Achterberg', 'Sandoval', 'Pemberton', 'Ferreira', 'Kaczmarek', 'Dunmore', 'Ostrowski', 'Bianchi', 'Thornquist', 'Valdez', 'Rasmussen', 'Calloway', 'Menon', 'Zielinski', 'Hawthorne', 'Basu', 'Lockhart', 'Ibarra', 'Stromberg', 'Ng', 'Carvalho', 'Fenwick', 'Odunsi', 'Pellegrini', 'Rutherford', 'Sakamoto', 'Teixeira', 'Underhill', 'Vandenberg', 'Wexler', 'Yamamoto', 'Zahn', 'Almeida'];

/** Per-recipient illustrative sample values; recomputable from (secret, recipient, version) alone. */
export function canaryValues(secret, recipient, version) {
  const h = prf(secret, `canary|${recipient}|${version}`);
  const ref = String(10000 + (h.readUInt32BE(2) % 90000));
  const dollars = 1000 + (h.readUInt16BE(6) % 9000);
  const cents = String(h[8] % 100).padStart(2, '0');
  return { name: `${FIRST[h[0] % FIRST.length]} ${LAST[h[1] % LAST.length]}`, ref, amount: `$${String(dollars).replace(/(\d)(?=(\d{3})+$)/, '$1,')}.${cents}` };
}
const canaryLine = (c) => `_Illustrative sample values (not rules or thresholds): contact ${c.name}, ticket ${c.ref}, amount ${c.amount}._`;

/** Opaque per-copy beacon token (derived from the org secret; the vault stores what it maps to). */
export function beaconToken(secret, recipient, skill, version) {
  return prf(secret, `beacon|${recipient}|${skill || ''}|${version}`).subarray(0, 16).toString('base64url');
}
const beaconLine = (url) => `Reference: ${url}`;

function insertCanary(lines, c, meta, rawLine) {
  const line = rawLine || canaryLine(c);
  const heads = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => meta.head[i] && /\bexamples?\b/i.test(l));
  if (heads.length && !meta.unbalanced) {
    const { l, i } = heads[0];
    const level = /^#+/.exec(l)[0].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (meta.head[j] && /^#+/.exec(lines[j])[0].length <= level) { end = j; break; }
    let last = end - 1;
    while (last > i && !lines[last].trim()) last--;
    lines.splice(last + 1, 0, '', line);
    return 'example-section';
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (meta.unbalanced) return null;
  lines.push('', '## Example (illustrative)', '', line, '');
  return 'appended-section';
}

function insertZw(lines, tag, secret, id, meta) {
  const ok = [];
  lines.forEach((l, i) => {
    if (meta.prot[i] || meta.head[i] || /^\s*(?:\||<|>)/.test(l) || !/[.:)]\s*$/.test(l) || /`\s*$/.test(l)) return;
    ok.push(i);
  });
  const k = Math.min(ZW_POINTS, ok.length);
  const payload = [...tag].map((b) => (b ? ZW1 : ZW0)).join('');
  const where = [];
  for (let t = 0; t < k; t++) {
    const lo = Math.floor((t * ok.length) / k);
    const hi = Math.floor(((t + 1) * ok.length) / k);
    const idx = ok[lo + (prf(secret, `zw|${id}|${t}`)[0] % (hi - lo))];
    lines[idx] = lines[idx].replace(/(\s*)$/, `${payload}$1`);
    where.push(idx);
  }
  return where.length;
}

export function markSkill(text, { recipient, version, orgSecret, layers = ['zw', 'wording', 'canary'], beaconUrl = null, skill = '' } = {}) {
  if (!recipient || !version || !orgSecret) throw new Error('markSkill needs recipient, version and orgSecret');
  const src = norm(text);
  const id = `${recipient}|${version}`;
  const master = prf(orgSecret, id);
  const tagBits = bitsOf(master, TAG_BITS);
  const codeBits = bitsOf(master.subarray(4), TAG_BITS);
  let lines = src.split('\n');
  const fp = { recipient, version, layers: [...layers], tag: toHex(tagBits), code: codeBits.join(''), sites: [], canary: null, zwPoints: 0, sourceSha256: crypto.createHash('sha256').update(src).digest('hex') };
  const meta = collect(lines);

  if (layers.includes('wording')) {
    const chosen = meta.sites.map((s) => {
      const j = prf(orgSecret, `bit|${s.key}`).readUInt16BE(0) % TAG_BITS;
      const r = prf(orgSecret, `pick|${id}|${s.key}`)[0];
      const valid = [];
      for (let i = 0; i < s.n; i++) if (i % 2 === codeBits[j]) valid.push(i);
      return { ...s, want: valid[r % valid.length] };
    });
    for (const s of chosen.filter((x) => x.kind === 'w').sort((a, b) => b.line - a.line || b.start - a.start)) {
      if (s.want === s.idx) continue;
      const set = SET_BY_ID[s.set];
      let out;
      if (s.set === 'oxford') out = s.want ? ',' : '';
      else {
        const f = set.forms[s.want];
        const wasUpper = /[A-Z]/.test(lines[s.line][s.start]);
        out = f.cap && wasUpper ? cap1(f.out) : f.out;
      }
      lines[s.line] = lines[s.line].slice(0, s.start) + out + lines[s.line].slice(s.start + s.len);
    }
    for (const s of chosen.filter((x) => x.kind === 's')) if (s.want !== s.idx) [lines[s.a], lines[s.b]] = [lines[s.b], lines[s.a]];
    for (const s of chosen.filter((x) => x.kind === 'm')) {
      if (s.want === s.idx) continue;
      for (const i of s.run.lines) {
        lines[i] = s.run.kind === 'b' ? lines[i].replace(BULLET, (m, a, c, w) => `${a}${s.want ? '*' : '-'}${w}`) : lines[i].replace(NUMBERED, (m, a, d, c, w) => `${a}${d}${s.want ? ')' : '.'}${w}`);
      }
    }
    fp.sites = chosen.map((s) => [s.key, s.set, s.want]);
  }
  if (layers.includes('canary')) {
    fp.canary = canaryValues(orgSecret, recipient, version);
    fp.canary.placement = insertCanary(lines, fp.canary, meta);
    if (!fp.canary.placement) fp.canary = null;
  }
  if (layers.includes('beacon') && beaconUrl) {
    // Optional, off by default: one reference link in the example section, mapped to this copy server-side.
    const token = beaconToken(orgSecret, recipient, skill, version);
    const url = `${String(beaconUrl).replace(/\/+$/, '')}/r/${token}`;
    const placement = insertCanary(lines, null, collect(lines), beaconLine(url));
    fp.beacon = placement ? { token, url, placement } : null;
  }
  if (layers.includes('zw')) {
    const m2 = collect(lines);
    fp.zwPoints = insertZw(lines, tagBits, orgSecret, id, m2);
  }
  return { text: lines.join('\n'), fingerprint: fp };
}

// ---- tracing ---------------------------------------------------------------------------------------------------

const LOG2 = Math.log2;
/** Chance that two independent recipients picked the same option at a site with n options (parity carries the code bit). */
const chanceMatch = (n) => 0.25 * (1 / Math.ceil(n / 2) + 1 / Math.floor(n / 2));

/** P(X >= m) for X ~ Binomial(n, p). */
function binomTail(m, n, p) {
  let term = (1 - p) ** n;
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= m) sum += term;
    term *= ((n - k) / (k + 1)) * (p / (1 - p));
  }
  return Math.max(sum, 1e-300);
}
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

/** What a text shows: zero-width tags, observed wording choices by site key, plain text for canary search. */
export function inspect(leakedText) {
  const raw = String(leakedText).replace(/\r\n?/g, '\n');
  const tags = {};
  for (const m of raw.matchAll(/[‍‎]{32,}/g)) {
    for (let o = 0; o + TAG_BITS <= m[0].length; o += TAG_BITS) {
      const bits = [...m[0].slice(o, o + TAG_BITS)].map((c) => (c === ZW1 ? 1 : 0));
      const t = toHex(bits);
      tags[t] = (tags[t] || 0) + 1;
    }
  }
  const clean = norm(raw);
  const meta = collect(clean.split('\n'));
  const observed = new Map(meta.sites.map((s) => [s.key, s.idx]));
  return { tags, observed, plain: clean };
}

export function trace(leakedText, candidates, { orgSecret } = {}) {
  if (!orgSecret) throw new Error('trace needs orgSecret');
  const seen = inspect(leakedText);
  const plain = seen.plain.toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').replace(/\s+/g, ' ');
  const results = [];
  for (const fp of candidates) {
    const evidence = [];
    let bits = 0;
    // zw: recompute the keyed tag from (secret, recipient, version); do not trust the stored one.
    const tag = toHex(bitsOf(prf(orgSecret, `${fp.recipient}|${fp.version}`), TAG_BITS));
    let zwHits = 0;
    let zwDist = 99;
    for (const [t, n] of Object.entries(seen.tags)) {
      const d = hamming([...parseInt(t, 16).toString(2).padStart(32, '0')], [...parseInt(tag, 16).toString(2).padStart(32, '0')]);
      if (d <= 2) { zwHits += n; zwDist = Math.min(zwDist, d); }
    }
    if (zwHits) {
      const b = TAG_BITS - 8 * zwDist;
      bits += b;
      evidence.push(`zero-width tag found at ${zwHits} point${zwHits > 1 ? 's' : ''}${zwDist ? ` (${zwDist} bit error)` : ''} (+${b} bits)`);
    }
    // wording: compare the candidate's stored choices with what the text shows, by content-anchored site key.
    let match = 0; let miss = 0; let p = 0; let z = 0;
    for (const [key, set, want] of fp.sites || []) {
      if (!seen.observed.has(key)) continue;
      p += chanceMatch(OPTIONS[set] || 2);
      if (seen.observed.get(key) === want) match++; else miss++;
    }
    if (match + miss) {
      z = (match - p) / Math.sqrt(Math.max(1e-9, p * (1 - p / (match + miss))));
      // Evidence: binomial tail of the match count under chance, Bonferroni-corrected for the number of candidates,
      // turned into a Bayes-factor bound (Sellke-Bayarri-Berger) so weak coincidences give no evidence.
      const pAdj = Math.min(1, binomTail(match, match + miss, p / (match + miss)) * Math.max(1, candidates.length));
      const wb = pAdj >= 1 / Math.E ? 0 : LOG2(1 / (-Math.E * pAdj * Math.log(pAdj)));
      bits += wb;
      evidence.push(`wording: ${match} of ${match + miss} visible sites match (+${wb.toFixed(1)} bits)`);
    }
    // canary: values are recomputed from the secret, so they work even if the stored fingerprint lacks them.
    if ((fp.layers || ['canary']).includes('canary') && (fp.canary || !fp.layers)) {
      const c = canaryValues(orgSecret, fp.recipient, fp.version);
      const found = [];
      let cb = 0;
      if (plain.includes(c.name.toLowerCase())) { found.push(`name "${c.name}"`); cb += LOG2(FIRST.length * LAST.length); }
      if (new RegExp(`(?<![\\d])${c.ref}(?![\\d])`).test(plain)) { found.push(`ticket ${c.ref}`); cb += LOG2(90000); }
      if (plain.includes(c.amount.replace(/,/g, '').toLowerCase())) { found.push(`amount ${c.amount}`); cb += LOG2(9000 * 100); }
      if (found.length) { bits += cb; evidence.push(`canary: ${found.join(', ')} (+${cb.toFixed(1)} bits)`); }
    }
    if (fp.beacon?.token && leakedText.includes(fp.beacon.token)) { bits += 40; evidence.push('beacon: the per-copy reference link is present (+40 bits)'); }
    results.push({ z, recipient: fp.recipient, version: fp.version, confidence: 0, evidenceBits: Math.round(bits * 10) / 10, evidence });
  }
  // Confidence = posterior share of this suspect among all suspects (and "nobody"), treating 2^bits as a Bayes factor:
  // one clear match is ~1; two colluders with equal evidence split it; a coincidental 3-bit match next to a 100-bit one is ~0.
  const top = Math.max(0, ...results.map((r) => r.evidenceBits));
  const denom = top + LOG2(2 ** -top + results.reduce((a, r) => a + 2 ** (r.evidenceBits - top), 0));
  for (const r of results) r.confidence = Math.round(2 ** (r.evidenceBits - denom) * 1e6) / 1e6;
  return results.sort((a, b) => b.evidenceBits - a.evidenceBits || b.z - a.z || a.recipient.localeCompare(b.recipient)).map(({ z, ...r }) => r);
}

// ---- CLI -------------------------------------------------------------------------------------------------------

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.DS_Store'].includes(e.name)) continue;
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}
const secretOf = (f) => {
  const s = f.secret && f.secret !== true ? f.secret : process.env.SKILLYARD_SECRET;
  if (!s) throw new Error('give --secret <org secret> (or set SKILLYARD_SECRET)');
  return s;
};

export async function run(args, f = {}) {
  const dir = args[0];
  if (!dir || !f.recipient || !f.version || f.recipient === true || f.version === true) throw new Error('usage: skillhawk mark <skill-dir> --recipient alice --version 1.0.0 --secret <s> --out <dir> [--marks marks.json] [--layers zw,wording,canary]');
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) throw new Error(`${dir} has no SKILL.md`);
  const out = path.resolve(f.out && f.out !== true ? f.out : `${path.basename(path.resolve(dir))}.${f.recipient}`);
  if (fs.existsSync(out) && fs.readdirSync(out).length && !f.force) throw new Error(`${out} exists and is not empty (use --force)`);
  const layers = f.layers && f.layers !== true ? String(f.layers).split(',') : undefined;
  const { text, fingerprint } = markSkill(fs.readFileSync(skillFile, 'utf8'), { recipient: f.recipient, version: f.version, orgSecret: secretOf(f), layers });
  copyDir(dir, out);
  fs.writeFileSync(path.join(out, 'SKILL.md'), text);
  const { reviewDir } = await import('./review.js');
  const [before, after] = [reviewDir(dir), reviewDir(out)];
  if (before.grade !== after.grade) {
    console.error(`marked copy grades ${after.grade} but the original grades ${before.grade}; not recorded`);
    process.exitCode = 1;
    return;
  }
  if (f.marks && f.marks !== true) {
    const list = fs.existsSync(f.marks) ? JSON.parse(fs.readFileSync(f.marks, 'utf8')) : [];
    const next = list.filter((x) => !(x.recipient === fingerprint.recipient && x.version === fingerprint.version && x.skill === (before.name || '')));
    next.push({ skill: before.name || '', ...fingerprint });
    fs.writeFileSync(f.marks, `${JSON.stringify(next, null, 2)}\n`);
  }
  console.log(`marked ${f.recipient} v${f.version} -> ${out}  (review grade ${after.grade}, ${fingerprint.sites.length} wording sites, ${fingerprint.zwPoints} zero-width points, canary ${fingerprint.canary ? fingerprint.canary.placement : 'off'})`);
}

export async function traceCmd(args, f = {}) {
  const file = args[0];
  if (!file || !f.marks || f.marks === true) throw new Error('usage: skillhawk trace <leaked.md> --marks marks.json --secret <s> [--json]');
  const candidates = JSON.parse(fs.readFileSync(f.marks, 'utf8'));
  const res = trace(fs.readFileSync(file, 'utf8'), candidates, { orgSecret: secretOf(f) });
  if (f.json) return void console.log(JSON.stringify(res, null, 2));
  const top = res.filter((r) => r.evidenceBits > 0).slice(0, 5);
  if (!top.length) return void console.log('no recipient could be identified from this text');
  for (const r of top) console.log(`${r.recipient.padEnd(14)} v${r.version.padEnd(8)} confidence ${r.confidence.toFixed(4)}  (${r.evidenceBits} bits)\n${r.evidence.map((e) => `    ${e}`).join('\n')}`);
}
