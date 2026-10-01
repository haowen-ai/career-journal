import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PERSONAL_DATA_ALLOWLIST, findPersonalData, personalDataFindings } from '../../scripts/check-release.mjs';

// Every sample of real-looking personal data is assembled at run time, so this file itself
// never contains one and the repository-wide check keeps passing.
const email = (local, domain) => [local, domain].join('@');
const phone = (...parts) => parts.join('');
const home = (...parts) => parts.join('');

const kinds = (text) => findPersonalData(text).map((item) => [item.kind, item.value]);

test('flags email addresses outside the example domains', () => {
  for (const address of [email('jane.doe', 'gmail.com'), email('j.doe+jobs', 'university.edu'), email('JANE', 'Outlook.COM'), email('me', 'example.co')]) {
    assert.deepEqual(kinds(`Contact: ${address}.`), [['email', address]], address);
  }
});

test('allows example domains, reserved test domains, GitHub no-reply addresses, and the listed test placeholders', () => {
  const allowed = [
    email('alex', 'example.com'), email('a.b', 'mail.example.org'), email('x', 'example.net'), email('student', 'example.edu'),
    email('candidate', 'school.edu'), email('you', 'your-domain.edu'), email('12345+octocat', 'users.noreply.github.com'),
    email('candidate', 'example.test'), email('recruiting', 'acme.example'), email('nobody', 'mail.invalid'), email('dev', 'app.localhost'),
    ...PERSONAL_DATA_ALLOWLIST.emailAddresses,
    'icon@2x.png', 'https://user:pass@example.com/', 'npm install @scope/package',
  ];
  for (const text of allowed) assert.deepEqual(kinds(text), [], text);
  // The placeholder list covers exact addresses only, not their whole domains.
  assert.deepEqual(kinds(email('someone', 'company.com')), [['email', email('someone', 'company.com')]]);
});

test('flags US phone numbers in common formats unless they are in the 555-01xx range', () => {
  const real = [
    phone('(212) ', '867-5309'), phone('212-', '867-', '5309'), phone('212.', '867.', '5309'), phone('212 ', '867 ', '5309'),
    phone('+1 ', '212 ', '867 ', '5309'), phone('+1-', '212-', '867-', '5309'), phone('1-', '212-', '867-', '5309'),
    phone('+1', '2128675309'), phone('+1 ', '867 ', '5309'), phone('(212) ', '555-', '0200'), phone('+1 ', '555 ', '0200'),
  ];
  for (const number of real) assert.deepEqual(kinds(`Call ${number} today`), [['phone', number]], number);
  const examples = [phone('+1 ', '555 ', '0100'), phone('+1 ', '555 ', '0199'), phone('(212) ', '555-', '0142'), phone('212-', '555-', '0100'), phone('+1', '2125550123')];
  for (const number of examples) assert.deepEqual(kinds(`Call ${number}`), [], number);
  const notPhones = ['2026-10-01T23:59:00-07:00', 'version 1.2.3', '08:00', '550e8400-e29b-41d4-a716-446655440000', 'id 2128675309', '4111 1111 1111 1111', '100-200-3000x'];
  for (const text of notPhones) assert.deepEqual(kinds(text), [], text);
});

test('flags personal home directories on macOS, Linux, and Windows, but not placeholders or URL paths', () => {
  const real = [
    home('/', 'Users/', 'jane', '/Documents/resume.pdf'),
    home('file:///', 'Users/', 'jane.doe', '/x'),
    home('/', 'home/', 'jane', '/job-search'),
    home('C:', '\\', 'Users', '\\', 'jane', '\\Desktop'),
    home('C:', '\\\\', 'Users', '\\\\', 'jane', '\\\\Desktop'),
    home('D:', '/', 'Users', '/', 'jane', '/Desktop'),
    home('"', '/', 'Users/', 'Jane', '"'),
  ];
  for (const text of real) assert.equal(kinds(text).length, 1, text);
  assert.equal(kinds(home('/', 'Users/', 'jane', '/x'))[0][0], 'home-path');
  const placeholders = [
    home('/', 'Users/', 'candidate', '/Library/LaunchAgents/job.plist'),
    home('/', 'Users/', 'example', '/Career Journal'),
    home('/', 'Users/', 'Shared', '/x'), home('C:', '\\', 'Users', '\\', 'Public', '\\x'),
    '/Users/<name>/', 'C:\\Users\\<name>\\', '~/job-search/resume.pdf', '/Users/', "text.includes('/Users/')",
    home('https://example.com', '/home/', 'jane'), home('https://example.com', '/Users/', 'jane'), home('/var', '/home/', 'jane'),
  ];
  for (const text of placeholders) assert.deepEqual(kinds(text), [], text);
});

test('findings carry the line number and a masked value that does not repeat the data', () => {
  const address = email('jane.doe', 'gmail.com');
  const number = phone('(212) ', '867-', '5309');
  const directory = home('/', 'Users/', 'janedoe', '/');
  const findings = findPersonalData(['first line', `mail ${address}`, `phone ${number}`, `path ${directory}`].join('\n'));
  assert.deepEqual(findings.map((item) => [item.line, item.kind]), [[2, 'email'], [3, 'phone'], [4, 'home-path']]);
  assert.deepEqual(findings.map((item) => item.masked), ['j***@gmail.com', '***09', home('/', 'Users/', 'j***')]);
  for (const item of findings) assert.equal(item.masked.includes(item.value), false);
});

test('scans tracked and unignored text files, skipping binary and ignored files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-personal-data-'));
  try {
    await promisify(execFile)('git', ['init', '--quiet'], { cwd: root });
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'clean.md'), `Write to ${email('alex', 'example.com')} or call +1 555 0100.\n`);
    await writeFile(path.join(root, 'docs', 'leak.md'), `# Notes\n\nResume at ${home('/', 'Users/', 'jane', '/resume.pdf')}\nReach me at ${email('jane', 'gmail.com')}\n`);
    await writeFile(path.join(root, 'notes'), `no extension, still text: ${phone('212-', '867-', '5309')}\n`);
    await writeFile(path.join(root, 'image.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(email('jane', 'gmail.com'))]));
    await writeFile(path.join(root, '.gitignore'), 'private/\n');
    await mkdir(path.join(root, 'private'));
    await writeFile(path.join(root, 'private', 'answers.md'), `${email('jane', 'gmail.com')}\n`);
    const findings = await personalDataFindings(root);
    assert.deepEqual(findings.map((item) => [item.file, item.line, item.kind]).sort(), [
      ['docs/leak.md', 3, 'home-path'],
      ['docs/leak.md', 4, 'email'],
      ['notes', 1, 'phone'],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the repository itself contains no personal data', async () => {
  const findings = await personalDataFindings(process.cwd());
  assert.deepEqual(findings.map((item) => `${item.file}:${item.line} ${item.kind} ${item.masked}`), []);
});
