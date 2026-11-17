// Company vault commands: versions, diff, rollback, audit, pull (+ lockfile), publish with checks.
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, detectAgents, installBundle, resolveAgents } from './agents.js';
import { loadConfig, RemoteRegistry } from './client.js';
import { parseSkillRef, readSkillDir, validateFiles } from './skill.js';

const registry = () => new RemoteRegistry(loadConfig());
const ref = (r) => {
  const x = parseSkillRef(r || '');
  if (!x) throw new Error(`invalid skill "${r || ''}" (use name or @org/name)`);
  return x;
};
const LOCK = 'skillyard.lock';

export async function versions(args) {
  const r = ref(args[0]);
  for (const v of await registry().versions(r.scope, r.name)) {
    console.log(`${v.current ? '*' : ' '} ${v.version.padEnd(10)} ${v.publishedAt.slice(0, 19)}  by ${String(v.publishedBy || '?').padEnd(12)} ${v.files} file(s)  ${v.checksum.slice(0, 19)}${v.signed ? '  signed' : ''}`);
  }
}

export async function diff(args) {
  if (args.length < 3) throw new Error('usage: skillhawk diff <skill> <v1> <v2>');
  const r = ref(args[0]);
  const d = await registry().diff(r.scope, r.name, args[1], args[2]);
  if (!d.files.length) return void console.log(`${d.id}: ${d.from} and ${d.to} are identical`);
  for (const f of d.files) console.log(`--- ${f.file} (${f.status}, +${f.added} -${f.removed})\n${f.diff}\n`);
}

export async function rollback(args) {
  if (args.length < 2) throw new Error('usage: skillhawk rollback <skill> <version>');
  const r = ref(args[0]);
  const s = await registry().rollback(r.scope, r.name, args[1]);
  console.log(`${s.id} now serves ${s.latest} (history kept; publish a new version to move forward)`);
}

export async function audit(_args, f) {
  const events = await registry().audit({ org: f.org, skill: f.skill, limit: f.limit });
  if (f.json) return void console.log(JSON.stringify(events, null, 2));
  for (const e of events.slice().reverse()) {
    const chk = e.check ? ` check=${e.check.grade}${e.check.forced ? ' FORCED' : ''}` : '';
    console.log(`${e.at.slice(0, 19)}  ${e.action.padEnd(16)} ${(e.skill || '').padEnd(28)} ${(e.version || '').padEnd(8)} by ${e.who}@${e.host || '?'}${chk}${e.reason ? `  (${e.reason})` : ''}`);
  }
  if (!events.length) console.log('no audit entries');
}

export async function publish(args, f) {
  const dir = args[0] || '.';
  if (!f.org) throw new Error('usage: skillhawk publish <dir> --org <org> [--visibility public|private] [--force]');
  const files = readSkillDir(dir);
  const v = validateFiles(files);
  if (!v.ok) throw new Error(`invalid skill:\n  - ${v.errors.join('\n  - ')}`);
  const r = await registry().publish(f.org, files, f.visibility, { force: !!f.force });
  console.log(`published ${r.id}@${v.manifest.version} (${r.visibility})${r.warnings?.length ? `\nwarnings:\n  - ${r.warnings.join('\n  - ')}` : ''}`);
}

/** Install every skill of an org into the detected agents and write skillyard.lock; --frozen installs exactly the lock. */
export async function pull(_args, f) {
  const reg = registry();
  const cwd = process.cwd();
  const agents = f.agent ? resolveAgents(f.agent) : (detectAgents(cwd).length ? detectAgents(cwd) : ['claude']);
  const lockPath = path.join(cwd, LOCK);
  let targets;
  let org = f.org;
  if (f.frozen) {
    if (!fs.existsSync(lockPath)) throw new Error(`${LOCK} not found; run skillhawk pull first`);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    org ||= lock.org;
    targets = Object.entries(lock.skills).map(([id, e]) => ({ id, version: e.version, hash: e.hash }));
  } else {
    if (!org) org = (await reg.request('GET', '/api/whoami')).org;
    if (!org) throw new Error('usage: skillhawk pull --org <org>');
    const o = await reg.request('GET', `/api/orgs/${org}`);
    targets = o.skills.filter((s) => s.scope === org).map((s) => ({ id: s.id, version: s.latest }));
    if (!targets.length) throw new Error(`@${org} has no skills you can read`);
  }
  const lock = { lockVersion: 1, org, skills: {} };
  for (const t of targets.sort((a, b) => a.id.localeCompare(b.id))) {
    const x = ref(t.id);
    const b = await reg.bundle(x.scope, x.name, t.version, { pull: true });
    if (t.hash && b.checksum !== t.hash) throw new Error(`${t.id}@${t.version}: content hash ${b.checksum} does not match ${LOCK} (${t.hash})`);
    for (const a of agents) installBundle(a, b, { force: !!f.force });
    lock.skills[t.id] = { version: b.version, hash: b.checksum };
    console.log(`pulled ${t.id}@${b.version} for ${agents.map((a) => AGENTS[a].label).join(', ')}`);
  }
  if (!f.frozen) {
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`wrote ${LOCK} (${Object.keys(lock.skills).length} skills)`);
  }
}
