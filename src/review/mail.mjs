import { canonicalUrl } from '../funnel/identity.mjs';
export const CONFIRMATION_PATTERNS = Object.freeze([/application (?:was )?(?:received|submitted)/i, /thank you for applying/i]);
const key = (text) => String(text ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchMailHits(db, hits, { now } = {}) {
  const postings = db.prepare('SELECT * FROM postings WHERE merged_into IS NULL').all();
  const aliases = db.prepare("SELECT * FROM posting_aliases WHERE kind IN ('req','company_req','url')").all();
  // Nightly data is ~56k postings and ~160k aliases, so look-ups stay constant-time per alias.
  const postingsById = new Map();
  for (const posting of postings) if (!postingsById.has(posting.id)) postingsById.set(posting.id, posting);
  const companyKeys = new Map([...postingsById].map(([id, posting]) => [id, key(posting.company)]));
  const distinctCompanyKeys = [...new Set(postings.map((posting) => key(posting.company)))];
  return hits.map((hit) => {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(hit.receivedAt ?? '') || !Number.isFinite(Date.parse(hit.receivedAt))) throw new Error('receivedAt must be ISO 8601 with offset');
    const text = `${hit.subject ?? ''}\n${String(hit.excerpt ?? '').slice(0, 4000)}`;
    const hitKey = key(`${hit.sender ?? ''} ${text}`);
    const companyMatches = (p) => hitKey.includes(companyKeys.get(p.id));
    const urls = [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) => match[0].replace(/[.,;)]+$/, ''));
    const confirmed = CONFIRMATION_PATTERNS.some((pattern) => pattern.test(text));
    const matches = new Map();
    for (const alias of confirmed ? aliases : []) {
      const posting = postingsById.get(alias.posting_id);
      if (!posting) continue;
      if (alias.kind !== 'url') {
        const token = alias.alias.split(':').at(-1);
        if (companyMatches(posting) && new RegExp(`(?<![A-Za-z0-9])${escape(token)}(?![A-Za-z0-9-])`).test(text)) matches.set(posting.id, token);
      } else {
        for (const url of urls) {
          if (`url:${canonicalUrl(url)}` !== alias.alias) continue;
          const host = new URL(url).hostname;
          const postingHost = new URL(/^https?:/.test(posting.canonical_url) ? posting.canonical_url : `https://${posting.canonical_url}`).hostname;
          if (companyMatches(posting) || host === postingHost) matches.set(posting.id, canonicalUrl(url));
        }
      }
    }
    if (matches.size === 1) { const [postingId, token] = [...matches][0]; return { hitId: hit.messageId, postingId, match: 'exact', token }; }
    return { hitId: hit.messageId, postingId: null, match: matches.size > 1 ? 'ambiguous' : distinctCompanyKeys.some((company) => hitKey.includes(company)) ? 'company' : 'none', token: null };
  });
}
