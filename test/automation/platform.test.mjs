import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScheduler } from '../../src/automation/platform.mjs';

const task = { id: 'career-journal-mail-sync', type: 'mail-sync', enabled: true, timezone: 'America/Chicago', schedule: '20:05' };
const runtime = { node: '/opt/node/bin/node', cli: '/Users/example/Career Journal/bin/career-journal.mjs', home: '/Users/example/Career Journal' };

test('renders a launchd plist with stable label and escaped arguments', () => {
  const artifact = renderScheduler(task, runtime, 'darwin');
  assert.equal(artifact.kind, 'launchd');
  assert.match(artifact.content, /io\.career-journal\.mail-sync/);
  assert.match(artifact.content, /<integer>20<\/integer>/);
  assert.match(artifact.content, /<integer>5<\/integer>/);
  assert.match(artifact.content, /\/Users\/example\/Career Journal/);
});

test('renders cron and Windows scheduler definitions without shell interpolation', () => {
  const cron = renderScheduler(task, runtime, 'linux');
  assert.match(cron.content, /^CRON_TZ=America\/Chicago\n5 20 \* \* \*/);
  assert.match(cron.content, /'\/Users\/example\/Career Journal\/bin\/career-journal\.mjs'/);
  const windows = renderScheduler(task, { ...runtime, node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs', home: 'C:\\Career Journal' }, 'win32');
  assert.equal(windows.kind, 'schtasks');
  assert.match(windows.command.join(' '), /career-journal-mail-sync/);
  assert.match(windows.command.join(' '), /20:05/);
});

test('regenerated legacy tasks keep their stored ID and platform registration name', () => {
  const legacyTask = { ...task, id: 'jobops-mail-sync' };
  const launchd = renderScheduler(legacyTask, runtime, 'darwin');
  assert.equal(launchd.fileName, 'io.job-search-ops.mail-sync.plist');
  assert.match(launchd.content, /<string>jobops-mail-sync<\/string>/);

  const windows = renderScheduler(legacyTask, {
    ...runtime,
    node: 'C:\\Program Files\\node.exe',
    cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
    home: 'C:\\Career Journal',
  }, 'win32');
  assert.match(windows.command.join(' '), /JobSearchOps-mail-sync/);
  assert.match(windows.command.join(' '), /jobops-mail-sync/);
});
