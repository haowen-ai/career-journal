import { openHomeDatabase } from '../runtime/home.mjs';
import {
  assertPublicEmailAddress,
  configureEmailAccount,
  listEmailAccounts,
  disconnectEmailAccount,
  emailSetupState,
  verifyImapEmailAccount,
} from '../email/accounts.mjs';
import { importEml } from '../email/eml.mjs';
import { saveConfig } from '../config/store.mjs';
import { createJevAdapter } from '../decision/jev.mjs';
import { classifyWithStructuredLlm } from '../decision/structured-llm.mjs';
import { createProvider } from '../providers/interface.mjs';
import { loadHostBatch, syncHostBatch } from '../email/host-sync.mjs';
import { automationSetupState, listTasks } from '../automation/registry.mjs';
import { syncImapEmailAccount } from '../email/imap-sync.mjs';

export function configuredDecisionAdapters(config, fetchImpl = globalThis.fetch, env = process.env) {
  const adapters = {};
  if (config.jev?.accessState) adapters.jev = createJevAdapter(config.jev, fetchImpl, env);
  if (config.model?.provider === 'openai-compatible' && config.model.baseUrl && config.model.model) {
    const provider = createProvider(config.model, fetchImpl, env);
    adapters.structuredLlm = (input) => classifyWithStructuredLlm(provider, input?.text);
    adapters.structuredLlmThreshold = Number.isFinite(Number(config.model.threshold))
      ? Number(config.model.threshold)
      : 0.8;
  }
  return adapters;
}

async function persistEmailState(context) {
  const accounts = listEmailAccounts(context.db);
  const tasks = listTasks(context.db);
  const mailTask = tasks.find((task) => task.type === 'mail-sync');
  context.config.email.accounts = accounts.map(({ id, provider, address, readOnly }) => ({ id, provider, address, readOnly }));
  context.config.email.setupState = emailSetupState(accounts, mailTask?.accountId ?? null);
  context.config.automation = { ...context.config.automation, setupState: automationSetupState(tasks) };
  context.config.updatedAt = new Date().toISOString();
  await saveConfig(context.root, context.config);
}

export async function emailCommand(parsed, io, runtime = {}) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (parsed.subcommand === 'configure') {
      const address = assertPublicEmailAddress(parsed.options.address);
      const provider = parsed.options.provider;
      const settings = provider === 'host'
        ? { connector: parsed.options.connector }
        : provider === 'imap'
          ? {
            host: parsed.options['imap-host'] ?? parsed.options.host,
            port: parsed.options['imap-port'] ?? parsed.options.port ?? 993,
            username: parsed.options['imap-user'] ?? parsed.options.username,
            mailbox: parsed.options['imap-mailbox'] ?? parsed.options.mailbox ?? 'INBOX',
          }
          : {};
      const account = configureEmailAccount(context.db, {
        provider,
        address,
        secretRef: parsed.options['secret-ref'] ?? null,
        settings,
      });
      await persistEmailState(context);
      io.out(JSON.stringify(account, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'list') {
      io.out(JSON.stringify(listEmailAccounts(context.db), null, 2));
      return 0;
    }
    if (parsed.subcommand === 'import-eml') {
      const result = await importEml(context.db, parsed.options.file, {
        accountId: parsed.options.account,
        applicationId: parsed.options.id ?? null,
        recordedAt: parsed.options['recorded-at'] ?? new Date().toISOString(),
      }, configuredDecisionAdapters(context.config));
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'sync-host') {
      const account = context.db.prepare('SELECT provider, read_only readOnly FROM email_accounts WHERE id = ?')
        .get(parsed.options.account);
      if (!account) throw new Error(`Unknown email account: ${parsed.options.account}`);
      if (!account.readOnly || account.provider !== 'host') {
        throw new Error('Host batch sync requires a host-managed read-only email account');
      }
      const batch = await loadHostBatch(parsed.options.file);
      if (parsed.options['dry-run'] === true) {
        io.out(JSON.stringify({ dryRun: true, accountId: parsed.options.account, examined: batch.messages.length, cursor: batch.cursor }, null, 2));
        return 0;
      }
      try {
        const result = await syncHostBatch(context.db, parsed.options.account, batch, configuredDecisionAdapters(context.config));
        if (!result.replayed) await persistEmailState(context);
        io.out(JSON.stringify(result, null, 2));
        return 0;
      } catch (error) {
        await persistEmailState(context);
        throw error;
      }
    }
    if (parsed.subcommand === 'verify-imap') {
      const account = await verifyImapEmailAccount(context.db, parsed.options.account, runtime.emailCapabilities ?? {});
      await persistEmailState(context);
      io.out(JSON.stringify(account, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'sync-imap') {
      try {
        const result = await syncImapEmailAccount(context.db, parsed.options.account, {
          ...(runtime.emailCapabilities ?? {}),
          externalTaskId: parsed.options['external-task-id'],
          runId: parsed.options['run-id'],
        }, configuredDecisionAdapters(context.config));
        await persistEmailState(context);
        io.out(JSON.stringify(result, null, 2));
        return 0;
      } catch (error) {
        await persistEmailState(context);
        throw error;
      }
    }
    if (parsed.subcommand === 'disconnect') {
      const removed = disconnectEmailAccount(context.db, parsed.options.account);
      await persistEmailState(context);
      io.out(JSON.stringify({ removed }));
      return 0;
    }
    throw new Error('Usage: career-journal email configure|list|import-eml|verify-imap|sync-imap|sync-host|disconnect');
  } finally { context.db.close(); }
}
