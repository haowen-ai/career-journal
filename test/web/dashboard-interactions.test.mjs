import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../../web/dashboard-model.js';
import { createDashboardLoader } from '../../web/dashboard-loader.js';

// Run the actual app entry point with a small DOM/event adapter. No copied
// event handlers: requests, debounce, retries, language and task refreshes all
// originate in app.js. Layout/browser rendering is outside this test's scope.
async function appHarness() {
  const nodes = new Map(), requests = [], timers = new Map(), saved = new Map();
  let timerId = 0;
  class Element {
    constructor(dataset = {}) { this.dataset = dataset; this.handlers = {}; this.value = ''; this.hidden = false; this.disabled = false; this.children = []; this.attributes = {}; this.textContent = ''; this.classList = { toggle() {} }; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    click() { return this.handlers.click?.(); }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelector(selector) { return node(`nested:${selector}`); }
    querySelectorAll() { return []; }
    replaceChildren(...children) { this.children = children; }
    scrollIntoView() { this.scrolled = true; }
    focus() {}
  }
  function node(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); }
  const filters = ['all', 'sent', 'waiting', 'interview', 'closed', 'preparing', 'queue', 'skipped', 'tasks'].map((filter) => new Element({ filter }));
  const sorts = model.ROLE_SORTS.map((sort) => new Element({ sort }));
  const fits = model.FIT_FILTERS.map((fit) => new Element({ fit }));
  const stats = Object.keys(model.STAT_FILTERS).map((stat) => new Element({ stat }));
  const document = {
    documentElement: {}, activeElement: null,
    querySelector(selector) {
      const filter = selector.match(/^\[data-filter="([^"]+)"\]$/);
      return filter ? filters.find((item) => item.dataset.filter === filter[1]) : node(selector);
    },
    querySelectorAll(selector) {
      return { '[data-filter]': filters, '[data-sort]': sorts, '[data-fit]': fits, '[data-stat]': stats }[selector] ?? [];
    },
  };
  const window = { setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), matchMedia: () => ({ matches: false }) };
  const fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  const source = (await readFile(new URL('../../web/app.js', import.meta.url), 'utf8'))
    .replace(/import \{ createDashboardLoader \}[^\n]+\n/, '')
    .replace(/import \{([^}]+)\} from '\.\/dashboard-model\.js';/, 'const {$1} = model;');
  vm.runInNewContext(`${source}\nwindow.inspect = () => state; window.updateTask = updateTaskStatus; window.render = render; window.renderMaterials = renderMaterials;`, {
    window, document, fetch, model, createDashboardLoader, navigator: { language: 'en' },
    localStorage: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    URLSearchParams, Intl, Date, console,
  });
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  function summary() { return { timezone: 'UTC', total: 101, stats: model.applicationStats([]), groups: { all: 101 },
    taskCardSummary: model.taskCardSummary([]), taskQueue: { open: [], done: [] }, toApplyQueue: model.toApplyQueue([]) }; }
  async function finish(start, { page = 1, total = 101 } = {}) {
    requests[start].resolve({ ok: true, json: async () => summary() });
    requests[start + 1].resolve({ ok: true, json: async () => ({ applications: [], page, pageSize: 50, total, fitCounts: model.fitCounts([]) }) });
    await settle();
  }
  function query(index) { return new URL(requests[index].url, 'http://localhost').searchParams; }
  return { nodes, requests, timers, saved, Element, node, filters, sorts, fits, stats, document, window, settle, finish, query };
}

