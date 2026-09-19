#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runCli } from '../src/cli/main.mjs';
import { setupCommand } from '../src/commands/setup.mjs';
import { doctorCommand } from '../src/commands/doctor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const io = { out: console.log, err: console.error };
const exitCode = await runCli(process.argv.slice(2), { out: (v) => io.out(v), err: (v) => io.err(v) }, {
  root,
  version,
  commands: new Map([
    ['setup', setupCommand],
    ['doctor', doctorCommand],
  ]),
});
process.exitCode = exitCode;
