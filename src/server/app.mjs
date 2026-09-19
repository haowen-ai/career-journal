import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleApi, sendJson } from './routes.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

export function createServer({ db, config, webRoot }) {
  const resolvedWebRoot = path.resolve(webRoot);
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
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

