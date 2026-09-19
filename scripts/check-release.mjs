#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

async function readable(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function candidateFiles(root) {
  const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root });
  return stdout.split('\n').filter(Boolean);
}

export async function checkRelease(root) {
  const checks = [];
  const errors = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    if (!ok) errors.push(`${id}: ${detail}`);
  };
  const read = (file) => readFile(path.join(root, file), 'utf8');

  let version = '';
  let packageJson = {};
  let changelog = '';
  try {
    [version, packageJson, changelog] = await Promise.all([
      read('VERSION').then((text) => text.trim()),
      read('package.json').then(JSON.parse),
      read('CHANGELOG.md'),
    ]);
    check('version-consistency', version === packageJson.version && changelog.includes(`## [${version}]`), `${version} / ${packageJson.version}`);
  } catch (error) { check('version-consistency', false, error.message); }

  try {
    const notices = await read('THIRD_PARTY_NOTICES.md');
    check('attribution', /career-ops-hq\/career-ops/.test(notices) && /Santiago Fernández de Valderrama/.test(notices) && /typesafe-ai\/skills/.test(notices) && /TypeSafe AI/.test(notices), 'CareerOps and TypeSafe attribution');
  } catch (error) { check('attribution', false, error.message); }

  const licenseFiles = ['LICENSE', 'LICENSES/career-ops-MIT.txt', 'LICENSES/typesafe-ai-skills-MIT.txt'];
  const licenses = await Promise.all(licenseFiles.map(async (file) => (await readable(path.join(root, file))) && /MIT License/.test(await read(file))));
  check('licenses', licenses.every(Boolean), licenseFiles.join(', '));
  check('changelog', /### Added/.test(changelog) && /### Changed/.test(changelog) && /### Fixed/.test(changelog) && /### Security/.test(changelog), 'required changelog sections');

  const files = await candidateFiles(root);
  const textFiles = files.filter((file) => /\.(?:mjs|js|json|md|yml|yaml|txt|html|css)$/.test(file));
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b/,
    /\b(?:password|token|api_key)\s*[:=]\s*["'][^"'\n]{8,}["']/i,
  ];
  let secretFile = null;
  for (const file of textFiles) {
    const content = await read(file);
    if (secretPatterns.some((pattern) => pattern.test(content))) { secretFile = file; break; }
  }
  check('tracked-secrets', secretFile === null, secretFile ?? 'none found');

  let missingImport = null;
  for (const file of textFiles.filter((item) => item.endsWith('.mjs'))) {
    const content = await read(file);
    for (const match of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const resolved = path.resolve(root, path.dirname(file), match[1]);
      if (!(await readable(resolved))) { missingImport = `${file}: ${match[1]}`; break; }
    }
    if (missingImport) break;
  }
  check('local-imports', missingImport === null, missingImport ?? 'all local imports resolve');
  return { ok: errors.length === 0, checks, errors };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const report = await checkRelease(process.cwd());
  for (const item of report.checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}: ${item.detail}`);
  if (!report.ok) process.exitCode = 1;
}
