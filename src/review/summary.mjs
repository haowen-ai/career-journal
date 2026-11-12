// One plain line for the nightly receipt (`review receipt --summary [zh]`, `review report`): status, counts
// fetched/stored, judged, eligible, due left, holds, stop reason. Works on a daily receipt (stages[].receipt),
// a review receipt or a scan receipt, and tolerates receipts written before these fields existed.
export const STOP_REASONS = Object.freeze({
  unfinished: { en: 'due work left with no external cause', zh: '有待审未做完且无外部原因' },
  external_failure: { en: 'an external service failed', zh: '外部服务故障' },
  jev_unavailable: { en: 'Jev unavailable', zh: 'Jev 不可用' },
  adapter_failure: { en: 'Codex adapter failed', zh: 'Codex 调用失败' },
  company_size_unavailable: { en: 'company size could not be decided', zh: '公司规模未能判定' },
  rate_limited: { en: 'judge API still rate-limited at concurrency 1', zh: '判定接口在并发 1 时仍持续限流' },
  network_unavailable: { en: 'judge API unreachable (network) for the stall budget', zh: '判定接口网络持续不可用，超过等待上限' },
  invalid_config: { en: 'invalid review-policy setting', zh: 'review-policy 配置无效' },
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
  const scanned = scans.length > 0;
  const fetched = sum(scans, (scan) => (Array.isArray(scan.ingest) && scan.ingest.length ? sum(scan.ingest, (item) => item.fetched) : scan.counts?.raw));
  const stored = sum(scans, (scan) => (Array.isArray(scan.ingest) && scan.ingest.length ? sum(scan.ingest, (item) => item.stored) : scan.counts?.stored ?? scan.counts?.observed));
  const countedOnly = sum(scans, (scan) => scan.counts?.countedOnly);
  const lastReview = reviews.at(-1);
  const stopReasons = [...new Set([receipt?.stop_reason, ...parts.map((item) => item.stop_reason)].filter(Boolean))];
  return {
    status: receipt?.status ?? 'unknown', fetched: scanned ? fetched : null, stored: scanned ? stored : null, countedOnly: scanned ? countedOnly : null,
    judged: sum(reviews, (item) => item.counts?.judged), eligible: sum(reviews, (item) => item.counts?.eligible),
    // Same-title grouping: reviews settled from another member's decision, with no fetch or model call.
    groupCopied: sum(reviews, (item) => item.counts?.group_copied), groupLocationRule: sum(reviews, (item) => item.counts?.group_location_rule),
    groupTextMismatch: sum(reviews, (item) => item.counts?.group_text_mismatch),
    // Amendment G: pre-fetch rule gates, re-queued rule settlements, final primary rejections and the escalation sample.
    gateTitle: sum(reviews, (item) => item.counts?.gate_title), gateLocation: sum(reviews, (item) => item.counts?.gate_location), gateTerm: sum(reviews, (item) => item.counts?.gate_term),
    gateReopened: sum(reviews, (item) => item.counts?.gate_reopened), primaryFinal: sum(reviews, (item) => item.counts?.primary_final),
    sampleAsked: sum(reviews, (item) => item.counts?.escalation_sample?.asked), sampleOverturned: sum(reviews, (item) => item.counts?.escalation_sample?.overturned),
    dueTotal: lastReview?.backlog?.due ?? null,
    dueLeft: lastReview?.backlog?.actionable_due ?? null, holds: lastReview?.backlog?.held ?? null,
    stopReasons, wallStarted: parts.find((item) => item.wallStarted)?.wallStarted ?? null, wallFinished: [...parts].reverse().find((item) => item.wallFinished)?.wallFinished ?? null,
  };
}

const known = (value) => (value === null || value === undefined ? '?' : value);
export function nightlySummary(receipt, { lang = 'en' } = {}) {
  const c = nightlyCounts(receipt);
  const zh = lang === 'zh';
  const reasons = c.stopReasons.length
    ? c.stopReasons.map((code) => `${code}${STOP_REASONS[code] ? (zh ? `（${STOP_REASONS[code].zh}）` : ` (${STOP_REASONS[code].en})`) : ''}`).join(zh ? '、' : ', ')
    : (zh ? '无' : 'none');
  const id = receipt?.run_id ?? receipt?.runId ?? '';
  const group = c.groupCopied || c.groupTextMismatch
    ? (zh ? `，同岗复用 ${c.groupCopied}（其中按地点规则 ${c.groupLocationRule}；正文不同另判 ${c.groupTextMismatch}）`
      : `, group copies ${c.groupCopied} (location rule ${c.groupLocationRule}; text differs, judged ${c.groupTextMismatch})`) : '';
  const gated = c.gateTitle || c.gateLocation || c.gateTerm || c.gateReopened || c.primaryFinal || c.sampleAsked
    ? (zh ? `，代码门结案 标题 ${c.gateTitle}、地点 ${c.gateLocation}${c.gateTerm ? `、学期地点 ${c.gateTerm}` : ''}（规则变更重排 ${c.gateReopened}），初审拒绝直接定案 ${c.primaryFinal}，抽检升级 ${c.sampleAsked}（推翻 ${c.sampleOverturned}）`
      : `, rule gates title ${c.gateTitle}, location ${c.gateLocation}${c.gateTerm ? `, term and place ${c.gateTerm}` : ''} (re-queued on rule change ${c.gateReopened}), final primary rejections ${c.primaryFinal}, sampled escalations ${c.sampleAsked} (overturned ${c.sampleOverturned})`) : '';
  if (zh) {
    return `${id}：状态 ${c.status}；抓取 ${known(c.fetched)}，入库 ${known(c.stored)}（只计数 ${known(c.countedOnly)}）；判定 ${c.judged}，合格 ${c.eligible}${group}${gated}；剩余待审 ${known(c.dueLeft)}；挂起 ${known(c.holds)}；停止原因 ${reasons}`;
  }
  return `${id}: status ${c.status}; fetched ${known(c.fetched)}, stored ${known(c.stored)} (counted only ${known(c.countedOnly)}); judged ${c.judged}, eligible ${c.eligible}${group}${gated}; due left ${known(c.dueLeft)}; holds ${known(c.holds)}; stop reason ${reasons}`;
}
