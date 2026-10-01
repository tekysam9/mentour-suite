require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const path = require('path');
const mysql = require('mysql2/promise');

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
            name: 'Jordan Blake', client: 'Acme / Platform', program: 'Acme', clientDetail: 'Platform',
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
      // a consultant for each named person, a client for each Program value,
      // a program for each clientDetail under its client, and a subvendor
      // only for the row whose employment type is actually 'Subvendor'
      // (the W2 row's subvendorText is a marker, not a real vendor name).
      r = await owner.fetch('/api/directory/consultants');
      check('directory consultants populated from margin upload', r.status === 200 &&
        r.body.consultants.length === 2 &&
        r.body.consultants.some((c) => c.name === 'Jordan Blake') &&
        r.body.consultants.some((c) => c.name === 'Priya Natarajan'), r.body);

      r = await owner.fetch('/api/directory/clients');
      check('directory clients populated from Program values', r.status === 200 &&
        r.body.clients.length === 2 &&
        r.body.clients.some((c) => c.name === 'Acme') &&
        r.body.clients.some((c) => c.name === 'Globex'), r.body);

      r = await owner.fetch('/api/directory/programs');
      check('directory programs populated from clientDetail, linked to its client', r.status === 200 &&
        r.body.programs.length === 1 &&
        r.body.programs[0].name === 'Platform' && r.body.programs[0].client_name === 'Acme', r.body);

      r = await owner.fetch('/api/directory/subvendors');
      check('directory subvendors only created for real Subvendor rows (W2 marker excluded)',
        r.status === 200 && r.body.subvendors.length === 1 && r.body.subvendors[0].name === 'Vendor Co', r.body);

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
      check('client status active when its row is Active', r.body.clients.find((c) => c.name === 'Acme').status === 'active', r.body.clients);
      check('client status inactive when its row is Left', r.body.clients.find((c) => c.name === 'Globex').status === 'inactive', r.body.clients);

      r = await owner.fetch('/api/directory/programs');
      check('program status active alongside its client', r.body.programs.find((p) => p.name === 'Platform').status === 'active', r.body.programs);

      r = await owner.fetch('/api/directory/consultants');
      const jordanRecord = r.body.consultants.find((c) => c.name === 'Jordan Blake');
      check('consultant found for editing', !!jordanRecord, r.body);

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
        data: { kpis: {}, records: [{ name: 'Jordan Blake', client: 'Acme / Platform', program: 'Acme', clientDetail: 'Platform', cost: 86, billing: 141, margin: 55, status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2' }] },
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

      const [ledgerRosterRows] = await dbConn.query(
        'SELECT name, subvendor_text, client_tag, amount, consultant_id, subvendor_id FROM ledger_roster_entries WHERE consultant_id = ?',
        [jordanRecord.id]
      );
      check('ledger_roster_entries row written with correct fields and linked ids',
        ledgerRosterRows.length === 1 && ledgerRosterRows[0].name === 'Jordan Blake' &&
        Number(ledgerRosterRows[0].amount) === 5000 && ledgerRosterRows[0].consultant_id === jordanRecord.id,
        ledgerRosterRows);

      // 26. The ledger upload above used "Vendor Co" for a currently-active
      // consultant (Jordan), so the shared subvendor record should now read
      // active even though the earlier Margin row that first created it
      // ("Priya Natarajan", Left) said otherwise — status always reflects
      // whichever upload touched it most recently.
      r = await owner.fetch('/api/directory/subvendors');
      check('subvendor status auto-syncs to active from the later Ledger upload',
        r.body.subvendors.find((s) => s.name === 'Vendor Co').status === 'active', r.body.subvendors);

      // 27. A later upload marking the same consultant Left should flip
      // their status back to inactive — and roll their client/program along
      // with them — without touching the contact details saved earlier.
      r = await owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'Roster3.xlsx',
        data: { kpis: {}, records: [{
          name: 'Jordan Blake', client: 'Acme / Platform', program: 'Acme', clientDetail: 'Platform',
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
        r.body.clients.find((c) => c.name === 'Acme').status === 'inactive', r.body.clients);

      r = await owner.fetch('/api/directory/programs');
      check('program status flips to inactive alongside its client',
        r.body.programs.find((p) => p.name === 'Platform').status === 'inactive', r.body.programs);

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

      r = await owner.fetch('/api/directory/duplicates?table=consultants');
      check('no open duplicate flags left referencing the merged-away record',
        !r.body.duplicates.some((d) => d.record_id === priyaFlag.record_id || d.matched_id === priyaFlag.record_id), r.body);
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
