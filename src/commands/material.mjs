import { readFile } from 'node:fs/promises';
import { openHomeDatabase } from '../runtime/home.mjs';
import { runCareerOps } from '../integrations/careerops.mjs';
import { archiveArtifact } from '../domain/artifacts.mjs';

export async function materialCommand(parsed, io) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (['prepare', 'verify'].includes(parsed.subcommand)) {
      if (!parsed.options.request) throw new Error('Usage: jobops material prepare|verify --request <json-file>');
      const request = JSON.parse(await readFile(parsed.options.request, 'utf8'));
      request.action = parsed.subcommand;
      const configured = context.config.careerOps ?? {};
      const result = await runCareerOps(request, {
        root: parsed.options['careerops-root'] ?? configured.root ?? process.env.CAREER_OPS_ROOT,
        pinnedVersion: configured.pinnedVersion ?? '1.32.0',
        entrypoint: configured.entrypoint,
      });
      const artifact = await archiveArtifact(context.db, {
        applicationId: request.applicationId,
        kind: request.materialKind,
        lifecycle: 'draft',
        submittedConfirmed: false,
        filePath: result.outputPath,
        storageRoot: context.artifactRoot,
        verification: result.verification,
        metadata: { source: 'careerops', action: parsed.subcommand, verificationEvidence: result.verificationEvidence ?? null },
      });
      context.db.prepare('UPDATE artifacts SET verification = ?, metadata_json = ? WHERE id = ?')
        .run(result.verification, JSON.stringify({ source: 'careerops', action: parsed.subcommand, verificationEvidence: result.verificationEvidence ?? null }), artifact.id);
      io.out(JSON.stringify({ ...result, artifact: { ...artifact, verification: result.verification } }, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'mark-submitted') {
      if (parsed.options.confirm !== true) throw new Error('mark-submitted requires --confirm and the exact uploaded file');
      const record = await archiveArtifact(context.db, {
        applicationId: parsed.options.id,
        kind: parsed.options.kind ?? 'resume',
        lifecycle: 'submitted',
        submittedConfirmed: true,
        submittedAt: parsed.options['submitted-at'] ?? null,
        filePath: parsed.options.file,
        storageRoot: context.artifactRoot,
        verification: parsed.options.verification ?? 'pending',
        metadata: { source: 'material mark-submitted' },
      });
      io.out(JSON.stringify(record, null, 2));
      return 0;
    }
    throw new Error('Usage: jobops material prepare|verify|mark-submitted');
  } finally { context.db.close(); }
}
