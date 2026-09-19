import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScheduler } from '../../src/automation/platform.mjs';

const task = { id: 'jobops-mail-sync', type: 'mail-sync', enabled: true, timezone: 'America/Chicago', schedule: '20:05' };
const runtime = { node: '/opt/node/bin/node', cli: '/Users/example/Job Ops/bin/jobops.mjs', home: '/Users/example/Job Ops' };

test('renders a launchd plist with stable label and escaped arguments', () => {
  const artifact = renderScheduler(task, runtime, 'darwin');
  assert.equal(artifact.kind, 'launchd');
  assert.match(artifact.content, /io\.job-search-ops\.mail-sync/);
  assert.match(artifact.content, /<integer>20<\/integer>/);
  assert.match(artifact.content, /<integer>5<\/integer>/);
  assert.match(artifact.content, /\/Users\/example\/Job Ops/);
});

test('renders cron and Windows scheduler definitions without shell interpolation', () => {
  const cron = renderScheduler(task, runtime, 'linux');
  assert.match(cron.content, /^CRON_TZ=America\/Chicago\n5 20 \* \* \*/);
  assert.match(cron.content, /'\/Users\/example\/Job Ops\/bin\/jobops\.mjs'/);
  const windows = renderScheduler(task, { ...runtime, node: 'C:\\Program Files\\node.exe', cli: 'C:\\Job Ops\\bin\\jobops.mjs', home: 'C:\\Job Ops' }, 'win32');
  assert.equal(windows.kind, 'schtasks');
  assert.match(windows.command.join(' '), /jobops-mail-sync/);
  assert.match(windows.command.join(' '), /20:05/);
});

