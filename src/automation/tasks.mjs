export const BUILT_IN_TASKS = Object.freeze({
  'mail-sync': { description: 'Read configured job-search email sources', requires: 'email' },
  'deadline-review': { description: 'Review upcoming application and interview deadlines', requires: 'core' },
  'daily-consolidation': { description: 'Consolidate project-local job-search knowledge', requires: 'core' },
  'local-backup': { description: 'Create a secret-free local backup', requires: 'core' },
});

