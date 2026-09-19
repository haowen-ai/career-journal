import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleApi, sendJson } from './routes.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dashboard-model.js', ['dashboard-model.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icons/arrow-up-right.svg', ['icons/arrow-up-right.svg', 'image/svg+xml']],
  ['/icons/clock.svg', ['icons/clock.svg', 'image/svg+xml']],
  ['/icons/language.svg', ['icons/language.svg', 'image/svg+xml']],
  ['/icons/minus.svg', ['icons/minus.svg', 'image/svg+xml']],
  ['/icons/plus.svg', ['icons/plus.svg', 'image/svg+xml']],
  ['/icons/search.svg', ['icons/search.svg', 'image/svg+xml']],
]);

export const FRIENDLY_DASHBOARD_HOST = 'career-journal.localhost';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', FRIENDLY_DASHBOARD_HOST]);

function requestHost(value) {
  if (!value) return null;
  try { return new URL(`http://${value}`).hostname; } catch { return null; }
}

function allowedOrigin(value) {
  if (!value) return true;
  try { return LOOPBACK_HOSTS.has(new URL(value).hostname); } catch { return false; }
}

export function createServer({ db, config, webRoot }) {
  const resolvedWebRoot = path.resolve(webRoot);
  return http.createServer(async (request, response) => {
    try {
      if (!LOOPBACK_HOSTS.has(requestHost(request.headers.host)) || !allowedOrigin(request.headers.origin)) {
        sendJson(response, 403, { error: 'Loopback Host and Origin required' });
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
          && !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(response, 415, { error: 'Mutating API requests require application/json' });
          return;
        }
        if (!await handleApi(request, response, url, { db, config })) sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const asset = assets.get(url.pathname);
      if (!asset || request.method !== 'GET') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found\n');
        return;
      }
      const body = await readFile(path.join(resolvedWebRoot, asset[0]));
      response.writeHead(200, { 'content-type': asset[1], 'content-length': body.length, 'x-content-type-options': 'nosniff' });
      response.end(body);
    } catch (error) {
      const status = Number(error.status) || 400;
      sendJson(response, status, { error: error.message });
    }
  });
}
