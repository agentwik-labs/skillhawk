// skillhawk snapshot / restore: never lose agent work. Saves the uncommitted changes (including new files, honouring
// .gitignore) of every repo and worktree your agents worked in, as a commit under refs/skillhawk/snapshots/. It uses
// a temporary index: your working tree, your staged changes, your branches and your stash are not touched, and
// nothing is pushed (refs/skillhawk/* is not fetched or pushed by default). Restore makes a new branch or worktree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listJsonl } from './tokens.js';

const NS = 'refs/skillhawk/snapshots';
export const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, maxBuffer: 64e6 }).trim();
const tryGit = (cwd, args, env) => { try { return git(cwd, args, env); } catch { return null; } };
const slug = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Folders your agents worked in recently (from Claude Code and Codex logs), resolved to repos and all their worktrees. */
/** cwd -> last time an agent session there was written (Claude Code and Codex logs). */
export function recentCwds({ days = 60, logs = [path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.codex', 'sessions')], now = Date.now() } = {}) {
  const out = new Map();
  for (const root of logs) for (const f of listJsonl(root)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (now - st.mtimeMs > days * 86400e3) continue;
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    if (m) { const c = JSON.parse(`"${m[1]}"`); out.set(c, Math.max(out.get(c) || 0, st.mtimeMs)); }
  }
  return out;
}

export function agentRepos({ days = 7, logs = [path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.codex', 'sessions')], extra = [], now = Date.now() } = {}) {
  const cwds = new Set([...extra.map((p) => path.resolve(p)), ...recentCwds({ days, logs, now }).keys()]);
  const tops = new Set();
  for (const c of cwds) { if (!fs.existsSync(c)) continue; const t = tryGit(c, ['rev-parse', '--show-toplevel']); if (t) tops.add(t); }
  const trees = new Set();
  for (const t of tops) {
    const wt = tryGit(t, ['worktree', 'list', '--porcelain']);
    for (const m of (wt || '').matchAll(/^worktree (.+)$/gm)) if (fs.existsSync(m[1])) trees.add(m[1]);
    trees.add(t);
  }
  return [...trees].sort();
}

/** Uncommitted state of one worktree: files changed and lines, without touching anything. */
export function pending(dir) {
  const s = tryGit(dir, ['status', '--porcelain=v1', '-uall']);
  if (s == null) return null;
  const files = s.split('\n').filter(Boolean).length;
  return { dir, files, branch: tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?' };
}

/** Save one worktree's uncommitted changes. Returns null when clean or unchanged since the last snapshot. */
export function snapshotOne(dir, { now = Date.now(), maxFileMb = 20, maxNewFiles = 2000, maxNewMb = 200 } = {}) {
  const p = pending(dir);
  if (!p || !p.files) return null;
  const head = tryGit(dir, ['rev-parse', '--verify', 'HEAD']);
  if (!head) return null; // no commits yet: nothing to base a snapshot on
  const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']);
  const tmpIndex = path.join(gitDir, `skillhawk-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    git(dir, ['read-tree', 'HEAD'], env);
    tryGit(dir, ['-c', 'core.safecrlf=false', 'add', '-u'], env); // every change to tracked files (fails only when HEAD is empty)
    // new files: smallest first, within the caps, so a folder of build output or media does not bloat the repo
    const others = git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], env).split('\0').filter(Boolean)
      .map((f) => { try { return [f, fs.statSync(path.join(dir, f)).size]; } catch { return [f, Infinity]; } }).sort((a, b) => a[1] - b[1]);
    const picked = []; let bytes = 0;
    for (const [f, size] of others) { if (size > maxFileMb * 1e6 || picked.length >= maxNewFiles || bytes + size > maxNewMb * 1e6) break; picked.push(f); bytes += size; }
    for (let i = 0; i < picked.length; i += 200) git(dir, ['-c', 'core.safecrlf=false', 'add', '--', ...picked.slice(i, i + 200)], env);
    const big = others.slice(picked.length).map(([f]) => f);
    const tree = git(dir, ['write-tree'], env);
    const name = `${NS}/${slug(path.basename(dir))}-${slug(p.branch)}`;
    const last = tryGit(dir, ['for-each-ref', '--sort=-refname', '--count=1', '--format=%(objectname)', `${name}/`]);
    if (last && tryGit(dir, ['rev-parse', `${last}^{tree}`]) === tree) return { dir, unchanged: true, files: p.files };
    if (tree === tryGit(dir, ['rev-parse', 'HEAD^{tree}'])) return null;
    const commit = git(dir, ['commit-tree', tree, '-p', head, '-m', `skillhawk snapshot of ${dir} (${p.branch}) at ${new Date(now).toISOString()}\n\n${p.files} uncommitted file(s).${big.length ? ` Left out ${big.length} new file(s) over the caps (${maxNewFiles} files, ${maxNewMb} MB, ${maxFileMb} MB each): ${big.slice(0, 10).join(', ')}${big.length > 10 ? ', …' : ''}` : ''}`], { GIT_AUTHOR_NAME: 'skillhawk', GIT_AUTHOR_EMAIL: 'snapshot@skillhawk.local', GIT_COMMITTER_NAME: 'skillhawk', GIT_COMMITTER_EMAIL: 'snapshot@skillhawk.local' });
    const ref = `${name}/${stamp(now)}`;
    git(dir, ['update-ref', ref, commit]);
    return { dir, ref, commit: commit.slice(0, 10), files: p.files - big.length, branch: p.branch, skipped: big.length };
  } finally { try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ } }
}

export function snapshotAll(dirs, opts = {}) { return dirs.map((d) => { try { return snapshotOne(d, opts); } catch (e) { return { dir: d, error: e.message.split('\n')[0] }; } }).filter(Boolean); }

/** Snapshots across the given worktrees (they share refs per repo, so de-duplicate). */
export function list(dirs) {
  const seen = new Map();
  for (const d of dirs) {
    const out = tryGit(d, ['for-each-ref', '--sort=-refname', '--format=%(refname)\t%(objectname)\t%(subject)', NS]);
    for (const line of (out || '').split('\n').filter(Boolean)) { const [ref, commit, subject] = line.split('\t'); const id = ref.split('/').slice(-1)[0]; if (!seen.has(`${commit}`)) seen.set(commit, { ref, commit, subject, id, repo: d }); }
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Restore a snapshot as a new branch (default) or a new worktree folder. Never overwrites anything. */
export function restore(dirs, which, { into = null } = {}) {
  const s = list(dirs).find((x) => (which.length >= 7 && x.commit.startsWith(which)) || x.ref.endsWith(which) || x.ref === which);
  if (!s) throw new Error(`no snapshot ${which}; list them with: skillhawk restore --list`);
  const branch = `skillhawk/restore-${s.ref.split('/').slice(-2).join('-')}`;
  if (into) { if (fs.existsSync(into)) throw new Error(`${into} already exists`); git(s.repo, ['worktree', 'add', '-b', branch, into, s.commit]); return { ...s, branch, into }; }
  git(s.repo, ['branch', branch, s.commit]);
  return { ...s, branch };
}

/** Delete snapshot refs older than `days` (the commits are then collected by git gc as usual). */
export function prune(dirs, { days = 30, now = Date.now() } = {}) {
  const cut = stamp(now - days * 86400e3); let n = 0;
  for (const s of list(dirs)) if (s.id < cut) { tryGit(s.repo, ['update-ref', '-d', s.ref]); n++; }
  return n;
}

export async function run(args, flags = {}, mode = 'snapshot') {
  const dirs = args.length ? args.map((a) => path.resolve(a)) : agentRepos({ days: Number(flags.days) || 7 });
  if (mode === 'restore') {
    if (flags.list || !args.length && !flags.id) {
      const xs = list(dirs);
      if (!xs.length) return void console.log('No snapshots yet. Take one: skillhawk snapshot');
      for (const s of xs.slice(0, 30)) console.log(`${s.commit.slice(0, 10)}  ${s.id}  ${s.subject.replace(/^skillhawk snapshot of /, '')}`);
      return void console.log('\nRestore one as a new branch: skillhawk restore --id <commit> [--into <new-folder>]');
    }
    const r = restore(dirs, String(flags.id || args[0]), { into: typeof flags.into === 'string' ? path.resolve(flags.into) : null });
    return void console.log(r.into ? `Restored into a new worktree: ${r.into} (branch ${r.branch})` : `Restored as branch ${r.branch} in ${r.repo}. Look: git switch ${r.branch}`);
  }
  if (flags.prune) return void console.log(`Removed ${prune(dirs, { days: Number(flags.prune) || 30 })} snapshot(s) older than ${Number(flags.prune) || 30} days.`);
  if (flags.check) { // what is at risk, without saving
    const ps = dirs.map(pending).filter((p) => p?.files);
    if (flags.json) return void console.log(JSON.stringify(ps, null, 1));
    console.log(ps.length ? ps.map((p) => `${p.files} uncommitted file(s)  ${p.dir.replace(os.homedir(), '~')} (${p.branch})`).join('\n') : 'No uncommitted work in your agent repos.');
    return;
  }
  const rs = snapshotAll(dirs);
  if (flags.json) return void console.log(JSON.stringify(rs, null, 1));
  const saved = rs.filter((r) => r.ref);
  for (const r of rs) console.log(r.error ? `could not snapshot ${r.dir}: ${r.error}` : r.unchanged ? `unchanged  ${r.dir.replace(os.homedir(), '~')}` : `saved ${String(r.files).padStart(3)} file(s)  ${r.dir.replace(os.homedir(), '~')} (${r.branch}) -> ${r.commit}${r.skipped ? `  (left out ${r.skipped} new files over the caps; add them to .gitignore or commit them)` : ''}`);
  console.log(`\n${saved.length} snapshot(s) saved across ${dirs.length} worktree(s). Your files, index and branches were not touched; nothing was pushed. Restore: skillhawk restore --list`);
}
