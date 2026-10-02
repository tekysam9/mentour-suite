require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const path = require('path');
const mysql = require('mysql2/promise');
const { backfillOrg, findOrphans } = require('../scripts/backfill-client-program-swap');

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;

function check(label, cond, extra) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; console.log('FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// Minimal cookie jar per "session" so we can hold multiple logged-in users at once.
function makeJar() {
  let cookie = null;
  return {
    async fetch(pathName, opts = {}) {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + pathName, Object.assign({}, opts, { headers }));
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch (e) { /* no body */ }
      return { status: res.status, body };
    },
  };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe' });
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d.toString(); });
  server.stderr.on('data', (d) => { serverOut += d.toString(); });

  // wait for it to be ready
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch(BASE + '/api/auth/me');
      if (res.status === 401) { ready = true; break; }
    } catch (e) { /* not up yet */ }
  }
  if (!ready) {
    console.log('Server never became ready. Log:\n' + serverOut);
    server.kill();
    process.exit(1);
  }
  console.log('Server is up.\n');

  try {
    const owner = makeJar();
    const teammate = makeJar();
    const otherOrgUser = makeJar();

    // 1. Signup
    let r = await owner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Mentour Corp', name: 'Alex Owner', email: 'alex@mentourcorp.com', password: 'correcthorsebattery' }) });
    check('signup returns 201', r.status === 201, r);
    check('signup returns invite code', r.body && r.body.user && r.body.user.organization && r.body.user.organization.inviteCode, r.body);
    const inviteCode = r.body.user.organization.inviteCode;

    // 2. Duplicate email
    r = await makeJar().fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'X', name: 'Dup', email: 'alex@mentourcorp.com', password: 'correcthorsebattery' }) });
    check('duplicate email signup returns 409', r.status === 409, r);

    // 3. Weak password
    r = await makeJar().fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'X', name: 'Y', email: 'weak@test.com', password: '123' }) });
    check('weak password returns 400', r.status === 400, r);

    // 4. /me while logged in
    r = await owner.fetch('/api/auth/me');
    check('/me returns 200 while logged in', r.status === 200, r);
    check('/me returns correct email', r.body.user.email === 'alex@mentourcorp.com', r.body);

    // 5. Logout then /me
    r = await owner.fetch('/api/auth/logout', { method: 'POST' });
    check('logout returns 200', r.status === 200, r);
    r = await owner.fetch('/api/auth/me');
    check('/me returns 401 after logout', r.status === 401, r);

    // 6. Login again
    r = await owner.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alex@mentourcorp.com', password: 'correcthorsebattery' }) });
    check('login returns 200', r.status === 200, r);

    // 7. Wrong password
    r = await makeJar().fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alex@mentourcorp.com', password: 'nope' }) });
    check('wrong password returns 401', r.status === 401, r);

    // 8. Teammate joins via invite
    r = await teammate.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode, name: 'Sam Teammate', email: 'sam@mentourcorp.com', password: 'anotherlongpassword' }) });
    check('teammate join returns 201', r.status === 201, r);
    check('teammate is a member (not owner)', r.body.user.role === 'member', r.body);
    check('teammate lands in same org', r.body.user.organization.name === 'Mentour Corp', r.body);

    // 9. Bad invite code
    r = await makeJar().fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: 'doesnotexist', name: 'Bad', email: 'bad@test.com', password: 'anotherlongpassword' }) });
    check('bad invite code returns 404', r.status === 404, r);

    // 10. Unauthenticated access to protected route
    r = await makeJar().fetch('/api/ledger/latest');
    check('unauthenticated /api/ledger/latest returns 401', r.status === 401, r);

    // 11. Save a ledger import as owner
    const ledgerPayload = { kpis: { totalConsultants: 55, totalCost: 3604452.66 }, consultants: [{ name: 'Rob Rosales', totalCost: 595587.42 }] };
    r = await owner.fetch('/api/ledger', { method: 'POST', body: JSON.stringify({ fileName: '2026_Sub_Vendors_payments.xlsx', data: ledgerPayload }) });
    check('save ledger import returns 201', r.status === 201, r);

    // 12. Owner can read it back, with data intact
    r = await owner.fetch('/api/ledger/latest');
    check('get latest ledger returns 200', r.status === 200, r);
    check('latest ledger data round-trips correctly', r.body.import && r.body.import.data && r.body.import.data.kpis.totalConsultants === 55, r.body);

    // 13. Teammate (same org) sees the SAME data
    r = await teammate.fetch('/api/ledger/latest');
    check('teammate sees same org data', r.body.import && r.body.import.data.kpis.totalConsultants === 55, r.body);

    // 14. A second, unrelated organization signs up
    r = await otherOrgUser.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Second Company LLC', name: 'Jordan', email: 'jordan@secondco.com', password: 'differentpassword1' }) });
    check('second org signup returns 201', r.status === 201, r);

    // 15. ISOLATION: second org must NOT see first org's data
    r = await otherOrgUser.fetch('/api/ledger/latest');
    check('second org sees no ledger data (isolation)', r.status === 200 && r.body.import === null, r.body);

    // 16. Save a second ledger import, check history ordering
    r = await owner.fetch('/api/ledger', { method: 'POST', body: JSON.stringify({ fileName: '2026_v2.xlsx', data: { kpis: { totalConsultants: 56 } } }) });
    check('save second ledger import returns 201', r.status === 201, r);
    r = await owner.fetch('/api/ledger/history');
    check('history returns 2 entries', r.status === 200 && r.body.history.length === 2, r.body);
    check('history is newest-first', r.body.history[0].file_name === '2026_v2.xlsx', r.body.history);

    // 17. Fetch a specific historical import by id, scoped correctly
    const oldId = r.body.history[1].id;
    r = await owner.fetch('/api/ledger/' + oldId);
    check('fetch specific import by id works', r.status === 200 && r.body.import.data.kpis.totalConsultants === 55, r.body);

    // 18. Second org cannot fetch first org's import by guessing the id (cross-tenant access check)
    r = await otherOrgUser.fetch('/api/ledger/' + oldId);
    check('cross-tenant fetch by id blocked (404, not data leak)', r.status === 404, r);

    // 19. Margin import is a totally separate table/dataset
    r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'Gross_Margin.xlsx', data: { kpis: { activeCount: 39 } } }) });
    check('save margin import returns 201', r.status === 201, r);
    r = await owner.fetch('/api/margin/latest');
    check('margin latest is independent of ledger data', r.body.import.data.kpis.activeCount === 39, r.body);
    r = await owner.fetch('/api/ledger/latest');
    check('ledger data unaffected by margin save', r.body.import.data.kpis.totalConsultants === 56, r.body);

    // 20. A Margin upload with real roster records also lands in
    // margin_roster_entries as normalized rows, not just the JSON blob —
    // including a malformed record (no name) being skipped rather than
    // failing the whole save, and a second org's rows staying separate.
    const rosterPayload = {
      fileName: 'Roster.xlsx',
      data: {
        kpis: { activeCount: 2 },
        records: [
          {
            name: 'Jordan Blake', client: 'Platform', program: 'Acme', clientDetail: 'Platform',
            cost: 85.5, billing: 140, margin: 54.5, status: 'Active', joined: '2023-01-15',
            leftText: null, leftDate: null, recruiter: 'Sam Lee',
            subvendorText: 'W2', employmentType: 'W2 (direct)', sourceSheet: 'Total',
          },
          {
            name: 'Priya Natarajan', client: 'Globex', program: 'Globex', clientDetail: null,
            cost: 90, billing: 150, margin: 60, status: 'Left', joined: '2022-06-01',
            leftText: null, leftDate: '2026-03-01T00:00:00.000Z', recruiter: null,
            subvendorText: 'Vendor Co', employmentType: 'Subvendor', sourceSheet: 'Left 2026',
          },
          { name: null, client: 'Should be skipped', program: 'X', cost: 1, billing: 2, margin: 1, status: 'Active' },
        ],
      },
    };
    r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify(rosterPayload) });
    check('save margin roster returns 201', r.status === 201, r);
    const marginImportId = r.body.import.id;

    r = await otherOrgUser.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'Other.xlsx', data: { kpis: {}, records: [{ name: 'Not Mine', program: 'Y', status: 'Active' }] } }) });
    check('second org margin roster save returns 201', r.status === 201, r);

    const dbConn = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });
    try {
      const [rosterRows] = await dbConn.query(
        'SELECT name, program, cost, billing, margin, status, employment_type, left_date FROM margin_roster_entries WHERE import_id = ? ORDER BY name',
        [marginImportId]
      );
      check('malformed record (no name) skipped, valid two kept', rosterRows.length === 2, rosterRows);
      check('roster row has correct numeric/text fields', rosterRows[0] &&
        rosterRows[0].name === 'Jordan Blake' && Number(rosterRows[0].cost) === 85.5 &&
        rosterRows[0].employment_type === 'W2 (direct)', rosterRows[0]);
      // mysql2 returns DATE columns as JS Date objects at local midnight;
      // String(date) gives a locale-formatted string, not ISO, and
      // toISOString() can shift the calendar day across timezones. Compare
      // the local date parts MySQL actually stored instead.
      const ld = rosterRows[1] && rosterRows[1].left_date;
      const ldStr = ld && `${ld.getFullYear()}-${String(ld.getMonth() + 1).padStart(2, '0')}-${String(ld.getDate()).padStart(2, '0')}`;
      check('roster row parses a real left_date', rosterRows[1] &&
        rosterRows[1].name === 'Priya Natarajan' && ldStr === '2026-03-01', { row: rosterRows[1], parsed: ldStr });

      const [orgCounts] = await dbConn.query(
        `SELECT o.name AS org_name, COUNT(*) AS n FROM margin_roster_entries m
         JOIN organizations o ON o.id = m.organization_id
         GROUP BY o.id ORDER BY o.id`
      );
      check('roster rows stay scoped to their own organization (no cross-tenant mixing)',
        orgCounts.length === 2 && orgCounts.every((row) => row.n > 0), orgCounts);

      // 21. The Margin upload above should have populated the directory:
      // a consultant for each named person, a client for each real
      // end-client name (the post-slash text in "Client / Account", e.g.
      // "Acme / Platform" names client "Platform"), a program for each
      // pre-slash Program value under its client, and a subvendor only for
      // the row whose employment type is actually 'Subvendor' (the W2
      // row's subvendorText is a marker, not a real vendor name).
      r = await owner.fetch('/api/directory/consultants');
      check('directory consultants populated from margin upload', r.status === 200 &&
        r.body.consultants.length === 2 &&
        r.body.consultants.some((c) => c.name === 'Jordan Blake') &&
        r.body.consultants.some((c) => c.name === 'Priya Natarajan'), r.body);

      r = await owner.fetch('/api/directory/clients');
      check('directory clients populated from the post-slash Client / Account text', r.status === 200 &&
        r.body.clients.length === 2 &&
        r.body.clients.some((c) => c.name === 'Platform') &&
        r.body.clients.some((c) => c.name === 'Globex'), r.body);

      r = await owner.fetch('/api/directory/programs');
      check('directory programs populated from the pre-slash Program value, linked to its client', r.status === 200 &&
        r.body.programs.length === 1 &&
        r.body.programs[0].name === 'Acme' && r.body.programs[0].client_name === 'Platform', r.body);

      r = await owner.fetch('/api/directory/subvendors');
      check('directory subvendors only created for real Subvendor rows (W2 marker excluded)',
        r.status === 200 && r.body.subvendors.length === 1 && r.body.subvendors[0].name === 'Vendor Co', r.body);

      // 21a. "Seen in" usage detail: the margin_rows/ledger_rows counts on
      // each directory record expand into the actual upload rows behind
      // them (file name, date, and the row's own detail) via a generic
      // usage route shared by all four tabs.
      const jordanForUsage = (await owner.fetch('/api/directory/consultants')).body.consultants.find((c) => c.name === 'Jordan Blake');
      r = await owner.fetch('/api/directory/consultants/' + jordanForUsage.id + '/usage');
      check('consultant usage detail returns the margin upload row behind its count', r.status === 200 &&
        r.body.margin.length === 1 && r.body.margin[0].file_name === 'Roster.xlsx' &&
        r.body.margin[0].client === 'Platform' && r.body.margin[0].program === 'Acme' &&
        Number(r.body.margin[0].billing) === 140, r.body);

      const platformClient = (await owner.fetch('/api/directory/clients')).body.clients.find((c) => c.name === 'Platform');
      r = await owner.fetch('/api/directory/clients/' + platformClient.id + '/usage');
      check('client usage detail shows which consultant the row belongs to', r.status === 200 &&
        r.body.margin.length === 1 && r.body.margin[0].name === 'Jordan Blake', r.body);

      const acmeProgram = (await owner.fetch('/api/directory/programs')).body.programs.find((p) => p.name === 'Acme');
      r = await owner.fetch('/api/directory/programs/' + acmeProgram.id + '/usage');
      check('program usage detail returns its margin row', r.status === 200 &&
        r.body.margin.length === 1 && r.body.margin[0].client === 'Platform', r.body);

      r = await owner.fetch('/api/directory/consultants/999999/usage');
      check('usage detail for an unknown record returns 404', r.status === 404, r);

      r = await otherOrgUser.fetch('/api/directory/consultants/' + jordanForUsage.id + '/usage');
      check('cross-tenant usage detail blocked (404)', r.status === 404, r);

      r = await owner.fetch('/api/directory/bogus-table/1/usage');
      check('usage detail for an unknown table returns 400', r.status === 400, r);

      // 21b. Status auto-syncs from this first upload: Jordan's row said
      // Active, Priya's said Left, so that's what each directory record
      // (and the client/program Jordan's row rolled up into) should show —
      // unlike email/phone/address, status is allowed to track the upload.
      r = await owner.fetch('/api/directory/consultants');
      check('consultant status set from upload (Active)',
        r.body.consultants.find((c) => c.name === 'Jordan Blake').status === 'active', r.body.consultants);
      check('consultant status set from upload (Left -> inactive)',
        r.body.consultants.find((c) => c.name === 'Priya Natarajan').status === 'inactive', r.body.consultants);

      r = await owner.fetch('/api/directory/clients');
      check('client status active when its row is Active', r.body.clients.find((c) => c.name === 'Platform').status === 'active', r.body.clients);
      check('client status inactive when its row is Left', r.body.clients.find((c) => c.name === 'Globex').status === 'inactive', r.body.clients);

      r = await owner.fetch('/api/directory/programs');
      check('program status active alongside its client', r.body.programs.find((p) => p.name === 'Acme').status === 'active', r.body.programs);

      r = await owner.fetch('/api/directory/consultants');
      const jordanRecord = r.body.consultants.find((c) => c.name === 'Jordan Blake');
      check('consultant found for editing', !!jordanRecord, r.body);
      check('consultant list reports its assignment count', jordanRecord.assignment_count === 1, jordanRecord);
      check('consultant list embeds the assignment itself (Client/Program and Billing columns need no extra fetch)',
        Array.isArray(jordanRecord.assignments) && jordanRecord.assignments.length === 1 &&
        jordanRecord.assignments[0].client_name === 'Platform' && jordanRecord.assignments[0].program_name === 'Acme' &&
        Number(jordanRecord.assignments[0].billing) === 140, jordanRecord);

      // 21c. The Margin upload auto-populated a billing assignment for
      // Jordan's one pairing (client "Platform", program "Acme", $140/hr)
      // — this is the same consultant_assignments row the Directory's
      // Consultants tab would expand to show.
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments');
      check('billing assignment auto-populated from upload', r.status === 200 &&
        r.body.assignments.length === 1 && r.body.assignments[0].client_name === 'Platform' &&
        r.body.assignments[0].program_name === 'Acme' && Number(r.body.assignments[0].billing) === 140 &&
        r.body.assignments[0].source === 'upload', r.body);

      r = await otherOrgUser.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments');
      check('cross-tenant assignment list blocked (404)', r.status === 404, r);

      // A second, unrelated engagement for the same consultant — added by
      // hand rather than from a file, which is the whole point: one
      // consultant, more than one billing rate at once.
      const globexClient = (await owner.fetch('/api/directory/clients')).body.clients.find((c) => c.name === 'Globex');
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments', {
        method: 'POST', body: JSON.stringify({ client_id: globexClient.id, billing: 99.99 }),
      });
      check('manually adding a second assignment returns 201', r.status === 201 &&
        r.body.assignment.client_name === 'Globex' && r.body.assignment.program_id === null &&
        Number(r.body.assignment.billing) === 99.99 && r.body.assignment.source === 'manual', r.body);
      const manualAssignmentId = r.body.assignment.id;

      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments', {
        method: 'POST', body: JSON.stringify({ client_id: 999999, billing: 10 }),
      });
      check('adding an assignment against an unknown client is rejected', r.status === 400, r);

      r = await owner.fetch('/api/directory/consultants');
      const jordanWithTwo = r.body.consultants.find((c) => c.name === 'Jordan Blake');
      check('consultant list reflects both assignments embedded, not just the count',
        jordanWithTwo.assignment_count === 2 && jordanWithTwo.assignments.length === 2 &&
        jordanWithTwo.assignments.some((a) => a.client_name === 'Globex' && Number(a.billing) === 99.99), jordanWithTwo);

      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments');
      check('consultant now shows both assignments', r.body.assignments.length === 2, r.body.assignments);

      r = await owner.fetch('/api/directory/assignments/' + manualAssignmentId, {
        method: 'PATCH', body: JSON.stringify({ billing: 120.5 }),
      });
      check('editing a manual assignment’s billing returns 200', r.status === 200 && Number(r.body.assignment.billing) === 120.5, r.body);

      r = await otherOrgUser.fetch('/api/directory/assignments/' + manualAssignmentId, {
        method: 'PATCH', body: JSON.stringify({ billing: 1 }),
      });
      check('cross-tenant assignment edit blocked (404)', r.status === 404, r);

      r = await owner.fetch('/api/directory/assignments/' + manualAssignmentId, { method: 'DELETE' });
      check('deleting an assignment returns ok', r.status === 200 && r.body.ok === true, r);

      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments');
      check('deleted assignment no longer listed', r.body.assignments.length === 1, r.body.assignments);

      // 22. Editing a consultant's contact details persists...
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id, {
        method: 'PATCH', body: JSON.stringify({ email: 'jordan@acme.test', phone: '555-0100', address: '1 Acme Way' }),
      });
      check('consultant edit returns 200 with updated fields', r.status === 200 &&
        r.body.record.email === 'jordan@acme.test' && r.body.record.phone === '555-0100', r.body);

      // 23. ...and a second org can't edit (or see) the first org's directory.
      r = await otherOrgUser.fetch('/api/directory/consultants/' + jordanRecord.id, {
        method: 'PATCH', body: JSON.stringify({ email: 'hijacked@evil.test' }),
      });
      check('cross-tenant directory edit blocked (404)', r.status === 404, r);

      // 24. ...and survives a second, unrelated upload touching the same org
      // (upsert must never overwrite existing contact details).
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'Roster2.xlsx',
        data: { kpis: {}, records: [{ name: 'Jordan Blake', client: 'Platform', program: 'Acme', clientDetail: 'Platform', cost: 86, billing: 141, margin: 55, status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2' }] },
      }) });
      check('second margin upload for same consultant returns 201', r.status === 201, r);
      r = await owner.fetch('/api/directory/consultants');
      const jordanAfter = r.body.consultants.find((c) => c.name === 'Jordan Blake');
      check('edited contact details survive a later import (not overwritten)',
        jordanAfter && jordanAfter.email === 'jordan@acme.test' && jordanAfter.margin_rows === 2, jordanAfter);

      // 25. A Ledger upload naming the same consultant and the same
      // subvendor resolves to the SAME directory records, not new ones —
      // the whole point of sharing the directory across both tools.
      r = await owner.fetch('/api/ledger', { method: 'POST', body: JSON.stringify({
        fileName: 'LedgerRoster.xlsx',
        data: {
          kpis: {},
          consultants: [{
            name: 'Jordan Blake', status: 'Active',
            placements: [{ subvendor: 'Vendor Co', period: 'Jan 2026', name: 'Jordan Blake', amount: 5000, rate: 85, hours: 160, month: 'Jan 2026', clientTag: 'HCL' }],
          }],
        },
      }) });
      check('ledger upload with roster consultants returns 201', r.status === 201, r);

      r = await owner.fetch('/api/directory/consultants');
      const jordanShared = r.body.consultants.find((c) => c.name === 'Jordan Blake');
      check('same consultant record used across Ledger and Margin (shared identity)',
        jordanShared && jordanShared.id === jordanRecord.id &&
        jordanShared.margin_rows === 2 && jordanShared.ledger_rows === 1 &&
        jordanShared.email === 'jordan@acme.test', jordanShared);

      r = await owner.fetch('/api/directory/subvendors');
      check('subvendor "Vendor Co" shared across Ledger and Margin, not duplicated',
        r.body.subvendors.length === 1 && r.body.subvendors[0].ledger_rows === 1 && r.body.subvendors[0].margin_rows === 1,
        r.body.subvendors);

      // Usage detail should now show both an upload's worth of Margin rows
      // and the one Ledger row, with the Ledger row's own fields intact.
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/usage');
      check('consultant usage detail includes both Margin and Ledger uploads', r.status === 200 &&
        r.body.margin.length === 2 && r.body.ledger.length === 1 &&
        r.body.ledger[0].file_name === 'LedgerRoster.xlsx' && r.body.ledger[0].client_tag === 'HCL' &&
        Number(r.body.ledger[0].amount) === 5000, r.body);

      const [ledgerRosterRows] = await dbConn.query(
        'SELECT name, subvendor_text, client_tag, amount, consultant_id, subvendor_id FROM ledger_roster_entries WHERE consultant_id = ?',
        [jordanRecord.id]
      );
      check('ledger_roster_entries row written with correct fields and linked ids',
        ledgerRosterRows.length === 1 && ledgerRosterRows[0].name === 'Jordan Blake' &&
        Number(ledgerRosterRows[0].amount) === 5000 && ledgerRosterRows[0].consultant_id === jordanRecord.id,
        ledgerRosterRows);

      // 26. Only Margin sets Active/Inactive; Ledger (payments) never does.
      // The ledger upload above used "Vendor Co" for a currently-active
      // consultant (Jordan), but Vendor Co keeps the inactive status its
      // Margin row (Priya, Left) gave it.
      r = await owner.fetch('/api/directory/subvendors');
      check('Ledger does not change the status of a subvendor that appears in Margin (stays inactive)',
        r.body.subvendors.find((s) => s.name === 'Vendor Co').status === 'inactive', r.body.subvendors);

      // 26a. Margin says Active (consultant and subvendor), then a Ledger
      // upload says Left -> both stay Active; Margin says Left, Ledger says
      // Active -> stays inactive. Records only ever seen in Ledger get no
      // status at all ("Not set"), and later Ledger uploads don't give them one.
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'RosterSub.xlsx',
        data: { kpis: {}, records: [{
          name: 'Sam Sublet', client: 'SubCo', program: 'SubCo', cost: 60, billing: 95, margin: 35,
          status: 'Active', employmentType: 'Subvendor', subvendorText: 'Margin Vendor',
        }] },
      }) });
      check('margin upload (Sam Sublet Active via Margin Vendor) returns 201', r.status === 201, r);

      const ledgerPrecedence = (fileName, consultants) => owner.fetch('/api/ledger', { method: 'POST', body: JSON.stringify({
        fileName, data: { kpis: {}, consultants: consultants.map(([name, status, subvendor]) => ({
          name, status, placements: [{ subvendor, period: 'Feb 2026', name, amount: 1000, rate: 50, hours: 20, month: 'Feb 2026', clientTag: 'HCL' }],
        })) },
      }) });
      r = await ledgerPrecedence('LedgerStatus1.xlsx', [
        ['Sam Sublet', 'Left', 'Margin Vendor'],
        ['Jordan Blake', 'Left', 'Vendor Co'],
        ['Priya Natarajan', 'Active', 'Vendor Co'],
        ['Lena Ledger', 'Active', 'Ledger Only Vendor'],
      ]);
      check('ledger upload with statuses that disagree with Margin returns 201', r.status === 201, r);

      r = await owner.fetch('/api/directory/consultants');
      check('Margin Active, then Ledger Left -> consultant stays active',
        r.body.consultants.find((c) => c.name === 'Sam Sublet').status === 'active' &&
        r.body.consultants.find((c) => c.name === 'Jordan Blake').status === 'active', r.body.consultants);
      check('Margin Left, then Ledger Active -> consultant stays inactive',
        r.body.consultants.find((c) => c.name === 'Priya Natarajan').status === 'inactive', r.body.consultants);
      check('ledger-only consultant is created with no status (not set), not the Ledger status',
        r.body.consultants.find((c) => c.name === 'Lena Ledger').status === null, r.body.consultants);
      r = await owner.fetch('/api/directory/subvendors');
      check('Margin Active, then Ledger (only Left consultants) -> subvendor stays active',
        r.body.subvendors.find((s) => s.name === 'Margin Vendor').status === 'active', r.body.subvendors);
      check('ledger-only subvendor is created with no status (not set)',
        r.body.subvendors.find((s) => s.name === 'Ledger Only Vendor').status === null, r.body.subvendors);

      r = await ledgerPrecedence('LedgerStatus2.xlsx', [['Lena Ledger', 'Left', 'Ledger Only Vendor']]);
      check('second ledger upload (Lena Left) returns 201', r.status === 201, r);
      r = await owner.fetch('/api/directory/consultants');
      check('a later Ledger upload does not set status on a ledger-only consultant either',
        r.body.consultants.find((c) => c.name === 'Lena Ledger').status === null, r.body.consultants);
      r = await owner.fetch('/api/directory/subvendors');
      check('a later Ledger upload does not set status on a ledger-only subvendor either',
        r.body.subvendors.find((s) => s.name === 'Ledger Only Vendor').status === null, r.body.subvendors);

      // A ledger-only record that later shows up in Margin gets Margin's status...
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'RosterLena.xlsx',
        data: { kpis: {}, records: [{
          name: 'Lena Ledger', client: 'SubCo', program: 'SubCo', cost: 60, billing: 95, margin: 35,
          status: 'Active', employmentType: 'Subvendor', subvendorText: 'Ledger Only Vendor',
        }] },
      }) });
      check('margin upload naming the ledger-only records returns 201', r.status === 201, r);
      r = await owner.fetch('/api/directory/consultants');
      check('a not-set record gets its status from its first Margin upload (-> active)',
        r.body.consultants.find((c) => c.name === 'Lena Ledger').status === 'active', r.body.consultants);
      r = await owner.fetch('/api/directory/subvendors');
      check('a not-set subvendor gets its status from its first Margin upload (-> active)',
        r.body.subvendors.find((s) => s.name === 'Ledger Only Vendor').status === 'active', r.body.subvendors);
      // ...and Ledger still can't change it afterwards.
      await ledgerPrecedence('LedgerStatus3.xlsx', [['Lena Ledger', 'Left', 'Ledger Only Vendor']]);
      r = await owner.fetch('/api/directory/consultants');
      check('after Margin set it, a Ledger upload still leaves it alone',
        r.body.consultants.find((c) => c.name === 'Lena Ledger').status === 'active', r.body.consultants);

      // ...and a later Margin upload still overrides as before.
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'RosterSub2.xlsx',
        data: { kpis: {}, records: [{
          name: 'Sam Sublet', client: 'SubCo', program: 'SubCo', cost: 60, billing: 95, margin: 35,
          status: 'Left', employmentType: 'Subvendor', subvendorText: 'Margin Vendor',
        }] },
      }) });
      r = await owner.fetch('/api/directory/consultants');
      check('a later Margin upload still sets status (Sam Sublet Left -> inactive)',
        r.body.consultants.find((c) => c.name === 'Sam Sublet').status === 'inactive', r.body.consultants);

      // 27. A later upload marking the same consultant Left should flip
      // their status back to inactive — and roll their client/program along
      // with them — without touching the contact details saved earlier.
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'Roster3.xlsx',
        data: { kpis: {}, records: [{
          name: 'Jordan Blake', client: 'Platform', program: 'Acme', clientDetail: 'Platform',
          cost: 86, billing: 141, margin: 55, status: 'Left', employmentType: 'W2 (direct)', subvendorText: 'W2',
        }] },
      }) });
      check('third margin upload (Jordan marked Left) returns 201', r.status === 201, r);

      r = await owner.fetch('/api/directory/consultants');
      const jordanFinal = r.body.consultants.find((c) => c.name === 'Jordan Blake');
      check('consultant status flips to inactive on a later upload, contact details untouched',
        jordanFinal && jordanFinal.status === 'inactive' && jordanFinal.email === 'jordan@acme.test', jordanFinal);

      r = await owner.fetch('/api/directory/clients');
      check('client status flips to inactive once its only row goes Left',
        r.body.clients.find((c) => c.name === 'Platform').status === 'inactive', r.body.clients);

      r = await owner.fetch('/api/directory/programs');
      check('program status flips to inactive alongside its client',
        r.body.programs.find((p) => p.name === 'Acme').status === 'inactive', r.body.programs);

      // 27b. That same upload's row said $141/hr, so the existing
      // Platform/Acme assignment should have tracked it automatically —
      // same auto-sync-from-upload reasoning as status.
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments');
      const platformAssignment = r.body.assignments.find((a) => a.client_name === 'Platform');
      check('billing assignment auto-syncs to the latest upload’s rate',
        platformAssignment && Number(platformAssignment.billing) === 141 && platformAssignment.source === 'upload', r.body.assignments);

      // 28. Smart-parser duplicate flagging: a typo'd name close to an
      // existing consultant should NOT create a silent duplicate — it
      // still gets its own record (matching stays exact-name-only), but
      // the near-match is logged for a person to confirm, never merged on
      // its own.
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'Typo1.xlsx',
        data: { kpis: {}, records: [{
          name: 'Jordn Blake', client: 'Initech', program: 'Initech', cost: 50, billing: 90, margin: 40,
          status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2',
        }] },
      }) });
      check('typo’d consultant upload ("Jordn Blake") returns 201', r.status === 201, r);

      r = await owner.fetch('/api/directory/consultants');
      check('a close-but-not-exact name still gets its own record (no silent auto-merge)',
        r.body.consultants.some((c) => c.name === 'Jordan Blake') && r.body.consultants.some((c) => c.name === 'Jordn Blake'),
        r.body.consultants);

      r = await owner.fetch('/api/directory/duplicates?table=consultants');
      const jordnFlag = r.body.duplicates.find((d) => d.record_name === 'Jordn Blake');
      check('near-duplicate flagged for review with a high similarity score',
        r.status === 200 && jordnFlag && jordnFlag.matched_name === 'Jordan Blake' && jordnFlag.similarity >= 0.82, r.body);

      r = await otherOrgUser.fetch('/api/directory/duplicates/' + jordnFlag.flag_id + '/dismiss', { method: 'POST' });
      check('cross-tenant duplicate dismiss blocked (404)', r.status === 404, r);

      r = await owner.fetch('/api/directory/duplicates/' + jordnFlag.flag_id + '/dismiss', { method: 'POST' });
      check('dismissing a flagged duplicate returns ok', r.status === 200 && r.body.ok === true, r);

      r = await owner.fetch('/api/directory/duplicates?table=consultants');
      check('dismissed duplicate no longer listed as open', !r.body.duplicates.some((d) => d.flag_id === jordnFlag.flag_id), r.body);

      r = await owner.fetch('/api/directory/consultants');
      check('dismissing a duplicate leaves both records intact',
        r.body.consultants.some((c) => c.name === 'Jordan Blake') && r.body.consultants.some((c) => c.name === 'Jordn Blake'),
        r.body.consultants);

      // 29. Confirming a flagged duplicate merges the two: the loser's
      // upload history (margin_roster_entries here) moves to the record
      // that's kept, and the loser row itself is gone.
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'Typo2.xlsx',
        data: { kpis: {}, records: [{
          name: 'Priya Natarjan', client: 'Globex', program: 'Globex', cost: 91, billing: 151, margin: 60,
          status: 'Active', employmentType: 'Subvendor', subvendorText: 'Vendor Co',
        }] },
      }) });
      check('typo’d consultant upload ("Priya Natarjan") returns 201', r.status === 201, r);

      r = await owner.fetch('/api/directory/duplicates?table=consultants');
      const priyaFlag = r.body.duplicates.find((d) => d.record_name === 'Priya Natarjan');
      check('second near-duplicate also flagged', !!priyaFlag && priyaFlag.matched_name === 'Priya Natarajan', r.body);

      // Give the typo'd record an invoice before merging: the merge must
      // move it to the surviving record, not cascade-delete it.
      r = await owner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-09', netTerms: 'NET30', issueDate: '2026-09-01' }) });
      check('invoice generation before merge returns 200/201', r.status === 200 || r.status === 201, r);
      r = await owner.fetch('/api/invoices?periodMonth=2026-09');
      const invoicesBeforeMerge = (r.body.invoices || []).length;

      r = await owner.fetch('/api/directory/duplicates/' + priyaFlag.flag_id + '/merge', {
        method: 'POST', body: JSON.stringify({ keep: 'matched' }),
      });
      check('merge keeping the original record returns the survivor',
        r.status === 200 && r.body.kept.name === 'Priya Natarajan' && r.body.removedId === priyaFlag.record_id, r.body);

      r = await owner.fetch('/api/directory/consultants');
      check('merged-away typo no longer appears in the directory',
        !r.body.consultants.some((c) => c.name === 'Priya Natarjan'), r.body.consultants);
      const priyaMerged = r.body.consultants.find((c) => c.name === 'Priya Natarajan');
      check('surviving record absorbed the merged-in upload (margin_rows went from 1 to 2)',
        priyaMerged && priyaMerged.margin_rows === 2, priyaMerged);

      // 29b. Both the original and the merged-in typo had their own
      // billing assignment for the same Globex pairing — merging must
      // transfer (not cascade-delete) the loser's assignment, and collapse
      // the resulting duplicate pairing down to one row rather than
      // leaving two billing figures for the same client.
      r = await owner.fetch('/api/directory/consultants/' + priyaMerged.id + '/assignments');
      check('merge transfers the loser’s billing assignment instead of losing it, deduped to one row',
        r.body.assignments.length === 1 && r.body.assignments[0].client_name === 'Globex' &&
        Number(r.body.assignments[0].billing) === 151, r.body.assignments);

      r = await owner.fetch('/api/invoices?periodMonth=2026-09');
      check('merge keeps every invoice (moved to the surviving record, none deleted)',
        invoicesBeforeMerge > 0 && (r.body.invoices || []).length === invoicesBeforeMerge &&
        !(r.body.invoices || []).some((i) => i.consultant_id === priyaFlag.record_id), r.body);

      r = await owner.fetch('/api/directory/duplicates?table=consultants');
      check('no open duplicate flags left referencing the merged-away record',
        !r.body.duplicates.some((d) => d.record_id === priyaFlag.record_id || d.matched_id === priyaFlag.record_id), r.body);

      // 30. Re-uploading a name that already exists must not re-run the
      // smart-parser scan for it. (It used to: mysql2's FOUND_ROWS flag made
      // an unchanged existing row look like a fresh insert, so uploading
      // "Jordan Blake" again re-opened the "Jordn Blake" pair someone had
      // just dismissed, in the reverse direction.)
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'Roster4.xlsx',
        data: { kpis: {}, records: [
          { name: 'Jordan Blake', client: 'Platform', program: 'Acme', clientDetail: 'Platform', cost: 86, billing: 141, margin: 55, status: 'Left', employmentType: 'W2 (direct)', subvendorText: 'W2' },
          { name: 'Jordn Blake', client: 'Initech', program: 'Initech', cost: 50, billing: 90, margin: 40, status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2' },
        ] },
      }) });
      check('re-upload of existing names returns 201', r.status === 201, r);
      r = await owner.fetch('/api/directory/duplicates?table=consultants');
      check('re-uploading existing names does not re-open a dismissed duplicate pair',
        r.status === 200 && !r.body.duplicates.some((d) =>
          [d.record_name, d.matched_name].includes('Jordan Blake') && [d.record_name, d.matched_name].includes('Jordn Blake')), r.body);

      // 31. A record in the legacy shape (client still holding the raw
      // "Wipro/TD Bank" text, as a stale pre-fix copy of margin.html would
      // send it) resolves exactly like a current one and is stored that way.
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'StaleTab.xlsx',
        data: { kpis: {}, records: [{
          name: 'Morgan Stale', client: 'Wipro/TD Bank', program: 'Wipro', clientDetail: 'TD Bank',
          cost: 70, billing: 100, margin: 30, status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2',
        }] },
      }) });
      check('legacy-shaped margin record upload returns 201', r.status === 201, r);
      const staleImportId = r.body.import.id;
      const [staleRows] = await dbConn.query(
        `SELECT m.client, c.name AS client_name, p.name AS program_name FROM margin_roster_entries m
           LEFT JOIN clients c ON c.id = m.client_id LEFT JOIN programs p ON p.id = m.program_id WHERE m.import_id = ?`,
        [staleImportId]
      );
      check('legacy-shaped record lands as client "TD Bank" / program "Wipro", stored client text normalized',
        staleRows.length === 1 && staleRows[0].client === 'TD Bank' && staleRows[0].client_name === 'TD Bank' &&
        staleRows[0].program_name === 'Wipro', staleRows);

      // 32. The one-time Client/Program swap backfill
      // (scripts/backfill-client-program-swap.js), on an organization whose
      // data was saved under the old, reversed mapping: one upload from
      // before margin.html sent the post-slash text as `client` (legacy
      // row), one after, a stale upload-sourced billing assignment on the
      // old reversed pairing, and a manual assignment that must survive.
      r = await makeJar().fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Backfill Co', name: 'Bea Fill', email: 'bea@backfill.test', password: 'backfillpassword1' }) });
      check('backfill test org signup returns 201', r.status === 201, r);
      const [[bfUser]] = await dbConn.query('SELECT id, organization_id FROM users WHERE email = ?', ['bea@backfill.test']);
      const bfOrg = bfUser.organization_id;
      const q1 = async (sql, params) => (await dbConn.query(sql, params))[0];
      const caseyId = (await q1('INSERT INTO consultants (organization_id, name, status) VALUES (?, ?, ?)', [bfOrg, 'Casey Legacy', 'active'])).insertId;
      const oldClientId = (await q1('INSERT INTO clients (organization_id, name, status) VALUES (?, ?, ?)', [bfOrg, 'Wipro', 'active'])).insertId;
      const oldProgramId = (await q1('INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, ?, ?)', [bfOrg, oldClientId, 'TD Bank', 'active'])).insertId;
      const legacyImportId = (await q1(
        "INSERT INTO margin_imports (organization_id, uploaded_by, file_name, imported_at, data) VALUES (?, ?, 'Old.xlsx', '2026-01-01 10:00:00', '{}')",
        [bfOrg, bfUser.id])).insertId;
      const newImportId = (await q1(
        "INSERT INTO margin_imports (organization_id, uploaded_by, file_name, imported_at, data) VALUES (?, ?, 'New.xlsx', '2026-02-01 10:00:00', '{}')",
        [bfOrg, bfUser.id])).insertId;
      const legacyRowId = (await q1(
        `INSERT INTO margin_roster_entries (import_id, organization_id, name, consultant_id, client, program, client_id, client_detail, program_id, billing, status)
         VALUES (?, ?, 'Casey Legacy', ?, 'Wipro/TD Bank', 'Wipro', ?, 'TD Bank', ?, 100, 'Active')`,
        [legacyImportId, bfOrg, caseyId, oldClientId, oldProgramId])).insertId;
      const currentRowId = (await q1(
        `INSERT INTO margin_roster_entries (import_id, organization_id, name, consultant_id, client, program, client_id, client_detail, program_id, billing, status)
         VALUES (?, ?, 'Casey Legacy', ?, 'TD Bank', 'Wipro', ?, 'TD Bank', ?, 110, 'Left')`,
        [newImportId, bfOrg, caseyId, oldClientId, oldProgramId])).insertId;
      const staleAssignmentId = (await q1(
        "INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing, source) VALUES (?, ?, ?, ?, 110, 'upload')",
        [bfOrg, caseyId, oldClientId, oldProgramId])).insertId;
      const manualAssignmentId2 = (await q1(
        "INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing, source, updated_at) VALUES (?, ?, ?, NULL, 75, 'manual', '2026-01-15 09:00:00')",
        [bfOrg, caseyId, oldClientId])).insertId;
      const [[manualBefore]] = await dbConn.query('SELECT * FROM consultant_assignments WHERE id = ?', [manualAssignmentId2]);

      const bfStats = await backfillOrg(dbConn, bfOrg);
      check('backfill reports both roster rows repointed and the legacy client text rewritten',
        bfStats.rosterRows === 2 && bfStats.rosterRepointed === 2 && bfStats.legacyClientText === 1 &&
        bfStats.assignmentsInserted === 1 && bfStats.assignmentsDeleted === 1, bfStats);

      const bfRows = await q1(
        `SELECT m.id, m.client, m.client_id, m.program_id, c.name AS client_name, p.name AS program_name, p.client_id AS program_client_id
           FROM margin_roster_entries m LEFT JOIN clients c ON c.id = m.client_id LEFT JOIN programs p ON p.id = m.program_id
          WHERE m.organization_id = ? ORDER BY m.id`, [bfOrg]);
      const legacyAfter = bfRows.find((x) => x.id === legacyRowId);
      const currentAfter = bfRows.find((x) => x.id === currentRowId);
      check('legacy-format stored row fixed: client = post-slash text, program = pre-slash Program under it',
        legacyAfter && legacyAfter.client_name === 'TD Bank' && legacyAfter.program_name === 'Wipro' &&
        legacyAfter.program_client_id === legacyAfter.client_id && legacyAfter.client === 'TD Bank', legacyAfter);
      check('legacy and current-format rows resolve to the same client and program',
        currentAfter && currentAfter.client_id === legacyAfter.client_id && currentAfter.program_id === legacyAfter.program_id, bfRows);

      const [[tdBank]] = await dbConn.query('SELECT status FROM clients WHERE id = ?', [legacyAfter.client_id]);
      check('backfilled client status follows the latest import (Left -> inactive)', tdBank.status === 'inactive', tdBank);

      const bfAssignments = await q1('SELECT * FROM consultant_assignments WHERE organization_id = ? ORDER BY id', [bfOrg]);
      const uploadAssignments = bfAssignments.filter((a) => a.source === 'upload');
      check('stale upload assignment on the old reversed pairing removed, replaced by the corrected one at the latest rate',
        !bfAssignments.some((a) => a.id === staleAssignmentId) && uploadAssignments.length === 1 &&
        uploadAssignments[0].client_id === legacyAfter.client_id && uploadAssignments[0].program_id === legacyAfter.program_id &&
        Number(uploadAssignments[0].billing) === 110, bfAssignments);
      const manualAfter = bfAssignments.find((a) => a.id === manualAssignmentId2);
      check('manual assignment left completely untouched by the backfill',
        manualAfter && JSON.stringify(manualAfter) === JSON.stringify(manualBefore), { manualBefore, manualAfter });

      const bfOrphans = await findOrphans(dbConn, bfOrg);
      check('orphan report lists the old reversed program, not the client a manual assignment still uses',
        bfOrphans.orphanPrograms.length === 1 && bfOrphans.orphanPrograms[0].id === oldProgramId &&
        bfOrphans.orphanClients.length === 0, bfOrphans);
      const [[stillThere]] = await dbConn.query('SELECT COUNT(*) AS n FROM programs WHERE id = ?', [oldProgramId]);
      check('backfill never deletes directory records', stillThere.n === 1, stillThere);

      const snapshot = async () => JSON.stringify(await Promise.all([
        q1('SELECT * FROM clients WHERE organization_id = ? ORDER BY id', [bfOrg]),
        q1('SELECT * FROM programs WHERE organization_id = ? ORDER BY id', [bfOrg]),
        q1('SELECT * FROM consultant_assignments WHERE organization_id = ? ORDER BY id', [bfOrg]),
        q1('SELECT * FROM margin_roster_entries WHERE organization_id = ? ORDER BY id', [bfOrg]),
        q1('SELECT * FROM directory_duplicate_candidates WHERE organization_id = ? ORDER BY id', [bfOrg]),
      ]));
      const before2 = await snapshot();
      await sleep(1100); // so any stray write would show up as an updated_at change
      const bfStats2 = await backfillOrg(dbConn, bfOrg);
      const after2 = await snapshot();
      check('second backfill run is a no-op (nothing written, every row identical incl. updated_at)',
        bfStats2.rosterRepointed === 0 && bfStats2.legacyClientText === 0 && bfStats2.clientsCreated === 0 &&
        bfStats2.programsCreated === 0 && bfStats2.statusChanges === 0 && bfStats2.assignmentsInserted === 0 &&
        bfStats2.assignmentsUpdated === 0 && bfStats2.assignmentsDeleted === 0 && before2 === after2, bfStats2);

      // 33. Fin-Module: generate monthly invoices from consultant_assignments,
      // one per (consultant, client, program) combo, billed to the Program
      // (falling back to the Client when there's no program), with pairings
      // that have no client/program or no billing rate skipped. Uses its own
      // org so it's independent of every other test's evolving fixtures.
      const finOwner = makeJar();
      r = await finOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Fin Test Co', name: 'Fin Owner', email: 'fin@fintest.test', password: 'finmodulepassword1' }) });
      check('fin-module test org signup returns 201', r.status === 201, r);

      r = await finOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'FinRoster.xlsx',
        data: {
          kpis: {},
          records: [
            { name: 'Dana Invoice', client: 'Acme Holdings', program: 'Rocket', clientDetail: 'Acme Holdings', billing: 120, status: 'Active' },
            { name: 'Evan NoProgram', client: 'Acme Holdings', program: 'Acme Holdings', clientDetail: null, billing: 95, status: 'Active' },
            { name: 'Fran NoRate', client: 'Beta Corp', program: 'Orbit', clientDetail: 'Beta Corp', billing: null, status: 'Active' },
            { name: 'Gale NoClient', client: null, program: null, clientDetail: null, billing: 200, status: 'Active' },
          ],
        },
      }) });
      check('fin-module roster upload returns 201', r.status === 201, r);

      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-10', netTerms: 'NET30', issueDate: '2026-10-01' }) });
      check('generate returns 201', r.status === 201, r);
      check('generate creates exactly 2 invoices (Dana and Evan)', r.body.created && r.body.created.length === 2, r.body);
      check('generate skips exactly 2 (Fran: no rate, Gale: no client/program)', r.body.skipped && r.body.skipped.length === 2, r.body);
      check('skip reasons are the expected two',
        r.body.skipped.some((s) => s.consultant === 'Fran NoRate' && s.reason === 'no billing rate set') &&
        r.body.skipped.some((s) => s.consultant === 'Gale NoClient' && s.reason === 'no client or program to bill'), r.body.skipped);

      // Fetch the two created invoices with names via the list endpoint instead
      // of relying on created-array ordering.
      r = await finOwner.fetch('/api/invoices?periodMonth=2026-10');
      check('list returns the 2 generated invoices for the period', r.body.invoices.length === 2, r.body);
      const danaInv = r.body.invoices.find((i) => i.consultant_name === 'Dana Invoice');
      const evanInv = r.body.invoices.find((i) => i.consultant_name === 'Evan NoProgram');
      check('Dana is billed to the Program (Rocket), at her rate', !!danaInv &&
        danaInv.bill_to_name === 'Rocket' && Number(danaInv.rate) === 120 && danaInv.client_name === 'Acme Holdings' && danaInv.program_name === 'Rocket', danaInv);
      check('Evan has no program, so bill-to falls back to the Client (Acme Holdings)', !!evanInv &&
        evanInv.bill_to_name === 'Acme Holdings' && Number(evanInv.rate) === 95 && evanInv.program_name === null, evanInv);
      check('invoice numbers follow INV-YYYYMM-##### and are unique', /^INV-202610-\d{5}$/.test(danaInv.invoice_number) &&
        /^INV-202610-\d{5}$/.test(evanInv.invoice_number) && danaInv.invoice_number !== evanInv.invoice_number, { danaInv, evanInv });
      check('due date is NET30 out from the Oct 1 issue date', String(danaInv.due_date).slice(0, 10) === '2026-10-31', danaInv);
      check('new invoice defaults to unpaid / timesheet not submitted', danaInv.payment_status === 'unpaid' && danaInv.timesheet_submitted === 'no', danaInv);

      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-10' }) });
      check('re-generating the same month is idempotent (creates nothing new)', r.status === 201 && r.body.created.length === 0, r.body);
      check('re-generating reports the existing pair as already invoiced',
        r.body.skipped.some((s) => s.reason === 'already invoiced for this month'), r.body.skipped);
      r = await finOwner.fetch('/api/invoices?periodMonth=2026-10');
      check('invoice count unchanged after re-generating', r.body.invoices.length === 2, r.body);

      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: 'not-a-month' }) });
      check('generate with a bad periodMonth returns 400', r.status === 400, r);

      r = await otherOrgUser.fetch('/api/invoices?periodMonth=2026-10');
      check('cross-tenant invoice list never shows another org’s invoices', r.status === 200 && !r.body.invoices.some((i) => i.id === danaInv.id), r.body);
      r = await otherOrgUser.fetch('/api/invoices/' + danaInv.id);
      check('cross-tenant invoice detail returns 404', r.status === 404, r);
      r = await otherOrgUser.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({ paymentStatus: 'paid' }) });
      check('cross-tenant invoice PATCH returns 404', r.status === 404, r);
      r = await otherOrgUser.fetch('/api/invoices/' + danaInv.id, { method: 'DELETE' });
      check('cross-tenant invoice DELETE returns 404', r.status === 404, r);

      r = await finOwner.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({ hours: 160 }) });
      check('setting hours auto-computes amount as rate x hours', r.status === 200 && Number(r.body.invoice.amount) === 19200, r.body);

      r = await finOwner.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({ hours: 10, amount: 5000 }) });
      check('an explicit amount always wins over the hours-derived figure', r.status === 200 &&
        Number(r.body.invoice.hours) === 10 && Number(r.body.invoice.amount) === 5000, r.body);

      r = await finOwner.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({
        paymentStatus: 'paid', timesheetSubmitted: 'yes', netTerms: 'NET60', notes: 'Paid via wire',
      }) });
      check('payment/timesheet/net-terms/notes all patch together',
        r.status === 200 && r.body.invoice.payment_status === 'paid' && r.body.invoice.timesheet_submitted === 'yes' &&
        r.body.invoice.net_terms === 'NET60' && r.body.invoice.notes === 'Paid via wire', r.body);

      r = await finOwner.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({ hours: 'not-a-number' }) });
      check('patching hours with garbage returns 400', r.status === 400, r);
      r = await finOwner.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({ paymentStatus: 'overdue' }) });
      check('patching an invalid paymentStatus returns 400', r.status === 400, r);
      r = await finOwner.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({ netTerms: 'WHENEVER' }) });
      check('patching an invalid netTerms returns 400', r.status === 400, r);

      r = await finOwner.fetch('/api/invoices/' + evanInv.id, { method: 'DELETE' });
      check('delete invoice returns ok', r.status === 200 && r.body.ok === true, r.body);
      r = await finOwner.fetch('/api/invoices?periodMonth=2026-10');
      check('deleted invoice no longer appears in the list', r.body.invoices.length === 1 && r.body.invoices[0].id === danaInv.id, r.body);
      r = await finOwner.fetch('/api/invoices/' + evanInv.id, { method: 'DELETE' });
      check('deleting an already-deleted invoice returns 404', r.status === 404, r);
    } finally {
      await dbConn.end();
    }

    console.log('\n' + '='.repeat(50));
    console.log(`RESULTS: ${pass} passed, ${fail} failed`);
    console.log('='.repeat(50));
  } catch (err) {
    console.error('TEST SCRIPT ERROR:', err);
    fail++;
  } finally {
    server.kill();
    await sleep(300);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main();
