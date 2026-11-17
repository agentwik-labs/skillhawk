// Beacon layer CLI (X4): `org settings --beacon on|off` and `alerts`. Works on the local data dir, like `token` and `org`.
// Mechanism and legal notes: docs/beacon.md.
import { Store } from './store.js';

const ADMIN = { name: 'cli', tokenId: 'cli' };
const dataDir = (f) => f.data || process.env.SKILLYARD_DATA || 'data';

export async function orgSettings(args, f) {
  const slug = (args[0] && !args[0].startsWith('-') ? args[0] : null) || (f.org !== true ? f.org : null);
  if (!slug) throw new Error('usage: skillhawk org settings <org> --beacon on|off [--i-have-legal-review] [--data dir]');
  const store = new Store(dataDir(f));
  if (!store.getOrg(slug)) throw new Error(`org ${slug} not found`);
  if (f.beacon === undefined) {
    const b = store.getOrg(slug).beacon;
    return void console.log(`@${slug}: beacon ${b?.enabled ? 'ON' : 'off'}${b?.changedAt ? ` (changed ${b.changedAt})` : ''}`);
  }
  if (!['on', 'off'].includes(f.beacon)) throw new Error('--beacon must be on or off');
  // args.js camelCases --i-have-legal-review to iHaveLegalReview; legalReview is the programmatic name.
  store.setBeacon(slug, f.beacon === 'on', !!(f.iHaveLegalReview || f.legalReview), ADMIN);
  console.log(`@${slug}: beacon ${f.beacon}${f.beacon === 'on' ? '. Disclose it in your employee policy (docs/beacon.md).' : ''}`);
}

export async function alertsCmd(_args, f) {
  const store = new Store(dataDir(f));
  const list = store.alerts(f.org !== true ? f.org : undefined);
  if (f.json) return void console.log(JSON.stringify(list, null, 2));
  if (!list.length) return void console.log('no beacon alerts');
  for (const a of list) console.log(`${a.at.slice(0, 19)}  ${a.recipient.padEnd(12)} ${a.skill}@${a.version}  ip ${a.ip || '?'}  ua "${a.userAgent || ''}"  referer "${a.referer || ''}"`);
}
