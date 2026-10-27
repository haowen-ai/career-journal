import { redact } from '../runtime/redact.mjs';
import { parseJson } from './deliver.mjs';
export function reviewReport(db, { receipt = null, sourceReceipts = [], lang = 'en' } = {}) {
  const zh = lang === 'zh';
  const rows = db.prepare(`SELECT p.*,r.state,r.decision,r.code,r.flags_json,r.evidence_json,r.hold_owner,a.fit,a.deadline_at,a.posting_end_at,a.skip_reason
    FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id WHERE p.merged_into IS NULL ORDER BY r.updated_at DESC,p.id`).all();
  const url = (row) => row.canonical_url ? (/^https?:/.test(row.canonical_url) ? row.canonical_url : `https://${row.canonical_url}`) : '';
  const line = (row) => `- ${row.company} — ${row.title} ${url(row)}${parseJson(row.flags_json, []).includes('manual') ? ' [manual intake]' : ''}`;
  const lines = [zh ? '# 岗位审核报告' : '# Official posting review', '', receipt ? `${receipt.run_id}: ${receipt.status}` : '', '', zh ? '## 已交付' : '## Delivered eligible'];
  for (const row of rows.filter((r) => r.decision === 'eligible' && r.application_id && !r.skip_reason)) lines.push(`${line(row)} — ${row.fit ?? ''}${row.deadline_at ? `; cutoff ${row.deadline_at}` : ''}${row.posting_end_at ? `; posting ends ${row.posting_end_at}` : ''}`);
  lines.push('', zh ? '## 待你定' : '## Awaiting you');
  for (const row of rows.filter((r) => r.hold_owner === 'user')) lines.push(`${line(row)} — ${parseJson(row.evidence_json).question ?? row.code}`);
  lines.push('', zh ? '## 已复用／已提交' : '## Reused / already submitted');
  for (const row of rows.filter((r) => r.decision === 'reused' || r.code === 'already_submitted')) lines.push(`${line(row)} — ${row.code}`);
  lines.push('', zh ? '## 等待系统审核' : '## Pending review');
  for (const row of rows.filter((r) => r.state === 'due' || parseJson(r.flags_json, []).includes('manual'))) lines.push(line(row));
  lines.push('', zh ? '## 超期' : '## Breaches');
  for (const item of receipt?.breaches ?? []) lines.push(`- ${item.postingId}: ${item.age_days ?? ''} ${item.code ?? ''}`);
  lines.push('', zh ? '## 来源告警' : '## Source alerts');
  for (const source of sourceReceipts.flatMap((s) => s.sources ?? [])) if (source.alert || !['ok','empty'].includes(source.status)) lines.push(`- ${source.source} ${source.partition}: ${source.alert ?? source.status}`);
  lines.push('', '## No-student-signal backlog', JSON.stringify(receipt?.backlog?.no_student_signal ?? {}));
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
