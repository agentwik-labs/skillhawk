// skillhawk clean: (1) static review of the scripts bundled in skills, (2) learn a coding-standards skill from a repo.
// Deterministic heuristics only: no network, no model calls, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.sh']);
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build', 'vendor', 'target']);
const SEV = { high: 0, medium: 1, low: 2 };
const LONG_FN = 60;

// ---- scripts ----------------------------------------------------------------

function walk(dir, keep, depth = 0, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 6) walk(p, keep, depth + 1, out); } else if (e.isFile() && keep(p)) out.push(p);
  }
  return out;
}

/** Blank out string contents and comments so brace and word scans are not fooled; line structure is kept. */
function stripCode(text, lang) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    let line = raw;
    if (lang === 'js') {
      if (inBlock) { const i = line.indexOf('*/'); if (i < 0) { out.push(''); continue; } line = line.slice(i + 2); inBlock = false; }
      line = line.replace(/\/\*.*?\*\//g, ' ');
      const b = line.indexOf('/*'); if (b >= 0 && !/['"`]/.test(line.slice(0, b))) { inBlock = true; line = line.slice(0, b); }
      line = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/(^|\s)\/\/.*$/, '');
    } else {
      line = line.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""').replace(/(^|\s)#.*$/, '');
    }
    out.push(line);
  }
  return out;
}

const langOf = (ext) => (ext === '.py' ? 'py' : ext === '.sh' ? 'sh' : 'js');
const countWord = (text, name) => (text.match(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) || []).length;

function insideTry(code, idx) {
  // JS/TS: is line idx inside a try { } block? Track braces from the top of the file.
  const stack = [];
  for (let i = 0; i <= idx; i++) {
    const l = code[i];
    for (let c = 0; c < l.length; c++) {
      if (l[c] === '{') stack.push(/\btry\s*$/.test(l.slice(0, c)));
      else if (l[c] === '}') stack.pop();
    }
    if (i === idx) break;
  }
  return stack.some(Boolean);
}

function pyInTry(lines, idx) {
  let indent = lines[idx].match(/^\s*/)[0].length;
  for (let i = idx - 1; i >= 0 && indent > 0; i--) {
    if (!lines[i].trim()) continue;
    const ind = lines[i].match(/^\s*/)[0].length;
    if (ind < indent) { if (/^\s*try\s*:/.test(lines[i])) return true; indent = ind; }
  }
  return false;
}

