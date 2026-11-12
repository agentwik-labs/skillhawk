// Write once, run everywhere: compile one skill folder into each agent's native format, with per-target checks.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, readSkillDir, validateFiles } from './skill.js';
import { fencedSet } from './review.js';

export const TARGETS = ['claude', 'codex', 'cursor', 'copilot', 'gemini'];
// Size guidance: Codex reads 32 KiB of AGENTS.md by default; Copilot code review reads the first 4000 chars of an
// instructions file; Cursor recommends rules under 500 lines.
export const LIMITS = { codex: 32768, copilot: 4000, cursor: 500, gemini: 20000 };
const START = (n) => `<!-- skillyard:${n}:start -->`;
const END = (n) => `<!-- skillyard:${n}:end -->`;
const BUNDLE = (n) => `.agents/skills/${n}`;

export function parsePaths(v) {
  if (!v) return [];
  return String(v).replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** Headings and fenced blocks of a markdown body (outside / inside fences). */
export function structure(text) {
  const lines = text.split('\n');
  const fenced = fencedSet(lines);
  const headings = lines.filter((l, i) => !fenced.has(i) && /^#{1,6}\s+\S/.test(l)).map((l) => l.replace(/^#{1,6}\s+/, '').trim());
  const blocks = []; let cur = null;
  lines.forEach((l, i) => { if (fenced.has(i)) { (cur ??= []).push(l); } else if (cur) { blocks.push(cur.join('\n')); cur = null; } });
  if (cur) blocks.push(cur.join('\n'));
  return { headings, blocks };
}

const demote = (text) => {
  const lines = text.split('\n'); const fenced = fencedSet(lines);
  return lines.map((l, i) => (!fenced.has(i) && /^#{1,5}\s/.test(l) ? `#${l}` : l)).join('\n');
};
const relink = (body, base) => body.replace(/\]\((?!https?:|#|\/)([^)\s]+)\)/g, `](${base}/$1)`);
const bundleNote = (n) => `Bundled files for this skill (scripts/, references/, templates/) are in \`${BUNDLE(n)}/\`; paths such as \`scripts/x\` in these instructions are relative to that folder.`;

function sectionFor(name, data, body) {
  return [START(name), `## Skill: ${name}`, '', `**When to use:** ${data.description || name}`, '', bundleNote(name), '', demote(relink(body.trim(), BUNDLE(name))), END(name)].join('\n') + '\n';
}

function upsert(file, name, section) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${START(name)}[\\s\\S]*?${END(name)}\\n?`);
  const next = re.test(cur) ? cur.replace(re, section) : `${cur}${cur && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : ''}${section}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

function copyBundle(files, root, name) {
  for (const [rel, buf] of Object.entries(files)) {
    if (rel === 'SKILL.md' || rel.startsWith('evals/') || rel.startsWith('tests/')) continue;
    const dest = path.join(root, BUNDLE(name), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const yamlStr = (s) => (/[:#'"\[\]{}>|*&!%@`]|^\s|\s$/.test(s) ? JSON.stringify(s) : s);

/** Compile to one target. Returns { target, files: [paths written], warnings, checks: [{name, ok, detail}] }. */
export function compileTarget(target, skillDir, outDir) {
  const files = readSkillDir(skillDir);
  const v = validateFiles(files);
  if (!v.ok) throw new Error(`invalid skill: ${v.errors.join('; ')}`);
  const raw = files['SKILL.md'].toString('utf8');
  const { data, body } = parseFrontmatter(raw);
  const name = v.manifest.name;
  const root = path.join(outDir, target);
  const warnings = []; const written = []; const checks = [];
  const hasScripts = Object.keys(files).some((f) => f.startsWith('scripts/'));
  const paths = parsePaths(data['paths'] || data['globs']);
  let output; let outFile;

  if (target === 'claude') {
    const dest = path.join(root, '.claude', 'skills', name);
    for (const [rel, buf] of Object.entries(files)) {
      if (rel.startsWith('evals/')) continue;
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.writeFileSync(path.join(dest, rel), buf); written.push(path.join(dest, rel));
    }
    output = raw; outFile = path.join(dest, 'SKILL.md');
    checks.push({ name: 'frontmatter valid', ok: v.ok, detail: 'name + description present' });
  } else {
    if (target === 'codex') { outFile = path.join(root, 'AGENTS.md'); output = sectionFor(name, data, body); upsert(outFile, name, output); }
    else if (target === 'gemini') { outFile = path.join(root, 'GEMINI.md'); output = sectionFor(name, data, body); upsert(outFile, name, output); }
    else if (target === 'cursor') {
      outFile = path.join(root, '.cursor', 'rules', `${name}.mdc`);
      output = ['---', `description: ${yamlStr(oneLine(data.description || name))}`, `globs: ${paths.join(',')}`.trimEnd(), 'alwaysApply: false', '---', bundleNote(name), '', relink(body.trim(), BUNDLE(name)), ''].join('\n');
      fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, output);
    } else if (target === 'copilot') {
      outFile = path.join(root, '.github', 'instructions', `${name}.instructions.md`);
      output = ['---', `applyTo: ${yamlStr(paths.length ? paths.join(',') : '**')}`, '---', `**When to use:** ${oneLine(data.description || name)}`, '', bundleNote(name), '', relink(body.trim(), BUNDLE(name)), ''].join('\n');
      fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, output);
    } else throw new Error(`unknown target "${target}". Choose from: ${TARGETS.join(', ')}, all`);
    written.push(outFile);
    copyBundle(files, root, name);
    if (hasScripts) { warnings.push(`${target}: scripts are copied to ${BUNDLE(name)}/scripts but ${target} has no skill runtime; the agent must run them from the shell`); }
    if (target === 'cursor' && !paths.length) warnings.push('cursor: skill declares no paths, so the rule is description-triggered only (globs empty)');
    if (target === 'copilot' && !paths.length) warnings.push('copilot: skill declares no paths, applyTo "**" applies it to every file');
  }
  if (data['allowed-tools'] && target !== 'claude') warnings.push(`${target}: allowed-tools (${oneLine(data['allowed-tools'])}) cannot be expressed; the agent's own permissions apply`);
  if (target === 'claude' && paths.length) { /* native */ }
  if (paths.length && ['codex', 'gemini'].includes(target)) warnings.push(`${target}: paths (${paths.join(', ')}) cannot scope a section; it is always loaded`);

  // per-target checks
  const text = target === 'claude' ? output : fs.readFileSync(outFile, 'utf8');
  if (target === 'cursor') {
    const fm = parseFrontmatter(text);
    checks.push({ name: 'frontmatter valid', ok: !!fm.data && !!fm.data.description && 'alwaysApply' in fm.data, detail: 'description, globs, alwaysApply' });
    const lines = text.split('\n').length; checks.push({ name: 'size', ok: lines <= LIMITS.cursor, detail: `${lines}/${LIMITS.cursor} lines` });
  } else if (target === 'copilot') {
    const fm = parseFrontmatter(text);
    checks.push({ name: 'frontmatter valid', ok: !!fm.data && !!fm.data.applyTo, detail: 'applyTo' });
    checks.push({ name: 'size', ok: text.length <= LIMITS.copilot, detail: `${text.length}/${LIMITS.copilot} chars read by code review` });
  } else if (target === 'codex' || target === 'gemini') {
    const whole = Buffer.byteLength(text);
    checks.push({ name: 'size', ok: whole <= LIMITS[target], detail: `${whole}/${LIMITS[target]} bytes` });
  }
  const src = structure(body); const dst = structure(output);
  const missingH = src.headings.filter((h) => !dst.headings.includes(h));
  const missingB = src.blocks.filter((b) => !output.includes(b));
  checks.push({ name: 'content kept', ok: !missingH.length && !missingB.length, detail: `${src.headings.length} headings, ${src.blocks.length} code blocks${missingH.length ? `; missing headings: ${missingH.join(', ')}` : ''}${missingB.length ? `; ${missingB.length} code block(s) missing` : ''}` });
  for (const c of checks) if (!c.ok && c.name === 'size') warnings.push(`${target}: ${c.detail} exceeds the guidance`);
  return { target, name, files: written, warnings, checks, ok: checks.every((c) => c.ok || c.name === 'size') };
}

export function resolveTargets(list) {
  const names = String(list || 'claude').split(',').map((s) => s.trim()).filter(Boolean);
  const out = names.includes('all') ? TARGETS : names;
  for (const n of out) if (!TARGETS.includes(n)) throw new Error(`unknown target "${n}". Choose from: ${TARGETS.join(', ')}, all`);
  return out;
}

export async function run(args, flags = {}) {
  const dir = args[0];
  if (!dir || !flags.to || flags.to === true) throw new Error('usage: skillyard compile <skill-dir> --to claude,codex,cursor,copilot,gemini|all [--out dir]');
  const out = path.resolve(flags.out && flags.out !== true ? flags.out : path.join('.skillyard', 'compiled'));
  let bad = 0;
  for (const t of resolveTargets(flags.to)) {
    const r = compileTarget(t, dir, out);
    console.log(`${t}: ${r.files[0] ? path.relative(out, r.files[0]) : ''}  ${r.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.name} (${c.detail})`).join('; ')}`);
    for (const w of r.warnings) console.log(`  warn ${w}`);
    if (!r.ok) bad++;
  }
  if (bad) process.exitCode = 1;
}
