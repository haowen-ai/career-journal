// Same-program sibling requisitions. Some employers post one internship program as one requisition per office
// (a Workday link per office: .../job/<Office>/<Title>_<Req>). On the live queue three of four such requisitions were
// withdrawn as duplicates of one representative chosen by fit, not by office; when that representative was later
// withdrawn for another reason, an apply batch picked a remaining requisition whose office is outside the profile's
// area and never saw that an in-area requisition of the same program was still queued.
// Rulings:
//   PS1  A Workday requisition's office is the path segment before the job slug. It is the requisition's own office,
//        whatever extra locations the posting or a board lists (the stored location column may list other offices).
//   PS2  Applications of one company with the same title (title similarity >= DUPLICATE_THRESHOLD) are one program.
//        A queued lead that has program siblings carries `program`: every member with its office, area verdict,
//        status and skip reason, and the representative.
//   PS3  The representative is a submitted member inside the area if one exists; otherwise the best in-area member,
//        preferring open (lead/prepared) members, then the profile's location rank, then fit. An out-of-area member is
//        never the representative, even with a higher fit or already submitted; with no in-area member there is none.
//   PS4  A queued lead that is not the representative is flagged (programOk false, with a note naming the
//        representative) and listed after every representative or lone lead.
//   PS5  `queue siblings --id <application> | --url <job link>` shows the same program view for any application,
//        whatever its status, so a batch picked from outside the queue also sees the in-area requisition.
//   PS6  Different titles are different programs; a lone lead carries no `program` and lists as before.
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, seedApplication } from '../../test-utils/funnel-v3.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { listQueue } from '../../src/commands/queue.mjs';
import { requisitionLocation } from '../../src/scan/dedupe.mjs';

const COMPANY = 'Sibling Example Bank';
const PROFILE = Object.freeze({
  search: {
    remoteOk: false,
    locations: [
      { label: 'New York, NY', match: ['new york', 'nyc'] },
      { label: 'California', match: ['california', 'los angeles', 'san diego', 'ca'] },
    ],
  },
});
const wd = (office, req, title = 'Product-Intern') => `https://siblingbank.wd5.myworkdayjobs.com/Ext/job/${office}/${title}_${req}`;

function seed(db, { req, office, status = 'lead', fit = 'medium', location = null, role = 'Product Intern', skipReason = null }) {
  const row = seedApplication(db, { company: COMPANY, role, jobUrl: wd(office, req), externalId: req, status, fit, skipReason });
  if (location) db.prepare('UPDATE applications SET location = ? WHERE id = ?').run(location, row.id);
  return row.id;
}
const item = (items, id) => items.find((entry) => entry.id === id);

test('PS1 the Workday office segment is the requisition office; other links have none', () => {
  assert.equal(requisitionLocation(wd('Edison-NJ', 'JR9003')), 'Edison NJ');
  assert.equal(requisitionLocation(wd('HQ---San-Diego-CA', 'JR9002')), 'HQ San Diego CA');
  assert.equal(requisitionLocation('https://siblingbank.wd5.myworkdayjobs.com/en-US/Ext/job/Los-Angeles-CA/Product-Intern_JR9001'), 'Los Angeles CA');
  assert.equal(requisitionLocation('https://job-boards.greenhouse.io/siblingbank/jobs/4000001'), null);
  assert.equal(requisitionLocation('not a url'), null);
});

test('PS2-PS4 an out-of-area requisition with a higher fit is flagged; the in-area sibling is the representative', () => {
  const db = freshDb();
  // The stored location column of the Edison requisition lists the program's other offices (as a board did live).
  const edison = seed(db, { req: 'JR9003', office: 'Edison-NJ', fit: 'high', location: 'San Diego, CA; Edison, NJ' });
  const sanDiego = seed(db, { req: 'JR9002', office: 'HQ---San-Diego-CA', fit: 'medium' });
  const losAngeles = seed(db, { req: 'JR9001', office: 'Los-Angeles-CA', status: 'withdrawn', fit: 'high', skipReason: 'Role direction rule' });
  const lone = seedApplication(db, { company: COMPANY, role: 'Automation Analyst Intern', jobUrl: wd('Edison-NJ', 'JR9010', 'Automation-Analyst-Intern'), fit: 'low' }).id;

  const items = listQueue(db, PROFILE);
  assert.deepEqual(items.map((entry) => entry.id), [sanDiego, lone, edison], 'the flagged sibling lists after every representative or lone lead');

  const flagged = item(items, edison);
  assert.equal(flagged.programOk, false);
  assert.equal(flagged.program.representative, sanDiego, 'never the out-of-area requisition, whatever its fit');
  assert.match(flagged.programNote, /Edison NJ/);
  assert.match(flagged.programNote, new RegExp(sanDiego));
  const members = Object.fromEntries(flagged.program.members.map((member) => [member.id, member]));
  assert.deepEqual(Object.keys(members).sort(), [edison, sanDiego, losAngeles].sort());
  assert.equal(members[edison].location, 'Edison NJ', 'the requisition office wins over the stored location column');
  assert.equal(members[edison].inArea, false);
  assert.equal(members[sanDiego].inArea, true);
  assert.equal(members[losAngeles].status, 'withdrawn');
  assert.equal(members[losAngeles].skipReason, 'Role direction rule');

  const kept = item(items, sanDiego);
  assert.equal(kept.programOk, true);
  assert.equal(kept.program.representative, sanDiego);
  assert.match(kept.programNote, /JR9003|Edison/);

  assert.equal(item(items, lone).program, undefined, 'PS6 a different title is a different program');
  assert.equal(item(items, lone).programOk, undefined);
});

