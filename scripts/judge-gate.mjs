#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli/parse-args.mjs';
import { runEval, saveEvalRecord } from '../src/review/eval.mjs';
import { loadReviewInputs } from '../src/review/inputs.mjs';
import { createJudgeAdapters } from '../src/review/judge.mjs';
import { assertHomeOutsideCheckout } from '../src/runtime/home.mjs';
import { redact } from '../src/runtime/redact.mjs';

try {
  const { options } = parseArgs(process.argv.slice(2));
  let judges;
  if (options.home) {
    assertHomeOutsideCheckout(options.home);
    judges = createJudgeAdapters((await loadReviewInputs(options.home)).policy);
  }
  const result = await runEval({ setDir: options.set ?? fileURLToPath(new URL('../test/fixtures/judge-smoke/', import.meta.url)), judges, concurrency: Number(options.concurrency ?? 3) });
  if (result.pass && options.home) await saveEvalRecord(options.home, result.record);
  process.stdout.write(`${redact(JSON.stringify(options.json ? result : { pass: result.pass, metrics: result.metrics, record: result.record }, null, 2))}\n`);
  process.exitCode = result.pass ? 0 : 1;
} catch (error) {
  process.stderr.write(`${redact(error.message)}\n`); process.exitCode = 1;
}
