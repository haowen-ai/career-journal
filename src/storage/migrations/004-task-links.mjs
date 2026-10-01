export const migration004 = {
  version: 4,
  name: 'task-links',
  sql: `
    ALTER TABLE application_tasks ADD COLUMN link TEXT;
  `,
};
