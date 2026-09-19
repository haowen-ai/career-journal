import { parseArgs } from './parse-args.mjs';

const HELP = `Job Search Ops

Usage: jobops <command> [subcommand] [options]

Commands:
  setup         Configure a local workspace
  doctor        Check local capabilities
  application   Add, list, or show applications
  event         Record an application event
  artifact      Add a draft or confirmed submitted artifact
  export        Export local records
  start         Start the local dashboard and API
  automation    Configure and run scheduled tasks
  email         Configure or import read-only email
  material      Prepare or verify application materials
  update        Check for updates
  migrate       Inspect or apply data migrations
  backup        Create a secret-free local backup

Options:
  -h, --help     Show this help
  -v, --version  Show the current version`;

export async function runCli(argv, io, runtime) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { io.err(error.message); return 2; }

  if (parsed.options.version || parsed.command === 'version') {
    io.out(runtime.version);
    return 0;
  }
  if (parsed.options.help || !parsed.command || parsed.command === 'help') {
    io.out(HELP);
    return 0;
  }
  const handler = runtime.commands.get(parsed.command);
  if (!handler) {
    io.err(`Unknown command: ${parsed.command}`);
    io.err('Run jobops --help to see available commands.');
    return 2;
  }
  try {
    return Number(await handler(parsed, io, runtime)) || 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export { HELP };

