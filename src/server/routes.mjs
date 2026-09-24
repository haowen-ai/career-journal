import { createApplication, listApplications } from '../commands/application.mjs';
import { recordEvent } from '../domain/events.mjs';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const MAX_BODY = 1_000_000;
const execFileAsync = promisify(execFile);

const artifactContentTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

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

const safeSourceKinds = new Set(['api', 'cli', 'email', 'import', 'manual', 'system']);

function dashboardApplication(db, id) {
  const detail = applicationDetail(db, id);
  if (!detail) return null;
  return {
    ...detail,
    events: detail.events.map(({ source, ...event }) => {
      const rawCandidate = String(source?.kind ?? source?.provider ?? '').toLowerCase();
      const candidate = rawCandidate === 'user' ? 'manual' : rawCandidate;
      return { ...event, sourceKind: safeSourceKinds.has(candidate) ? candidate : 'other' };
    }),
  };
}

function latestApplicationTime(application) {
  const eventTime = application.events.reduce((latest, event) => {
    const value = Date.parse(event.recordedAt ?? event.observedAt ?? event.occurredAt ?? 0) || 0;
    return Math.max(latest, value);
  }, 0);
  const artifactTime = application.artifacts.reduce((latest, artifact) => {
    const recorded = Date.parse(artifact.recordedAt ?? 0) || 0;
    const submitted = Date.parse(artifact.submittedAt ?? 0) || 0;
    return Math.max(latest, recorded, submitted);
  }, 0);
  return Math.max(eventTime, artifactTime, Date.parse(application.updatedAt ?? 0) || 0);
}

async function resolveArtifactFile(artifact, artifactRoot) {
  if (!artifactRoot) {
    const error = new Error('Artifact file is unavailable');
    error.status = 404;
    throw error;
  }
  const [resolvedRoot, resolvedFile] = await Promise.all([
    realpath(path.resolve(artifactRoot)),
    realpath(path.resolve(artifact.storagePath)),
  ]);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    const error = new Error('Artifact file is unavailable');
    error.status = 404;
    throw error;
  }
  const fileStat = await stat(resolvedFile);
  if (!fileStat.isFile()) {
    const error = new Error('Artifact file is unavailable');
    error.status = 404;
    throw error;
  }
  return { resolvedFile, fileStat, fileName: String(artifact.fileName ?? 'artifact').replace(/[\r\n"]/g, '_') };
}

export async function revealInFileManager(filePath, { platform = process.platform, run = execFileAsync } = {}) {
  if (platform === 'darwin') await run('open', ['-R', filePath]);
  else if (platform === 'win32') await run('explorer.exe', ['/select,', filePath]);
  else await run('xdg-open', [path.dirname(filePath)]);
}

async function sendArtifact(response, artifact, artifactRoot) {
  try {
    const { resolvedFile, fileStat, fileName } = await resolveArtifactFile(artifact, artifactRoot);
    response.writeHead(200, {
      'content-type': artifactContentTypes.get(path.extname(fileName).toLowerCase()) ?? 'application/octet-stream',
      'content-length': fileStat.size,
      'content-disposition': `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(resolvedFile).pipe(response);
  } catch {
    sendJson(response, 404, { error: 'Artifact file is unavailable' });
  }
}

export async function handleApi(request, response, url, { db, config, artifactRoot, revealFile = revealInFileManager }) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, schemaVersion: config.schemaVersion });
    return true;
  }
  if (url.pathname === '/api/applications' && request.method === 'GET') {
    sendJson(response, 200, listApplications(db));
    return true;
  }
  if (url.pathname === '/api/dashboard' && request.method === 'GET') {
    const applications = listApplications(db)
      .map((application) => dashboardApplication(db, application.id))
      .sort((left, right) => latestApplicationTime(right) - latestApplicationTime(left)
        || left.company.localeCompare(right.company)
        || left.role.localeCompare(right.role));
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      timezone: config.timezone,
      applications,
    });
    return true;
  }
  const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/file$/);
  if (artifactMatch && request.method === 'GET') {
    const artifact = db.prepare('SELECT file_name fileName, storage_path storagePath FROM artifacts WHERE id = ?')
      .get(decodeURIComponent(artifactMatch[1]));
    if (!artifact) sendJson(response, 404, { error: 'Artifact not found' });
    else await sendArtifact(response, artifact, artifactRoot);
    return true;
  }
  const revealMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/reveal$/);
  if (revealMatch && request.method === 'POST') {
    const artifact = db.prepare('SELECT file_name fileName, storage_path storagePath FROM artifacts WHERE id = ?')
      .get(decodeURIComponent(revealMatch[1]));
    if (!artifact) sendJson(response, 404, { error: 'Artifact not found' });
    else {
      const { resolvedFile } = await resolveArtifactFile(artifact, artifactRoot);
      await revealFile(resolvedFile);
      sendJson(response, 200, { ok: true });
    }
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
