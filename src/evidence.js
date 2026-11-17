// Evidence pack (X5): trace a leaked file against an org's stored marks and write a signed, auditable bundle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './store.js';
import { trace } from './mark.js';
import { signFiles, verifyFiles } from './sign.js';

const dataDir = (f) => f.data || process.env.SKILLYARD_DATA || 'data';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function buildEvidence(store, { org, leaked, leakedName = 'leaked.md', out }) {
  const o = store.getOrg(org);
  if (!o) throw new Error(`org ${org} not found`);
  const generatedAt = new Date().toISOString();
  const text = leaked.toString('utf8');
  // Candidates: every stored mark of this org, deduplicated per skill/recipient/version.
  const bySkill = new Map();
  for (const m of store.db.marks) {
    if (!m.fingerprint || !m.skill.startsWith(`@${org}/`)) continue;
    const list = bySkill.get(m.skill) || new Map();
    list.set(`${m.recipient}|${m.version}`, m.fingerprint);
    bySkill.set(m.skill, list);
  }
  let results = [];
  for (const [skill, fps] of bySkill) {
    for (const r of trace(text, [...fps.values()], { orgSecret: o.secret })) if (r.evidenceBits > 0) results.push({ skill, ...r });
  }
  results = results.sort((a, b) => b.evidenceBits - a.evidenceBits).slice(0, 5);
  const top = results[0] || null;
  const audit = store.verifyAudit();
  const log = store.auditLog({ org, limit: 100000 }).reverse();
  const pulls = top ? log.filter((e) => e.action === 'pull' && e.who === top.recipient && e.skill === top.skill).map((e) => ({ at: e.at, version: e.version, host: e.host, marked: !!e.marked })) : [];
  const hits = top ? store.alerts(org).filter((a) => a.recipient === top.recipient && a.skill === top.skill).map(({ at, ip, userAgent, referer, version }) => ({ at, ip, userAgent, referer, version })) : [];
  const evidence = {
    kind: 'skillyard-evidence', version: 1, generatedAt, org,
    leakedFile: { name: leakedName, sha256: sha256(leaked), bytes: leaked.length },
    candidates: results,
    topCandidate: top ? { recipient: top.recipient, skill: top.skill, version: top.version, confidence: top.confidence, evidenceBits: top.evidenceBits } : null,
    pullHistory: pulls,
    beaconHits: hits,
    auditLog: { ok: audit.ok, entries: audit.entries, chained: audit.chained, legacy: audit.legacy, head: audit.head, errors: audit.errors },
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const sig = signFiles([{ path: 'evidence.json', content: json }], o.privateKey);

  const pct = (c) => `${(c * 100).toFixed(2)}%`;
  const report = [
    `# Leak evidence report: @${org}`, '',
    `Generated ${generatedAt}. Leaked file \`${leakedName}\`, sha256 \`${evidence.leakedFile.sha256}\` (${leaked.length} bytes).`, '',
    '## Summary', '',
    top ? `The leaked text most likely derives from the copy delivered to **${top.recipient}** (${top.skill} v${top.version}), confidence ${pct(top.confidence)} (${top.evidenceBits} bits of evidence). Confidence is a statistical estimate from the marks, not proof of who disclosed the file; review it with the pull history below.` : 'No stored mark matched this text. No recipient can be named.', '',
    '## Candidates', '',
    ...(results.length ? ['| Recipient | Skill | Version | Confidence | Bits |', '|---|---|---|---|---|', ...results.map((r) => `| ${r.recipient} | ${r.skill} | ${r.version} | ${pct(r.confidence)} | ${r.evidenceBits} |`)] : ['None.']), '',
    '## Per-layer evidence', '',
    ...(results.length ? results.flatMap((r) => [`**${r.recipient}** (${r.skill} v${r.version})`, ...r.evidence.map((e) => `- ${e}`), '']) : ['None.', '']),
    '## Pull history of the top candidate', '',
    ...(pulls.length ? ['| Time (UTC) | Version | Host |', '|---|---|---|', ...pulls.map((p) => `| ${p.at} | ${p.version} | ${p.host || '?'} |`)] : ['No pulls recorded.']), '',
    '## Beacon hits', '',
    ...(hits.length ? ['| Time (UTC) | IP | User-agent | Referer |', '|---|---|---|---|', ...hits.map((h) => `| ${h.at} | ${h.ip || '?'} | ${h.userAgent || ''} | ${h.referer || ''} |`)] : ['None recorded (the beacon layer is off by default; see docs/beacon.md).']), '',
    '## Audit log integrity', '',
    `${audit.ok ? 'VERIFIED' : 'FAILED'}: ${audit.entries} entries (${audit.chained} hash-chained, ${audit.legacy} written before chaining). Head hash \`${audit.head}\`.`,
    ...audit.errors.map((e) => `- ${e}`), '',
    '## Signature', '',
    'evidence.json is signed with the org ed25519 key (evidence.sig.json). The public key is in public-key.pem. See VERIFY.md.', '',
  ].join('\n');

  const takedown = [
    '# DRAFT: review with counsel before sending', '',
    'This is a template, not legal advice. Placeholders in [BRACKETS] must be completed.', '',
    'To: [HOSTING PROVIDER / PLATFORM DESIGNATED AGENT]', `Date: [DATE]`, '',
    'Subject: Notice of claimed infringement and request for removal', '',
    `I, [NAME], [TITLE] of [COMPANY] ("Rights holder"), am authorized to act for the owner of the copyright in the work "${top ? top.skill : '[SKILL NAME]'}".`, '',
    'Original work: [DESCRIBE THE WORK AND WHERE THE AUTHORIZED COPY LIVES]', '',
    'Infringing material: [URL OF THE INFRINGING COPY]. The material contains a copy of the work, identified by a per-recipient mark. The attached evidence pack (evidence.json, signed) records a file with sha256 ' + evidence.leakedFile.sha256 + '.', '',
    'I have a good faith belief that use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.', '',
    'The information in this notice is accurate, and under penalty of perjury, I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.', '',
    'Contact: [ADDRESS] / [EMAIL] / [PHONE]', '',
    'Signature: [ELECTRONIC SIGNATURE]', '',
  ].join('\n');

  const verify = [
    '# Verifying this evidence pack', '',
    '1. Confirm `evidence.json` matches the signature, using the org public key in `public-key.pem`:', '',
    '   `skillhawk evidence verify <this directory>`', '',
    '   This checks the ed25519 signature in `evidence.sig.json` against `public-key.pem` and the sha256 of `evidence.json`. A changed byte in evidence.json makes it fail.', '',
    '2. Confirm the public key is the org key: compare `public-key.pem` with the key the registry publishes at `GET /api/orgs/' + org + '` (field `publicKey`).', '',
    '3. Re-hash the leaked file: `shasum -a 256 <leaked file>` must equal `leakedFile.sha256` in evidence.json.', '',
    '4. Audit log chain: on the registry host run `skillhawk audit verify --data <dir>`; the head hash must be at or after the one in evidence.json (`auditLog.head`).', '',
    'The chain detects edited, removed or inserted entries in the middle of the log. A log truncated at its very end is only detectable by comparing against a head hash saved earlier, such as the one here.', '',
  ].join('\n');

  const dir = path.resolve(out);
  fs.mkdirSync(dir, { recursive: true });
  const write = (n, c) => fs.writeFileSync(path.join(dir, n), c);
  write('report.md', report);
  write('evidence.json', json);
  write('evidence.sig.json', `${JSON.stringify(sig, null, 2)}\n`);
  write('public-key.pem', o.publicKey);
  write('audit-verification.json', `${JSON.stringify(audit, null, 2)}\n`);
  write('takedown-notice-DRAFT.md', takedown);
  write('VERIFY.md', verify);
  return { dir, evidence };
}

export function verifyEvidence(dir) {
  const d = path.resolve(dir);
  const sig = JSON.parse(fs.readFileSync(path.join(d, 'evidence.sig.json'), 'utf8'));
  const pub = fs.readFileSync(path.join(d, 'public-key.pem'), 'utf8');
  return verifyFiles([{ path: 'evidence.json', content: fs.readFileSync(path.join(d, 'evidence.json')) }], sig, pub);
}

export async function evidenceCmd(args, f) {
  if (args[0] === 'verify') {
    if (!args[1]) throw new Error('usage: skillhawk evidence verify <evidence-dir>');
    const r = verifyEvidence(args[1]);
    console.log(r.ok ? 'ok   evidence.json signature valid' : `FAIL ${r.error || 'evidence.json differs from what was signed'}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  const file = args[0];
  if (!file || !f.org || f.org === true) throw new Error('usage: skillhawk evidence <leaked.md> --org <org> [--out evidence/] [--data dir]  |  evidence verify <dir>');
  const out = f.out && f.out !== true ? f.out : 'evidence';
  const { evidence } = buildEvidence(new Store(dataDir(f)), { org: f.org, leaked: fs.readFileSync(file), leakedName: path.basename(file), out });
  const t = evidence.topCandidate;
  console.log(`${t ? `most likely recipient: ${t.recipient} (${t.skill} v${t.version}, confidence ${(t.confidence * 100).toFixed(2)}%)` : 'no recipient identified'}\naudit log chain: ${evidence.auditLog.ok ? 'verified' : 'FAILED'}\nwrote evidence pack to ${path.resolve(out)}`);
}

export async function auditVerifyCmd(_args, f) {
  const r = new Store(dataDir(f)).verifyAudit();
  if (f.json) console.log(JSON.stringify(r, null, 2));
  else console.log(`${r.ok ? 'ok  ' : 'FAIL'} audit log: ${r.entries} entries (${r.chained} chained, ${r.legacy} legacy), head ${r.head}${r.errors.length ? `\n  ${r.errors.join('\n  ')}` : ''}`);
  if (!r.ok) process.exitCode = 1;
}
