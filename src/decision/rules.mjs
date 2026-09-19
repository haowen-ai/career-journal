export const EMAIL_CLASSIFICATIONS = Object.freeze([
  'application_confirmation',
  'assessment',
  'interview',
  'rejection',
  'offer',
  'marketing',
  'unknown',
]);

export function classifyEmailWithRules(text) {
  const normalized = String(text ?? '').toLowerCase();
  const rules = [
    ['offer', /\boffer\b|congratulations.{0,50}(position|role)|pleased to offer/],
    ['interview', /\binterview\b|schedule.{0,50}(time|call|meeting)|video cover letter/],
    ['assessment', /\bassessment\b|coding challenge|complete.{0,50}(test|exercise)/],
    ['rejection', /not moving forward|other candidates|unfortunately|regret to inform/],
    ['application_confirmation', /application (has been )?received|thank you for applying|application submitted/],
    ['marketing', /newsletter|job alert|recommended jobs|talent community/],
  ];
  for (const [classification, pattern] of rules) {
    if (pattern.test(normalized)) return { classification, confidence: 1 };
  }
  return { classification: 'unknown', confidence: 0 };
}