function blockEnd(code, start, lang) {
  if (lang === 'py') {
    const ind = code[start].match(/^\s*/)[0].length;
    let end = start;
    for (let i = start + 1; i < code.length; i++) {
      if (!code[i].trim()) continue;
      if (code[i].match(/^\s*/)[0].length <= ind) break;
      end = i;
    }
    return end;
  }
  let depth = 0, seen = false;
  for (let i = start; i < code.length; i++) {
    for (const ch of code[i]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
    if (seen && depth <= 0) return i;
  }
  return seen ? code.length - 1 : start;
}

export function reviewScript(rel, text, { referenced = false, direct = false, mode = 0o644 } = {}) {
  const findings = [];
  const add = (rule, severity, line, message, fix) => findings.push({ rule, severity, file: rel, line, message, fix });
  const lang = langOf(path.extname(rel));
  const lines = text.split('\n');
  const code = stripCode(text, lang);
  const stripped = code.join('\n');
  const hasShebang = lines[0]?.startsWith('#!');
  const entry = hasShebang || referenced || lang === 'sh';

  // shebang / exec bit
  if (referenced && !hasShebang && (direct || lang === 'sh')) add('missing-shebang', 'medium', 1, 'SKILL.md runs this script but it has no #! line', lang === 'sh' ? 'Start with #!/usr/bin/env bash.' : lang === 'py' ? 'Start with #!/usr/bin/env python3.' : 'Start with #!/usr/bin/env node.');
  if (referenced && direct && !(mode & 0o111)) add('not-executable', 'medium', 1, 'SKILL.md runs this script directly but the exec bit is not set', 'chmod +x it and commit with git update-index --chmod=+x.');

  // shell
  if (lang === 'sh') {
    if (!lines.slice(0, 15).some((l) => /^\s*set\s+-[a-zA-Z]*e/.test(l) || /^\s*set\s+-o\s+errexit/.test(l))) add('shell-no-set-e', 'high', hasShebang ? 2 : 1, 'no `set -e`: a failed command is ignored and the script keeps going', 'Add `set -euo pipefail` after the shebang.');
    else if (!lines.slice(0, 15).some((l) => /^\s*set\s+-[a-zA-Z]*u/.test(l))) add('shell-no-set-u', 'low', 2, 'no `set -u`: typos in variable names expand to empty strings', 'Use `set -euo pipefail`.');
    let heredoc = null;
    code.forEach((l, i) => {
      const t = lines[i];
      if (heredoc) { if (t.trim() === heredoc) heredoc = null; return; }
      const h = t.match(/<<-?\s*['"]?(\w+)['"]?/); if (h) heredoc = h[1];
      if (/^\s*#/.test(t) || /^\s*(\[\[|\w+=)/.test(t) || /^\s*(case|export|local|readonly|declare)\b/.test(t)) return;
      const body = l.replace(/\$\(\(.*?\)\)/g, '').replace(/\[\[.*?\]\]/g, '');
      const m = body.match(/\$(?:\{[A-Za-z_][^}]*\}|[A-Za-z_]\w*|[0-9@*])/);
      if (m && !/^\$\{[^}]*:[-=+?]/.test(m[0]) && !/^\s*(echo|printf)\b/.test(t)) add('unquoted-variable', 'medium', i + 1, `${m[0]} is unquoted: spaces or globs in its value split the argument`, `Write "${m[0]}".`);
    });
  }

  // paths
  lines.forEach((l, i) => {
    if (/^\s*(#|\/\/)\s/.test(l) && !/\/Users\/|\/home\//.test(l)) return;
    const home = l.match(/(\/Users\/[\w.-]+|\/home\/[\w.-]+|[A-Z]:\\Users\\[\w.-]+)/);
    if (home) add('hardcoded-home-path', 'high', i + 1, `hard-coded user path ${home[1]}`, 'Use $HOME, os.homedir(), Path.home() or a path relative to the script.');
    else {
      const abs = l.match(/(?:^|[\s='"])(\/(?:opt|etc|var|srv|mnt|data|Volumes|workspace|app)\/[^'"\s]+)/);
      if (abs) add('hardcoded-absolute-path', 'low', i + 1, `hard-coded absolute path ${abs[1]}`, 'Take it from an argument or environment variable, or resolve it relative to the script.');
    }
  });

  // TODO
  lines.forEach((l, i) => { const m = l.match(/\b(TODO|FIXME|XXX|HACK)\b/); if (m) add('todo-left', 'low', i + 1, `${m[1]} left in a shipped script`, 'Resolve it or move it to an issue.'); });

  // unused names + error handling + long functions
  const defs = [];
  if (lang === 'js') {
    code.forEach((l, i) => {
      let m;
      if ((m = l.match(/^\s*(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/)) && !/^\s*export\b/.test(l)) defs.push({ name: m[1], kind: 'function', line: i + 1 });
      else if ((m = l.match(/^\s*(?:const|let|var)\s+([\w$]+)\s*=/)) && !/^\s*export\b/.test(l)) defs.push({ name: m[1], kind: 'variable', line: i + 1 });
      else if ((m = l.match(/^\s*import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+([\w$]+))?\s*from\b/)) || (m = lines[i].match(/^\s*import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\b/))) {
        const names = [m[1], m[3], ...(m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/).pop())].filter(Boolean);
        for (const n of names) defs.push({ name: n, kind: 'import', line: i + 1 });
      }
    });
  } else if (lang === 'py') {
    code.forEach((l, i) => {
      let m;
      if ((m = l.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/))) defs.push({ name: m[1], kind: 'function', line: i + 1 });
      else if ((m = l.match(/^import\s+(.+)$/))) for (const n of m[1].split(',')) defs.push({ name: n.trim().split(/\s+as\s+/).pop().split('.')[0], kind: 'import', line: i + 1 });
      else if ((m = l.match(/^from\s+\S+\s+import\s+([^(*]+)$/))) for (const n of m[1].split(',')) defs.push({ name: n.trim().split(/\s+as\s+/).pop(), kind: 'import', line: i + 1 });
    });
  } else {
    code.forEach((l, i) => { const m = l.match(/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{?/); if (m && !/^\s*(if|while|for)\b/.test(l)) defs.push({ name: m[1], kind: 'function', line: i + 1 }); });
  }
  const seenDef = new Set();
  for (const d of defs) {
    if (!d.name || seenDef.has(d.name) || /^__\w+__$/.test(d.name) || d.name === 'main' || d.name === '_') continue;
    seenDef.add(d.name);
    if (countWord(stripped, d.name) <= 1 && !(lang === 'py' && /__all__/.test(text))) add(`unused-${d.kind}`, 'low', d.line, `${d.kind} ${d.name} is never used`, d.kind === 'import' ? 'Remove the import.' : `Delete ${d.name} or use it.`);
  }
  // long functions
  for (const d of defs.filter((x) => x.kind === 'function' || (lang === 'js' && /=>\s*\{?\s*$/.test(code[x.line - 1] || '')))) {
    const end = blockEnd(code, d.line - 1, lang);
    if (end - d.line + 1 > LONG_FN) add('long-function', 'low', d.line, `${d.name} is ${end - d.line + 1} lines long`, `Split it; keep functions under ${LONG_FN} lines.`);
  }
  if (lang === 'js') {
    const NET = /\b(fetch|axios\.\w+|https?\.(?:get|request)|execSync|execFileSync|spawnSync|spawn|execFile|exec)\s*\(/;
    const FS = /\b(?:fs\.)?(readFileSync|writeFileSync|readdirSync|mkdirSync|rmSync|unlinkSync|copyFileSync|readFile|writeFile)\s*\(/;
    code.forEach((l, i) => {
      const n = l.match(NET), f = !n && l.match(FS);
      if (!n && !f) return;
      if (insideTry(code, i) || /\.catch\s*\(/.test(code.slice(i, i + 4).join(' '))) return;
      const kind = n ? (/fetch|axios|http/.test(n[1]) ? 'network' : 'subprocess') : 'filesystem';
      add('no-error-handling', n ? 'medium' : 'low', i + 1, `${kind} call ${(n || f)[1]}() has no try/catch or .catch`, 'Wrap it, print a clear message and exit non-zero.');
    });
  } else if (lang === 'py') {
    const CALL = /\b(subprocess\.(?:run|call|check_output|check_call|Popen)|requests\.\w+|urllib\.request\.urlopen|urlopen|open|os\.remove|shutil\.\w+)\s*\(/;
    code.forEach((l, i) => {
      const m = l.match(CALL);
      if (!m || /^\s*(def|class)\b/.test(l) || pyInTry(lines, i)) return;
      const sub = m[1].startsWith('subprocess');
      if (sub && /check\s*=\s*True/.test(l)) return;
      const kind = /subprocess/.test(m[1]) ? 'subprocess' : /requests|urlopen/.test(m[1]) ? 'network' : 'filesystem';
      if (/^\s*with\s+open/.test(l) && !sub) { add('no-error-handling', 'low', i + 1, 'filesystem call open() has no try/except', 'Catch OSError and exit with a clear message.'); return; }
      add('no-error-handling', kind === 'filesystem' ? 'low' : 'medium', i + 1, `${kind} call ${m[1]}() has no try/except${sub ? ' and no check=True' : ''}`, sub ? 'Pass check=True or test returncode.' : 'Wrap it and exit non-zero with a clear message.');
    });
  } else {
    code.forEach((l, i) => {
      const m = l.match(/^\s*(curl|wget)\b/);
      if (m && !/\|\||\bif\b|&&/.test(l) && !/(^|\s)(-f|--fail)/.test(l) && !/^\s*(\w+=)/.test(l)) add('no-error-handling', 'low', i + 1, `${m[1]} without --fail: HTTP errors pass silently`, 'Use curl -fsSL or check the status.');
    });
  }

  // usage / help
  if (entry && !/(--help|\s-h\b|usage|Usage|USAGE|argparse|-\?\))/.test(text)) add('no-usage', 'low', 1, 'no usage or --help text', 'Print usage when called with --help or without required arguments.');

  findings.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.line - b.line);
  return findings;
}

/** Review every script file bundled in one skill directory. */
export function reviewScripts(skillDir) {
  let md = '';
  try { md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'); } catch { /* no SKILL.md */ }
  const files = walk(skillDir, (p) => SCRIPT_EXT.has(path.extname(p)) && fs.statSync(p).size < 300000 && !/\.(test|spec)\.\w+$/.test(p));
  const findings = [];
  const scripts = [];
  for (const p of files) {
    const rel = path.relative(skillDir, p).split(path.sep).join('/');
    scripts.push(rel);
    const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ref = new RegExp(`(^|[^\\w/.-])((?:\\./)?${esc})`, 'm').test(md) || new RegExp(`\\b${path.basename(rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(md);
    const direct = ref && new RegExp(`(^|[\\s\`$>])(?:\\./|\\$\\{?CLAUDE_SKILL_DIR\\}?/|\\.\\./)?${esc}`, 'm').test(md.replace(new RegExp(`\\b(?:node|python3?|bash|sh|npx tsx|tsx|deno run|zsh|ts-node)\\s+(?:\\S*/)?${esc}`, 'g'), ''));
    findings.push(...reviewScript(rel, fs.readFileSync(p, 'utf8'), { referenced: ref, direct, mode: fs.statSync(p).mode }));
  }
  return { scripts, findings };
}

export function renderScripts(r, indent = '     ') {
  const o = [`${indent}scripts: ${r.scripts.length} file${r.scripts.length === 1 ? '' : 's'}, ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}`];
  for (const f of r.findings) o.push(`${indent}  ${f.severity.padEnd(6)} ${f.file}:${f.line} [${f.rule}] ${f.message}`, `${indent}         fix: ${f.fix}`);
  return o;
}

// ---- standards ----------------------------------------------------------------

const CODE_EXT = { '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.php': 'PHP', '.cs': 'C#', '.sh': 'Shell', '.c': 'C', '.cpp': 'C++' };
const CONFIGS = [
  [/^\.prettierrc(\..+)?$|^prettier\.config\./, 'Prettier (formatter)'], [/^\.eslintrc(\..+)?$|^eslint\.config\./, 'ESLint (linter)'], [/^biome\.jsonc?$/, 'Biome (formatter + linter)'],
  [/^\.editorconfig$/, 'EditorConfig'], [/^ruff\.toml$|^\.ruff\.toml$/, 'Ruff (linter)'], [/^\.flake8$/, 'flake8 (linter)'], [/^rustfmt\.toml$|^\.rustfmt\.toml$/, 'rustfmt'],
  [/^\.golangci\.ya?ml$/, 'golangci-lint'], [/^tsconfig\.json$/, 'TypeScript config'], [/^\.nvmrc$/, 'pinned Node version (.nvmrc)'], [/^\.pre-commit-config\.yaml$/, 'pre-commit hooks'],
  [/^\.husky$/, 'husky git hooks'], [/^\.github$/, 'GitHub workflows/templates'], [/^Dockerfile$/, 'Dockerfile'], [/^Makefile$/, 'Makefile'], [/^CONTRIBUTING\.md$/, 'CONTRIBUTING.md'],
];
const NOISE = /(^|\/)(node_modules|dist|build|vendor|fixtures?|generated|seed|examples?|registry|plugins|starter-kit|docs|web|studio|sources|reports)\//;
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 });

function listFiles(root) {
  try { return sh('git', ['ls-files'], root).split('\n').filter(Boolean); } catch { /* not a git repo */ }
  return walk(root, () => true).map((p) => path.relative(root, p).split(path.sep).join('/'));
}
const mode = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

function nameStyle(n) {
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(n)) return 'kebab-case';
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(n)) return 'snake_case';
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(n)) return 'camelCase';
  if (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+$/.test(n)) return 'PascalCase';
  if (/^[a-z][a-z0-9]*$/.test(n)) return 'single-word';
  return null;
}

export function detectConventions(root) {
  const files = listFiles(root);
  const c = { root, fileCount: files.length, languages: [], configs: [], examples: {} };
  const langs = {};
  const codeFiles = [];
  for (const f of files) { const l = CODE_EXT[path.extname(f)]; if (l && !NOISE.test(f)) { langs[l] = (langs[l] || 0) + 1; codeFiles.push(f); } }
  c.languages = Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, files: n, pct: pct(n, codeFiles.length) }));

  const top = new Set(files.map((f) => f.split('/')[0]));
  const bases = new Set(files.map((f) => path.basename(f)));
  for (const [re, label] of CONFIGS) if ([...top, ...bases].some((b) => re.test(b)) && !c.configs.includes(label)) c.configs.push(label);
  if (files.some((f) => f === 'pyproject.toml')) {
    const t = read(root, 'pyproject.toml');
    for (const [re, label] of [[/\[tool\.ruff/, 'Ruff (linter)'], [/\[tool\.black/, 'Black (formatter)'], [/\[tool\.pytest|pytest/, 'pytest'], [/\[tool\.mypy/, 'mypy']]) if (re.test(t) && !c.configs.includes(label)) c.configs.push(label);
  }

  // sample source files (skip tests and generated/vendored) for style statistics
  const src = codeFiles.filter((f) => !NOISE.test(f) && !/\.min\./.test(f)).slice(0, 4000);
  const sample = src.filter((f) => { try { return fs.statSync(path.join(root, f)).size < 200000; } catch { return false; } }).slice(0, 250);
  let tabs = 0, spaceLines = 0; const deltas = {}; let single = 0, dbl = 0, semi = 0, noSemi = 0, esm = 0, cjs = 0;
  const fnStyles = {};
  const jsLike = (f) => /\.(m?js|cjs|jsx|tsx?)$/.test(f);
  for (const f of sample) {
    const text = read(root, f);
    const lines = text.split('\n');
    let prev = 0;
    for (const l of lines) {
      if (/^\t/.test(l)) tabs++;
      else if (/^ +\S/.test(l)) { spaceLines++; const n = l.match(/^ */)[0].length; if (n > prev && n - prev <= 8) deltas[n - prev] = (deltas[n - prev] || 0) + 1; prev = n; } else if (l.trim()) prev = 0;
    }
    if (jsLike(f)) {
      const code = stripCode(text, 'js');
      for (const [i, l] of lines.entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
        single += (l.match(/'[^'\n"`]*'/g) || []).length; dbl += (l.match(/"[^"\n'`]*"/g) || []).length;
        const t = code[i].trim();
        if (/^(const|let|var|return|import|export|throw|await)\b/.test(t) && !/[{(\[,]$|=>$|[&|+?:=]$/.test(t)) { if (/;$/.test(t)) semi++; else if (/[\w)\]"'`]$/.test(t)) noSemi++; }
        let m;
        if ((m = l.match(/\bfunction\s+([A-Za-z_$][\w$]*)/)) || (m = l.match(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/))) { const s = nameStyle(m[1]); if (s && s !== 'single-word') fnStyles[s] = (fnStyles[s] || 0) + 1; }
      }
      if (/^\s*import\s.+from\s|^\s*export\s/m.test(text)) esm++; else if (/\brequire\(|module\.exports/.test(text)) cjs++;
    } else if (/\.py$/.test(f)) {
      for (const l of lines) { const m = l.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/); if (m) { const s = nameStyle(m[1].replace(/^_+/, '')); if (s && s !== 'single-word') fnStyles[s] = (fnStyles[s] || 0) + 1; } }
    }
  }
  const dm = mode(deltas);
  c.indent = tabs > spaceLines ? { kind: 'tabs', share: pct(tabs, tabs + spaceLines) } : spaceLines ? { kind: 'spaces', width: dm ? Number(dm[0]) : null, share: pct(spaceLines, tabs + spaceLines) } : null;
  c.quotes = single + dbl >= 10 ? { style: single >= dbl ? 'single' : 'double', share: pct(Math.max(single, dbl), single + dbl) } : null;
  c.semicolons = semi + noSemi >= 10 ? { use: semi >= noSemi, share: pct(Math.max(semi, noSemi), semi + noSemi) } : null;
  c.modules = esm + cjs >= 3 ? { kind: esm >= cjs ? 'ES modules (import/export)' : 'CommonJS (require)', share: pct(Math.max(esm, cjs), esm + cjs) } : null;
  const fnM = mode(fnStyles); c.functionNaming = fnM ? { style: fnM[0], share: pct(fnM[1], Object.values(fnStyles).reduce((a, b) => a + b, 0)) } : null;

  const fileStyles = {};
  for (const f of src) { const b = path.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, ''); const s = nameStyle(b); if (s && s !== 'single-word') fileStyles[s] = (fileStyles[s] || 0) + 1; }
  const fsM = mode(fileStyles); c.fileNaming = fsM ? { style: fsM[0], share: pct(fsM[1], Object.values(fileStyles).reduce((a, b) => a + b, 0)) } : null;

  // tests
  const isTest = (f) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.\w+$/.test(f) || /(^|\/)test_[^/]+\.py$|_test\.(go|py|rs)$/.test(f);
  const tests = files.filter(isTest);
  const dirs = {}; for (const t of tests) { const d = path.dirname(t); dirs[d] = (dirs[d] || 0) + 1; }
  c.tests = { files: tests.length, dir: mode(dirs)?.[0] || null, pattern: tests.some((t) => /\.test\./.test(t)) ? '*.test.*' : tests.some((t) => /\.spec\./.test(t)) ? '*.spec.*' : tests.some((t) => /test_.*\.py$/.test(t)) ? 'test_*.py' : tests.some((t) => /_test\./.test(t)) ? '*_test.*' : null, command: null };
  const pj = parseJson(read(root, 'package.json'));
  if (pj?.scripts?.test) c.tests.command = `npm test (runs: ${pj.scripts.test})`;
  else if (files.includes('Makefile') && /^test:/m.test(read(root, 'Makefile'))) c.tests.command = 'make test';
  else if (files.includes('Cargo.toml')) c.tests.command = 'cargo test';
  else if (files.includes('go.mod')) c.tests.command = 'go test ./...';
  else if (c.configs.includes('pytest') || tests.some((t) => /\.py$/.test(t))) c.tests.command = 'pytest';
  if (pj) { c.node = { engines: pj.engines?.node || null, type: pj.type || 'commonjs', dependencies: Object.keys(pj.dependencies || {}).length }; }

  // examples straight from the repo
  c.examples.files = src.filter((f) => !isTest(f) && !/^scripts\//.test(f)).slice(0, 4);
  c.examples.snippet = pickSnippet(root, src.filter((f) => !isTest(f)));
  c.git = gitStyle(root);
  return c;
}

function read(root, f) { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } }
function parseJson(t) { try { return JSON.parse(t); } catch { return null; } }

function pickSnippet(root, files) {
  for (const f of files.filter((x) => /\.(m?js|ts|py)$/.test(x)).sort((a, b) => a.length - b.length)) {
    const lines = read(root, f).split('\n');
    const lang = /\.py$/.test(f) ? 'py' : 'js';
    const code = stripCode(lines.join('\n'), lang);
    for (let i = 0; i < lines.length; i++) {
      if (!(lang === 'py' ? /^def \w+/.test(code[i]) : /^(export )?(async )?function \w+/.test(code[i]))) continue;
      const end = blockEnd(code, i, lang);
      if (end - i >= 3 && end - i <= 12 && !lines.slice(i, end + 1).some((l) => /(token|secret|password|key)\s*[:=]/i.test(l))) return { file: f, line: i + 1, lang: lang === 'py' ? 'python' : 'js', text: lines.slice(i, end + 1).join('\n') };
    }
  }
  return null;
}

export function gitStyle(root) {
  let subjects;
  try { subjects = sh('git', ['log', '-200', '--format=%s'], root).split('\n').filter(Boolean); } catch { return null; }
  if (!subjects.length) return null;
  const n = subjects.length;
  const conv = subjects.filter((s) => /^(feat|fix|docs|chore|refactor|test|tests|perf|build|ci|style|revert)(\([^)]+\))?!?:\s/.test(s));
  const types = {}; for (const s of conv) { const t = s.match(/^(\w+)/)[1]; types[t] = (types[t] || 0) + 1; }
  const cap = subjects.filter((s) => /^[A-Z]/.test(s)).length;
  const period = subjects.filter((s) => /\.$/.test(s)).length;
  const refs = subjects.filter((s) => /#\d+|\b[A-Z]{2,}-\d+\b/.test(s)).length;
  const firstWords = {}; for (const s of subjects) { const w = s.split(/\s+/)[0].toLowerCase(); if (!/^[a-z]+$/.test(w)) continue; firstWords[w] = (firstWords[w] || 0) + 1; }
  const len = subjects.map((s) => s.length).sort((a, b) => a - b);
  return { count: n, conventionalPct: pct(conv.length, n), types: Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 5), capitalizedPct: pct(cap, n), periodPct: pct(period, n), refPct: pct(refs, n), medianLength: len[Math.floor(n / 2)], topVerbs: Object.entries(firstWords).filter(([, k]) => k >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w), samples: subjects.filter((s) => s.length < 90 && !/\S+\/\S+|\w\.\w{2,4}\b/.test(s)).slice(0, 3) };
}

// ---- review comments -> rules ---------------------------------------------------

const FILLER = new Set(['please', 'maybe', 'nit', 'nits', 'here', 'there', 'think', 'might', 'perhaps', 'lgtm', 'thanks', 'thank', 'also', 'suggest', 'consider', 'could', 'would', 'want', 'make', 'sure', 'too', 'one', 'get', 'let', 'see', 'look', 'seems', 'still', 'again', 'change', 'should', 'file', 'line', 'code', 'pr', 'this', 'new']);
const tok = (t) => new Set(String(t).toLowerCase().replace(/[`*_#>\[\]()"“”.,:;!?/]/g, ' ').replace(/'/g, '').split(/\s+/).filter((w) => w.length > 2 && !FILLER.has(w) && !/^(the|and|for|you|are|but|not|with|that|its|can|use|from|have|has|was|our|any|all|too|add)$/.test(w)).map((w) => w.replace(/(?:ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? '' : m))));
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return a.size && b.size ? i / (a.size + b.size - i) : 0; };

export function parseReviewComments(text, fileName = '') {
  const out = [];
  const pull = (v) => {
    if (typeof v === 'string') return;
    if (Array.isArray(v)) return v.forEach(pull);
    if (v && typeof v === 'object') {
      const body = v.body ?? v.comment ?? v.text ?? v.message;
      if (typeof body === 'string') out.push(body);
      for (const k of Object.keys(v)) if (typeof v[k] === 'object') pull(v[k]);
    }
  };
  let json = null;
  if (/\.json$/i.test(fileName) || /^\s*[[{]/.test(text)) json = parseJson(text);
  if (json) { if (Array.isArray(json) && json.every((x) => typeof x === 'string')) out.push(...json); else pull(json); } else {
    for (const para of text.split(/\n\s*\n/)) {
      const items = para.split('\n').filter((l) => /^\s*([-*]|\d+[.)])\s+/.test(l));
      if (items.length >= 2) out.push(...items); else out.push(para);
    }
  }
  return out.map((s) => s.replace(/^\s*([-*>]|\d+[.)])\s+/gm, '').replace(/^[#\s]+/, '').replace(/\s+/g, ' ').replace(/^(@\w+[:,]?\s*)+/, '').replace(/^(nit|suggestion|issue|question)\s*:\s*/i, '').trim()).filter((s) => s.split(' ').length >= 3);
}

export function clusterComments(comments, { minCount = 2 } = {}) {
  // Keyword-first grouping: the keyword shared by the most unassigned comments claims them (ties go to the keyword
  // whose comments are most alike), then each group is summarised by its most central comment.
  const items = comments.map((text) => ({ text, t: tok(text) })).filter((x) => x.t.size >= 2);
  const generic = items.length >= 6 ? items.length * 0.6 : Infinity;
  const left = new Set(items);
  const groups = [];
  for (;;) {
    const df = new Map();
    for (const it of left) for (const w of it.t) df.set(w, [...(df.get(w) || []), it]);
    let best = null, bestScore = 0;
    for (const [w, its] of df) {
      if (its.length < minCount || its.length > generic) continue;
      let sim = 0;
      for (const a of its) for (const b of its) if (a !== b) sim += jac(a.t, b.t);
      const score = its.length + sim / (its.length * its.length);
      if (score > bestScore) { bestScore = score; best = { w, its }; }
    }
    if (!best) break;
    groups.push(best.its);
    for (const it of best.its) left.delete(it);
  }
  return groups.map((members) => {
    const centre = members.map((m) => ({ m, s: members.reduce((a, o) => a + jac(m.t, o.t), 0) })).sort((a, b) => b.s - a.s || a.m.text.length - b.m.text.length)[0].m;
    const freq = {}; for (const m of members) for (const w of m.t) freq[w] = (freq[w] || 0) + 1;
    return { count: members.length, rule: centre.text.replace(/[?]+$/, '').replace(/^(can|could|would) you /i, '').replace(/^./, (x) => x.toUpperCase()), keywords: Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w), examples: members.slice(0, 3).map((m) => m.text) };
  }).sort((a, b) => b.count - a.count);
}

// ---- render the skill ---------------------------------------------------------

export function renderStandards(c, rules, name = 'coding-standards') {
  const repo = path.basename(path.resolve(c.root)) || 'this repo';
  const L = [];
  const rl = [];
  const langs = c.languages.slice(0, 4).map((l) => `${l.name} ${l.pct}%`).join(', ');
  if (langs) rl.push(`Write new code in the repo's main languages (${langs}); do not introduce another language or runtime without asking.`);
  if (c.indent) rl.push(c.indent.kind === 'tabs' ? `Indent with tabs (${c.indent.share}% of indented lines).` : `Indent with ${c.indent.width || 2} spaces, never tabs (${c.indent.share}% of indented lines).`);
  if (c.quotes) rl.push(`Use ${c.quotes.style} quotes for JavaScript/TypeScript strings (${c.quotes.share}% of strings).`);
  if (c.semicolons) rl.push(c.semicolons.use ? `End JavaScript/TypeScript statements with semicolons (${c.semicolons.share}% do).` : `Leave semicolons off JavaScript/TypeScript statements (${c.semicolons.share}% do).`);
  if (c.modules) rl.push(`Use ${c.modules.kind} in JavaScript (${c.modules.share}% of files).`);
  if (c.fileNaming) rl.push(`Name source files in ${c.fileNaming.style} (${c.fileNaming.share}% of files).`);
  if (c.functionNaming) rl.push(`Name functions in ${c.functionNaming.style} (${c.functionNaming.share}% of functions).`);
  const fmt = c.configs.filter((x) => /Prettier|ESLint|Biome|Ruff|flake8|Black|rustfmt|golangci|EditorConfig|pre-commit|mypy/.test(x));
  if (fmt.length) rl.push(`Run the repo's own tooling before committing; it is configured here: ${fmt.join(', ')}.`);
  else rl.push('No formatter or linter config was found: match the surrounding file exactly and do not reformat lines you did not change.');
  if (c.tests.files) rl.push(`Put tests ${c.tests.dir ? `in ${c.tests.dir}/` : 'next to the code'}${c.tests.pattern ? ` named ${c.tests.pattern}` : ''}; the repo has ${c.tests.files} test file${c.tests.files === 1 ? '' : 's'}.`);
  if (c.tests.command) rl.push(`Run the tests with ${c.tests.command} and make them pass before you finish.`);
  if (c.node?.engines) rl.push(`Target Node ${c.node.engines} (from package.json engines).`);
  if (c.node && !c.node.dependencies) rl.push('Prefer the standard library: the project has no runtime dependencies, so do not add one for a small helper.');
  const g = c.git;
  if (g) {
    if (g.conventionalPct >= 60) rl.push(`Write commit subjects as conventional commits (${g.conventionalPct}% of the last ${g.count}): \`type(scope): summary\`${g.types.length ? `, with types such as ${g.types.map(([t]) => t).join(', ')}` : ''}.`);
    else rl.push(`Write commit subjects in plain ${g.capitalizedPct >= 60 ? 'capitalised' : 'lowercase'} sentences without a type prefix (${g.conventionalPct}% of the last ${g.count} use one)${g.periodPct < 20 ? ' and no trailing period' : ''}, about ${g.medianLength} characters long.`);
    if (g.topVerbs.length) rl.push(`Start commit subjects with a verb; the common ones here are ${g.topVerbs.join(', ')}.`);
  }
  L.push('---', `name: ${name}`,
    `description: Coding standards for ${repo}, learned from the repo itself. Use when writing, changing or reviewing code in ${repo}, when asked what style, naming, test or commit conventions to follow, or before opening a pull request.`,
    'license: MIT', '---', '', `# ${repo} coding standards`, '',
    `Conventions detected from ${c.fileCount} tracked files${g ? ` and the last ${g.count} commits` : ''}. They describe what the code does today, so follow them over personal preference.`, '',
    '## When to use', '',
    `- You are about to write, edit or review code in ${repo}.`, '- Someone asks which naming, formatting, test or commit-message convention applies.', '- You are preparing a commit or pull request and want to match the history.', '', '## Rules', '');
  rl.forEach((r, i) => L.push(`${i + 1}. ${r}`));
  if (rules.length) {
    L.push('', '## Rules learned from review comments', '', 'Reviewers asked for these repeatedly. The count is how many separate comments made the request.', '');
    rules.slice(0, 12).forEach((r, i) => L.push(`${i + 1}. ${r.rule} (requested ${r.count} times)`));
  }
  L.push('', '## Examples from this repo', '');
  if (c.examples.files.length) L.push(`Source files to imitate: ${c.examples.files.join(', ')}.`, '');
  if (c.examples.snippet) L.push(`A function in the house style (${c.examples.snippet.file}, line ${c.examples.snippet.line}):`, '', `\`\`\`${c.examples.snippet.lang}`, c.examples.snippet.text, '```', '');
  if (g?.samples.length) L.push('Recent commit subjects:', '', '```', ...g.samples, '```', '');
  L.push('## Steps', '', '1. Read the nearest existing file and match it before applying the rules above.', '2. Make the change, run the test command, then check the diff touches only what was asked.', '3. If a rule conflicts with the file you are editing, keep the file consistent and mention the conflict.', '');
  return L.join('\n');
}

export function casesYaml(c) {
  const repo = path.basename(path.resolve(c.root));
  return `# Trigger cases for the coding-standards skill (run: skillhawk test <dir>)
should_fire:
  - "write a new function in ${repo} that follows our coding standards"
  - "what commit message format do we use here"
  - "review this change against the repo conventions before I open a pull request"
  - "which naming and test conventions does this codebase follow"
should_not_fire:
  - "plan a team offsite for next quarter"
  - "summarise this sales spreadsheet"
  - "draft a press release for the product launch"
`;
}

export async function learnStandards(repo, { out = 'skills/coding-standards', fromReviews = null, fromGit = false } = {}) {
  const root = path.resolve(repo);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${repo}`);
  const c = detectConventions(root);
  if (fromGit && !c.git) throw new Error('--from-git needs a git repository with at least one commit');
  let rules = [];
  if (fromReviews) {
    if (!fs.existsSync(fromReviews)) throw new Error(`review comments file not found: ${fromReviews}`);
    rules = clusterComments(parseReviewComments(fs.readFileSync(fromReviews, 'utf8'), fromReviews));
  }
  const dir = path.resolve(out);
  const name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'coding-standards';
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderStandards(c, rules, name));
  fs.writeFileSync(path.join(dir, 'tests', 'cases.yaml'), casesYaml(c));
  const { reviewDir } = await import('./review.js');
  return { dir, conventions: c, rules, review: reviewDir(dir) };
}

// ---- command ------------------------------------------------------------------

export async function run(args, flags = {}) {
  const sub = args[0];
  if (sub === 'scripts') {
    const { findSkillDirs } = await import('./review.js');
    const dirs = findSkillDirs(args.length > 1 ? args.slice(1) : ['.']);
    if (!dirs.length) throw new Error('no skill directories found (looking for folders with a SKILL.md)');
    const results = dirs.map((d) => ({ dir: d, ...reviewScripts(d) }));
    if (flags.json) {
      const body = `${JSON.stringify({ skills: results }, null, 2)}\n`;
      if (flags.json === true) process.stdout.write(body); else fs.writeFileSync(flags.json, body);
    }
    if (flags.json !== true) {
      for (const r of results) { console.log(r.dir); console.log(r.scripts.length ? renderScripts(r, '  ').join('\n') : '  no scripts'); }
      if (flags.json) console.log(`wrote ${flags.json}`);
    }
    if (results.some((r) => r.findings.some((f) => f.severity === 'high'))) process.exitCode = 1;
    return;
  }
  if (sub === 'standards') {
    const r = await learnStandards(args[1] || '.', { out: typeof flags.out === 'string' ? flags.out : 'skills/coding-standards', fromReviews: typeof flags['from-reviews'] === 'string' ? flags['from-reviews'] : null, fromGit: !!flags['from-git'] });
    const c = r.conventions;
    console.log(`learned conventions from ${c.fileCount} files${c.git ? ` and ${c.git.count} commits` : ''}${r.rules.length ? `, ${r.rules.length} rule(s) from review comments` : ''}`);
    for (const rule of r.rules.slice(0, 5)) console.log(`  x${rule.count}  ${rule.rule}`);
    console.log(`wrote ${path.join(r.dir, 'SKILL.md')} and tests/cases.yaml`);
    console.log(`review: ${r.review.grade} (${r.review.reason})`);
    if ('CDF'.includes(r.review.grade)) process.exitCode = 1;
    return;
  }
  throw new Error('usage: skillhawk clean scripts <skill-dir...> [--json]  |  skillhawk clean standards [repo] [--from-git] [--from-reviews <file>] [--out <dir>]');
}
