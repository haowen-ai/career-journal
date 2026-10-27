import { parseJson } from './deliver.mjs';
export function postingLedger(db, postingIds) {
  return postingIds.map((postingId) => {
    const posting = db.prepare('SELECT * FROM postings WHERE id=?').get(postingId);
    if (!posting) throw new Error(`Unknown posting: ${postingId}`);
    const review = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(postingId);
    const evidence = parseJson(review?.evidence_json);
    const app = posting.application_id && db.prepare('SELECT * FROM applications WHERE id=?').get(posting.application_id);
    return { postingId, sightings: db.prepare('SELECT run_id,source,partition,seen_at FROM observation_sightings WHERE posting_id=? ORDER BY seen_at,run_id,partition').all(postingId),
      applicationId: app?.id ?? null, attempts: db.prepare('SELECT id,run_id,tier,state,dispatched_at,finished_at,error FROM attempts WHERE posting_id=? ORDER BY dispatched_at,rowid').all(postingId),
      quotes: evidence.evidence ?? [], question: evidence.question ?? null, visibility: !app ? 'absent' : app.status === 'withdrawn' ? 'withdrawn' : app.skip_reason ? 'hidden' : 'visible',
      terminal: { state: review?.state ?? null, decision: review?.decision ?? null, code: review?.code ?? null },
      company: posting.company, title: posting.title, url: posting.canonical_url, manual: parseJson(review?.flags_json, []).includes('manual') };
  });
}
