import { parseJson } from './deliver.mjs';

const normalizeQuestion = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function awaitingUserSummary(rows) {
  const groups = new Map();
  for (const row of rows.filter((item) => item.hold_owner === 'user')) {
    const evidence = parseJson(row.evidence_json);
    // factsUsed also contains unrelated constraints; only the criterion that
    // raised this question supplies its grouping keys.
    const keys = evidence.holdFactIds?.length ? evidence.holdFactIds : [normalizeQuestion(evidence.question) || row.code];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(row.posting_id);
    }
  }
  return [...groups].map(([key, postings]) => ({ key, count: postings.size, postings: [...postings].sort() }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
