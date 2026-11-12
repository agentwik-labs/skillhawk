// Flags that take a value only when it is one of these; otherwise they stay boolean and the next token is a positional.
const ENUM_FLAGS = { gate: ['high', 'medium', 'low'] };

export function parseArgs(argv) {
  const out = { _: [] };
  const alias = { g: 'global', a: 'agent', h: 'help', f: 'force' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out[k] = v;
      else if (ENUM_FLAGS[k]) {
        if (argv[i + 1] !== undefined && ENUM_FLAGS[k].includes(argv[i + 1])) out[k] = argv[++i];
        else out[k] = true;
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) out[k] = argv[++i];
      else out[k] = true;
    } else if (/^-[a-z]$/.test(a)) {
      const k = alias[a[1]] || a[1];
      if (k === 'agent' && argv[i + 1] && !argv[i + 1].startsWith('-')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  // --allow-model is readable as flags['allow-model'] and flags.allowModel, so no command misses a dashed flag.
  for (const k of Object.keys(out)) if (k.includes('-')) { const c = k.replace(/-([a-z])/g, (_, x) => x.toUpperCase()); if (!(c in out)) out[c] = out[k]; }
  return out;
}
