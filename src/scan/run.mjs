import { createHash } from 'node:crypto';
import { createApplication } from '../commands/application.mjs';
import { recordEvent } from '../domain/events.mjs';
import { dedupeRoles } from './dedupe.mjs';
import { filterRole } from './filter.mjs';
import { scoreFit } from './fit.mjs';
import { fetchAtsBoards } from './sources/ats-boards.mjs';
import { fetchCareerOpsRoles } from './sources/careerops.mjs';
import { fetchSimplify } from './sources/simplify.mjs';

const FIT_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

function rankOrLast(value) {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

// Fetches every configured source. Order matters for duplicates: official ATS
// boards first, then CareerOps, then the opt-in Simplify list.
export async function collectRoles(profile, { fetchImpl, careerOpsConfig, careerOpsDependencies, timeoutMs } = {}) {
  const options = timeoutMs ? { timeoutMs } : {};
  const parts = [
    await fetchAtsBoards(profile.sources.atsBoards, fetchImpl, options),
    await fetchCareerOpsRoles(profile.sources.careerOps, careerOpsConfig, careerOpsDependencies),
    await fetchSimplify(profile.sources.simplify, fetchImpl, options),
  ];
  return { sources: parts.flatMap((part) => part.sources), roles: parts.flatMap((part) => part.roles) };
}

export function existingApplications(db) {
  return db.prepare(`SELECT id, company, role, job_url jobUrl, source, source_id sourceId, external_id externalId, status
    FROM applications ORDER BY created_at, id`).all();
}

function summarizeRole(role) {
  return { source: role.source, sourceId: role.sourceId, company: role.company, title: role.title, url: role.url };
}

function insertLead(db, item, now) {
  const { role, filter, fit, possibleDuplicate } = item;
  const sourceKey = `${role.source}:${role.sourceId}`;
  const note = [fit.note, possibleDuplicate ? `Possible duplicate of ${possibleDuplicate.of.id ?? `"${possibleDuplicate.of.title}"`} (title similarity ${possibleDuplicate.similarity}); check before applying` : null]
    .filter(Boolean).join('. ');
  db.exec('BEGIN IMMEDIATE');
  try {
    const application = createApplication(db, {
      company: role.company,
      role: role.title,
      externalId: sourceKey,
      jobUrl: role.url,
      status: 'lead',
    }, now);
    if (application.source) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare(`UPDATE applications SET source = ?, source_id = ?, location = ?, posted_at = ?, deadline_at = ?,
      fit = ?, fit_confidence = ?, fit_note = ?, updated_at = ? WHERE id = ?`)
      .run(role.source, role.sourceId, role.locations.length ? role.locations.join('; ') : null, role.postedAt ?? null,
        role.deadlineAt ?? null, fit.fit, fit.confidence, note, now, application.id);
    const traceId = `fit-${shortHash(sourceKey)}`;
    db.prepare(`INSERT OR IGNORE INTO decision_traces
      (id, application_id, engine, mode, decision_json, confidence, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(traceId, application.id, fit.engine, 'role-fit', JSON.stringify({
        fit: fit.fit,
        confidence: fit.confidence,
        ruleBased: fit.ruleBased,
        note: fit.note,
        jevAttempted: fit.jevAttempted ?? false,
        jevOutcome: fit.jevOutcome ?? 'not-enabled',
        ...(fit.shadow ? { shadow: fit.shadow } : {}),
      }), fit.confidence, fit.applied ? 1 : 0, now);
    recordEvent(db, {
      id: `scan-${shortHash(sourceKey)}`,
      applicationId: application.id,
      type: 'role_found',
      occurredAt: role.postedAt ?? null,
      observedAt: now,
      recordedAt: now,
      title: 'Found by role scan',
      note: possibleDuplicate ? possibleDuplicate.reason : '',
      source: {
        kind: 'role-scan',
        source: role.source,
        sourceId: role.sourceId,
        url: role.url,
        locRank: filter.locRank ?? null,
        ...(possibleDuplicate?.of?.id ? { possibleDuplicateOf: possibleDuplicate.of.id } : {}),
      },
    }, { withinTransaction: true });
    db.exec('COMMIT');
    return application.id;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// Fetch → filter → dedupe → score fit → queue as leads. With dryRun nothing is
// written and no Jev or model call is made; fit comes from the local rule.
export async function runScan({
  db,
  profile,
  fetchImpl = globalThis.fetch,
  adapters = {},
  careerOpsConfig = {},
  careerOpsDependencies = {},
  dryRun = false,
  now = new Date().toISOString(),
  timeoutMs,
}) {
  const { sources, roles } = await collectRoles(profile, { fetchImpl, careerOpsConfig, careerOpsDependencies, timeoutMs });
  const evaluated = roles.map((role) => ({ role, filter: filterRole(role, profile) }));
  const dropped = evaluated.filter((item) => !item.filter.keep)
    .map((item) => ({ ...summarizeRole(item.role), reasons: item.filter.reasons }));
  // Best-ranked location first, so a near-identical posting keeps its best office.
  const kept = evaluated.filter((item) => item.filter.keep)
    .map((item, index) => ({ ...item, index }))
    .sort((left, right) => rankOrLast(left.filter.locRank) - rankOrLast(right.filter.locRank) || left.index - right.index);
  const deduped = dedupeRoles(kept.map((item) => item.role), existingApplications(db));
  const duplicates = [];
  const candidates = [];
  deduped.forEach((result, index) => {
    if (result.status === 'duplicate') {
      duplicates.push({ ...summarizeRole(result.role), reason: result.reason, duplicateOf: result.of?.id ?? null });
    } else {
      candidates.push({ ...kept[index], possibleDuplicate: result.status === 'possible-duplicate' ? result : null });
    }
  });
  const queued = [];
  for (const candidate of candidates) {
    const fit = await scoreFit(candidate.role, profile, adapters, { rulesOnly: dryRun });
    const item = { ...candidate, fit };
    const id = dryRun ? null : insertLead(db, item, now);
    if (!dryRun && !id) continue;
    queued.push({
      id,
      ...summarizeRole(candidate.role),
      location: candidate.role.locations.join('; ') || null,
      locRank: candidate.filter.locRank ?? null,
      postedAt: candidate.role.postedAt ?? null,
      fit: fit.fit,
      fitConfidence: fit.confidence,
      fitEngine: fit.engine,
      fitNote: fit.note,
      possibleDuplicateOf: candidate.possibleDuplicate ? candidate.possibleDuplicate.of.id ?? candidate.possibleDuplicate.of.title : null,
    });
  }
  queued.sort((left, right) => (FIT_ORDER[left.fit] ?? 3) - (FIT_ORDER[right.fit] ?? 3)
    || rankOrLast(left.locRank) - rankOrLast(right.locRank)
    || String(right.postedAt ?? '').localeCompare(String(left.postedAt ?? '')));
  const dropReasons = {};
  for (const item of dropped) {
    for (const reason of item.reasons) {
      const code = reason.slice(0, reason.indexOf(':'));
      dropReasons[code] = (dropReasons[code] ?? 0) + 1;
    }
  }
  return {
    dryRun,
    scannedAt: now,
    sources,
    counts: {
      fetched: roles.length,
      dropped: dropped.length,
      duplicates: duplicates.length,
      queued: queued.length,
      possibleDuplicates: queued.filter((item) => item.possibleDuplicateOf).length,
    },
    dropReasons,
    queued,
    dropped,
    duplicates,
  };
}
