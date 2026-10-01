import path from 'node:path';
import { loadConfig } from '../config/store.mjs';
import {
  answersPath, appendAnswer, getProfileValue, missingItems, parseProfileValue, profileFields, profilePath,
  profileStatus, readAnswers, readProfile, updateProfile,
} from '../domain/profile.mjs';
import { hardRules, profileQuestions, profileRounds } from '../domain/profile-questions.mjs';

const usage = 'Usage: career-journal profile show|questions|set|answer|status';
const setUsage = 'Usage: career-journal profile set --key <dot.path> --value <json-or-text>';

async function configuredHome(parsed) {
  const home = path.resolve(parsed.options.home ?? process.cwd());
  const config = await loadConfig(home);
  return { home, config };
}

function roundOption(value) {
  if (value === undefined) return null;
  const round = Number(value);
  if (typeof value !== 'string' || !Number.isInteger(round) || round < 1 || round > 4 || value.trim() !== String(round)) {
    throw new Error('--round must be 1, 2, 3, or 4');
  }
  return round;
}

function optionalText(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`--${name} needs a value`);
  return value;
}

function display(value) {
  if (value === null || value === undefined) return '(not set)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function questions(parsed, io) {
  const round = roundOption(parsed.options.round);
  let selected = profileQuestions.filter((item) => round === null || item.round === round);
  if (parsed.options.missing) {
    const { home } = await configuredHome(parsed);
    const missing = new Map(missingItems(await readProfile(home), { answers: await readAnswers(home) }).map((item) => [item.key, item]));
    selected = selected.filter((item) => missing.has(item.key)).map((item) => ({ ...item, skipped: missing.get(item.key).skipped }));
  }
  if (parsed.options.json) {
    const rounds = profileRounds.filter((item) => round === null || item.round === round);
    io.out(JSON.stringify({ rounds, questions: selected, hardRules }, null, 2));
  } else {
    for (const item of selected) io.out([`round ${item.round}`, item.key, item.required ? 'required' : 'optional', item.target, item.prompts.en].join('\t'));
  }
  return 0;
}

async function show(parsed, io) {
  const { home } = await configuredHome(parsed);
  const profile = await readProfile(home);
  if (parsed.options.json) {
    io.out(JSON.stringify({ exists: profile !== null, path: profilePath(home), answersPath: answersPath(home), profile }, null, 2));
    return 0;
  }
  if (!profile) {
    io.out(`No profile yet at ${profilePath(home)}. Start the interview with career-journal profile questions --json, then save answers with profile set and profile answer.`);
    return 0;
  }
  io.out(`Profile: ${profilePath(home)}`);
  io.out(`Answers sheet: ${answersPath(home)}`);
  io.out(`updatedAt: ${display(profile.updatedAt)}`);
  for (const field of profileFields) io.out(`${field}: ${display(getProfileValue(profile, field))}`);
  return 0;
}

async function set(parsed, io) {
  const { home } = await configuredHome(parsed);
  if (typeof parsed.options.key !== 'string' || typeof parsed.options.value !== 'string') throw new Error(setUsage);
  const value = parseProfileValue(parsed.options.key, parsed.options.value);
  const result = await updateProfile(home, parsed.options.key, value);
  io.out(JSON.stringify({ key: result.key, value: result.value, updatedAt: result.profile.updatedAt }));
  return 0;
}

async function answer(parsed, io) {
  const { home, config } = await configuredHome(parsed);
  const key = optionalText(parsed.options.key, 'key');
  const record = await appendAnswer(
    home,
    optionalText(parsed.options.question, 'question'),
    optionalText(parsed.options.answer, 'answer'),
    optionalText(parsed.options.source, 'source') ?? 'user',
    { key: key ?? null, timeZone: config.timezone },
  );
  io.out(JSON.stringify(record));
  return 0;
}

async function status(parsed, io) {
  const { home } = await configuredHome(parsed);
  const state = await profileStatus(home);
  if (parsed.options.json) {
    io.out(JSON.stringify(state, null, 2));
    return 0;
  }
  io.out(`profile: ${state.exists ? 'saved' : 'not created'} (${state.path})`);
  for (const round of state.rounds) io.out(`round ${round.round} ${round.id}: ${round.complete ? 'complete' : `missing ${round.missing.join(', ')}`}`);
  io.out(`scan: ${state.readiness.scan.detail}`);
  io.out(`apply: ${state.readiness.apply.detail}`);
  return 0;
}

const handlers = { show, questions, set, answer, status };

export async function profileCommand(parsed, io) {
  const handler = Object.hasOwn(handlers, parsed.subcommand ?? '') ? handlers[parsed.subcommand] : null;
  if (!handler) throw new Error(usage);
  return handler(parsed, io);
}
