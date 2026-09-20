import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile, stat, lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { isCurrentTaskClaim } from './registry.mjs';
import { parseWindowsCommandLine, quoteWindowsArgument } from './windows-argv.mjs';

const execFileDefault = promisify(execFileCallback);

function evidenceDigest(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function expectedExecutionArgv(task) {
  const execution = task.config.registration.execution;
  if (!execution?.node || !execution?.cli || !execution?.home) return null;
  return [
    execution.node, execution.cli, 'automation', 'run', '--id', task.id, '--home', execution.home,
    '--external-id', task.config.registration.externalId,
  ];
}

export function codexCommandLineForTask(task) {
  const args = expectedExecutionArgv(task);
  const platform = task.config.registration.execution?.platform;
  if (!args || !platform) return null;
  return args.map(platform === 'win32' ? quoteWindowsArgument : shellQuote).join(' ');
}

function xmlDecode(value) {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function xmlTag(source, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(source);
  return match ? xmlDecode(match[1].trim()) : null;
}

function plistValue(source, key, tag) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<key>\\s*${escaped}\\s*<\\/key>\\s*<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(source);
  return match ? xmlDecode(match[1].trim()) : null;
}

function launchdDefinitionMatches(task, source) {
  const registration = task.config.registration;
  const [hour, minute] = task.schedule.split(':').map(Number);
  const keys = [...String(source ?? '').matchAll(/<key>\s*([^<]+?)\s*<\/key>/gi)]
    .map((match) => xmlDecode(match[1].trim()));
  const expectedKeyCounts = new Map([
    ['Label', 1], ['ProgramArguments', 1], ['EnvironmentVariables', 1], ['TZ', 1],
    ['StartCalendarInterval', 1], ['Hour', 1], ['Minute', 1], ['RunAtLoad', 1],
  ]);
  if (keys.length !== [...expectedKeyCounts.values()].reduce((total, count) => total + count, 0)) return false;
  for (const [key, count] of expectedKeyCounts) {
    if (keys.filter((value) => value === key).length !== count) return false;
  }
  if (!/<key>\s*RunAtLoad\s*<\/key>\s*<false\s*\/>/i.test(source)) return false;
  const argsBlock = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(source)?.[1] ?? '';
  const args = [...argsBlock.matchAll(/<string>([\s\S]*?)<\/string>/gi)].map((match) => xmlDecode(match[1]));
  const intervals = [...String(source ?? '').matchAll(/<key>\s*StartCalendarInterval\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/gi)];
  if (intervals.length !== 1) return false;
  const interval = intervals[0][1];
  const actualHour = Number(plistValue(interval, 'Hour', 'integer'));
  const actualMinute = Number(plistValue(interval, 'Minute', 'integer'));
  const expectedArgs = expectedExecutionArgv(task);
  return Boolean(expectedArgs)
    && plistValue(source, 'Label', 'string') === registration.externalId
    && plistValue(source, 'TZ', 'string') === task.timezone
    && actualHour === hour
    && actualMinute === minute
    && args.length === expectedArgs.length
    && args.every((value, index) => value === expectedArgs[index]);
}

function launchctlBlocks(source, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^\\s*${escaped}\\s*=\\s*\\{\\s*$`, 'gmi');
  const blocks = [];
  for (const match of String(source ?? '').matchAll(matcher)) {
    const open = String(source).indexOf('{', match.index);
    let depth = 1;
    let quoted = false;
    let escapedCharacter = false;
    for (let index = open + 1; index < String(source).length; index += 1) {
      const character = String(source)[index];
      if (quoted) {
        if (escapedCharacter) escapedCharacter = false;
        else if (character === '\\') escapedCharacter = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(String(source).slice(open + 1, index));
          break;
        }
      }
    }
  }
  return blocks;
}

function launchctlBraceEntries(source) {
  const entries = [];
  let current = null;
  let depth = 0;
  for (const line of String(source ?? '').split(/\r?\n/)) {
    if (depth === 0) {
      if (!line.trim()) continue;
      const start = /^\s*(.+?)\s*=>\s*\{\s*$/.exec(line);
      if (!start) return null;
      current = { key: start[1], lines: [] };
      depth = 1;
      continue;
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    depth += opens - closes;
    if (depth < 0) return null;
    if (depth === 0) {
      if (line.trim() !== '}') return null;
      entries.push({ key: current.key, body: current.lines.join('\n') });
      current = null;
    } else {
      current.lines.push(line);
    }
  }
  return depth === 0 && current === null ? entries : null;
}

function launchctlTriggerFields(source) {
  const fields = new Map();
  let depth = 0;
  let descriptorCount = 0;
  for (const line of String(source ?? '').split(/\r?\n/)) {
    if (depth > 0) {
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (depth < 0) return null;
      continue;
    }
    if (!line.trim()) continue;
    const nested = /^\s*([A-Za-z][A-Za-z0-9 ]*)\s*=\s*\{\s*$/.exec(line);
    if (nested) {
      if (nested[1].trim() !== 'descriptor') return null;
      descriptorCount += 1;
      depth = 1;
      continue;
    }
    const scalar = /^\s*([A-Za-z][A-Za-z0-9 ]*)\s*=\s*(.+?)\s*$/.exec(line);
    const key = scalar?.[1].trim();
    if (!scalar || fields.has(key)) return null;
    fields.set(key, scalar[2].replace(/^"|"$/g, ''));
  }
  return depth === 0 ? { fields, descriptorCount } : null;
}

function launchdLoadedMatches(task, source) {
  const expectedArgs = expectedExecutionArgv(task);
  if (!expectedArgs) return false;
  const programs = [...String(source ?? '').matchAll(/^\s*program\s*=\s*(.+?)\s*$/gmi)]
    .map((match) => match[1].replace(/^"|"$/g, ''));
  const argumentBlocks = launchctlBlocks(source, 'arguments');
  if (programs.length !== 1 || programs[0] !== expectedArgs[0] || argumentBlocks.length !== 1) return false;
  const args = argumentBlocks[0].split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^"|"$/g, ''));
  if (args.length !== expectedArgs.length || !args.every((value, index) => value === expectedArgs[index])) return false;

  const environmentBlocks = launchctlBlocks(source, 'environment');
  if (environmentBlocks.length !== 1) return false;
  const timezoneValues = environmentBlocks[0].split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:"TZ"|TZ)\s*=>\s*(?:"([^"]*)"|(\S+))\s*$/.exec(line);
    return match ? [match[1] ?? match[2]] : [];
  });
  if (timezoneValues.length !== 1 || timezoneValues[0] !== task.timezone) return false;

  const eventBlocks = launchctlBlocks(source, 'event triggers');
  if (eventBlocks.length !== 1) return false;
  const triggers = launchctlBraceEntries(eventBlocks[0]);
  if (!triggers || triggers.length !== 1) return false;
  const trigger = launchctlTriggerFields(triggers[0].body);
  const allowedFields = new Set(['keepalive', 'service', 'stream', 'monitor']);
  if (!trigger
    || trigger.descriptorCount !== 1
    || trigger.fields.size !== allowedFields.size
    || [...trigger.fields.keys()].some((key) => !allowedFields.has(key))
    || trigger.fields.get('keepalive') !== '0'
    || trigger.fields.get('service') !== task.config.registration.externalId
    || trigger.fields.get('stream') !== 'com.apple.launchd.calendarinterval'
    || !trigger.fields.get('monitor')) return false;
  const descriptorBlocks = launchctlBlocks(triggers[0].body, 'descriptor');
  if (descriptorBlocks.length !== 1) return false;
  const descriptor = new Map();
  for (const line of descriptorBlocks[0].split(/\r?\n/).filter((item) => item.trim())) {
    const match = /^\s*"([A-Za-z]+)"\s*=>\s*(\d+)\s*$/.exec(line);
    if (!match || descriptor.has(match[1])) return false;
    descriptor.set(match[1], Number(match[2]));
  }
  const [hour, minute] = task.schedule.split(':').map(Number);
  return descriptor.size === 2
    && descriptor.get('Hour') === hour
    && descriptor.get('Minute') === minute;
}

function cronDefinitionMatches(task, source) {
  const begin = `# BEGIN CAREER JOURNAL ${task.id}`;
  const end = `# END CAREER JOURNAL ${task.id}`;
  const lines = String(source ?? '').split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line === begin ? [index] : []);
  const ends = lines.flatMap((line, index) => line === end ? [index] : []);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return false;
  const block = lines.slice(starts[0] + 1, ends[0]);
  const timezoneLines = block.filter((line) => line.startsWith('CRON_TZ='));
  if (timezoneLines.length !== 1 || timezoneLines[0] !== `CRON_TZ=${task.timezone}`) return false;
  const active = block.filter((line) => line.trim() && !line.trimStart().startsWith('#') && !line.startsWith('CRON_TZ='));
  if (active.length !== 1) return false;
  const schedule = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s+(.+)$/.exec(active[0]);
  if (!schedule) return false;
  const [expectedHour, expectedMinute] = task.schedule.split(':').map(Number);
  if (Number(schedule[1]) !== expectedMinute || Number(schedule[2]) !== expectedHour) return false;
  const expectedArgs = expectedExecutionArgv(task);
  return Boolean(expectedArgs)
    && schedule[3] === expectedArgs.map(shellQuote).join(' ');
}

const WINDOWS_START_CLOCK_SKEW_MS = 5 * 60 * 1000;
const WINDOWS_START_FUTURE_WINDOW_MS = 24 * 60 * 60 * 1000 + WINDOWS_START_CLOCK_SKEW_MS;

function windowsLocalTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/.exec(value ?? '');
  if (!match) return null;
  const parts = [...match.slice(1, 6).map(Number), Number(match[6] ?? 0)];
  const milliseconds = Number((match[7] ?? '').slice(0, 3).padEnd(3, '0'));
  const timestamp = Date.UTC(...parts.slice(0, 2).map((part, index) => index === 1 ? part - 1 : part), ...parts.slice(2), milliseconds);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== parts[0]
    || date.getUTCMonth() + 1 !== parts[1]
    || date.getUTCDate() !== parts[2]
    || date.getUTCHours() !== parts[3]
    || date.getUTCMinutes() !== parts[4]
    || date.getUTCSeconds() !== parts[5]) return null;
  return timestamp;
}

