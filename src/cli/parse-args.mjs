export function parseArgs(argv) {
  const options = {};
  const option = (key, value) => {
    options[key] = Object.hasOwn(options, key) ? [options[key], value].flat() : value;
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const separator = value.indexOf('=');
      const rawKey = value.slice(2, separator === -1 ? undefined : separator);
      const inline = separator === -1 ? undefined : value.slice(separator + 1);
      if (!rawKey) throw new Error('Option name cannot be empty');
      if (inline !== undefined) option(rawKey, inline);
      else if (argv[index + 1] && !argv[index + 1].startsWith('-')) option(rawKey, argv[++index]);
      else option(rawKey, true);
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

