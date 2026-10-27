import { COLD_START } from './contract.mjs';
import { fetchAtsBoard } from '../scan/sources/ats-boards.mjs';
import { simplifyUrls } from '../scan/sources/simplify.mjs';
import { redact } from '../runtime/redact.mjs';

const keyOf = (item) => `${item.source}\0${item.partition}`;
const attempted = (status) => ['ok', 'empty', 'partial', 'error'].includes(status);
export function buildExpectedManifest(profile, { careerOpsPartitions = [] } = {}) {
  const manifest = [];
  const expected = profile.sources?.expected ?? [];
  if (expected.includes('atsBoards')) for (const entry of profile.sources.atsBoards ?? []) manifest.push({ source: entry.ats, partition: `${entry.ats}:${entry.board}` });
  if (expected.includes('careerops')) for (const partition of careerOpsPartitions.length ? careerOpsPartitions : ['all']) manifest.push({ source: 'careerops', partition });
  if (expected.includes('simplify')) {
    const urls = simplifyUrls(profile.sources.simplify);
    for (const [index] of urls.entries()) manifest.push({ source: 'simplify', partition: `simplify:${index + 1}` });
    if (!urls.length) manifest.push({ source: 'simplify', partition: 'all' });
  }
  return [...new Map(manifest.map((item) => [keyOf(item), item])).values()];
}

export function assessSourceHealth(db, { runId, now, manifest, reported, baselineDays = 7 }) {
  const expected = new Map(manifest.map((item) => [keyOf(item), item]));
  const sources = new Map(reported.map((item) => [keyOf(item), item]));
  const previous = db.prepare('SELECT * FROM expected_partitions').all();
  for (const item of manifest) db.prepare(`INSERT INTO expected_partitions (source,partition,first_expected,last_expected,retired_at)
    VALUES (?,?,?,?,NULL) ON CONFLICT(source,partition) DO UPDATE SET last_expected=excluded.last_expected,retired_at=NULL`)
    .run(item.source, item.partition, now, now);
  for (const old of previous) if (!expected.has(keyOf(old)) && !old.retired_at) {
    db.prepare('UPDATE expected_partitions SET retired_at=? WHERE source=? AND partition=?').run(now, old.source, old.partition);
    sources.set(keyOf(old), { source: old.source, partition: old.partition, status: 'retired', count: 0, rawCount: 0, alert: 'removed_from_config' });
  }
  for (const item of manifest) if (!sources.has(keyOf(item))) sources.set(keyOf(item), { ...item, status: 'stale', count: 0, rawCount: 0 });
  const results = [];
  for (const item of sources.values()) {
    const isExpected = expected.has(keyOf(item));
    const history = db.prepare(`SELECT rs.*,r.started_at FROM run_sources rs JOIN runs r ON r.run_id=rs.run_id
      WHERE rs.source=? AND rs.partition=? AND rs.run_id<>? ORDER BY r.started_at DESC`).all(item.source, item.partition, runId);
    const registry = db.prepare('SELECT first_expected FROM expected_partitions WHERE source=? AND partition=?').get(item.source, item.partition);
    const attempts = history.filter((row) => attempted(row.status)).length + Number(attempted(item.status));
    const coldStart = isExpected && attempts < COLD_START.censuses && Date.parse(now) - Date.parse(registry.first_expected) < COLD_START.days * 86_400_000;
    const counts = history.filter((row) => ['ok', 'empty'].includes(row.status) && Date.parse(row.started_at) >= Date.parse(now) - baselineDays * 86_400_000).map((row) => row.count).sort((a, b) => a - b);
    const baseline = counts.length ? Math.round((counts[Math.floor((counts.length - 1) / 2)] + counts[Math.ceil((counts.length - 1) / 2)]) / 2) : null;
    let status = item.status;
    let alert = item.alert ?? null;
    const count = item.count ?? 0;
    if (item.truncated || item.capDetected) { status = 'partial'; alert = 'cap'; }
    else if (status === 'error') alert = 'error';
    else if (status === 'partial') alert = 'partial';
    else if (['disabled', 'skipped'].includes(status)) { if (isExpected) { status = 'disabled'; alert = 'disabled'; } }
    else if (status === 'stale') alert = history.some((row) => ['ok', 'empty'].includes(row.status)) ? 'missing' : 'never_reported';
    else if (['ok', 'empty'].includes(status)) {
      status = count === 0 ? 'empty' : 'ok';
      if (count === 0 && !coldStart && isExpected) alert = 'zero';
      else if (baseline != null && count < 0.5 * baseline) alert = 'drop';
      const sample = db.prepare('SELECT status FROM source_samples WHERE partition=? AND sampled_at<=? ORDER BY sampled_at DESC LIMIT 1').get(item.partition, now);
      if (sample?.status === 'sample_mismatch') alert = 'sample_mismatch';
    }
    const result = { ...item, status, count, rawCount: item.rawCount ?? count, baseline, alert, coldStart };
    if (result.detail) result.detail = redact(result.detail);
    db.prepare(`INSERT INTO run_sources (run_id,source,partition,status,count,errors,truncated,expected,detail,baseline,alert,raw_count,quarantined)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,source,partition) DO UPDATE SET status=excluded.status,count=excluded.count,
      errors=excluded.errors,truncated=excluded.truncated,expected=excluded.expected,detail=excluded.detail,baseline=excluded.baseline,
      alert=excluded.alert,raw_count=excluded.raw_count,quarantined=excluded.quarantined`)
      .run(runId, item.source, item.partition, status, count, Number(status === 'error'), Number(Boolean(item.truncated || item.capDetected)), Number(isExpected), result.detail ?? '', baseline, alert, result.rawCount, item.quarantined ?? 0);
    results.push(result);
  }
  return results;
}

export async function sampleOfficialBoards(db, { now, partitions, fetchImpl, sampleSize = 5, everyDays = 7 }) {
  const samples = [];
  for (const entry of partitions) {
    if (samples.length >= sampleSize) break;
    const ats = entry.ats ?? entry.partition.split(':')[0];
    if (!['greenhouse', 'lever', 'ashby'].includes(ats)) continue;
    const last = db.prepare('SELECT sampled_at FROM source_samples WHERE partition=? ORDER BY sampled_at DESC LIMIT 1').get(entry.partition);
    if (last && Date.parse(now) - Date.parse(last.sampled_at) < everyDays * 86_400_000) continue;
    const census = db.prepare(`SELECT rs.count FROM run_sources rs JOIN runs r ON rs.run_id=r.run_id
      WHERE rs.partition=? AND rs.status IN ('ok','empty','partial') AND r.started_at<=? ORDER BY r.started_at DESC LIMIT 1`).get(entry.partition, now);
    let boardCount = null;
    let status = 'error';
    try {
      const result = await fetchAtsBoard({ ats, board: entry.board ?? entry.partition.slice(entry.partition.indexOf(':') + 1) }, fetchImpl);
      boardCount = result.roles.length;
      status = census && census.count < boardCount * 0.9 ? 'sample_mismatch' : 'ok';
    } catch { /* Failed samples are recorded, never counted as empty boards. */ }
    const result = { partition: entry.partition, boardCount, censusCount: census?.count ?? null, status };
    db.prepare('INSERT OR REPLACE INTO source_samples (partition,sampled_at,board_count,census_count,status) VALUES (?,?,?,?,?)')
      .run(result.partition, now, boardCount, result.censusCount, status);
    samples.push(result);
  }
  return samples;
}
