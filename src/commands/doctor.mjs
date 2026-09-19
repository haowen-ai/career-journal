import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/store.mjs';
import { detectCareerOps } from '../integrations/careerops.mjs';

const major = (version) => Number(String(version).replace(/^v/, '').split('.')[0]);

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
    const directory = path.join(path.resolve(home), '.jobops');
    await mkdir(directory, { recursive: true });
    await access(directory);
    return { ok: true, detail: 'writable' };
  });
  try {
    const storage = await storageCheck();
    checks.push({ id: 'storage', severity: storage.ok ? 'pass' : 'fail', detail: storage.detail ?? '' });
  } catch (error) { checks.push({ id: 'storage', severity: 'fail', detail: error.message }); }
  const careerOpsCheck = capabilities.careerOps ?? (() => detectCareerOps(config.careerOps));
  const careerOps = await careerOpsCheck();
  checks.push({ id: 'careerops', severity: careerOps.ok ? 'pass' : 'warn', detail: careerOps.detail ?? '' });
  checks.push({ id: 'email', severity: config.email.accounts.length ? 'pass' : 'warn', detail: config.email.setupState });
  checks.push({ id: 'jev', severity: config.jev.accessState === 'enabled' ? 'pass' : 'warn', detail: config.jev.accessState });
  return { ok: !checks.some((item) => item.severity === 'fail'), checks };
}

export async function doctorCommand(parsed, io) {
  const report = await doctor(parsed.options.home ?? process.cwd());
  for (const check of report.checks) io.out(`${check.severity.toUpperCase()} ${check.id}: ${check.detail}`);
  return report.ok ? 0 : 1;
}
