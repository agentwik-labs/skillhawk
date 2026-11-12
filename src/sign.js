// Signed skills: ed25519 over a canonical manifest (sorted path -> sha256) of a skill's files.
//
// The vault signs the per-person marked copy it serves, at serve time, with the org key: a marked copy differs
// from the originally signed skill, so the signature of the original can never verify it. `verify` works on
// whatever was delivered, against the org public key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSkillDir } from './skill.js';

export const SIGNATURE_FILE = '.skillyard-signature.json';
// Files that are not part of the signed content: the signature itself and the install marker.
const EXCLUDED = new Set([SIGNATURE_FILE, '.skillyard-install.json']);
const ALG = 'ed25519';

export function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

const buf = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
const sha = (c) => crypto.createHash('sha256').update(buf(c)).digest('hex');

/** { path: sha256 } with keys sorted by path; the signature file itself is never included. */
export function buildManifest(files) {
  const m = {};
  for (const f of [...files].filter((x) => !EXCLUDED.has(x.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) m[f.path] = sha(f.content);
  return m;
}

const canonical = (manifest) => Buffer.from(JSON.stringify(Object.keys(manifest).sort().map((k) => [k, manifest[k]])), 'utf8');

/** files = [{ path, content }] → { alg, manifest, sig } (sig is base64). */
export function signFiles(files, privateKey) {
  const manifest = buildManifest(files);
  const sig = crypto.sign(null, canonical(manifest), crypto.createPrivateKey(privateKey)).toString('base64');
  return { alg: ALG, manifest, sig };
}

/** → { ok, changed: [paths added, removed or modified], error? }. */
export function verifyFiles(files, signature, publicKey) {
  if (!signature || signature.alg !== ALG || typeof signature.sig !== 'string' || !signature.manifest || typeof signature.manifest !== 'object') {
    return { ok: false, changed: [], error: 'missing or malformed signature' };
  }
  let valid = false;
  try { valid = crypto.verify(null, canonical(signature.manifest), crypto.createPublicKey(publicKey), Buffer.from(signature.sig, 'base64')); } catch { valid = false; }
  const have = buildManifest(files);
  const changed = [...new Set([...Object.keys(have), ...Object.keys(signature.manifest)])]
    .filter((p) => have[p] !== signature.manifest[p]).sort();
  if (!valid) return { ok: false, changed, error: 'signature does not match the public key (wrong key, or the manifest was edited)' };
  return { ok: changed.length === 0, changed };
}

export const dirToFiles = (dir) => Object.entries(readSkillDir(dir)).map(([p, content]) => ({ path: p, content }));

// ---- CLI ------------------------------------------------------------------

export async function keysCmd(args, f) {
  if (args[0] !== 'create' || !f.out || f.out === true) throw new Error('usage: skillyard keys create --out <dir>');
  const out = path.resolve(f.out);
  const priv = path.join(out, 'skillyard-private.pem');
  const pub = path.join(out, 'skillyard-public.pem');
  if ((fs.existsSync(priv) || fs.existsSync(pub)) && !f.force) throw new Error(`${out} already holds keys (use --force to replace them)`);
  fs.mkdirSync(out, { recursive: true });
  const { publicKey, privateKey } = generateKeys();
  fs.writeFileSync(priv, privateKey, { mode: 0o600 });
  fs.writeFileSync(pub, publicKey);
  console.log(`wrote ${priv} (keep secret)\nwrote ${pub} (share with whoever verifies)`);
}

export async function signCmd(args, f) {
  const dir = args[0];
  if (!dir || !f.key || f.key === true) throw new Error('usage: skillyard sign <skill-dir> --key <private.pem>');
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`${dir} has no SKILL.md`);
  const sig = signFiles(dirToFiles(dir), fs.readFileSync(f.key, 'utf8'));
  fs.writeFileSync(path.join(dir, SIGNATURE_FILE), `${JSON.stringify(sig, null, 2)}\n`);
  console.log(`signed ${dir}: ${Object.keys(sig.manifest).length} file(s) → ${SIGNATURE_FILE}`);
}

export async function verifyCmd(args, f) {
  const dir = args[0];
  if (!dir || !f.pub || f.pub === true) throw new Error('usage: skillyard verify <skill-dir> --pub <public.pem>');
  const sigPath = path.join(dir, SIGNATURE_FILE);
  if (!fs.existsSync(sigPath)) { console.log(`FAIL ${dir}: no ${SIGNATURE_FILE}`); process.exitCode = 1; return; }
  const r = verifyFiles(dirToFiles(dir), JSON.parse(fs.readFileSync(sigPath, 'utf8')), fs.readFileSync(f.pub, 'utf8'));
  if (r.ok) { console.log(`ok   ${dir}: signature valid`); return; }
  console.log(`FAIL ${dir}: ${r.error || 'files differ from what was signed'}${r.changed.length ? `\n  changed: ${r.changed.join(', ')}` : ''}`);
  process.exitCode = 1;
}
