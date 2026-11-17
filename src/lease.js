// Installed-file safety net: copies of private skills carry a lease (.skillyard-lease.json). Sync removes expired ones.
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, LEASE_FILE, listInstalled, uninstall } from './agents.js';

export function readLease(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, LEASE_FILE), 'utf8')); } catch { return null; }
}

/** Remove every installed skill whose lease has run out. Returns [{agent, name, id, expiredAt}]. */
export function expireLeases({ agents = Object.keys(AGENTS), cwd = process.cwd(), global = false, now = Date.now() } = {}) {
  const removed = [];
  for (const agent of agents) {
    for (const s of listInstalled(agent, { cwd, global })) {
      const lease = readLease(s.dir);
      if (lease && Date.parse(lease.expiresAt) <= now) {
        uninstall(agent, s.name, { cwd, global });
        removed.push({ agent, name: s.name, id: s.id, expiredAt: lease.expiresAt });
      }
    }
  }
  return removed;
}

/** Wrapper for `skillhawk sync`: expire first, then sync re-fetches (and fails if access was revoked). */
export async function syncWithLeases(args, f, sync) {
  const removed = expireLeases({ cwd: process.cwd(), global: !!f.global });
  if (!f.quiet) for (const r of removed) console.log(`lease expired: removed ${r.id} from ${AGENTS[r.agent].label}`);
  return sync(args, f);
}
