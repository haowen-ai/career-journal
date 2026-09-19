import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_SCHEMA_VERSION } from './defaults.mjs';

export function configPath(home) {
  return path.join(path.resolve(home), '.jobops', 'config.json');
}

export async function loadConfig(home) {
  const file = configPath(home);
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`CAREER JOURNAL is not configured at ${path.resolve(home)}. Run jobops setup.`);
    throw error;
  }
  if (parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new Error(`Unsupported config schema: ${parsed.schemaVersion}`);
  return parsed;
}

export async function saveConfig(home, config) {
  const file = configPath(home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.new`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

