import { createApplication, listApplications } from '../commands/application.mjs';
import { recordEvent } from '../domain/events.mjs';

const MAX_BODY = 1_000_000;

export function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function applicationDetail(db, id) {
  const application = db.prepare(`SELECT id, company, role, external_id externalId, job_url jobUrl, status,
    stage, applied_at appliedAt, created_at createdAt, updated_at updatedAt FROM applications WHERE id = ?`).get(id);
  if (!application) return null;
  const events = db.prepare(`SELECT id, event_type type, occurred_at occurredAt, observed_at observedAt,
    recorded_at recordedAt, title, note, source_json source, status_after statusAfter
    FROM application_events WHERE application_id = ? ORDER BY recorded_at DESC, id`).all(id)
    .map((event) => ({ ...event, source: JSON.parse(event.source) }));
  const artifacts = db.prepare(`SELECT id, kind, lifecycle, file_name fileName, sha256, submitted_at submittedAt,
    recorded_at recordedAt, verification FROM artifacts WHERE application_id = ? ORDER BY recorded_at DESC, id`).all(id);
  return { ...application, events, artifacts };
}

export async function handleApi(request, response, url, { db, config }) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, schemaVersion: config.schemaVersion });
    return true;
  }
  if (url.pathname === '/api/applications' && request.method === 'GET') {
    sendJson(response, 200, listApplications(db));
    return true;
  }
  if (url.pathname === '/api/applications' && request.method === 'POST') {
    sendJson(response, 201, createApplication(db, await readJson(request)));
    return true;
  }
  const eventMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/events$/);
  if (eventMatch && request.method === 'POST') {
    const input = await readJson(request);
    sendJson(response, 200, recordEvent(db, { ...input, applicationId: decodeURIComponent(eventMatch[1]) }));
    return true;
  }
  const detailMatch = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (detailMatch && request.method === 'GET') {
    const detail = applicationDetail(db, decodeURIComponent(detailMatch[1]));
    if (!detail) sendJson(response, 404, { error: 'Application not found' });
    else sendJson(response, 200, detail);
    return true;
  }
  return false;
}

