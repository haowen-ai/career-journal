import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CONFIG_SCHEMA_VERSION } from './defaults.mjs';

export function workspaceDirectory(home) {
  const root = path.resolve(home);
  const primary = path.join(root, '.career-journal');
  const legacy = path.join(root, '.jobops');
  const primaryConfig = existsSync(path.join(primary, 'config.json'));
  const legacyConfig = existsSync(path.join(legacy, 'config.json'));
  if (primaryConfig && legacyConfig) {
    throw new Error(`Conflicting CAREER JOURNAL workspaces found at ${primary} and ${legacy}. Keep one config.json before continuing.`);
  }
  if (primaryConfig) return primary;
  if (legacyConfig) return legacy;
  return primary;
}

export function configPath(home) {
  return path.join(workspaceDirectory(home), 'config.json');
}

export async function loadConfig(home) {
  const file = configPath(home);
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`CAREER JOURNAL is not configured at ${path.resolve(home)}. Run career-journal setup.`);
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
