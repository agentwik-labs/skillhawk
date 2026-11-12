// Company vault helpers: roles, line diffs, publish checks (review + secure), pull finalisation (signature check, per-person marks).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { reviewFiles } from './review.js';
import { secureScan, formatFinding } from './secure.js';

export const DEFAULT_LEASE_DAYS = 7;
export const ROLES = ['admin', 'editor', 'reader'];
export const GRADES = ['A', 'B', 'C', 'D', 'F'];
export const ROLE_SCOPES = { admin: ['read', 'publish'], editor: ['read', 'publish'], reader: ['read'] };

/** Role for a token record; older tokens only have scopes. */
export const roleOf = (t) => t.role || (t.scopes.includes('admin') ? 'admin' : t.scopes.includes('publish') ? 'editor' : 'reader');

export const newOrgKeys = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    secret: crypto.randomBytes(32).toString('hex'),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
};

// ---- checks ---------------------------------------------------------------

/** Run Reviewer and Security on a file set. passed = grade >= minGrade and no high security finding. */
export function runChecks(files, minGrade = 'C') {
  const review = reviewFiles(files, 'skill');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillyard-check-'));
  let sec;
  try {
    for (const [rel, buf] of Object.entries(files)) {
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    sec = secureScan([tmp]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const reasons = [];
  if (GRADES.indexOf(review.grade) > GRADES.indexOf(minGrade)) reasons.push(`review grade ${review.grade} is below the org minimum ${minGrade}`);
  const high = sec.findings.filter((f) => f.severity === 'high');
  if (high.length) reasons.push(`${high.length} high security finding${high.length === 1 ? '' : 's'}`);
  const report = [
    `review: grade ${review.grade} (${review.score}/100), ${review.reason}`,
    ...review.findings.filter((f) => ['high', 'medium'].includes(f.severity)).slice(0, 6).map((f) => `  ${f.severity} ${f.file}:${f.line} ${f.message}`),
    `security: ${sec.high} high, ${sec.medium} medium, ${sec.low} low`,
    ...high.slice(0, 6).map((f) => `  ${formatFinding(f).split('\n')[0]}`),
  ].join('\n');
  return {
    passed: reasons.length === 0, reasons, report, minGrade,
    summary: { grade: review.grade, score: review.score, high: sec.high, medium: sec.medium },
  };
}

// ---- diff -----------------------------------------------------------------

/** Line diff (LCS). Returns lines prefixed with ' ', '+' or '-'. */
export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((l) => `-${l}`), ...y.map((l) => `+${l}`)];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push(` ${x[i]}`); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${x[i++]}`);
    else out.push(`+${y[j++]}`);
  }
  while (i < x.length) out.push(`-${x[i++]}`);
  while (j < y.length) out.push(`+${y[j++]}`);
  return out;
}

/** Diff two file maps ({rel: Buffer}). Only changed lines are kept, with 2 lines of context. */
export function diffFiles(a, b) {
  const files = [];
  for (const f of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[f] && b[f] && a[f].equals(b[f])) continue;
    const status = !a[f] ? 'added' : !b[f] ? 'removed' : 'changed';
    const lines = lineDiff(a[f]?.toString('utf8') ?? '', b[f]?.toString('utf8') ?? '');
    const keep = new Set();
    lines.forEach((l, i) => { if (l[0] !== ' ') for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k); });
    const out = [];
    lines.forEach((l, i) => { if (keep.has(i)) out.push(l); else if (out[out.length - 1] !== '...') out.push('...'); });
    files.push({ file: f, status, added: lines.filter((l) => l[0] === '+').length, removed: lines.filter((l) => l[0] === '-').length, diff: out.join('\n') });
  }
  return files;
}

// ---- optional lanes (mark.js, sign.js) ------------------------------------

export async function signFiles(files, org) {
  const s = await import('./sign.js').catch(() => null);
  if (!s?.signFiles || !org?.privateKey) return null;
  const list = Array.isArray(files) ? files : Object.entries(files).map(([path, content]) => ({ path, content }));
  return await s.signFiles(list, org.privateKey);
}

/** Verify the stored signature and give the recipient a marked copy. Mutates and returns the bundle. */
export async function finalizePull(store, bundle, auth, { baseUrl = null } = {}) {
  const org = store.getOrg(bundle.scope);
  const ver = store.db.skills[bundle.id].versions[bundle.version];
  const who = auth?.name || auth?.tokenId || 'anonymous';
  if (ver.signature) {
    const s = await import('./sign.js').catch(() => null);
    if (s?.verifyFiles) {
      const files = Object.entries(bundle.files).map(([path, v]) => ({ path, content: Buffer.from(v, 'base64') }));
      let ok = false;
      try { ok = (await s.verifyFiles(files, ver.signature, org.publicKey))?.ok === true; } catch { ok = false; }
      if (!ok) {
        store.audit({ action: 'pull.rejected', org: bundle.scope, skill: bundle.id, version: bundle.version, reason: 'signature mismatch' }, auth);
        const { HttpError } = await import('./store.js');
        throw new HttpError(409, `signature check failed for ${bundle.id}@${bundle.version}: files do not match what the org signed`);
      }
    }
  }
  let fingerprint = null;
  const m = await import('./mark.js').catch(() => null);
  if (m?.markSkill && bundle.files['SKILL.md']) {
    const r = await m.markSkill(Buffer.from(bundle.files['SKILL.md'], 'base64').toString('utf8'), {
      recipient: who, version: bundle.version, orgSecret: org.secret, skill: bundle.id,
      ...(org.beacon?.enabled && baseUrl ? { layers: ['zw', 'wording', 'canary', 'beacon'], beaconUrl: baseUrl } : {}),
    });
    bundle.files['SKILL.md'] = Buffer.from(r.text).toString('base64');
    fingerprint = r.fingerprint ?? null;
    store.recordMark({ recipient: who, skill: bundle.id, version: bundle.version, fingerprint });
    if (r.fingerprint?.beacon) store.registerBeacon({ org: bundle.scope, recipient: who, skill: bundle.id, version: bundle.version, token: r.fingerprint.beacon.token });
  }
  store.audit({ action: 'pull', org: bundle.scope, skill: bundle.id, version: bundle.version, marked: !!fingerprint }, auth);
  // Installed copies of private skills carry a lease; `skillyard sync` removes them once it runs out.
  if (store.db.skills[bundle.id].visibility === 'private') {
    const days = org.leaseDays ?? DEFAULT_LEASE_DAYS;
    bundle.lease = { days, expiresAt: new Date(Date.now() + days * 86400000).toISOString() };
  }
  return bundle;
}
