import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig, workspaceDirectory } from '../config/store.mjs';
import { detectCareerOps } from '../integrations/careerops.mjs';

const major = (version) => Number(String(version).replace(/^v/, '').split('.')[0]);

function envReferenceState(secretRef, env) {
  if (!secretRef) return { ok: true, detail: 'no credential reference configured' };
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(secretRef);
  if (!match) return { ok: false, detail: 'credential must use env:VARIABLE' };
  return env[match[1]] ? { ok: true, detail: `credential ${match[1]} is available` } : { ok: false, detail: `set environment variable ${match[1]}` };
}

export async function doctor(home, capabilities = {}) {
  const checks = [];
  const nodeVersion = capabilities.nodeVersion ?? process.versions.node;
  checks.push({ id: 'node', severity: major(nodeVersion) >= 24 ? 'pass' : 'fail', detail: nodeVersion });
  let config;
  try {
    config = await loadConfig(home);
    checks.push({ id: 'config', severity: 'pass', detail: `schema ${config.schemaVersion}` });
  } catch (error) {
    checks.push({ id: 'config', severity: 'fail', detail: error.message });
    return { ok: false, checks };
  }
  const storageCheck = capabilities.storage ?? (async () => {
    const directory = workspaceDirectory(home);
    await mkdir(directory, { recursive: true });
    await access(directory);
    const probe = path.join(directory, `.doctor-${randomUUID()}`);
    await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await rm(probe);
    return { ok: true, detail: 'writable' };
  });
  try {
    const storage = await storageCheck();
    checks.push({ id: 'storage', severity: storage.ok ? 'pass' : 'fail', detail: storage.detail ?? '' });
  } catch (error) { checks.push({ id: 'storage', severity: 'fail', detail: error.message }); }
  const careerOpsCheck = capabilities.careerOps ?? (() => detectCareerOps(config.careerOps));
  const careerOps = await careerOpsCheck();
  checks.push({ id: 'careerops', severity: careerOps.ok ? 'pass' : 'warn', detail: careerOps.detail ?? '' });
  const emailProviders = config.email.accounts.map((item) => item.provider);
  const emailUsable = emailProviders.length > 0 && emailProviders.every((provider) => provider === 'manual-eml');
  checks.push({ id: 'email', severity: emailUsable ? 'pass' : 'warn', detail: emailUsable ? 'configured read-only manual-eml adapter' : emailProviders.length ? 'unsupported email adapter; configure manual-eml' : `${config.email.setupState}; run career-journal email configure` });

  const env = capabilities.env ?? process.env;
  const model = config.model ?? { provider: 'none' };
  let modelState = { ok: false, detail: 'not configured; core rules remain available' };
  if (model.provider === 'openai-compatible') {
    const credential = envReferenceState(model.secretRef, env);
    modelState = { ok: Boolean(model.baseUrl && model.model && credential.ok), detail: !model.baseUrl || !model.model ? 'configure model baseUrl and model name' : credential.detail };
  } else if (model.provider !== 'none') modelState = { ok: false, detail: `unsupported provider ${model.provider}` };
  checks.push({ id: 'model', severity: modelState.ok ? 'pass' : 'warn', detail: modelState.detail });

  let jevState = { ok: false, detail: config.jev.accessState };
  if (config.jev.accessState === 'enabled') {
    const credential = envReferenceState(config.jev.secretRef, env);
    jevState = { ok: credential.ok && Boolean(config.jev.model), detail: credential.ok ? `enabled with ${config.jev.model}` : credential.detail };
  } else if (config.jev.accessState === 'waitlisted') jevState.detail = 'waitlisted; no key required until access is granted';
  checks.push({ id: 'jev', severity: jevState.ok ? 'pass' : 'warn', detail: jevState.detail });
  return { ok: !checks.some((item) => item.severity === 'fail'), checks };
}

export async function doctorCommand(parsed, io) {
  const report = await doctor(parsed.options.home ?? process.cwd());
  for (const check of report.checks) io.out(`${check.severity.toUpperCase()} ${check.id}: ${check.detail}`);
  return report.ok ? 0 : 1;
}
