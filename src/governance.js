// Governance pack (X8): auditor-ready evidence export. Claims are modest: the files "support evidence for" controls;
// they do not make an organisation compliant with anything.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { runChecks } from './vault.js';
import { compareSemver } from './skill.js';

const dataDir = (f) => f.data || process.env.SKILLYARD_DATA || 'data';
export const FRAMEWORKS = ['soc2', 'iso42001', 'euaiact'];

export const MAPPING = {
  soc2: { name: 'SOC 2 (Trust Services Criteria)', rows: [
    ['CC6.1', 'Logical access controls', ['access-control.json', 'inventory.csv']],
    ['CC6.2 / CC6.3', 'Provisioning, modification and removal of access', ['access-control.json']],
    ['CC7.2', 'Monitoring of system activity', ['audit-integrity.json', 'approval-trail.json']],
    ['CC8.1', 'Change management: authorised, tested, approved changes', ['approval-trail.json', 'change-history.json']],
    ['CC3.2 / CC9.2', 'Risk assessment and vendor/third-party content', ['inventory.csv']],
  ] },
  iso42001: { name: 'ISO/IEC 42001 (AI management system)', rows: [
    ['Clause 8.1', 'Operational planning and control', ['approval-trail.json', 'change-history.json']],
    ['Clause 9.1', 'Monitoring, measurement, analysis and evaluation', ['inventory.csv', 'audit-integrity.json']],
    ['Annex A.6 (AI system life cycle)', 'Verification, release and change records', ['approval-trail.json', 'change-history.json']],
    ['Annex A.9 (Use of AI systems)', 'Controlled use and access to agent instructions', ['access-control.json', 'inventory.csv']],
    ['Annex A.10 (Third-party and customer relationships)', 'Control of content imported from third parties', ['inventory.csv']],
  ] },
  euaiact: { name: 'EU AI Act', rows: [
    ['Art. 12', 'Record-keeping (automatic logs of events)', ['audit-integrity.json', 'approval-trail.json']],
    ['Art. 9', 'Risk management system (review grade and security checks before release)', ['approval-trail.json', 'inventory.csv']],
    ['Art. 14', 'Human oversight (named approvers; forced overrides recorded)', ['approval-trail.json', 'access-control.json']],
    ['Art. 15', 'Cybersecurity and robustness (signed skills, scan results)', ['inventory.csv']],
    ['Art. 11 / Annex IV', 'Technical documentation inputs (versions, owners, history)', ['inventory.csv', 'change-history.json']],
  ] },
};

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function buildGovernance(store, { org, framework = 'all', out }) {
  const o = store.getOrg(org);
  if (!o) throw new Error(`org ${org} not found`);
  const fws = framework === 'all' ? FRAMEWORKS : [framework];
  if (fws.some((x) => !FRAMEWORKS.includes(x))) throw new Error(`--framework must be ${FRAMEWORKS.join('|')}|all`);
  const log = store.auditLog({ org, limit: 1e6 }).reverse();
  const tokenName = (id) => store.db.tokens[id]?.name || log.find((e) => e.tokenId === id)?.who || id || 'unknown';

  const inventory = Object.values(store.db.skills).filter((s) => s.scope === org).sort((a, b) => a.id.localeCompare(b.id)).map((s) => {
    const versions = Object.keys(s.versions).sort(compareSemver);
    const first = s.versions[versions[0]];
    const cur = s.versions[s.latest];
    let grade = null; let secHigh = null;
    try {
      const c = runChecks(store.versionFiles(s, s.latest), o.minGrade || 'C');
      grade = c.summary.grade; secHigh = c.summary.high;
    } catch { /* files missing: left unknown */ }
    return {
      skill: s.id, owner: tokenName(first.publishedBy), visibility: s.visibility, versions: versions.join(' '), latest: s.latest,
      signed: !!cur.signature, lastReviewGrade: grade, securityStatus: secHigh === null ? 'unknown' : secHigh === 0 ? 'no high findings' : `${secHigh} high finding(s)`,
      scanCritical: cur.scan?.critical ?? 0, scanWarnings: cur.scan?.warning ?? 0, updatedAt: s.updatedAt,
    };
  });
  const approvalTrail = log.filter((e) => ['publish', 'publish.rejected', 'publish.forced', 'rollback'].includes(e.action))
    .map((e) => ({ at: e.at, action: e.action, skill: e.skill, version: e.version, by: e.who, host: e.host, check: e.check || null, forced: !!e.forced || e.action === 'publish.forced', reasons: e.reasons || undefined }));
  const tokens = store.listTokens(org).map((t) => ({ id: t.id, name: t.name, role: t.role, scopes: t.scopes, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
  const ev = store.db.events.filter((e) => e.org === org || (e.skill || '').startsWith(`@${org}/`));
  const access = {
    org, minGrade: o.minGrade, beaconEnabled: !!o.beacon?.enabled,
    roles: { admin: 'read, publish, org administration, audit log, force a failing publish', editor: 'read, publish, rollback', reader: 'read' },
    tokens,
    tokenCreations: ev.filter((e) => e.type === 'token.create').map(({ at, tokenId, role, scopes }) => ({ at, tokenId, role, scopes })),
    revocations: ev.filter((e) => e.type === 'token.revoke').map(({ at, tokenId }) => ({ at, tokenId })),
  };
  const history = {
    events: ev.map(({ at, type, ...rest }) => ({ at, type, ...rest })),
    note: 'Registry event history keeps the most recent 1000 events; the audit log is the long-term record.',
  };
  const integrity = store.verifyAudit();
  const csv = [['skill', 'owner', 'visibility', 'versions', 'latest', 'signed', 'last_review_grade', 'security_status', 'scan_critical', 'scan_warnings', 'updated_at'].join(','),
    ...inventory.map((r) => [r.skill, r.owner, r.visibility, r.versions, r.latest, r.signed, r.lastReviewGrade, r.securityStatus, r.scanCritical, r.scanWarnings, r.updatedAt].map(csvCell).join(','))].join('\n');
  const mapping = Object.fromEntries(fws.map((k) => [k, { name: MAPPING[k].name, rows: MAPPING[k].rows.map(([control, topic, files]) => ({ control, topic, evidenceFiles: files })) }]));
  const generatedAt = new Date().toISOString();
  const forced = approvalTrail.filter((a) => a.forced);

  const md = [
    `# Governance evidence export: @${org}`, '',
    `Generated ${generatedAt} by Skillhawk. This bundle **supports evidence for** the controls named below. It does not by itself establish compliance with any framework; scope, interpretation and attestation remain with the organisation and its auditor.`, '',
    '## Summary', '',
    `- Skills: ${inventory.length} (${inventory.filter((s) => s.visibility === 'private').length} private, ${inventory.filter((s) => s.signed).length} signed)`,
    `- Publish events: ${approvalTrail.filter((a) => a.action === 'publish').length}; rejected by checks: ${approvalTrail.filter((a) => a.action === 'publish.rejected').length}; forced overrides: ${forced.length}`,
    `- Active tokens: ${tokens.length}; revocations on record: ${access.revocations.length}`,
    `- Audit log integrity: ${integrity.ok ? 'verified' : 'FAILED'} (${integrity.entries} entries, ${integrity.chained} hash-chained, ${integrity.legacy} predate chaining), head \`${integrity.head}\``, '',
    '## Skill inventory', '',
    '| Skill | Owner | Visibility | Latest | Signed | Review grade | Security |', '|---|---|---|---|---|---|---|',
    ...inventory.map((r) => `| ${r.skill} | ${r.owner} | ${r.visibility} | ${r.latest} | ${r.signed ? 'yes' : 'no'} | ${r.lastReviewGrade ?? '?'} | ${r.securityStatus} |`), '',
    '## Approval trail', '',
    `Every publish passes a review grade of at least ${o.minGrade} and a security scan, or is rejected; an org admin can force an override, which is logged. ${approvalTrail.length} events in approval-trail.json.`, '',
    ...(forced.length ? ['Forced overrides:', ...forced.map((a) => `- ${a.at} ${a.skill}@${a.version} by ${a.by}`), ''] : ['No forced overrides on record.', '']),
    '## Access control', '', `Roles, ${tokens.length} active tokens and ${access.revocations.length} revocations in access-control.json.`, '',
    '## Change history', '', `${history.events.length} registry events and ${approvalTrail.filter((a) => a.action === 'rollback').length} rollbacks in change-history.json and approval-trail.json.`, '',
    '## Audit log integrity', '', `Each audit entry stores the hash of the one before it; \`skillhawk audit verify\` re-walks the chain. Result in audit-integrity.json. Truncation of the final entries is detectable only against a previously saved head hash.`, '',
    '## Control mapping (supports evidence for)', '',
    ...fws.flatMap((k) => [`### ${MAPPING[k].name}`, '', '| Control | Topic | Evidence files |', '|---|---|---|', ...MAPPING[k].rows.map(([c, t, f]) => `| ${c} | ${t} | ${f.join(', ')} |`), '']),
    'Evidence file names refer to files in this directory.', '',
  ].join('\n');

  const dir = path.resolve(out);
  fs.mkdirSync(dir, { recursive: true });
  const w = (n, c) => fs.writeFileSync(path.join(dir, n), typeof c === 'string' ? c : `${JSON.stringify(c, null, 2)}\n`);
  w('governance.md', md);
  w('governance.json', { org, generatedAt, frameworks: fws, summary: { skills: inventory.length, forcedOverrides: forced.length, auditIntegrity: integrity.ok }, inventory, mapping });
  w('inventory.csv', `${csv}\n`);
  w('approval-trail.json', approvalTrail);
  w('access-control.json', access);
  w('change-history.json', history);
  w('audit-integrity.json', integrity);
  return { dir, inventory, mapping, integrity };
}

export async function governanceCmd(args, f) {
  if (args[0] !== 'export' || !f.org || f.org === true) throw new Error('usage: skillhawk governance export --org <org> [--framework soc2|iso42001|euaiact|all] [--out dir] [--data dir]');
  const out = f.out && f.out !== true ? f.out : `governance-${f.org}`;
  const r = buildGovernance(new Store(dataDir(f)), { org: f.org, framework: f.framework && f.framework !== true ? f.framework : 'all', out });
  console.log(`wrote governance bundle (${r.inventory.length} skills, audit log ${r.integrity.ok ? 'verified' : 'FAILED'}) to ${r.dir}`);
}
