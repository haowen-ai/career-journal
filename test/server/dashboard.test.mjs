import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createServer } from '../../src/server/app.mjs';
import { FIT_FILTERS, ROLE_SORTS, STAT_FILTERS } from '../../web/dashboard-model.js';

test('serves the bilingual career-journal dashboard shell and rejects path traversal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-dashboard-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const context = await openHomeDatabase(home);
  const server = createServer({ db: context.db, config: context.config, artifactRoot: context.artifactRoot, webRoot: path.resolve('web') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /CAREER JOURNAL/);
    assert.match(html, /data-testid="language-toggle"/);
    assert.match(html, /data-testid="stat-applied"/);
    assert.match(html, /data-testid="stat-waiting"/);
    assert.match(html, /data-testid="stat-interview"/);
    assert.match(html, /data-testid="stat-closed"/);
    assert.match(html, /data-testid="stat-preparing"/);
    assert.match(html, /data-testid="filter-all"/);
    assert.match(html, /data-testid="search-input"/);
    assert.match(html, /data-testid="application-card"/);
    assert.match(html, /data-testid="application-details"/);
    assert.match(html, /data-testid="timeline"/);
    assert.match(html, /data-testid="materials"/);
    assert.match(html, /data-testid="tasks-section"/);
    assert.match(html, /data-testid="open-tasks"/);
    assert.match(html, /data-testid="tasks-empty"/);
    assert.match(html, /data-testid="completed-tasks"/);
    assert.match(html, /data-testid="task-row"/);
    assert.match(html, /data-testid="filter-tasks"/);
    assert.match(html, /data-testid="card-tasks"/);
    assert.match(html, /data-testid="card-task-list"/);
    assert.match(html, /data-testid="filter-queue" data-filter="queue"/);
    assert.match(html, /data-i18n="filterQueue"/);
    assert.match(html, /class="card-queue" role="group" data-testid="card-queue"/);
    assert.match(html, /data-testid="card-skip"/);
    assert.ok(html.indexOf('data-testid="filter-preparing"') < html.indexOf('data-testid="filter-queue"'));
    assert.ok(html.indexOf('data-testid="card-queue"') < html.indexOf('class="card-facts"'));
    for (const [stat, filter] of Object.entries(STAT_FILTERS)) {
      assert.match(html, new RegExp(`<button class="stat-card[^"]*" type="button" data-stat="${stat}" data-testid="stat-card-${stat}" aria-label="[^"]+">`));
      assert.match(html, new RegExp(`data-testid="filter-${filter}" data-filter="${filter}"`));
    }
    assert.doesNotMatch(html, /<article class="stat-card/);
    // The sixth card counts open assessment and interview steps. It has no list
    // filter: it scrolls to its section and focuses the heading.
    assert.equal(html.match(/<button class="stat-card/g).length, 6);
    const tasksCard = html.match(/<button class="stat-card stat-tasks" type="button" data-scroll-target="tasks-heading" data-testid="stat-card-tasks" aria-label="[^"]+">/);
    assert.ok(tasksCard, 'tasks card button');
    assert.doesNotMatch(tasksCard[0], /data-stat=/);
    assert.match(html, /<span class="semantic-dot dot-tasks" aria-hidden="true"><\/span><span data-i18n="statTasks">/);
    assert.match(html, /<strong id="stat-tasks" data-testid="stat-tasks">/);
    assert.match(html, /<span class="stat-note" id="stat-tasks-hint" data-testid="stat-tasks-hint">/);
    assert.match(html, /<h2 id="tasks-heading" tabindex="-1" data-i18n="tasksTitle">/);
    for (const [, target] of html.matchAll(/data-scroll-target="([^"]+)"/g)) assert.match(html, new RegExp(`id="${target}"`));
    assert.ok(html.indexOf('data-testid="stat-card-preparing"') < html.indexOf('data-testid="stat-card-tasks"'));
    assert.ok(html.indexOf('data-testid="stat-card-tasks"') < html.indexOf('data-testid="to-apply-section"'));
    assert.match(html, /data-i18n="filterSent"/);
    assert.ok(html.indexOf('data-testid="filter-all"') < html.indexOf('data-testid="filter-sent"'));
    assert.ok(html.indexOf('data-testid="filter-sent"') < html.indexOf('data-testid="filter-waiting"'));
    assert.match(html, /<div class="role-controls" id="role-controls" data-testid="role-controls" hidden>/);
    for (const sort of ROLE_SORTS) assert.match(html, new RegExp(`data-testid="sort-${sort}" data-sort="${sort}" type="button" aria-pressed="(?:true|false)"`));
    for (const fit of FIT_FILTERS) {
      assert.match(html, new RegExp(`data-testid="fit-${fit}" data-fit="${fit}" type="button" aria-pressed="(?:true|false)"`));
      assert.match(html, new RegExp(`data-fit-count="${fit}"`));
    }
    assert.match(html, /data-sort="deadline" type="button" aria-pressed="true"/);
    assert.match(html, /data-fit="all" type="button" aria-pressed="true"/);
    assert.ok(html.indexOf('class="filters"') < html.indexOf('data-testid="role-controls"'));
    assert.ok(html.indexOf('data-testid="role-controls"') < html.indexOf('id="applications"'));
    assert.match(html, /data-testid="to-apply-section"/);
    assert.match(html, /data-i18n="toApplyTitle"/);
    assert.match(html, /data-i18n="toApplyBody"/);
    assert.match(html, /data-testid="to-apply-summary"/);
    assert.match(html, /class="apply-group is-today" id="apply-group-today" data-testid="to-apply-today"/);
    assert.match(html, /data-testid="to-apply-week"/);
    assert.match(html, /<details class="apply-more" id="apply-group-later" data-testid="to-apply-later" hidden>/);
    assert.match(html, /<details class="apply-more" id="apply-group-none" data-testid="to-apply-none" hidden>/);
    assert.match(html, /data-testid="to-apply-empty"/);
    assert.match(html, /<template id="apply-template">/);
    assert.match(html, /data-testid="to-apply-row"/);
    assert.match(html, /class="fit-badge"[\s\S]*class="queue-check apply-check"/);
    assert.match(html, /class="task-action apply-link" data-testid="to-apply-link" target="_blank" rel="noopener noreferrer"/);
    for (const group of ['today', 'week', 'later', 'none']) assert.match(html, new RegExp(`id="apply-${group}-rows"`));
    assert.ok(html.indexOf('data-testid="to-apply-today"') < html.indexOf('data-testid="to-apply-week"'));
    assert.ok(html.indexOf('data-testid="to-apply-week"') < html.indexOf('data-testid="to-apply-later"'));
    assert.ok(html.indexOf('data-testid="to-apply-later"') < html.indexOf('data-testid="to-apply-none"'));
    assert.ok(html.indexOf('class="stats"') < html.indexOf('data-testid="to-apply-section"'));
    assert.ok(html.indexOf('data-testid="to-apply-section"') < html.indexOf('data-testid="tasks-section"'));
    assert.ok(html.indexOf('class="stats"') < html.indexOf('data-testid="tasks-section"'));
    assert.ok(html.indexOf('data-testid="tasks-section"') < html.indexOf('id="applications-heading"'));
    assert.equal((await fetch(`${baseUrl}/dashboard-model.js`)).status, 200);
    // Both copy tables carry the tasks card text, and every model helper the
    // page imports exists.
    const app = await (await fetch(`${baseUrl}/app.js`)).text();
    assert.match(app, /statTasks: 'Assessments & interviews', statTasksLabel: \(count, hint\) =>/);
    assert.match(app, /statTasks: '测评与面试准备', statTasksLabel: \(count, hint\) =>/);
    const model = await import('../../web/dashboard-model.js');
    const imported = app.match(/import \{([^}]+)\} from '\.\/dashboard-model\.js'/)[1].split(',').map((name) => name.trim()).filter(Boolean);
    assert.ok(imported.includes('taskCardSummary') && imported.includes('taskCardHint'));
    for (const name of imported) assert.ok(name in model, `dashboard-model.js exports ${name}`);
    const icon = await fetch(`${baseUrl}/icons/search.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
    assert.doesNotMatch(html, /PrivateCandidate|PrivateEmployer|private@example\.com/);
    assert.equal((await fetch(`${baseUrl}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    context.db.close();
    await rm(home, { recursive: true, force: true });
  }
});