function wallClockNow(now, timezone) {
  const instant = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  } catch {
    return null;
  }
}

function windowsDefinitionMatches(task, source, options) {
  const [expectedHour, expectedMinute] = task.schedule.split(':').map(Number);
  const systemTimezone = options.systemTimezone
    ?? ((options.platform ?? process.platform) === process.platform && process.platform === 'win32'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : null);
  if (systemTimezone && systemTimezone !== task.timezone) return false;
  if (/<!--[\s\S]*?-->|<!\[CDATA\[/i.test(source)) return false;
  if (/<Enabled>\s*false\s*<\/Enabled>/i.test(source)) return false;
  const triggersBlock = /<Triggers(?:\s[^>]*)?>([\s\S]*?)<\/Triggers>/i.exec(source)?.[1];
  if (triggersBlock == null) return false;
  const triggerTags = [...triggersBlock.matchAll(/<([A-Za-z][A-Za-z0-9]*Trigger)(?:\s[^>]*)?>/g)]
    .map((match) => match[1]);
  if (triggerTags.length !== 1 || triggerTags[0] !== 'CalendarTrigger') return false;
  const calendars = [...triggersBlock.matchAll(/<CalendarTrigger(?:\s[^>]*)?>([\s\S]*?)<\/CalendarTrigger>/gi)];
  if (calendars.length !== 1) return false;
  const calendar = calendars[0][1];
  if (/<EndBoundary(?:\s[^>]*)?>|<Repetition(?:\s[^>]*)?>/i.test(calendar)) return false;
  const boundaries = [...calendar.matchAll(/<StartBoundary(?:\s[^>]*)?>([\s\S]*?)<\/StartBoundary>/gi)];
  const enabledTags = [...calendar.matchAll(/<Enabled(?:\s[^>]*)?>([\s\S]*?)<\/Enabled>/gi)];
  const boundary = boundaries.length === 1 ? xmlDecode(boundaries[0][1].trim()) : null;
  const boundaryTimestamp = windowsLocalTimestamp(boundary);
  const currentWallClock = wallClockNow(options.now, task.timezone);
  const time = boundary && /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,7})?)?$/.exec(boundary);
  const schedules = [...calendar.matchAll(/<ScheduleBy([A-Za-z]+)(?:\s[^>]*)?>([\s\S]*?)<\/ScheduleBy\1>/gi)];
  const unknownCalendarContent = calendar
    .replace(/<StartBoundary(?:\s[^>]*)?>[\s\S]*?<\/StartBoundary>/gi, '')
    .replace(/<Enabled(?:\s[^>]*)?>[\s\S]*?<\/Enabled>/gi, '')
    .replace(/<ScheduleBy[A-Za-z]+(?:\s[^>]*)?>[\s\S]*?<\/ScheduleBy[A-Za-z]+>/gi, '')
    .trim();
  if (!time
    || boundaries.length !== 1
    || enabledTags.length > 1
    || (enabledTags.length === 1 && enabledTags[0][1].trim().toLowerCase() !== 'true')
    || unknownCalendarContent
    || boundaryTimestamp == null
    || currentWallClock == null
    || boundaryTimestamp > currentWallClock + WINDOWS_START_FUTURE_WINDOW_MS
    || Number(time[1]) !== expectedHour
    || Number(time[2]) !== expectedMinute
    || schedules.length !== 1
    || schedules[0][1].toLowerCase() !== 'day'
    || !/^\s*<DaysInterval>\s*1\s*<\/DaysInterval>\s*$/i.test(schedules[0][2])) return false;
  const actionsBlock = /<Actions(?:\s[^>]*)?>([\s\S]*?)<\/Actions>/i.exec(source)?.[1];
  if (actionsBlock == null) return false;
  const actionTags = [...actionsBlock.matchAll(/<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?>/g)]
    .map((match) => match[1])
    .filter((tag) => !['Command', 'Arguments', 'WorkingDirectory'].includes(tag));
  const execs = [...actionsBlock.matchAll(/<Exec(?:\s[^>]*)?>([\s\S]*?)<\/Exec>/gi)];
  if (actionTags.length !== 1 || actionTags[0] !== 'Exec' || execs.length !== 1) return false;
  const exec = execs[0][1];
  const commandTags = [...exec.matchAll(/<Command(?:\s[^>]*)?>([\s\S]*?)<\/Command>/gi)];
  const argumentTags = [...exec.matchAll(/<Arguments(?:\s[^>]*)?>([\s\S]*?)<\/Arguments>/gi)];
  if (commandTags.length !== 1 || argumentTags.length > 1 || /<WorkingDirectory(?:\s[^>]*)?>/i.test(exec)) return false;
  const command = xmlDecode(commandTags[0][1].trim());
  const args = argumentTags.length === 1 ? xmlDecode(argumentTags[0][1].trim()) : null;
  const actualArgv = args == null ? [command] : [command, ...(parseWindowsCommandLine(args) ?? [])];
  const expectedArgs = expectedExecutionArgv(task);
  return Boolean(actualArgv && expectedArgs)
    && actualArgv.length === expectedArgs.length
    && actualArgv.every((value, index) => value === expectedArgs[index]);
}

