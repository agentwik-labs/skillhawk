// skillhawk tidy: the clutter agents leave behind, measured, and removed only when you say so.
// Finds: worktrees whose branch is merged and untouched for N days; node_modules in agent repos untouched for N days;
// dev servers left listening (from `skillhawk agents`); old agent session logs (archived as .gz, restorable).
// Without --yes it only lists. Each removal is reversible or re-creatable, and it says which: a merged worktree is
// snapshotted first and its branch kept; node_modules is reinstallable; logs are archived, not deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { agentRepos, recentCwds, snapshotOne, git } from './snapshot.js';
import { listJsonl } from './tokens.js';

const DAY = 86400e3;
export const DEFAULT_RULES = { worktreeDays: 14, nodeModulesDays: 21, logDays: 60, servers: true };
export const CATEGORIES = ['worktrees', 'node_modules', 'servers', 'logs'];
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };
export const archiveDir = () => path.join(process.env.SKILLHAWK_HOME || path.join(os.homedir(), '.skillhawk'), 'archive', 'logs');

export function duBytes(p) {
  try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\t')[0]) * 1024; } catch { return 0; }
}
const newest = (dir, depth = 2) => { let m = 0; const go = (d, k) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.name === 'node_modules' || e.name === '.git') continue; const p = path.join(d, e.name); try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch { /* gone */ } if (e.isDirectory() && k < depth) go(p, k + 1); } }; go(dir, 0); return m; };
export const human = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`);

function defaultBranch(top) {
  const r = tryGit(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r) return r;
  for (const b of ['main', 'master']) if (tryGit(top, ['rev-parse', '--verify', b])) return b;
  return null;
}

/** Everything tidy could do, with sizes. Nothing is changed. */
export async function find({ rules = DEFAULT_RULES, dirs = null, now = Date.now(), logs = path.join(os.homedir(), '.claude', 'projects'), servers = null } = {}) {
  const R = { ...DEFAULT_RULES, ...rules };
  const trees = dirs || agentRepos({ days: 60, now });
  const items = [];
  const mains = new Set();
  for (const t of trees) { const common = tryGit(t, ['rev-parse', '--git-common-dir']); if (common) mains.add(path.resolve(t, common)); }
  const active = recentCwds({ days: 120, now });
  // last sign of life: newest file, the folder itself, the last commit, the last agent session in it
  const lastTouched = (t) => Math.max(newest(t), (() => { try { return fs.statSync(t).mtimeMs; } catch { return 0; } })(), Number(tryGit(t, ['log', '-1', '--format=%ct']) || 0) * 1000, ...[...active].filter(([c]) => c === t || c.startsWith(`${t}${path.sep}`)).map(([, m]) => m));
  for (const t of trees) {
    const gitDir = tryGit(t, ['rev-parse', '--absolute-git-dir']);
    const isLinked = gitDir && /\/worktrees\/[^/]+$/.test(gitDir);
    if (isLinked && R.worktreeDays != null) {
      const branch = tryGit(t, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const top = path.resolve(t, tryGit(t, ['rev-parse', '--git-common-dir']), '..');
      const base = defaultBranch(top);
      const merged = base && branch && branch !== 'HEAD' && tryGit(top, ['merge-base', '--is-ancestor', branch, base]) !== null;
      const age = (now - lastTouched(t)) / DAY;
      const dirty = (tryGit(t, ['status', '--porcelain']) || '').trim().length > 0;
      if (merged && age >= R.worktreeDays) items.push({ category: 'worktrees', path: t, bytes: duBytes(t), detail: `branch ${branch} is merged into ${base}; untouched ${Math.floor(age)} days${dirty ? '; has uncommitted changes (snapshotted first)' : ''}`, undo: `git worktree add ${t} ${branch}`, branch, top, dirty });
    }
    const nm = path.join(t, 'node_modules');
    if (R.nodeModulesDays != null && fs.existsSync(nm)) {
      const age = (now - lastTouched(t)) / DAY;
      if (age >= R.nodeModulesDays) items.push({ category: 'node_modules', path: nm, bytes: duBytes(nm), detail: `repo untouched ${Math.floor(age)} days`, undo: `cd ${t} && npm install (or your package manager)` });
    }
  }
  if (R.servers) {
    let svs = servers;
    if (!svs) { try { const { collect } = await import('./agentwatch.js'); svs = (await collect({}, now)).servers || []; } catch { svs = []; } }
    for (const s of svs) items.push({ category: 'servers', path: `pid ${s.pid}`, pid: s.pid, bytes: (s.rssMb || 0) * 1e6, memory: true, detail: `${s.command || 'dev server'} on port ${(s.ports || []).join(',') || '?'}, running ${Math.floor((s.seconds || 0) / 3600)}h with no terminal (${s.rssMb || '?'} MB memory)`, undo: 'start it again from its project' });
  }
  if (R.logDays != null) {
    let bytes = 0; const files = [];
    for (const f of listJsonl(logs)) { try { const st = fs.statSync(f); if (now - st.mtimeMs > R.logDays * DAY) { bytes += st.size; files.push(f); } } catch { /* gone */ } }
    if (files.length) items.push({ category: 'logs', path: logs, files, bytes, detail: `${files.length} session logs older than ${R.logDays} days (archived as .gz; those sessions can't be resumed until restored)`, undo: 'skillhawk tidy --restore-logs' });
  }
  return { items, bytes: items.filter((x) => !x.memory).reduce((a, x) => a + x.bytes, 0) };
}

