const BULLET = /^\s*(?:[•*+-]|\d+[.)])\s+/;
const clauseBody = (text) => text.replace(BULLET, '').replace(/^(?:TITLE|Eligibility):\s*/i, '');
const indentation = (line) => line.match(/^[ \t]*/)[0].length;

function headingKind(line) {
  const heading = line.trim().replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1')
    .replace(/^[^\p{L}\p{N}]+/u, '').replace(/:\s*$/, '').trim();
  const conversational = /^(?:what (?:you (?:will bring|bring|need to succeed)|we(?: require|(?: are|['’]re)? looking for))|student qualities we['’]re seeking)\b/i.test(heading);
  if ((conversational || /qualifications|requirements|skills|experience/i.test(heading)) && /\b(?:preferred|desired|nice.to.have|bonus)\b/i.test(heading)
    || /^(?:preferred|desired|nice.to.have|bonus)$/i.test(heading)) return 'preferred';
  if (conversational) return 'required';
  if (/^(?:(?:required|minimum|basic|essential|mandatory)\s+(?:qualifications|requirements|skills|experience|knowledge,\s*skills and experience)|requirements|required qualifications|qualifications)$/i.test(heading)) return 'required';
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
    while (bulletIndex > 0 && !BULLET.test(lines[bulletIndex].text) && /^[ \t]+\S/.test(lines[bulletIndex].text)) bulletIndex -= 1;
    const continuation = (line) => line.text.trim() && !BULLET.test(line.text)
      && indentation(line.text) > indentation(lines[bulletIndex].text);
    if (BULLET.test(lines[bulletIndex].text) && lines.slice(bulletIndex + 1, lineIndex + 1).every(continuation)) {
      let endIndex = bulletIndex + 1;
      while (endIndex < lines.length && continuation(lines[endIndex])) endIndex += 1;
      const start = lines[bulletIndex].start;
      const end = lines[endIndex - 1].end;
      return { start, end, text: text.slice(start, end) };
    }
  }
  // A new prose line starts a new clause, even without sentence punctuation.
  const start = lines[lineIndex]?.start ?? section.start;
  const end = lines[lineIndex]?.end ?? section.end;
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
  let clause = clauseAt(text, found.start);
  // A whole prose line may contain several sentences. Keep fragments and
  // partial wrapped bullets subject to the whole-clause check below.
  const lineStart = text.lastIndexOf('\n', found.start - 1) + 1;
  const nextLine = text.indexOf('\n', found.end);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  if (!BULLET.test(clause.text) && !clauseBody(text.slice(lineStart, found.start)).trim()
    && !text.slice(found.end, lineEnd).trim()) {
    clause = { start: lineStart, end: lineEnd, text: text.slice(lineStart, lineEnd) };
  }
  const result = { ...base, valid: true, reason: null, section, clause };
  // Parentheticals and attributive wording such as "Preferred Graduation Date"
  // do not make the main requirement optional. Check its own predicate instead.
  let main = clauseBody(clause.text);
  while (/\([^()]*\)/.test(main)) main = main.replace(/\([^()]*\)/g, '');
  if (section === 'preferred' || /\b(?:preferred|optional|nice.to.have|bonus(?: points)?|not required|a plus)\b\s*[.!?]?\s*$/i.test(main)
    || /\b(?:could (?:include|be required)|depending on the role)\b/i.test(main)) return { ...result, reason: 'non_mandatory' };
  if (criterion.status !== 'conflicts') return result;
  const body = normalizeQuote(clauseBody(clause.text)).trim();
  const quote = normalizeQuote(clauseBody(criterion.quote)).trim();
  if (found.end > clause.end || quote !== body) return { ...result, valid: false, reason: 'partial_clause' };
  const cited = (criterion.fact_ids ?? []).map((id) => facts.find((fact) => fact.id === id));
  const conflicting = cited.filter((fact) => ['lacks', 'constraint'].includes(fact?.polarity));
  if (!conflicting.length && cited.some((fact) => fact?.polarity === 'has')) return { ...result, reason: 'contradictory_fact' };
  if (!conflicting.length || cited.some((fact) => !fact || !['has', 'lacks', 'constraint'].includes(fact.polarity))) return { ...result, reason: 'missing_fact' };
  // The model decides whether the cited facts contradict this whole requirement.
  // Word overlap, degree levels and OR-branch semantics cannot validate that claim.
  return { ...result, confirmedConflict: true };
}
