// skillhawk brief: one short page on your agents. Usage pace, sessions waiting for you, uncommitted agent work,
// clutter, secrets in logs. Autopilot sends it every morning and adds what it did overnight; this is the on-demand
// version. Each section is a free command you can run on its own.
import os from 'node:os';
import { human } from './tidy.js';

export async function collectBrief({ mods = null, now = Date.now() } = {}) {
  const m = mods || {
    usage: await import('./usage.js'), stuck: await import('./stuck.js'), snapshot: await import('./snapshot.js'), tidy: await import('./tidy.js'), secrets: await import('./logsecrets.js'),
  };
  const safe = async (f) => { try { return await f(); } catch (e) { return { error: e.message.split('\n')[0] }; } };
  const usage = await safe(async () => m.usage.pace(await m.usage.scan({ since: now - 35 * 86400e3 }), { now }));
  const stuck = await safe(() => m.stuck.findStuck({ now }));
  const repos = await safe(() => m.snapshot.agentRepos({ now }));
  const unsaved = Array.isArray(repos) ? repos.map(m.snapshot.pending).filter((p) => p?.files) : [];
  const tidy = await safe(() => m.tidy.find({ now }));
  const secrets = await safe(() => m.secrets.scanLogs({ since: now - 2 * 86400e3 }).map(({ _value, ...x }) => x));
  return { at: new Date(now).toISOString(), usage, stuck, unsaved, tidy, secrets };
}

/** Plain text. `extra` lines (e.g. what Autopilot did overnight) go first. needsYou counts what a human must act on. */
export function renderBrief(b, extra = []) {
  const L = []; let needsYou = 0;
  if (extra.length) L.push('Done for you:', ...extra.map((x) => `  ${x}`), '');
  const u = b.usage;
  if (u && !u.error) {
    if (u.limitedNow) { needsYou++; L.push(`Usage: limited now; resets ${new Date(u.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`); }
    else if (u.weekPct != null) L.push(`Usage: ${u.weekPct}% of your weekly cap${u.daysLeftAtPace != null && u.daysLeftAtPace < 7 ? `; at today's pace it lasts ${u.daysLeftAtPace} more days` : '; on pace'}`);
    else if (u.typicalWeek) L.push(`Usage: this week is ${Math.round((100 * u.week) / u.typicalWeek)}% of your typical week`);
    else L.push(`Usage: $${u.week} in 7 days (list prices)`);
  }
  if (Array.isArray(b.stuck) && b.stuck.length) { needsYou += b.stuck.length; L.push(`Waiting for you: ${b.stuck.map((s) => `${s.project} (${s.kind === 'tool' ? s.what.split(':')[0] : s.kind})`).join(', ')}`); }
  if (b.unsaved?.length) L.push(`Uncommitted agent work: ${b.unsaved.reduce((a, p) => a + p.files, 0)} files in ${b.unsaved.length} worktree${b.unsaved.length > 1 ? 's' : ''} (skillhawk snapshot saves it)`);
  if (b.tidy && !b.tidy.error && b.tidy.bytes > 1e8) L.push(`Clutter: ${human(b.tidy.bytes)} could be freed (skillhawk tidy)`);
  if (Array.isArray(b.secrets) && b.secrets.length) { needsYou++; L.push(`Secrets in recent logs: ${b.secrets.length} (skillhawk logs-secrets); rotate the keys`); }
  L.unshift(needsYou ? `${needsYou} thing${needsYou > 1 ? 's' : ''} need${needsYou > 1 ? '' : 's'} you.` : 'Nothing needs you.', '');
  return { text: L.join('\n'), needsYou };
}

export async function run(_args, flags = {}) {
  const b = await collectBrief();
  if (flags.json) return void console.log(JSON.stringify(b, null, 1));
  console.log(`skillhawk brief · ${new Date().toLocaleString()} · ${os.hostname().split('.')[0]}\n`);
  console.log(renderBrief(b).text);
}