test('PS3 an in-area submitted sibling is the representative and the open requisitions are flagged', () => {
  const db = freshDb();
  const applied = seed(db, { req: 'JR9101', office: 'Los-Angeles-CA', status: 'applied' });
  const open = seed(db, { req: 'JR9102', office: 'HQ---San-Diego-CA' });
  const [entry] = listQueue(db, PROFILE);
  assert.equal(entry.id, open);
  assert.equal(entry.programOk, false);
  assert.equal(entry.program.representative, applied);
  assert.match(entry.programNote, /submitted/i);
});

test('PS3 an out-of-area submission never represents the program: the in-area requisition stays applicable', () => {
  const db = freshDb();
  const applied = seed(db, { req: 'JR9111', office: 'Edison-NJ', status: 'applied' });
  const open = seed(db, { req: 'JR9112', office: 'HQ---San-Diego-CA' });
  const [entry] = listQueue(db, PROFILE);
  assert.equal(entry.id, open);
  assert.equal(entry.programOk, true);
  assert.equal(entry.program.representative, open);
  assert.match(entry.programNote, new RegExp(`${applied}.*outside the profile area`));
});

test('PS3 with no in-area member there is no representative and no lead is preferred over another', () => {
  const db = freshDb();
  const one = seed(db, { req: 'JR9201', office: 'Edison-NJ' });
  const two = seed(db, { req: 'JR9202', office: 'Omaha-NE' });
  const items = listQueue(db, PROFILE);
  for (const id of [one, two]) {
    assert.equal(item(items, id).program.representative, null);
    assert.equal(item(items, id).programOk, false);
    assert.match(item(items, id).programNote, /no requisition .*in the profile area/i);
  }
});

test('PS5 queue siblings shows the program for a withdrawn application, by id or by link', async () => {
  const { setup } = await import('../../src/commands/setup.mjs');
  const { runCli } = await import('../../src/cli/main.mjs');
  const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
  const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-siblings-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const profileDir = path.join(home, '.career-journal', 'profile');
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const profile = JSON.parse(await readFile(new URL('../fixtures/scan/profile.json', import.meta.url), 'utf8'));
    profile.search = { ...profile.search, ...PROFILE.search };
    await writeFile(path.join(profileDir, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
    const context = await openHomeDatabase(home);
    let edison;
    let sanDiego;
    try {
      edison = seed(context.db, { req: 'JR9303', office: 'Edison-NJ', status: 'withdrawn', fit: 'high', skipReason: 'Duplicate program' });
      sanDiego = seed(context.db, { req: 'JR9302', office: 'HQ---San-Diego-CA' });
    } finally { context.db.close(); }
    const run = async (args) => {
      const io = memoryIO();
      const code = await runCli(args, io, createRuntime({ root: process.cwd(), version: 'test' }));
      assert.equal(code, 0, io.stderr);
      return io.stdout;
    };
    const byId = JSON.parse(await run(['queue', 'siblings', '--id', edison, '--home', home, '--json']));
    assert.equal(byId.representative, sanDiego);
    assert.deepEqual(byId.members.map((member) => member.id).sort(), [edison, sanDiego].sort());
    const byUrl = JSON.parse(await run(['queue', 'siblings', '--url', `${wd('Edison-NJ', 'JR9303')}?source=board`, '--home', home, '--json']));
    assert.equal(byUrl.representative, sanDiego);
    const text = await run(['queue', 'siblings', '--id', edison, '--home', home]);
    assert.match(text, /Edison NJ/);
    assert.match(text, /HQ San Diego CA/);
    assert.match(text, new RegExp(`apply via ${sanDiego}`));
  } finally { await rm(home, { recursive: true, force: true }); }
});