test('dashboard app requests summary plus one page, shares all filter entrances, debounces, refreshes off-page tasks and recovers', async () => {
  const { requests, timers, saved, Element, node, sorts, fits, stats, window, settle, finish, query } = await appHarness();
  assert.deepEqual(requests.map((item) => item.url.split('?')[0]), ['/api/dashboard/summary', '/api/dashboard/page']);
  assert.equal(query(1).get('page'), '1');
  await finish(0);
  assert.equal(node('#previous-page').disabled, true);
  assert.equal(node('#next-page').disabled, false);
  node('#next-page').click();
  assert.equal(query(3).get('page'), '2');
  assert.equal(node('#next-page').disabled, true);
  await finish(2, { page: 2 });
  stats.find((item) => item.dataset.stat === 'preparing').click();
  assert.equal(query(5).get('group'), 'preparing');
  assert.equal(query(5).get('page'), '1');
  assert.equal(node('.applications-section').scrolled, true);
  sorts.find((item) => item.dataset.sort === 'fit').click();
  fits.find((item) => item.dataset.fit === 'high').click();
  assert.equal(query(9).get('sort'), 'fit');
  assert.equal(query(9).get('fit'), 'high');
  assert.equal(saved.get('career-journal-role-fit'), 'high');
  await finish(8);
  await finish(6, { page: 3 }); await finish(4, { page: 3 });
  assert.equal(window.inspect().page, 1, 'old sort/filter responses cannot overwrite new data');
  node('#search').value = 'first'; node('#search').handlers.input();
  node('#search').value = '%_'; node('#search').handlers.input();
  assert.equal(requests.length, 10);
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0]; assert.equal(timer.delay, 300); timer.callback();
  assert.equal(query(11).get('query'), '%_');
  await finish(10, { page: 3 });
  // A summary task can belong to an application absent from this empty page.
  const update = window.updateTask({ id: 'outside-page', applicationId: 'other' }, 'done', new Element());
  assert.equal(requests[12].options.method, 'POST');
  requests[12].resolve({ ok: true }); await settle();
  assert.equal(query(14).get('page'), '3');
  await finish(13, { page: 2, total: 51 }); await update;
  assert.equal(window.inspect().page, 2, 'server clamping updates current page');
  assert.equal(node('#next-page').disabled, true);
  node('#language-toggle').click();
  assert.equal(window.inspect().locale, 'zh-CN');
  assert.equal(requests.length, 15, 'language change renders current page locally');
  assert.equal(node('#page-label').textContent, '第 2 / 2 页，共 51 条');
  node('#previous-page').click();
  requests[15].reject(new Error('network unavailable')); requests[16].resolve({ ok: true, json: async () => ({}) }); await settle();
  assert.equal(node('#error').hidden, false);
  assert.equal(node('#next-page').disabled, true);
  node('#retry').click(); await finish(17, { page: 1, total: 0 });
  assert.equal(node('#error').hidden, true);
  assert.equal(node('#empty').hidden, false);
  assert.equal(node('#previous-page').disabled, true);
  assert.equal(node('#next-page').disabled, true);
});


test('task completion during search debounce requests the new query on page one', async () => {
  const { requests, timers, Element, node, window, settle, finish, query } = await appHarness();
  await finish(0, { page: 3 });
  const update = window.updateTask({ id: 'off-page' }, 'done', new Element());
  node('#search').value = 'new keyword';
  node('#search').handlers.input();
  assert.equal(timers.size, 1);
  requests[2].resolve({ ok: true });
  await settle();
  assert.equal(query(4).get('query'), 'new keyword');
  assert.equal(query(4).get('page'), '1');
  await finish(3);
  await update;
});

test('dashboard refresh restores the same material control in the detail card instead of the to-apply row', async () => {
  const { Element, node, document, window, finish } = await appHarness();
  await finish(0);
  // Render real material controls; the adapter supplies row regions and remounts.
  document.createElement = (tag) => { const element = new Element(); element.tagName = tag.toUpperCase(); element.append = (...items) => element.children.push(...items); return element; };
  function row(region) {
    const element = new Element({ applicationId: 'same-application' });
    element.classList = { 0: region, contains: (name) => name === region, toggle() {} };
    element.matches = (selector) => selector.split(',').some((item) => item.trim() === `.${region}`);
    const materials = new Element(); materials.append = (...items) => materials.children.push(...items);
    window.renderMaterials(materials, { artifacts: ['first', 'second'].map((id) => ({ id, kind: 'resume', lifecycle: 'draft', fileName: `${id}.txt`, recordedAt: '2026-11-01' })) });
    const controls = materials.children.flatMap((card) => card.children.at(-1).children);
    for (const control of controls) {
      control.classList = { 0: control.className };
      control.closest = (selector) => selector.includes('data-artifact-id') ? materials.children.find((card) => card.children.at(-1).children.includes(control)) : element;
      control.focus = () => { document.activeElement = control; };
    }
    element.querySelector = (selector) => controls.find((control) => selector === `${control.tagName.toLowerCase()}.${control.className}`);
    element.querySelectorAll = (selector) => controls.filter((control) => selector === `${control.tagName.toLowerCase()}.${control.className}`);
    return { element, controls };
  }
  const original = row('application-card');
  const refreshed = row('application-card');
  const apply = row('apply-row'); apply.element.querySelector = () => null; apply.element.querySelectorAll = () => [];
  const baseQuery = document.querySelectorAll;
  document.querySelectorAll = (selector) => selector.includes('[data-application-id]') ? [apply.element, refreshed.element] : baseQuery(selector);
  for (const index of [2, 3]) {
    document.activeElement = original.controls[index];
    window.render();
    assert.equal(document.activeElement, refreshed.controls[index], `second material ${index === 2 ? 'open link' : 'reveal button'} regains focus`);
  }
});