async function readLaunchdDefinition(task, options) {
  if (typeof options.definitionContent === 'string') return options.definitionContent;
  const registration = task.config.registration;
  const osHome = path.resolve(options.osHome ?? os.homedir());
  const launchAgents = path.join(osHome, 'Library', 'LaunchAgents');
  const file = path.resolve(launchAgents, `${registration.externalId}.plist`);
  if (!file.startsWith(`${launchAgents}${path.sep}`)) throw new Error('launchd definition path is invalid');
  const details = await (options.lstat ?? lstat)(file);
  if (!details.isFile() || details.isSymbolicLink?.() || details.size > 1024 * 1024) {
    throw new Error('launchd definition is not a regular bounded file');
  }
  return (options.readFile ?? readFile)(file, 'utf8');
}

function parseTopLevelToml(source) {
  const fields = new Map();
  for (const line of String(source ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match || fields.has(match[1])) return null;
    let value;
    if (/^"(?:\\.|[^"\\])*"$/.test(match[2])) {
      try { value = JSON.parse(match[2]); } catch { return null; }
    } else if (/^[+-]?\d(?:_?\d)*$/.test(match[2])) {
      value = Number(match[2].replaceAll('_', ''));
      if (!Number.isSafeInteger(value)) return null;
    } else if (match[2] === 'true' || match[2] === 'false') {
      value = match[2] === 'true';
    } else {
      return null;
    }
    fields.set(match[1], value);
  }
  return fields;
}

