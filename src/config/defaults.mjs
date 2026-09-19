export const CONFIG_SCHEMA_VERSION = 1;

export function defaultConfig(now = new Date().toISOString(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC') {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    timezone,
    data: { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' },
    email: { setupState: 'not-configured', accounts: [] },
    model: { provider: 'none', baseUrl: null, model: null, secretRef: null },
    jev: { accessState: 'unavailable', model: 'jev-latest', secretRef: null, mode: 'off' },
    careerOps: { root: null, pinnedVersion: '1.32.0', entrypoint: 'jobops-adapter.mjs' },
    materials: { ruleFiles: [] },
    automation: { setupState: 'not-configured' },
  };
}

export function validateTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Timezone is required');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date()); }
  catch { throw new Error(`Invalid IANA timezone: ${value}`); }
  return value;
}
