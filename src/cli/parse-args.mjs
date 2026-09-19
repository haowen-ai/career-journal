export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const [rawKey, inline] = value.slice(2).split('=', 2);
      if (!rawKey) throw new Error('Option name cannot be empty');
      if (inline !== undefined) options[rawKey] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith('-')) options[rawKey] = argv[++index];
      else options[rawKey] = true;
    } else if (value === '-h') options.help = true;
    else if (value === '-v') options.version = true;
    else positionals.push(value);
  }
  return {
    command: positionals[0] ?? '',
    subcommand: positionals[1] ?? null,
    options,
    positionals: positionals.slice(2),
  };
}

