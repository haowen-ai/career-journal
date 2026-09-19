import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defaultConfig, validateTimezone } from '../config/defaults.mjs';
import { loadConfig, saveConfig } from '../config/store.mjs';
import { openDatabase, openReadOnlyDatabase, migrate, pendingMigrationError } from '../storage/database.mjs';
import { assertPublicEmailAddress, configureEmailAccount, listEmailAccounts, emailSetupState } from '../email/accounts.mjs';
import { upsertTask, listTasks, automationSetupState } from '../automation/registry.mjs';

const DAILY_AUTOMATIONS = Object.freeze({
  'mail-sync': { time: '20:00', notificationPolicy: 'actionable' },
  'deadline-review': { time: '20:15', notificationPolicy: 'actionable' },
  'daily-consolidation': { time: '22:00', notificationPolicy: 'actionable' },
  'local-backup': { time: '23:00', notificationPolicy: 'failures' },
});

function cleanBaseUrl(value) {
  if (value == null || value === '') return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Model base URL must use http(s) without credentials');
  return url.href.replace(/\/$/, '');
}

function cleanJevBaseUrl(value) {
  if (value == null || value === '') return 'https://api.typesafe.ai/v1/systemone';
  const url = new URL(value);
  if (url.origin !== 'https://api.typesafe.ai' || url.pathname.replace(/\/$/, '') !== '/v1/systemone' || url.search || url.hash) {
    throw new Error('Jev endpoint must be https://api.typesafe.ai/v1/systemone');
  }
  return 'https://api.typesafe.ai/v1/systemone';
}

function jevSettings(input, current) {
  const secretRef = input.secretRef ?? current.secretRef;
  if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(String(secretRef ?? ''))) {
    throw new Error('--jev-secret-ref env:VARIABLE is required; do not put the API key in config');
  }
  const threshold = input.threshold === undefined ? Number(current.threshold ?? 0.8) : Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Jev threshold must be between 0 and 1');
  return {
    accessState: 'enabled',
    baseUrl: cleanJevBaseUrl(input.baseUrl ?? current.baseUrl),
    model: String(input.model ?? current.model ?? 'jev-latest'),
    secretRef,
    mode: 'active',
    threshold,
  };
}

function emailAccount(input) {
  if (!input?.provider || !input?.address) throw new Error('Email provider and address are required');
  const address = String(input.address).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) throw new Error('Email address is invalid');
  const provider = String(input.provider).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error('Email provider is invalid');
  return { id: `${provider}:${address}`, provider, address, readOnly: true };
}

