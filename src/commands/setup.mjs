import { access } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig, validateTimezone } from '../config/defaults.mjs';
import { loadConfig, saveConfig } from '../config/store.mjs';

function cleanBaseUrl(value) {
  if (value == null || value === '') return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Model base URL must use http(s) without credentials');
  return url.href.replace(/\/$/, '');
}

function emailAccount(input) {
  if (!input?.provider || !input?.address) throw new Error('Email provider and address are required');
  const address = String(input.address).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) throw new Error('Email address is invalid');
  const provider = String(input.provider).trim();
  return { id: `${provider}:${address}`, provider, address, readOnly: true };
}

export async function setup(home, answers = {}) {
  let config;
  let created = false;
  try { config = await loadConfig(home); }
  catch (error) {
    if (!/not configured/.test(error.message)) throw error;
    config = defaultConfig();
    created = true;
  }
  if (answers.timezone !== undefined) config.timezone = validateTimezone(answers.timezone);
  if (answers.email?.mode === 'skip') {
    config.email.setupState = 'skipped';
  } else if (answers.email?.mode === 'configure') {
    const account = emailAccount(answers.email);
    config.email.accounts = [...config.email.accounts.filter((item) => item.id !== account.id), account];
    config.email.setupState = 'configured';
  }
  if (answers.model) {
    config.model = {
      ...config.model,
      provider: answers.model.provider ?? config.model.provider,
      baseUrl: answers.model.baseUrl === undefined ? config.model.baseUrl : cleanBaseUrl(answers.model.baseUrl),
      model: answers.model.model ?? config.model.model,
      secretRef: answers.model.secretRef ?? config.model.secretRef,
    };
  }
  if (answers.jev?.accessState) {
    const allowed = new Set(['unavailable', 'waitlisted', 'enabled', 'disabled']);
    if (!allowed.has(answers.jev.accessState)) throw new Error('Invalid Jev access state');
    config.jev.accessState = answers.jev.accessState;
  }
  if (answers.careerOps?.root !== undefined) {
    config.careerOps ??= { root: null, pinnedVersion: '1.32.0', entrypoint: 'career-journal-adapter.mjs' };
    config.careerOps.root = answers.careerOps.root ? String(answers.careerOps.root) : null;
  }
  config.materials ??= { ruleFiles: [] };
  if (answers.materialRules !== undefined) {
    if (!Array.isArray(answers.materialRules)) throw new Error('Material rules must be a list of file paths');
    const ruleFiles = [...new Set(answers.materialRules.map((file) => path.resolve(String(file))))];
    for (const file of ruleFiles) {
      try { await access(file); }
      catch { throw new Error(`Material rules file is not readable: ${file}`); }
    }
    config.materials.ruleFiles = ruleFiles;
  }
  config.updatedAt = new Date().toISOString();
  await saveConfig(home, config);
  return { created, config };
}

export async function setupCommand(parsed, io, runtime) {
  const home = parsed.options.home ?? process.cwd();
  let timezone = parsed.options.timezone;
  if (timezone === undefined) {
    try { await loadConfig(home); }
    catch (error) {
      if (!/not configured/.test(error.message)) throw error;
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    }
  }
  const answers = {
    timezone,
    email: parsed.options['skip-email'] ? { mode: 'skip' } : undefined,
    careerOps: parsed.options['careerops-root'] !== undefined ? { root: parsed.options['careerops-root'] } : undefined,
    materialRules: parsed.options['material-rules'] !== undefined ? [parsed.options['material-rules']] : undefined,
  };
  const result = await setup(home, answers);
  io.out(result.created ? 'Configuration created.' : 'Configuration updated.');
  io.out(`Timezone: ${result.config.timezone}`);
  io.out(`Email: ${result.config.email.setupState}`);
  return 0;
}
