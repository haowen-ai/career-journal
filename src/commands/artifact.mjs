import { openHomeDatabase } from '../runtime/home.mjs';
import { archiveArtifact } from '../domain/artifacts.mjs';

export async function artifactCommand(parsed, io) {
  if (parsed.subcommand !== 'add') throw new Error('Usage: jobops artifact add');
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    const record = await archiveArtifact(context.db, {
      applicationId: parsed.options.id,
      kind: parsed.options.kind ?? 'resume',
      lifecycle: parsed.options.lifecycle ?? 'draft',
      submittedConfirmed: parsed.options.submitted === true,
      submittedAt: parsed.options['submitted-at'] ?? null,
      filePath: parsed.options.file,
      storageRoot: context.artifactRoot,
      verification: parsed.options.verification ?? 'pending',
    });
    io.out(JSON.stringify(record));
    return 0;
  } finally { context.db.close(); }
}

