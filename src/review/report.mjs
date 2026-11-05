import { redact } from '../runtime/redact.mjs';
import { parseJson } from './deliver.mjs';
import { awaitingUserSummary } from './awaiting-user.mjs';
import { nightlySummary, STOP_REASONS } from './summary.mjs';
export function reviewReport(db, { receipt = null, sourceReceipts = [], lang = 'en' } = {}) {
  const zh = lang === 'zh';
  const rows = db.prepare(`SELECT p.*,r.state,r.decision,r.code,r.flags_json,r.evidence_json,r.hold_owner,a.fit,a.deadline_at,a.posting_end_at,a.skip_reason
    FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id WHERE p.merged_into IS NULL ORDER BY r.updated_at DESC,p.id`).all();
  const url = (row) => row.canonical_url ? (/^https?:/.test(row.canonical_url) ? row.canonical_url : `https://${row.canonical_url}`) : '';
  const line = (row) => `- ${row.company} — ${row.title} ${url(row)}${parseJson(row.flags_json, []).includes('manual') ? ' [manual intake]' : ''}`;
  const lines = [zh ? '# 岗位审核报告' : '# Official posting review', '', receipt ? `${receipt.run_id}: ${receipt.status}` : ''];
  if (receipt) {
    const combined = receipt.kind === 'daily' ? receipt
      : { kind: 'daily', run_id: receipt.run_id, status: receipt.status, stages: [...sourceReceipts.map((scan) => ({ receipt: scan })), { receipt: { kind: 'review', ...receipt } }] };
    lines.push(nightlySummary(combined, { lang }).replace(/^[^:：]*[:：]\s*/, ''));
    if (receipt.stop_reason) lines.push(`${zh ? '停止原因' : 'Stop reason'}: ${receipt.stop_reason}${STOP_REASONS[receipt.stop_reason] ? ` — ${STOP_REASONS[receipt.stop_reason][zh ? 'zh' : 'en']}` : ''}`);
    if (receipt.wallStarted || receipt.wallFinished) lines.push(`${zh ? '实际时间' : 'Wall clock'}: ${receipt.wallStarted ?? '?'} → ${receipt.wallFinished ?? '?'}`);
    for (const item of receipt.external_failures ?? []) lines.push(`${zh ? '外部故障' : 'External failure'}: ${item.postingId} ${item.error ?? ''}`);
    for (const item of receipt.external_holds ?? []) lines.push(`${zh ? '外部项' : 'External item'}: ${item.postingId} ${item.code ?? ''}`);
  }
  // Per-source intake: fetched = stored + counted only (+ quarantined).
  const ingest = sourceReceipts.flatMap((scan) => scan?.ingest ?? []);
  if (ingest.length) {
    lines.push('', zh ? '## 抓取与入库' : '## Intake (fetched / stored / counted only)');
    for (const item of ingest) lines.push(`- ${item.source} ${item.partition}: ${item.fetched ?? '?'} / ${item.stored ?? '?'} / ${item.countedOnly ?? 0}${item.quarantined ? ` (${zh ? '隔离' : 'quarantined'} ${item.quarantined})` : ''}${Number.isFinite(item.elapsedMs) ? ` ${item.elapsedMs} ms` : ''}`);
  }
  lines.push('', zh ? '## 已交付' : '## Delivered eligible');
  for (const row of rows.filter((r) => r.decision === 'eligible' && r.application_id && !r.skip_reason)) lines.push(`${line(row)} — ${row.fit ?? ''}${row.deadline_at ? `; cutoff ${row.deadline_at}` : ''}${row.posting_end_at ? `; posting ends ${row.posting_end_at}` : ''}`);
  lines.push('', zh ? '## 模型代定' : '## Model-decided');
  for (const row of rows.filter((r) => r.state === 'done' && parseJson(r.flags_json, []).includes('model_decided'))) {
    const model = parseJson(row.evidence_json).modelDecision;
    if (model) lines.push(`${line(row)} — ${row.decision}: ${model.assumption}${parseJson(row.flags_json, []).includes('disputed') ? ' [disputed]' : ''}`);
  }
  lines.push('', zh ? '## 待你定' : '## Awaiting you');
  const held = rows.filter((r) => r.hold_owner === 'user');
  const heldById = new Map(held.map((row) => [row.id, row]));
  for (const group of awaitingUserSummary(held.map((row) => ({ ...row, posting_id: row.id })))) {
    lines.push(`- ${group.key} (${group.count})`);
    for (const id of group.postings) lines.push(`  ${line(heldById.get(id))}`);
  }
  lines.push('', zh ? '## 已复用／已提交' : '## Reused / already submitted');
  for (const row of rows.filter((r) => r.decision === 'reused' || r.code === 'already_submitted')) lines.push(`${line(row)} — ${row.code}`);
  lines.push('', zh ? '## 等待系统审核' : '## Pending review');
  for (const row of rows.filter((r) => r.state === 'due' || parseJson(r.flags_json, []).includes('manual'))) lines.push(line(row));
  lines.push('', zh ? '## 超期' : '## Breaches');
  for (const item of receipt?.breaches ?? []) lines.push(`- ${item.postingId}: ${item.age_days ?? ''} ${item.code ?? ''}`);
  lines.push('', zh ? '## 来源告警' : '## Source alerts');
  for (const source of sourceReceipts.flatMap((s) => s.sources ?? [])) if (source.alert || !['ok','empty'].includes(source.status)) lines.push(`- ${source.source} ${source.partition}: ${source.alert ?? source.status}`);
  lines.push('', '## No-student-signal backlog', JSON.stringify(receipt?.backlog?.no_student_signal ?? {}));
  lines.push('', '## Out-of-direction backlog', JSON.stringify(receipt?.backlog?.out_of_direction ?? {}));
  lines.push('', zh ? '## 抽查证据' : '## Spot-check (up to 3)');
  const runPostingIds = receipt?.run_id ? new Set(db.prepare('SELECT DISTINCT posting_id FROM attempts WHERE run_id=?').all(receipt.run_id).map((r) => r.posting_id)) : null;
  for (const row of rows.filter((r) => r.decision === 'eligible' && (!runPostingIds || runPostingIds.has(r.id))).slice(0,3)) {
    lines.push(line(row));
    for (const evidence of parseJson(row.evidence_json).evidence ?? []) if (evidence.quote) lines.push(`  > ${evidence.quote}`);
  }
  lines.push('', ...((receipt?.warnings ?? []).map((warning) => `Warning: ${typeof warning === 'string' ? warning : JSON.stringify(warning)}`)),
    ...((receipt?.errors ?? []).map((error) => `Error: ${typeof error === 'string' ? error : JSON.stringify(error)}`)));
  return redact(lines.filter((line) => line !== undefined).join('\n'));
}
