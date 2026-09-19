import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const safeName = (name) => name.normalize('NFKC').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'artifact';

export async function archiveArtifact(db, input) {
  if (!['draft', 'submitted'].includes(input.lifecycle)) throw new Error('Artifact lifecycle must be draft or submitted');
  if (input.lifecycle === 'submitted' && input.submittedConfirmed !== true) throw new Error('Submitted artifact requires explicit confirmation');
  const application = db.prepare('SELECT id FROM applications WHERE id = ?').get(input.applicationId);
  if (!application) throw new Error(`Unknown application: ${input.applicationId}`);
  const bytes = await readFile(input.filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = db.prepare(`SELECT id, application_id applicationId, kind, lifecycle, file_name fileName,
    storage_path storagePath, sha256, submitted_at submittedAt, recorded_at recordedAt, verification
    FROM artifacts WHERE application_id = ? AND kind = ? AND lifecycle = ? AND sha256 = ?`)
    .get(input.applicationId, input.kind, input.lifecycle, sha256);
  if (existing) return existing;
  const fileName = safeName(path.basename(input.filePath));
  const directory = path.join(path.resolve(input.storageRoot), input.applicationId, input.kind, input.lifecycle);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storagePath = path.join(directory, `${sha256}-${fileName}`);
  await copyFile(input.filePath, storagePath);
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const submittedAt = input.lifecycle === 'submitted' ? (input.submittedAt ?? null) : null;
  const id = createHash('sha256').update(`${input.applicationId}\0${input.kind}\0${input.lifecycle}\0${sha256}`).digest('hex').slice(0, 32);
  db.prepare(`INSERT INTO artifacts
    (id, application_id, kind, lifecycle, file_name, storage_path, sha256, submitted_at, recorded_at, verification, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.applicationId, input.kind, input.lifecycle, fileName, storagePath, sha256, submittedAt, recordedAt, input.verification ?? 'pending', JSON.stringify(input.metadata ?? {}));
  return { id, applicationId: input.applicationId, kind: input.kind, lifecycle: input.lifecycle, fileName, storagePath, sha256, submittedAt, recordedAt, verification: input.verification ?? 'pending' };
}