function rruleMatchesSchedules(rrule, schedules) {
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYSECOND']);
  const fields = new Map();
  for (const token of String(rrule ?? '').split(';')) {
    const match = /^([A-Z]+)=([^;]+)$/.exec(token);
    if (!match || !allowed.has(match[1]) || fields.has(match[1])) return false;
    fields.set(match[1], match[2]);
  }
  const integerList = (value, max) => {
    if (!/^\d{1,2}(?:,\d{1,2})*$/.test(value ?? '')) return null;
    const values = value.split(',').map(Number);
    if (values.some((item) => item > max) || new Set(values).size !== values.length) return null;
    return values;
  };
  const hours = integerList(fields.get('BYHOUR'), 23);
  const minutes = integerList(fields.get('BYMINUTE'), 59);
  if (!hours || !minutes) return false;
  const actual = hours.flatMap((hour) => minutes.map((minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)).sort();
  const expected = [...new Set(schedules)].sort();
  return fields.get('FREQ') === 'DAILY'
    && (!fields.has('INTERVAL') || fields.get('INTERVAL') === '1')
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
    && (!fields.has('BYSECOND') || fields.get('BYSECOND') === '0');
}

async function probeCodex(task, options) {
  const registration = task.config.registration;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(registration.externalId)) {
    return { ok: false, detail: 'Codex automation id contains unsupported characters' };
  }
  const codexHome = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const automationRoot = path.join(codexHome, 'automations');
  const file = path.resolve(automationRoot, registration.externalId, 'automation.toml');
  if (!file.startsWith(`${automationRoot}${path.sep}`)) return { ok: false, detail: 'Codex automation path is invalid' };
  try {
    const details = await (options.stat ?? stat)(file);
    if (!details.isFile() || details.size > 1024 * 1024) return { ok: false, detail: 'Codex automation definition is not a regular bounded file' };
    const source = await (options.readFile ?? readFile)(file, 'utf8');
    const document = parseTopLevelToml(source);
    if (!document) return { ok: false, detail: 'Codex automation TOML is malformed or contains duplicate keys' };
    const version = document.get('version');
    const id = document.get('id');
    const kind = document.get('kind');
    const status = document.get('status');
    const prompt = document.get('prompt');
    const rrule = document.get('rrule');
    const targetThreadId = document.get('target_thread_id');
    if (version !== 1) return { ok: false, detail: 'Codex automation version must be 1' };
    if (id !== registration.externalId) return { ok: false, detail: 'Codex automation id does not match its directory' };
    if (kind !== 'heartbeat') return { ok: false, detail: 'Codex automation must use the heartbeat kind' };
    if (typeof targetThreadId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(targetThreadId)) {
      return { ok: false, detail: 'Codex automation target_thread_id is missing or invalid' };
    }
    if (status !== 'ACTIVE') return { ok: false, detail: 'Codex automation must be ACTIVE' };
    const systemTimezone = options.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (systemTimezone !== task.timezone) return { ok: false, detail: 'Codex host timezone does not match the task timezone' };
    const sharedSchedules = registration.sharedSchedules;
    const expectedSchedules = Array.isArray(sharedSchedules) && sharedSchedules.length > 1
      ? sharedSchedules.map((item) => item?.schedule)
      : [task.schedule];
    if (!rrule || !rruleMatchesSchedules(rrule, expectedSchedules)) return { ok: false, detail: 'Codex automation schedule does not match the task' };
    const expectedCommand = codexCommandLineForTask(task);
    const commandMatches = Boolean(expectedCommand)
      && prompt.split(/\r?\n/).some((line) => line === expectedCommand);
    if (!prompt
      || !commandMatches
      || !prompt.includes(task.timezone)) {
      return { ok: false, detail: 'Codex automation prompt must contain the exact registered CAREER JOURNAL command as a standalone line and the task timezone' };
    }
    return {
      ok: true,
      detail: `Codex automation ${registration.externalId} is ACTIVE with the expected binding`,
      evidenceDigest: evidenceDigest(source),
    };
  } catch (error) {
    return { ok: false, detail: `Codex automation probe failed: ${error.message}` };
  }
}

