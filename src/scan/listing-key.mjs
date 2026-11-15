// The native id of one listing on one list (plan 2026-11-14 v2 step 1). Together with the source and the
// partition it is the "seen" key: a listing whose key was recorded by an earlier scan is skipped before
// classification once that list has a completed baseline (src/funnel/seen.mjs).
//
// It is the board's own id for the posting, never a requisition alias: two Greenhouse postings can share one
// requisition_id and still be two listings (src/funnel/identity.mjs keeps them apart too). A Workday row carries
// the posting token of its URL (`listingId`, set by the career-ops provider), so the same posting found by two
// keyword searches of one tenant has one key. A reposted listing with a new id is simply a new key.
import { canonicalUrl } from '../funnel/identity.mjs';

const text = (value) => (typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '');

// A provider row (career-ops bridge output, before parsing): the provider's listing identity, its own listing
// token, its external id, its row id, and only then the canonical URL.
export function nativeListingId(item = {}) {
  return text(item?.listingIdentity?.posting_id) || text(item?.listingId) || text(item?.externalId) || text(item?.id) || canonicalUrl(item?.url) || null;
}

// A parsed record: CareerOps records carry `listingId` (from nativeListingId); boards and Simplify carry their
// row id as `sourceId`.
export function listingKeyOf(record = {}) {
  return text(record?.listingId) || text(record?.sourceId) || canonicalUrl(record?.url) || null;
}
