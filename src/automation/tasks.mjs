import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspaceDirectory } from '../config/store.mjs';

export const BUILT_IN_TASKS = Object.freeze({
  'mail-sync': { description: 'Read configured job-search email sources', requires: 'email' },
  'deadline-review': { description: 'Review applications in assessment, interview, or offer stages', requires: 'core' },
  'daily-consolidation': { description: 'Consolidate project-local job-search knowledge', requires: 'core' },
  'local-backup': { description: 'Create a secret-free local backup', requires: 'core' },
});

function contentCursor(type, value) {
  return `sha256:${createHash('sha256').update(JSON.stringify({ type, value })).digest('hex')}`;
}

export async function runDeadlineReview(db, task) {
  const applications = db.prepare(`SELECT id, company, role, status, stage, updated_at updatedAt
    FROM applications WHERE status IN ('assessment', 'interview', 'offer') ORDER BY updated_at DESC, id`).all();
  const cursor = contentCursor('deadline-review', applications);
  const changed = task.cursor === cursor ? 0 : 1;
  return {
    cursor,
    changed,
    message: changed
      ? applications.length
        ? `${applications.length} application(s) are in assessment, interview, or offer stages`
        : 'No applications are in assessment, interview, or offer stages'
      : 'No change in assessment, interview, or offer stages',
    applications,
  };
}

export async function runDailyConsolidation(db, task, { home, now = new Date().toISOString() }) {
  const records = db.prepare(`SELECT company, role, status, stage, applied_at appliedAt, updated_at updatedAt
    FROM applications ORDER BY updated_at DESC, company, role`).all();
  const cursor = contentCursor('daily-consolidation', records);
  const directory = path.join(workspaceDirectory(home), 'reports');
  const output = path.join(directory, 'daily-summary.md');
  if (task.cursor === cursor) {
    return { cursor, changed: 0, message: 'Daily application summary is unchanged', output };
  }
  const report = `# CAREER JOURNAL daily summary\n\nGenerated: ${now}\n\n| Company | Role | Status | Stage | Applied |\n|---|---|---|---|---|\n${records.map((item) => `| ${String(item.company).replaceAll('|', '\\|')} | ${String(item.role).replaceAll('|', '\\|')} | ${item.status} | ${String(item.stage ?? '').replaceAll('|', '\\|')} | ${item.appliedAt ?? ''} |`).join('\n')}\n`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(output, report, { mode: 0o600 });
  return { cursor, changed: 1, message: `Daily summary written to ${output}`, output };
}