export async function probeTaskRegistration(task, options = {}) {
  if (!isCurrentTaskClaim(task)) {
    return { ok: false, detail: `${task.type} does not have a current registration claim` };
  }
  const registration = task.config.registration;
  const driver = registration.driver.toLowerCase();
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? execFileDefault;
  try {
    let result;
    if (driver === 'launchd') {
      if (platform !== 'darwin') return { ok: false, detail: 'launchd registration cannot be probed on this platform' };
      const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
      if (!Number.isInteger(uid)) return { ok: false, detail: 'launchd user domain is unavailable' };
      result = await execFile('launchctl', ['print', `gui/${uid}/${registration.externalId}`], { encoding: 'utf8' });
      const stdout = typeof result === 'string' ? result : result?.stdout ?? '';
      const definition = await readLaunchdDefinition(task, options);
      const systemTimezone = options.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (systemTimezone !== task.timezone || !launchdLoadedMatches(task, stdout) || !launchdDefinitionMatches(task, definition)) {
        return { ok: false, detail: `launchd job exists but its definition, command, schedule, or timezone does not match ${task.type}` };
      }
      return {
        ok: true,
        detail: `launchd job ${registration.externalId} is loaded with the expected command, schedule, and timezone`,
        evidenceDigest: evidenceDigest(`${stdout}\n${definition}`),
      };
    } else if (driver === 'cron') {
      if (platform === 'win32') return { ok: false, detail: 'cron registration cannot be probed on Windows' };
      result = await execFile('crontab', ['-l'], { encoding: 'utf8' });
    } else if (driver === 'schtasks') {
      if (platform !== 'win32') return { ok: false, detail: 'Windows Task Scheduler registration cannot be probed on this platform' };
      result = await execFile('schtasks.exe', ['/Query', '/TN', registration.externalId, '/XML'], { encoding: 'utf8' });
    } else if (driver === 'codex') {
      return probeCodex(task, options);
    } else {
      return { ok: false, detail: `scheduler driver ${driver} has no trusted verifier` };
    }
    const stdout = typeof result === 'string' ? result : result?.stdout ?? '';
    const matches = driver === 'cron'
      ? cronDefinitionMatches(task, stdout)
      : windowsDefinitionMatches(task, stdout, { ...options, platform });
    if (!matches) {
      return { ok: false, detail: `${driver} job exists but its command, schedule, or timezone does not match ${task.type}` };
    }
    return {
      ok: true,
      detail: `${driver} job ${registration.externalId} is installed with the expected command`,
      evidenceDigest: evidenceDigest(stdout),
    };
  } catch (error) {
    return { ok: false, detail: `${driver} probe failed: ${error.message}` };
  }
}
