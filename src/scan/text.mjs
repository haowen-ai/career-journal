const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', hellip: '...', bull: '•', middot: '·', trade: '', reg: '', copy: '',
});

export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Job boards return HTML (Greenhouse returns it entity-escaped), so decode,
// strip tags, and decode again to get readable plain text.
export function htmlToText(value) {
  const html = decodeEntities(value);
  const stripped = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-term match: the term may not be glued to other letters or digits.
export function termPattern(term) {
  const body = escapeRegExp(normalizeText(term)).replace(/ /g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

export function excerpt(text, index, length, radius = 40) {
  const source = String(text ?? '');
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + length + radius);
  return `${start > 0 ? '...' : ''}${source.slice(start, end).replace(/\s+/g, ' ').trim()}${end < source.length ? '...' : ''}`;
}
