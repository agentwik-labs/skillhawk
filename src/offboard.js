// Admin offboarding: revoke a member's access, and report everything they ever pulled.
import fs from 'node:fs';
import { loadConfig, RemoteRegistry } from './client.js';

async function orgOf(reg, f) {
  const org = f.org || (await reg.request('GET', '/api/whoami')).org;
  if (!org) throw new Error('give --org <org>');
  return org;
}

export async function revokeCmd(args, f) {
  const member = f.user && f.user !== true ? f.user : args[0];
  if (!member) throw new Error('usage: skillhawk revoke --user <token-name|member> [--org o]');
  const reg = new RemoteRegistry(loadConfig());
  const org = await orgOf(reg, f);
  const r = await reg.request('POST', `/api/orgs/${org}/revoke`, { member });
  console.log(`revoked ${r.member} in @${org}: ${r.revoked.length} token(s) disabled. Their next call fails with "access revoked by your org admin".`);
  return r;
}

export function formatReport(h) {
  const L = [`# Offboarding report: ${h.member} (@${h.org})`, ''];
  L.push('## Access', '');
  if (h.tokens.length) h.tokens.forEach((t) => L.push(`- token ${t.id} (${t.name}), created ${t.createdAt.slice(0, 10)}, last used ${t.lastUsedAt?.slice(0, 10) || 'never'}, ${t.revokedAt ? `revoked ${t.revokedAt.slice(0, 19)}Z` : 'STILL ACTIVE'}`));
  else L.push('- no tokens found');
  L.push('', `## Skills held (${h.held.length})`, '');
  if (h.held.length) {
    L.push('| Skill | Version | Times | First | Last | How | Mark |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of h.held) L.push(`| ${r.skill} | ${r.version} | ${r.count} | ${r.first?.slice(0, 10) || ''} | ${r.last?.slice(0, 10) || ''} | ${r.via.join(', ') || 'marked copy'} | ${markLabel(r.fingerprint)} |`);
  } else L.push('This person never pulled a skill.');
  L.push('', 'Copies pulled as files may still sit on their machines until the lease expires (default 7 days, removed by `skillhawk sync`); marks identify a leaked copy.');
  return `${L.join('\n')}\n`;
}

export async function offboardCmd(args, f) {
  const member = args[0];
  if (!member) throw new Error('usage: skillhawk offboard <member> [--org o] [--out report.md]');
  const reg = new RemoteRegistry(loadConfig());
  const org = await orgOf(reg, f);
  await reg.request('POST', `/api/orgs/${org}/revoke`, { member });
  const md = formatReport(await reg.request('GET', `/api/orgs/${org}/members/${encodeURIComponent(member)}/holdings`));
  if (f.out && f.out !== true) { fs.writeFileSync(f.out, md); console.log(`revoked ${member}; report written to ${f.out}`); } else process.stdout.write(md);
  return md;
}

/** A short, readable mark: the per-person tag and which layers carry it. */
export const markLabel = (fp) => (!fp ? '' : typeof fp === 'object' ? `\`${fp.tag || '?'}\`${fp.layers?.length ? ` (${fp.layers.join(', ')})` : ''}` : `\`${fp}\``);
