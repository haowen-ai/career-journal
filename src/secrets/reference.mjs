import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENV_REFERENCE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const KEYCHAIN_REFERENCE = /^keychain:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9][A-Za-z0-9._@+-]{0,127})$/;

export function validSecretReference(value, { allowKeychain = false } = {}) {
  const text = String(value ?? '');
  return ENV_REFERENCE.test(text) || (allowKeychain && KEYCHAIN_REFERENCE.test(text));
}

async function readMacOSKeychain(service, account) {
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password', '-w', '-s', service, '-a', account,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 });
  return stdout.trim();
}

export async function resolveSecretReference(secretRef, capabilities = {}) {
  const text = String(secretRef ?? '');
  const envMatch = ENV_REFERENCE.exec(text);
  if (envMatch) {
    const value = (capabilities.env ?? process.env)[envMatch[1]];
    if (!value) throw new Error(`Credential environment variable is unavailable: ${envMatch[1]}`);
    return { value, source: `environment variable ${envMatch[1]}` };
  }

  const keychainMatch = KEYCHAIN_REFERENCE.exec(text);
  if (!keychainMatch) throw new Error('Credential must use env:VARIABLE or keychain:SERVICE:ACCOUNT');
  if ((capabilities.platform ?? process.platform) !== 'darwin') {
    throw new Error('keychain:SERVICE:ACCOUNT credentials require macOS');
  }
  try {
    const value = await (capabilities.readKeychain ?? readMacOSKeychain)(keychainMatch[1], keychainMatch[2]);
    if (!value) throw new Error('empty credential');
    return { value, source: `macOS Keychain service ${keychainMatch[1]}` };
  } catch {
    throw new Error(`macOS Keychain credential is unavailable for service ${keychainMatch[1]}`);
  }
}

export async function secretReferenceState(secretRef, capabilities = {}) {
  if (!secretRef) return { ok: true, detail: 'no credential reference configured' };
  try {
    const resolved = await resolveSecretReference(secretRef, capabilities);
    return { ok: true, detail: `credential is available from ${resolved.source}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}
