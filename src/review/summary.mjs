// One plain line for the nightly receipt (`review receipt --summary [zh]`, `review report`): status, counts
// fetched/stored, judged, eligible, due left, holds, stop reason. Works on a daily receipt (stages[].receipt),
// a review receipt or a scan receipt, and tolerates receipts written before these fields existed.
export const STOP_REASONS = Object.freeze({
  unfinished: { en: 'due work left with no external cause', zh: '有待审未做完且无外部原因' },
  external_failure: { en: 'an external service failed', zh: '外部服务故障' },
  jev_unavailable: { en: 'Jev unavailable', zh: 'Jev 不可用' },
  adapter_failure: { en: 'Codex adapter failed', zh: 'Codex 调用失败' },
  company_size_unavailable: { en: 'company size could not be decided', zh: '公司规模未能判定' },
  budget: { en: 'budget', zh: '预算用完' },
  deadline: { en: 'deadline', zh: '到达截止时间' },
});

const stageReceipts = (receipt) => (receipt?.kind === 'daily' ? (receipt.stages ?? []).map((stage) => stage?.receipt).filter(Boolean) : [receipt].filter(Boolean));
const isScan = (item) => item?.kind === 'scan' || (item?.counts && Object.hasOwn(item.counts, 'raw')) || Array.isArray(item?.ingest);
const isReview = (item) => item?.kind === 'review';
const sum = (items, pick) => items.reduce((total, item) => total + (Number(pick(item)) || 0), 0);

export function nightlyCounts(receipt) {
  const parts = stageReceipts(receipt);
  const scans = parts.filter(isScan);
  const reviews = parts.filter(isReview);
  // Fetched comes from the per-batch census (ingest[]), else the scan totals; stored likewise.
  const fetched = sum(scans, (scan) => (Array.isArray(scan.ingest) && scan.ingest.length ? sum(scan.ingest, (item) => item.fetched) : scan.counts?.raw));
  const stored = sum(scans, (scan) => (Array.isArray(scan.ingest) && scan.ingest.length ? sum(scan.ingest, (item) => item.stored) : scan.counts?.stored ?? scan.counts?.observed));
  const countedOnly = sum(scans, (scan) => scan.counts?.countedOnly);
  const lastReview = reviews.at(-1);
  const stopReasons = [...new Set([receipt?.stop_reason, ...parts.map((item) => item.stop_reason)].filter(Boolean))];
  return {
    status: receipt?.status ?? 'unknown', fetched, stored, countedOnly,
    judged: sum(reviews, (item) => item.counts?.judged), eligible: sum(reviews, (item) => item.counts?.eligible),
    dueLeft: lastReview?.backlog?.actionable_due ?? null, holds: lastReview?.backlog?.held ?? null,
    stopReasons, wallStarted: parts.find((item) => item.wallStarted)?.wallStarted ?? null, wallFinished: [...parts].reverse().find((item) => item.wallFinished)?.wallFinished ?? null,
  };
}

const known = (value) => (value === null || value === undefined ? '?' : value);
export function nightlySummary(receipt, { lang = 'en' } = {}) {
  const c = nightlyCounts(receipt);
  const zh = lang === 'zh';
  const reasons = c.stopReasons.length
    ? c.stopReasons.map((code) => `${code}${STOP_REASONS[code] ? ` (${STOP_REASONS[code][zh ? 'zh' : 'en']})` : ''}`).join(', ')
    : (zh ? '无' : 'none');
  const id = receipt?.run_id ?? receipt?.runId ?? '';
  if (zh) {
    return `${id}：状态 ${c.status}；抓取 ${c.fetched}，入库 ${c.stored}（只计数 ${c.countedOnly}）；判定 ${c.judged}，合格 ${c.eligible}；剩余待审 ${known(c.dueLeft)}；挂起 ${known(c.holds)}；停止原因 ${reasons}`;
  }
  return `${id}: status ${c.status}; fetched ${c.fetched}, stored ${c.stored} (counted only ${c.countedOnly}); judged ${c.judged}, eligible ${c.eligible}; due left ${known(c.dueLeft)}; holds ${known(c.holds)}; stop reason ${reasons}`;
}
