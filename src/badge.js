// Skillyard badge: a static shields-style SVG from facts we can verify offline.
// Grade comes from review, "secure" only when secure finds no high/medium issue, lift only from a provided eval report.
import fs from 'node:fs';
import path from 'node:path';
import { reviewDir } from './review.js';
import { secureScan } from './secure.js';

const COLORS = { A: '#2ea44f', B: '#7cb305', C: '#dfb317', D: '#fe7d37', F: '#d73a49' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const width = (s) => Math.round(s.length * 6.6 + 14);

/** lift in points from --lift <pts> or a report json ({lift: 0.38} fraction, or array/first of those). Never invented. */
export function liftFrom({ lift, fromReport } = {}) {
  if (lift !== undefined && lift !== true) {
    const n = Number(lift);
    if (!Number.isFinite(n)) throw new Error(`--lift must be a number of points, got "${lift}"`);
    return Math.round(n);
  }
  if (fromReport && fromReport !== true) {
    const j = JSON.parse(fs.readFileSync(fromReport, 'utf8'));
    const r = Array.isArray(j) ? j[0] : j;
    if (!r || typeof r.lift !== 'number') throw new Error(`${fromReport} has no numeric "lift" (fraction, as written by eval)`);
    return Math.round(r.lift * 100);
  }
  return null;
}

export function badgeFacts(dir, opts = {}) {
  const review = reviewDir(dir);
  const sec = secureScan([dir]);
  return { name: path.basename(path.resolve(dir)), grade: review.grade, secure: sec.high + sec.medium === 0, lift: liftFrom(opts) };
}

export function badgeText({ grade, lift, secure }) {
  const parts = [grade];
  if (lift !== null && lift !== undefined) parts.push(`${lift >= 0 ? '+' : ''}${lift} lift`);
  parts.push(secure ? 'secure' : 'security findings');
  return parts.join(' · ');
}

export function badgeSvg(facts) {
  const left = 'skillyard';
  const right = badgeText(facts);
  const lw = width(left); const rw = width(right);
  const title = `Skillyard: ${right}`;
  const color = COLORS[facts.grade] || '#9f9f9f';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect width="${lw}" height="20" fill="#555"/>
<rect x="${lw}" width="${rw}" height="20" fill="${color}"/>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(left)}</text>
<text x="${lw + rw / 2}" y="14">${esc(right)}</text>
</g>
</svg>
`;
}

export async function run(args, flags = {}) {
  const dir = args[0];
  if (!dir) throw new Error('usage: skillyard badge <skill-dir> [--out badge.svg] [--lift <pts> | --from-report r.json] [--markdown]');
  const facts = badgeFacts(dir, { lift: flags.lift, fromReport: flags.fromReport });
  const svg = badgeSvg(facts);
  const out = flags.out && flags.out !== true ? flags.out : 'badge.svg';
  if (flags.markdown) {
    console.log(`[![skillyard: ${badgeText(facts)}](${out})](https://github.com/agentwik-labs/skillyard)`);
    if (!flags.out) return;
  }
  if (flags.out || !flags.markdown) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, svg);
    console.log(`${out}: skillyard | ${badgeText(facts)}`);
  }
}
