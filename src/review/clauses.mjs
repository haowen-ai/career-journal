const BULLET = /^\s*(?:[•*+-]|\d+[.)])\s+/;

function headingKind(line) {
  const heading = line.trim().replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1')
    .replace(/^[^\p{L}\p{N}]+/u, '').replace(/:\s*$/, '').trim();
  const conversational = /^(?:what (?:you (?:will bring|bring)|we(?: require|(?: are|['’]re)? looking for))|student qualities we['’]re seeking)\b/i.test(heading);
  if ((conversational || /qualifications|requirements|skills|experience/i.test(heading)) && /\b(?:preferred|desired|nice.to.have|bonus)\b/i.test(heading)
    || /^(?:preferred|desired|nice.to.have|bonus)$/i.test(heading)) return 'preferred';
  if (conversational) return 'required';
  if (/^(?:(?:required|minimum|basic|essential|mandatory)\s+(?:qualifications|requirements|skills|experience)|requirements|required qualifications|qualifications)$/i.test(heading)) return 'required';
  if (/^(?:eligibility|eligibility requirements|who (?:can|may) apply)$/i.test(heading)) return 'eligibility';
  if (/^(?:responsibilities|(?:your|key) responsibilities|what you(?:'|’)ll do|duties)$/i.test(heading)) return 'responsibilities';
  if (/^(?:about (?:the role|us|the team)|benefits|compensation|equal opportunity|how to apply)$/i.test(heading)) return 'other';
  if (/^#{1,6}\s+/.test(line.trim())) return 'unknown';
  return null;
}

export function segmentSections(text) {
  text = String(text);
  const sections = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const kind = headingKind(line);
    if (kind !== null) {
      if (!sections.length && offset > 0) sections.push({ kind: 'unknown', start: 0, end: offset, heading: '' });
      if (sections.length) sections.at(-1).end = offset;
      sections.push({ kind, start: offset, end: text.length, heading: line.trim() });
    }
    offset += line.length + 1;
  }
  return sections.length ? sections : [{ kind: 'unknown', start: 0, end: text.length, heading: '' }];
}

export function clauseAt(text, offset) {
  text = String(text);
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new RangeError('Clause offset must be inside the snapshot');
  const section = segmentSections(text).find((item) => item.start <= offset && offset < item.end) ?? { start: 0, end: text.length };
  const lines = [];
  let position = section.start;
  for (const line of text.slice(section.start, section.end).split('\n')) {
    lines.push({ text: line, start: position, end: Math.min(section.end, position + line.length) });
    position += line.length + 1;
  }
  const lineIndex = lines.findIndex((line) => line.start <= offset && offset <= line.end);
  if (lineIndex >= 0) {
    let bulletIndex = lineIndex;
    while (bulletIndex > 0 && !BULLET.test(lines[bulletIndex].text) && lines[bulletIndex - 1].text.trim()) bulletIndex -= 1;
    if (BULLET.test(lines[bulletIndex].text)) {
      let endIndex = bulletIndex + 1;
      while (endIndex < lines.length && lines[endIndex].text.trim() && !BULLET.test(lines[endIndex].text)) endIndex += 1;
      const start = lines[bulletIndex].start;
      const end = lines[endIndex - 1].end;
      return { start, end, text: text.slice(start, end) };
    }
  }
  // Restrict unbulleted prose to its paragraph, then use deterministic sentence boundaries.
  let start = section.start;
  let end = section.end;
  for (const match of text.slice(section.start, section.end).matchAll(/\n\s*\n/g)) {
    const boundary = section.start + match.index;
    if (boundary + match[0].length <= offset) start = boundary + match[0].length;
    else if (boundary >= offset) { end = boundary; break; }
  }
  const paragraph = text.slice(start, end);
  for (const sentence of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(paragraph)) {
    const from = start + sentence.index;
    const to = from + sentence.segment.length;
    if (from <= offset && offset < to) {
      const trimmed = sentence.segment.trimEnd();
      return { start: from, end: from + trimmed.length, text: trimmed };
    }
  }
  return { start, end, text: text.slice(start, end) };
}

function normalizedWithOffsets(text) {
  let value = '';
  const starts = [];
  const ends = [];
  let offset = 0;
  for (const character of String(text)) {
    const normalized = character.normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
    for (const char of normalized) {
      if (/\s/u.test(char)) {
        if (value && !value.endsWith(' ')) { value += ' '; starts.push(offset); ends.push(offset + character.length); }
        else if (value.endsWith(' ')) ends[ends.length - 1] = offset + character.length;
      } else { value += char; starts.push(offset); ends.push(offset + character.length); }
    }
    offset += character.length;
  }
  if (value.endsWith(' ')) { value = value.slice(0, -1); starts.pop(); ends.pop(); }
  return { value, starts, ends };
}

export function normalizeQuote(text) { return normalizedWithOffsets(text).value; }

export function findQuote(text, quote) {
  if (typeof quote !== 'string' || !quote.trim()) return null;
  const position = String(text).indexOf(quote);
  if (position < 0) return null;
  return { start: position, end: position + quote.length, text: quote };
}

export function validateCriterion(text, criterion, facts) {
  const found = findQuote(text, criterion?.quote);
  const base = { valid: false, reason: 'quote_not_found', section: null, clause: null, confirmedConflict: false };
  if (!found) return base;
  const section = segmentSections(text).find((item) => item.start <= found.start && found.start < item.end)?.kind ?? 'unknown';
  const clause = clauseAt(text, found.start);
  const result = { ...base, valid: true, reason: null, section, clause };
  if (section === 'preferred' || /\b(?:preferred|optional|nice.to.have|bonus(?: points)?|not required)\b/i.test(clause.text)) return { ...result, reason: 'non_mandatory' };
  if (criterion.status !== 'conflicts') return result;
  const body = normalizeQuote(clause.text.replace(BULLET, '')).trim();
  const quote = normalizeQuote(criterion.quote.replace(BULLET, '')).trim();
  if (found.end > clause.end || quote !== body) return { ...result, valid: false, reason: 'partial_clause' };
  const cited = (criterion.fact_ids ?? []).map((id) => facts.find((fact) => fact.id === id));
  if (cited.some((fact) => fact?.polarity === 'has')) return { ...result, reason: 'contradictory_fact' };
  if (!cited.length || cited.some((fact) => !fact || !['lacks', 'constraint'].includes(fact.polarity))) return { ...result, reason: 'missing_fact' };
  // The model decides whether the cited facts contradict this whole requirement.
  // Word overlap, degree levels and OR-branch semantics cannot validate that claim.
  return { ...result, confirmedConflict: true };
}
