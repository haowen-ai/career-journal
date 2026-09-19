#!/usr/bin/env node
import { createJevAdapter } from '../src/decision/jev.mjs';

const adapter = createJevAdapter({
  accessState: 'enabled',
  baseUrl: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  secretRef: 'env:TYPESAFE_API_KEY',
  mode: 'active',
  threshold: 0.8,
});

const cases = [
  {
    id: 'application-confirmation',
    expected: 'application_confirmation',
    text: 'Thank you for applying. We have received your application for the Data Science Internship.',
  },
  {
    id: 'video-interview',
    expected: 'interview',
    text: 'Please record a two-minute video response by Monday so the hiring team can learn more about you.',
  },
  {
    id: 'rejection',
    expected: 'rejection',
    text: 'After reviewing your application, we have decided not to move forward with your candidacy.',
  },
];

const results = [];
for (const item of cases) {
  const decision = await adapter.decide({ kind: 'email-classification', text: item.text });
  results.push({
    id: item.id,
    expected: item.expected,
    actual: decision.classification,
    confidence: decision.confidence,
    usage: decision.usage ?? null,
    passed: decision.classification === item.expected,
  });
}

const totals = results.reduce((sum, item) => ({
  input_tokens: sum.input_tokens + (item.usage?.input_tokens ?? 0),
  output_tokens: sum.output_tokens + (item.usage?.output_tokens ?? 0),
}), { input_tokens: 0, output_tokens: 0 });

console.log(JSON.stringify({ model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/systemone', results, totals }, null, 2));
if (results.some((item) => !item.passed)) process.exitCode = 1;
