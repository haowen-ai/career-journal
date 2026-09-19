import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openHomeDatabase } from '../runtime/home.mjs';
import { runCareerOps } from '../integrations/careerops.mjs';
import { archiveArtifact } from '../domain/artifacts.mjs';

async function resolveRuleFiles(request, config, runtimeRoot, requestFile) {
  const builtIn = path.join(runtimeRoot, 'config', 'material-rules', 'us-resume-default.md');
  const requested = Array.isArray(request.ruleFiles)
    ? request.ruleFiles.map((file) => path.resolve(path.dirname(requestFile), String(file)))
    : [];
  const configured = Array.isArray(config.materials?.ruleFiles) ? config.materials.ruleFiles : [];
  const builtInFiles = request.materialKind === 'resume' ? [builtIn] : [];
  const files = [...new Set([...builtInFiles, ...configured.map((file) => path.resolve(file)), ...requested])];
  for (const file of files) {
    try { await access(file); }
    catch { throw new Error(`Material rules file is not readable: ${file}`); }
  }
  return files;
}

export async function materialCommand(parsed, io, runtime = {}) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (['prepare', 'verify'].includes(parsed.subcommand)) {
      if (!parsed.options.request) throw new Error('Usage: career-journal material prepare|verify --request <json-file>');
      const requestFile = path.resolve(parsed.options.request);
      const request = JSON.parse(await readFile(requestFile, 'utf8'));
      request.action = parsed.subcommand;
      request.ruleFiles = await resolveRuleFiles(request, context.config, runtime.root ?? process.cwd(), requestFile);
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
    throw new Error('Usage: career-journal material prepare|verify|mark-submitted');
  } finally { context.db.close(); }
}