function hasDailyMailbox(home, config) {
  const databasePath = path.resolve(home, config.data.database);
  if (!existsSync(databasePath)) return false;
  const db = openReadOnlyDatabase(databasePath);
  try {
    const pending = migrate(db, { dryRun: true }).pending;
    if (pending.length) throw pendingMigrationError(pending);
    return listEmailAccounts(db).some((account) => account.readOnly && (
      (account.provider === 'host' && account.settings?.connector)
      || (account.provider === 'imap' && account.settings?.host && account.settings?.username)
    ));
  } finally { db.close(); }
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
    config.email.setupState = ['host', 'imap'].includes(answers.email.provider) ? 'pending-verification' : 'fallback-only';
    if (answers.provisionAutomations) config.automation = { ...config.automation, setupState: 'pending-registration' };
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
    config.jev = answers.jev.accessState === 'enabled'
      ? jevSettings(answers.jev, config.jev)
      : { ...config.jev, accessState: answers.jev.accessState, mode: 'off' };
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
  if (answers.email?.mode === 'configure' || answers.provisionAutomations) {
    const databasePath = path.resolve(home, config.data.database);
    const existed = existsSync(databasePath);
    if (existed) {
      const inspect = openReadOnlyDatabase(databasePath);
      try {
        const pending = migrate(inspect, { dryRun: true }).pending;
        if (pending.length) throw pendingMigrationError(pending);
      } finally { inspect.close(); }
    }
    const db = openDatabase(databasePath);
    try {
      if (!existed) migrate(db);
      const account = answers.email?.mode === 'configure'
        ? configureEmailAccount(db, {
          provider: answers.email.provider,
          address: answers.email.address,
          secretRef: answers.email.secretRef ?? null,
          settings: answers.email.settings ?? {},
        })
        : null;
      if (answers.provisionAutomations) {
        const existingTasks = listTasks(db);
        const existingByType = new Map(existingTasks.map((task) => [task.type, task]));
        const eligibleAccounts = listEmailAccounts(db)
          .filter((item) => item.readOnly && (
            (item.provider === 'host' && item.settings?.connector)
            || (item.provider === 'imap' && item.settings?.host && item.settings?.username)
          ));
        const existingMailAccount = eligibleAccounts.find((item) => item.id === existingByType.get('mail-sync')?.accountId);
        const configuredAccount = eligibleAccounts.find((item) => item.id === account?.id);
        const selectedAccount = configuredAccount ?? existingMailAccount ?? (eligibleAccounts.length === 1 ? eligibleAccounts[0] : null);
        if (!selectedAccount) {
          if (eligibleAccounts.length > 1) {
            throw new Error('Multiple daily email accounts are configured; select one by rerunning setup with --email-provider and --email-address');
          }
          throw new Error('A host-managed or IMAPS read-only email account is required before automations can be provisioned');
        }
        for (const [type, defaults] of Object.entries(DAILY_AUTOMATIONS)) {
          const existingTask = existingByType.get(type);
          const explicitTime = Object.hasOwn(answers.automationTimes ?? {}, type);
          upsertTask(db, {
            type,
            enabled: existingTask?.enabled ?? true,
            timezone: answers.timezone !== undefined ? config.timezone : existingTask?.timezone ?? config.timezone,
            time: explicitTime ? answers.automationTimes[type] : existingTask?.schedule ?? defaults.time,
            accountId: type === 'mail-sync' ? selectedAccount.id : existingTask?.accountId ?? null,
            notificationPolicy: existingTask?.notificationPolicy ?? defaults.notificationPolicy,
            config: existingTask?.config ?? {},
          });
        }
        config.automation = { ...config.automation, setupState: automationSetupState(listTasks(db)) };
      }
      const accounts = listEmailAccounts(db);
      const mailTask = listTasks(db).find((task) => task.type === 'mail-sync');
      config.email.accounts = accounts.map(({ id, provider, address, readOnly }) => ({ id, provider, address, readOnly }));
      config.email.setupState = emailSetupState(accounts, mailTask?.accountId ?? null);
    } finally { db.close(); }
  }
  await saveConfig(home, config);
  return { created, config };
}