/** Do the chosen categories. Returns an action log (what was done, how to undo it). */
export function apply(found, { categories = CATEGORIES, kill = (pid) => process.kill(pid, 'SIGTERM'), now = Date.now(), logsRoot = path.join(os.homedir(), '.claude', 'projects') } = {}) {
  const done = [];
  for (const it of found.items.filter((x) => categories.includes(x.category))) {
    try {
      if (it.category === 'worktrees') {
        if (it.dirty) snapshotOne(it.path, { now });
        git(it.top, ['worktree', 'remove', ...(it.dirty ? ['--force'] : []), it.path]);
      } else if (it.category === 'node_modules') fs.rmSync(it.path, { recursive: true, force: true });
      else if (it.category === 'servers') kill(it.pid);
      else if (it.category === 'logs') {
        for (const f of it.files) {
          const dest = path.join(archiveDir(), path.relative(logsRoot, f) + '.gz');
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          fs.writeFileSync(dest, zlib.gzipSync(fs.readFileSync(f)), { mode: 0o600 });
          fs.rmSync(f);
        }
      }
      done.push({ at: new Date(now).toISOString(), category: it.category, path: it.path, bytes: it.bytes, undo: it.undo });
    } catch (e) { done.push({ at: new Date(now).toISOString(), category: it.category, path: it.path, error: e.message.split('\n')[0] }); }
  }
  return done;
}

/** Put archived session logs back where Claude Code reads them. */
export function restoreLogs({ logsRoot = path.join(os.homedir(), '.claude', 'projects') } = {}) {
  let n = 0;
  const go = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else if (e.name.endsWith('.jsonl.gz')) { const dest = path.join(logsRoot, path.relative(archiveDir(), p).replace(/\.gz$/, '')); if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, zlib.gunzipSync(fs.readFileSync(p))); } fs.rmSync(p); n++; } } };
  go(archiveDir());
  return n;
}

export async function run(args, flags = {}) {
  if (flags['restore-logs']) return void console.log(`Restored ${restoreLogs()} session log(s).`);
  const num = (k, d) => (flags[k] === 'off' ? null : flags[k] != null && flags[k] !== true ? Number(flags[k]) : d);
  const rules = { worktreeDays: num('worktree-days', DEFAULT_RULES.worktreeDays), nodeModulesDays: num('node-modules-days', DEFAULT_RULES.nodeModulesDays), logDays: num('log-days', DEFAULT_RULES.logDays), servers: flags.servers !== 'off' };
  const f = await find({ rules, dirs: args.length ? args.map((a) => path.resolve(a)) : null });
  const cats = typeof flags.only === 'string' ? flags.only.split(',') : CATEGORIES;
  if (flags.json && !flags.yes) return void console.log(JSON.stringify(f, (k, v) => (k === 'files' ? v.length : v), 1));
  if (!f.items.length) return void console.log('Nothing to tidy under your rules.');
  for (const c of CATEGORIES) {
    const xs = f.items.filter((x) => x.category === c); if (!xs.length) continue;
    console.log(`\n${c} (${human(xs.reduce((a, x) => a + x.bytes, 0))}${c === 'servers' ? ' memory' : ''})`);
    for (const x of xs.slice(0, 15)) console.log(`  ${human(x.bytes).padStart(7)}  ${x.path.replace(os.homedir(), '~')}\n           ${x.detail}`);
  }
  if (!flags.yes) return void console.log(`\n${human(f.bytes)} of disk could be freed. Nothing was changed. Do it: skillhawk tidy --yes [--only ${CATEGORIES.join(',')}]\nRules: --worktree-days ${rules.worktreeDays} --node-modules-days ${rules.nodeModulesDays} --log-days ${rules.logDays} (any can be "off")`);
  const done = apply(f, { categories: cats });
  for (const d of done) console.log(d.error ? `  could not: ${d.path}: ${d.error}` : `  done: ${d.category} ${d.path.replace(os.homedir(), '~')} (undo: ${d.undo})`);
  console.log(`\nFreed about ${human(done.filter((d) => !d.error && d.category !== 'servers').reduce((a, d) => a + (d.bytes || 0), 0))}.`);
}
