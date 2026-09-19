import { openHomeDatabase } from '../runtime/home.mjs';
import { configureEmailAccount, listEmailAccounts, disconnectEmailAccount } from '../email/accounts.mjs';
import { importEml } from '../email/eml.mjs';
import { saveConfig } from '../config/store.mjs';
import { createProvider } from '../providers/interface.mjs';
import { createJevAdapter } from '../decision/jev.mjs';
import { classifyWithStructuredLlm } from '../decision/structured-llm.mjs';

export function configuredDecisionAdapters(config, fetchImpl = globalThis.fetch, env = process.env) {
  const adapters = {};
  if (config.model?.provider && config.model.provider !== 'none') {
    const provider = createProvider(config.model, fetchImpl, env);
    adapters.structuredLlm = (input) => classifyWithStructuredLlm(provider, input.text);
  }
  if (config.jev?.accessState) adapters.jev = createJevAdapter(config.jev, fetchImpl, env);
  return adapters;
}

export async function emailCommand(parsed, io) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (parsed.subcommand === 'configure') {
      const account = configureEmailAccount(context.db, {
        provider: parsed.options.provider,
        address: parsed.options.address,
        secretRef: parsed.options['secret-ref'] ?? null,
      });
      context.config.email.accounts = listEmailAccounts(context.db).map(({ id, provider, address, readOnly }) => ({ id, provider, address, readOnly }));
      context.config.email.setupState = 'configured';
      context.config.updatedAt = new Date().toISOString();
      await saveConfig(context.root, context.config);
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
    if (parsed.subcommand === 'disconnect') {
      const removed = disconnectEmailAccount(context.db, parsed.options.account);
      context.config.email.accounts = context.config.email.accounts.filter((item) => item.id !== parsed.options.account);
      context.config.email.setupState = context.config.email.accounts.length ? 'configured' : 'not-configured';
      await saveConfig(context.root, context.config);
      io.out(JSON.stringify({ removed }));
      return 0;
    }
    throw new Error('Usage: jobops email configure|list|import-eml|disconnect');
  } finally { context.db.close(); }
}