export async function setupCommand(parsed, io, runtime) {
  const home = parsed.options.home ?? process.cwd();
  let timezone = parsed.options.timezone;
  let existing = true;
  let existingConfig = null;
  if (timezone === undefined) {
    try { existingConfig = await loadConfig(home); }
    catch (error) {
      if (!/not configured/.test(error.message)) throw error;
      existing = false;
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    }
  } else {
    try { existingConfig = await loadConfig(home); }
    catch (error) {
      if (!/not configured/.test(error.message)) throw error;
      existing = false;
    }
  }
  const emailProvider = parsed.options['email-provider'];
  const emailAddress = parsed.options['email-address'];
  const emailConnector = parsed.options['email-connector'];
  if ((emailProvider && !emailAddress) || (!emailProvider && emailAddress)) throw new Error('Both --email-provider and --email-address are required');
  if (parsed.options['skip-email'] === true) throw new Error('A read-only job-search email account is required; --skip-email is not supported');
  if (emailProvider && !['host', 'imap'].includes(emailProvider)) throw new Error('Initial setup requires a host-managed connector or live IMAPS; manual EML is fallback-only');
  if (emailProvider) assertPublicEmailAddress(emailAddress);
  if (emailProvider === 'host' && parsed.options['secret-ref'] !== undefined) {
    throw new Error('Host-managed email connectors keep credentials in the host; --secret-ref is not accepted');
  }
  if (emailProvider === 'host' && (typeof emailConnector !== 'string' || !emailConnector.trim())) {
    throw new Error('--email-connector is required for the host-managed read-only mailbox');
  }
  if (emailProvider === 'imap') {
    if (typeof parsed.options['imap-host'] !== 'string' || !parsed.options['imap-host'].trim()) throw new Error('--imap-host is required for IMAPS');
    if (typeof parsed.options['imap-user'] !== 'string' || !parsed.options['imap-user'].trim()) throw new Error('--imap-user is required for IMAPS');
    if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(String(parsed.options['secret-ref'] ?? ''))) {
      throw new Error('--secret-ref env:VARIABLE is required for IMAPS');
    }
  }
  const existingMailbox = existing && existingConfig ? hasDailyMailbox(home, existingConfig) : false;
  if (!emailProvider && !existingMailbox) {
    throw new Error('A read-only job-search email account is required. Provide --email-provider and --email-address.');
  }
  const answers = {
    timezone,
    email: emailProvider ? {
      mode: 'configure',
      provider: emailProvider,
      address: emailAddress,
      secretRef: emailProvider === 'imap' ? parsed.options['secret-ref'] : null,
      settings: emailProvider === 'host'
        ? { connector: emailConnector.trim() }
        : {
          host: parsed.options['imap-host'],
          port: parsed.options['imap-port'] ?? 993,
          username: parsed.options['imap-user'],
          mailbox: parsed.options['imap-mailbox'] ?? 'INBOX',
        },
    } : undefined,
    provisionAutomations: Boolean(emailProvider || existingMailbox),
    automationTimes: {
      ...(parsed.options['mail-sync-time'] ? { 'mail-sync': parsed.options['mail-sync-time'] } : {}),
      ...(parsed.options['deadline-review-time'] ? { 'deadline-review': parsed.options['deadline-review-time'] } : {}),
      ...(parsed.options['daily-consolidation-time'] ? { 'daily-consolidation': parsed.options['daily-consolidation-time'] } : {}),
      ...(parsed.options['local-backup-time'] ? { 'local-backup': parsed.options['local-backup-time'] } : {}),
    },
    careerOps: parsed.options['careerops-root'] !== undefined ? { root: parsed.options['careerops-root'] } : undefined,
    materialRules: parsed.options['material-rules'] !== undefined ? [parsed.options['material-rules']] : undefined,
    jev: parsed.options['jev-secret-ref'] !== undefined
      ? {
        accessState: 'enabled',
        secretRef: parsed.options['jev-secret-ref'],
        baseUrl: parsed.options['jev-base-url'],
        model: parsed.options['jev-model'],
        threshold: parsed.options['jev-threshold'],
      }
      : undefined,
  };
  const result = await setup(home, answers);
  io.out(result.created ? 'Configuration created.' : 'Configuration updated.');
  io.out(`Timezone: ${result.config.timezone}`);
  io.out(`Email: ${result.config.email.setupState}`);
  io.out(`Automation: ${result.config.automation.setupState}`);
  io.out(`Jev: ${result.config.jev.accessState === 'enabled' ? `${result.config.jev.model} active; key from ${result.config.jev.secretRef}` : `${result.config.jev.accessState}; ambiguous decisions require manual review`}`);
  if (result.config.email.setupState !== 'verified') {
    io.out(emailProvider === 'imap'
      ? 'Next: set the IMAP credential environment variable, run email verify-imap, then create and register the mail-sync job.'
      : 'Next: connect a live verifier for the selected host mailbox; host batch JSON alone remains self-attested.');
  }
  if (result.config.automation.setupState !== 'registered') {
    io.out('Next: create all four real schedules, register each returned ID, add the returned exact command to its scheduler job, run automation verify, trigger each verified job once, then run doctor.');
  }
  return 0;
}
