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
    async raw(pathName) {
      const res = await fetch(BASE + pathName, { headers: cookie ? { Cookie: cookie } : {} });
      return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
  process.env.AUTH_RATE_LIMIT = '1000';
  // a local mail server that records what the app sends
  const mailbox = [];
  const { SMTPServer } = require('smtp-server');
  const { simpleParser } = require('mailparser');
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) { simpleParser(stream).then((m) => { mailbox.push({ to: (m.to && m.to.text) || '', from: (m.from && m.from.text) || '', replyTo: (m.replyTo && m.replyTo.text) || '', rcpt: session.envelope.rcptTo.map((x) => x.address).join(), subject: m.subject, text: m.text }); cb(); }).catch(cb); },
  });
  await new Promise((ok) => smtp.listen(2599, '127.0.0.1', ok));
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2599', SMTP_SECURE: 'false', SMTP_USER: 'onboarding@mentour.test', SMTP_PASS: 'x', SMTP_FROM: 'Mentour Suite <onboarding@mentour.test>' });
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

      // Several projects at once, each with its own billing and pay rate (Rob Rosales scenario).
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments/bulk', {
        method: 'POST', body: JSON.stringify({ text: 'Client\tVendor\tBilling\tPay\\n1. RCA\tCDW\t$240\t$210\\nIBM, CDW, 210, 200\\nAustin Energy, CDW, 225, 210\\nPre-Sales, CDW, 235, 225\\nCisco, CDW, 260, 250'.replace(/\\n/g, '\n') }),
      });
      const bulk = r.body.assignments || [];
      const rcaA = bulk.find((a) => a.client_name === 'RCA');
      const ciscoA = bulk.find((a) => a.client_name === 'Cisco');
      check('bulk add creates five new pairings', r.status === 201 && r.body.added === 5 && bulk.length === 6, r.body);
      check('each pairing keeps its own billing and pay rate',
        rcaA && Number(rcaA.billing) === 240 && Number(rcaA.pay_rate) === 210 && rcaA.program_name === 'CDW' &&
        ciscoA && Number(ciscoA.billing) === 260 && Number(ciscoA.pay_rate) === 250, bulk);
      r = await owner.fetch('/api/directory/assignments/' + rcaA.id, { method: 'PATCH', body: JSON.stringify({ pay_rate: 215 }) });
      check('editing pay rate leaves billing alone', Number(r.body.assignment.pay_rate) === 215 && Number(r.body.assignment.billing) === 240, r.body);
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments/bulk', { method: 'POST', body: JSON.stringify({ rows: [{ client: 'Texas, State of', vendor: 'New Vendor, Inc', billing: '77', pay_rate: '60' }] }) });
      check('add-form row creates a new client and a new vendor under it (names may contain commas)',
        r.status === 201 && (r.body.assignments || []).some((a) => a.client_name === 'Texas, State of' && a.program_name === 'New Vendor, Inc' && Number(a.billing) === 77 && Number(a.pay_rate) === 60), r.body);
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments/bulk', { method: 'POST', body: JSON.stringify({ text: 'IBM, CDW, 215, 205' }) });
      const ibm = (r.body.assignments || []).filter((a) => a.client_name === 'IBM');
      check('re-adding an existing pairing updates it instead of duplicating', ibm.length === 1 && Number(ibm[0].billing) === 215 && Number(ibm[0].pay_rate) === 205, r.body);
      r = await owner.fetch('/api/directory/consultants/' + jordanRecord.id + '/assignments/bulk', { method: 'POST', body: JSON.stringify({ text: 'IBM, CDW, abc, 1' }) });
      check('bad rate in bulk add is rejected', r.status === 400, r.body);
      for (const a of bulk) await owner.fetch('/api/directory/assignments/' + a.id, { method: 'DELETE' });

      // Margin roster runs from the database: add, edit, close and delete placements without any file.
      r = await owner.fetch('/api/roster', { method: 'POST', body: JSON.stringify({ name: 'Rob Rosales', client: 'RCA', vendor: 'CDW', employmentType: 'W2 (direct)', billing: 240, cost: 210, joined: 'Oct 2026', recruiter: 'Pat' }) });
      const robRec = r.body.record;
      check('roster: add a placement without a file', r.status === 201 && robRec.name === 'Rob Rosales' && robRec.margin === 30 && robRec.program === 'CDW' && robRec.subvendorText === 'W2', r.body);
      r = await owner.fetch('/api/roster', { method: 'POST', body: JSON.stringify({ name: 'Rob Rosales', client: 'IBM', vendor: 'CDW', billing: 210, cost: 200 }) });
      check('roster: same consultant, second project', r.status === 201 && r.body.record.consultantId === robRec.consultantId && r.body.record.id !== robRec.id, r.body);
      r = await owner.fetch('/api/roster');
      check('roster: lists both placements in the margin record shape', r.status === 200 && r.body.records.filter((x) => x.name === 'Rob Rosales').length === 2 && r.body.records.every((x) => 'margin' in x && 'subvendorText' in x), r.body.records && r.body.records.length);
      r = await owner.fetch('/api/roster/' + robRec.id, { method: 'PATCH', body: JSON.stringify({ cost: 205, status: 'Left', leftDate: '2026-12-31' }) });
      check('roster: edit cost and mark left', r.status === 200 && r.body.record.cost === 205 && r.body.record.margin === 35 && r.body.record.status === 'Left' && r.body.record.leftDate === '2026-12-31', r.body);
      r = await owner.fetch('/api/roster/' + robRec.id, { method: 'PATCH', body: JSON.stringify({ client: 'IBM' }) });
      check('roster: moving onto an existing client/vendor pairing is refused (409)', r.status === 409, r.body);
      r = await owner.fetch('/api/roster', { method: 'POST', body: JSON.stringify({ name: 'X', client: 'Y', billing: 'abc' }) });
      check('roster: bad rate rejected', r.status === 400, r.body);
      r = await otherOrgUser.fetch('/api/roster/' + robRec.id, { method: 'PATCH', body: JSON.stringify({ cost: 1 }) });
      check('roster: cross-tenant edit blocked (404)', r.status === 404, r.status);
      r = await owner.fetch('/api/roster');
      check('roster: another organization does not see these placements', (await otherOrgUser.fetch('/api/roster')).body.records.every((x) => x.name !== 'Rob Rosales'), 1);
      r = await owner.fetch('/api/roster/' + robRec.id, { method: 'DELETE' });
      check('roster: delete a placement', r.status === 200, r.body);

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
      // (includeInactive: this check is about merge integrity, not status --
      // the surviving record here is Inactive.)
      r = await owner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-09', netTerms: 'NET30', issueDate: '2026-09-01', includeInactive: true }) });
      check('invoice generation before merge returns 200/201', r.status === 200 || r.status === 201, r);
      r = await owner.fetch('/api/invoices?periodMonth=2026-09&includeInactive=1');
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

      r = await owner.fetch('/api/invoices?periodMonth=2026-09&includeInactive=1');
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
            { name: 'Hal Inactive', client: 'Acme Holdings', program: 'Nova', clientDetail: 'Acme Holdings', billing: 100, status: 'Left' },
            { name: 'Ivy Unset', client: 'Beta Corp', program: 'Orbit', clientDetail: 'Beta Corp', billing: 80, status: 'Active' },
          ],
        },
      }) });
      check('fin-module roster upload returns 201', r.status === 201, r);
      // Ivy stands in for a consultant whose status was never set (NULL --
      // e.g. only ever seen in a Ledger upload).
      await dbConn.query(
        `UPDATE consultants c JOIN users u ON u.organization_id = c.organization_id
         SET c.status = NULL WHERE u.email = ? AND c.name = ?`, ['fin@fintest.test', 'Ivy Unset']);

      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-10', netTerms: 'NET30', issueDate: '2026-10-01' }) });
      check('generate returns 201', r.status === 201, r);
      check('generate creates exactly 2 invoices (Dana and Evan)', r.body.created && r.body.created.length === 2, r.body);
      check('generate skips exactly 4 (Fran: no rate, Gale: no client/program, Hal: inactive, Ivy: status not set)', r.body.skipped && r.body.skipped.length === 4, r.body);
      check('skip reasons are the expected four',
        r.body.skipped.some((s) => s.consultant === 'Fran NoRate' && s.reason === 'no billing rate set') &&
        r.body.skipped.some((s) => s.consultant === 'Gale NoClient' && s.reason === 'no client or vendor to bill') &&
        r.body.skipped.some((s) => s.consultant === 'Hal Inactive' && s.reason === 'consultant is inactive' && s.inactive === true) &&
        r.body.skipped.some((s) => s.consultant === 'Ivy Unset' && s.reason === 'consultant status not set' && s.inactive === true), r.body.skipped);
      check('active-only generation reports skippedInactive = 2 and invoices no inactive/unset consultant',
        r.body.skippedInactive === 2 && r.body.includeInactive === false &&
        !r.body.created.some((i) => r.body.skipped.some((s) => s.inactive && s.assignmentId === i.assignment_id)), r.body);
      check('generate reports the default as 0 hours (no assumed hours)', r.body.defaultHours === 0, r.body);

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
      check('new invoices start at 0 hours and $0',
        Number(danaInv.hours) === 0 && Number(danaInv.amount) === 0 &&
        Number(evanInv.hours) === 0 && Number(evanInv.amount) === 0, { danaInv, evanInv });

      // Edit hours on one invoice and type a flat amount on the other, then
      // re-generate: neither edit may be overwritten by the defaults.
      r = await finOwner.fetch('/api/invoices/' + danaInv.id, { method: 'PATCH', body: JSON.stringify({ hours: 100 }) });
      check('typing hours recomputes amount = rate x hours', r.status === 200 && Number(r.body.invoice.hours) === 100 && Number(r.body.invoice.amount) === 12000, r.body);
      r = await finOwner.fetch('/api/invoices/' + evanInv.id, { method: 'PATCH', body: JSON.stringify({ amount: 999.5 }) });
      check('typing an amount over the defaulted one overrides it (hours left as-is)',
        r.status === 200 && Number(r.body.invoice.amount) === 999.5 && Number(r.body.invoice.hours) === 0, r.body);

      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-10' }) });
      check('re-generating the same month is idempotent (creates nothing new)', r.status === 201 && r.body.created.length === 0, r.body);
      check('re-generating reports the existing pair as already invoiced',
        r.body.skipped.some((s) => s.reason === 'already invoiced for this month'), r.body.skipped);
      r = await finOwner.fetch('/api/invoices?periodMonth=2026-10');
      check('invoice count unchanged after re-generating', r.body.invoices.length === 2, r.body);
      check('re-generating never overwrites edited hours/amounts',
        r.body.invoices.some((i) => i.id === danaInv.id && Number(i.hours) === 100 && Number(i.amount) === 12000) &&
        r.body.invoices.some((i) => i.id === evanInv.id && Number(i.hours) === 0 && Number(i.amount) === 999.5), r.body.invoices);

      // Include-inactive option: invoices Hal (Inactive) and Ivy (not set)
      // too, still at the default hours, without touching Dana/Evan.
      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-10', includeInactive: true, issueDate: '2026-10-01' }) });
      check('includeInactive generation creates exactly the 2 inactive/unset invoices (Hal, Ivy)',
        r.status === 201 && r.body.created.length === 2 && r.body.skippedInactive === 0 && r.body.includeInactive === true &&
        r.body.created.every((i) => Number(i.hours) === 0), r.body);
      check('includeInactive generation still skips no-rate/no-client and already-invoiced pairings',
        r.body.skipped.filter((s) => s.reason === 'already invoiced for this month').length === 2 &&
        r.body.skipped.some((s) => s.consultant === 'Fran NoRate') && r.body.skipped.some((s) => s.consultant === 'Gale NoClient'), r.body.skipped);
      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-10', includeInactive: true }) });
      check('re-running includeInactive generation is idempotent too', r.status === 201 && r.body.created.length === 0, r.body);

      r = await finOwner.fetch('/api/invoices?periodMonth=2026-10');
      check('invoice list shows only Active consultants by default',
        r.body.invoices.length === 2 && r.body.invoices.every((i) => i.consultant_status === 'active'), r.body.invoices);
      r = await finOwner.fetch('/api/invoices?periodMonth=2026-10&includeInactive=1');
      const halInv = r.body.invoices.find((i) => i.consultant_name === 'Hal Inactive');
      const ivyInv = r.body.invoices.find((i) => i.consultant_name === 'Ivy Unset');
      check('includeInactive=1 lists inactive and status-not-set consultants’ invoices too',
        r.body.invoices.length === 4 && halInv && halInv.consultant_status === 'inactive' && ivyInv && ivyInv.consultant_status === null &&
        Number(halInv.amount) === 0 && Number(ivyInv.amount) === 0, r.body.invoices);

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

      // Max billable hours excludes weekends and observed US federal holidays.
      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-09', issueDate: '2026-09-01' }) });
      const sepDana = (r.body.created || []).find((i) => i.consultant_id === danaInv.consultant_id);
      check('Sep 2026 invoices also start at 0 hours / $0',
        r.status === 201 && sepDana && Number(sepDana.hours) === 0 && Number(sepDana.amount) === 0, r.body);
      r = await finOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-07', issueDate: '2026-07-01' }) });
      const julDana = (r.body.created || []).find((i) => i.consultant_id === danaInv.consultant_id);
      check('Jul 2026 invoices also start at 0 hours / $0',
        r.status === 201 && julDana && Number(julDana.hours) === 0 && Number(julDana.amount) === 0, r.body);

      // 33b. Merging two flagged clients that both have a same-named program
      // used to fail (programs are unique per client) and the page showed
      // nothing. The duplicate program folds into the kept one.
      const dupOwner = makeJar();
      r = await dupOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Dup Client Co', name: 'Dup Owner', email: 'dup@dupclient.test', password: 'dupclientpass1' }) });
      check('client-merge test org signup returns 201', r.status === 201, r);
      const dupRec = (name, client, program) => ({ name, client, program, clientDetail: client, cost: 50, billing: 90, margin: 40, status: 'Active', employmentType: 'Subvendor', subvendorText: 'V' });
      await dupOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'd1.xlsx', data: { kpis: {}, records: [dupRec('Ann One', 'Tyler Technologies', 'Prog A')] } }) });
      await dupOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'd2.xlsx', data: { kpis: {}, records: [dupRec('Ann One', 'Tyler Tchnologies', 'Prog A')] } }) });
      r = await dupOwner.fetch('/api/directory/duplicates?table=clients');
      const tylerFlag = r.body.duplicates.find((d) => d.record_name === 'Tyler Tchnologies');
      check('typo’d client flagged as a duplicate', !!tylerFlag, r.body);
      r = await dupOwner.fetch('/api/directory/duplicates/' + tylerFlag.flag_id + '/merge', { method: 'POST', body: JSON.stringify({ keep: 'matched' }) });
      check('merging clients that share a program name succeeds', r.status === 200 && r.body.kept.name === 'Tyler Technologies', r);
      r = await dupOwner.fetch('/api/directory/programs');
      check('the shared program is now a single program under the kept client',
        r.body.programs.filter((pr) => pr.name === 'Prog A').length === 1, r.body);

      // 33c. A consultant who left a client/program (Left row on the Margin
      // file) keeps that pairing as history but it is marked left and no
      // longer invoiced; the project they are still Active on is billed.
      const leftOwner = makeJar();
      r = await leftOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Left Pairing Co', name: 'Left Owner', email: 'lo@leftpair.test', password: 'leftpairpass1' }) });
      check('left-pairing test org signup returns 201', r.status === 201, r);
      r = await leftOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'mohan.xlsx', data: { kpis: {}, records: [
        { name: 'Mohan Test', client: 'State of RI', program: 'IRG', clientDetail: 'State of RI', cost: 60, billing: 100, margin: 40, status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2' },
        { name: 'Mohan Test', client: 'District of Columbia', program: 'CITI', clientDetail: 'District of Columbia', cost: 55, billing: 90, margin: 35, status: 'Left', leftDate: '2023-01-25T00:00:00.000Z', employmentType: 'W2 (direct)', subvendorText: 'W2' },
      ] } }) });
      check('margin upload with an Active and a Left pairing returns 201', r.status === 201, r);
      r = await leftOwner.fetch('/api/directory/consultants');
      const mohan = r.body.consultants.find((c) => c.name === 'Mohan Test');
      const mohanRI = mohan.assignments.find((a) => a.client_name === 'State of RI');
      const mohanDC = mohan.assignments.find((a) => a.client_name === 'District of Columbia');
      check('Active pairing stays active; Left pairing is marked left with its left date',
        mohan.assignments.length === 2 && mohanRI.status === 'active' && mohanDC.status === 'left' && String(mohanDC.left_date).slice(0, 10) === '2023-01-25', mohan.assignments);
      r = await leftOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-11' }) });
      check('only the active client/program is invoiced; the left one is skipped',
        r.status === 201 && r.body.created.length === 1 && r.body.skipped.some((x) => /left this client/.test(x.reason)), r.body);
      // An invoice generated for the old pairing before it was marked left no longer lists.
      r = await leftOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-11', includeInactive: true }) });
      check('includeInactive generation also bills the left pairing', r.status === 201 && r.body.created.length === 1, r.body);
      r = await leftOwner.fetch('/api/invoices?periodMonth=2026-11');
      check('list hides the unpaid invoice on the left pairing', r.body.invoices.length === 1 && r.body.invoices[0].client_name === 'State of RI', r.body);
      r = await leftOwner.fetch('/api/invoices?periodMonth=2026-11&includeInactive=1');
      check('includeInactive=1 shows it again', r.body.invoices.length === 2, r.body);
      r = await leftOwner.fetch('/api/invoices?periodMonth=2026-11');
      check('the one invoice is State of RI / IRG at $100',
        r.body.invoices.length === 1 && r.body.invoices[0].client_name === 'State of RI' && r.body.invoices[0].program_name === 'IRG' && Number(r.body.invoices[0].rate) === 100, r.body);

      // 33d. Import hours: past invoices from an uploaded hours sheet.
      const hrsOwner = makeJar();
      r = await hrsOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Hours Import Co', name: 'Hrs Owner', email: 'hrs@hoursimport.test', password: 'hoursimportpass1' }) });
      check('hours-import test org signup returns 201', r.status === 201, r);
      const hrsRec = (name, client, program, billing) => ({ name, client, program, clientDetail: client, cost: 50, billing, margin: 10, status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2' });
      await hrsOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'h.xlsx', data: { kpis: {}, records: [
        hrsRec('Hana Hours', 'State of RI', 'IRG', 100), hrsRec('Ivo Hours', 'Acme', 'Acme', 80), hrsRec('Jun Hours', 'Beta', 'Rocket', 90), hrsRec('Jun Hours', 'Beta', 'Orbit', 95),
      ] } }) });
      const hrsRows = [
        { name: 'Hana Hours', client: 'IRG/State of RI', hours: { 1: 160, 2: 152 } },
        { name: 'HANA HOURS', client: 'State of RI', hours: { 3: 168 } },
        { name: 'Ivo Hours', client: 'Acme', hours: { 1: 100, 2: 0 } },
        { name: 'Nobody Known', client: 'Acme', hours: { 1: 10 } },
        { name: 'Jun Hours', client: 'Beta', hours: { 1: 50 } },
        { name: 'Jun Hours', client: 'Rocket/Beta', hours: { 1: 40 } },
        { name: 'Ivo Hours', client: 'Wrong Client', hours: { 1: 5 } },
      ];
      const hrsBody = (extra) => JSON.stringify(Object.assign({ rows: hrsRows, year: 2026, netTerms: 'NET30', paymentStatus: 'paid', timesheetSubmitted: 'yes' }, extra || {}));
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: hrsBody() });
      check('preview creates nothing but lists the plan', r.status === 200 && r.body.applied === false && r.body.summary.willCreate === 5, r.body);
      // Billed one month in arrears: Jan hours -> Feb invoice.
      check('preview: hours x billing rate (160 x 100 = 16000) on the next month\'s invoice, client-only name matches, zero hours ignored',
        r.body.willCreate.some((w) => w.consultant === 'Hana Hours' && w.periodMonth === '2026-02' && w.hoursMonth === '2026-01' && w.amount === 16000) &&
        r.body.willCreate.some((w) => w.consultant === 'Hana Hours' && w.periodMonth === '2026-04' && w.hoursMonth === '2026-03' && w.hours === 168) &&
        !r.body.willCreate.some((w) => w.consultant === 'Ivo Hours' && w.periodMonth === '2026-03'), r.body.willCreate);
      check('unknown consultant, unknown client and ambiguous client are reported, not guessed',
        r.body.unmatched.some((u) => u.name === 'Nobody Known') && r.body.unmatched.some((u) => u.client === 'Wrong Client') &&
        r.body.unmatched.some((u) => u.client === 'Beta' && /more than one vendor/.test(u.reason)), r.body.unmatched);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2026-02&includeInactive=1');
      check('preview wrote no invoices', r.body.invoices.length === 0, r.body);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: hrsBody({ apply: true }) });
      check('apply creates the 5 invoices', r.status === 201 && r.body.created === 5, r.body);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2026-02');
      const hanaJan = r.body.invoices.find((i) => i.consultant_name === 'Hana Hours');
      check('Jan hours invoice: Feb 2026 invoice billed to program IRG, paid, timesheet yes, issued Feb 1, NET30 due Mar 3',
        !!hanaJan && hanaJan.program_name === 'IRG' && hanaJan.payment_status === 'paid' && hanaJan.timesheet_submitted === 'yes' &&
        String(hanaJan.period_month).slice(0, 10) === '2026-02-01' &&
        String(hanaJan.issue_date).slice(0, 10) === '2026-02-01' && String(hanaJan.due_date).slice(0, 10) === '2026-03-03' && Number(hanaJan.amount) === 16000 && /^INV-202602-\d{5}$/.test(hanaJan.invoice_number), hanaJan);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: hrsBody({ apply: true }) });
      check('re-uploading the same file creates nothing (existing months left untouched)',
        r.status === 201 && r.body.created === 0 && r.body.skippedExisting.length === 5, r.body);
      // An invoice generated at 0 hours is filled in from the file; one with hours is never changed.
      r = await hrsOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-05' }) });
      check('generating the May invoice month creates 0-hour placeholders', r.status === 201 && r.body.created.length === 4 && r.body.created.every((i) => Number(i.hours) === 0), r.body);
      const aprRows = [{ name: 'Ivo Hours', client: 'Acme', hours: { 4: 120 } }];
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: aprRows, year: 2026, apply: true }) });
      check('April hours fill the 0-hour May invoice (120 x 80 = 9600), not duplicated',
        r.status === 201 && r.body.created === 0 && r.body.filled === 1, r.body);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2026-05');
      const ivoApr = r.body.invoices.filter((i) => i.consultant_name === 'Ivo Hours');
      check('May invoice now has the file’s April hours and amount', ivoApr.length === 1 && Number(ivoApr[0].hours) === 120 && Number(ivoApr[0].amount) === 9600, ivoApr);
      aprRows[0].hours = { 4: 999 };
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: aprRows, year: 2026, apply: true }) });
      check('an invoice that already has hours is left untouched', r.body.created === 0 && r.body.filled === 0 && r.body.skippedExisting.length === 1, r.body);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: hrsRows, year: 'abc' }) });
      check('bad year returns 400', r.status === 400, r);
      r = await otherOrgUser.fetch('/api/invoices/import-hours', { method: 'POST', body: hrsBody({ apply: true }) });
      check('another org cannot match this org’s consultants (nothing created)', r.status === 201 && r.body.created === 0, r.body);
      r = await makeJar().fetch('/api/invoices/import-hours', { method: 'POST', body: hrsBody() });
      check('import without a login returns 401', r.status === 401, r);

      // 33e. Each hours column gets its own year (Sam's W2 Payroll sheet: Hours/Dec is
      // December 2025 hours, then Hours/Jan.. 2026), and billing is one month in arrears
      // (Dec 2025 hours -> Jan 2026 invoice, issued Jan 1). The browser resolves the
      // columns with public/import-hours.js and sends hours keyed by HOURS month 'YYYY-MM'.
      const IH = require('../public/import-hours.js');
      const decJanCols = IH.resolveHourColumns(['Hours/Dec', 'Hours/Jan'].map(IH.parseHoursHeader), 2026);
      check('Dec-before-Jan columns with Year 2026: Dec 2025 hours -> Jan 2026 invoice, Jan 2026 hours -> Feb 2026 invoice',
        decJanCols.map((c) => c.key + '>' + c.invoiceKey).join(',') === '2025-12>2026-01,2026-01>2026-02', decJanCols);
      const decRow = { name: 'Hana Hours', client: 'IRG/State of RI', hours: {} };
      decRow.hours[decJanCols[0].key] = 168;
      decRow.hours[decJanCols[1].key] = 160; // the Feb 2026 invoice already has hours -> left untouched
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [decRow] }) });
      check('YYYY-MM payload needs no year; preview: invoice Jan 2026 for Dec 2025 hours (no Dec 2026)',
        r.status === 200 && r.body.willCreate.length === 1 && r.body.willCreate[0].periodMonth === '2026-01' && r.body.willCreate[0].hoursMonth === '2025-12' &&
        r.body.skippedExisting.length === 1 && r.body.skippedExisting[0].periodMonth === '2026-02' && r.body.skippedExisting[0].hoursMonth === '2026-01', r.body);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [decRow], apply: true }) });
      check('apply creates the Jan 2026 invoice', r.status === 201 && r.body.created === 1, r.body);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2026-01');
      check('month filter returns only that invoice month (2026-01)',
        r.status === 200 && r.body.invoices.length === 1 && r.body.invoices.every((i) => String(i.period_month).slice(0, 10) === '2026-01-01'), r.body);
      const hanaDec = r.body.invoices.find((i) => i.consultant_name === 'Hana Hours');
      check('Dec 2025 hours invoice: period_month 2026-01-01, issued 2026-01-01, NET30 due 2026-01-31, 168 x 100, INV-202601',
        !!hanaDec && String(hanaDec.period_month).slice(0, 10) === '2026-01-01' && String(hanaDec.issue_date).slice(0, 10) === '2026-01-01' &&
        String(hanaDec.due_date).slice(0, 10) === '2026-01-31' && Number(hanaDec.hours) === 168 && Number(hanaDec.amount) === 16800 &&
        /^INV-202601-\d{5}$/.test(hanaDec.invoice_number), hanaDec);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2025-12&includeInactive=1');
      const r2 = await hrsOwner.fetch('/api/invoices?periodMonth=2026-12&includeInactive=1');
      check('no Dec 2025 or Dec 2026 invoice was created', r.body.invoices.length === 0 && r2.body.invoices.length === 0, [r.body, r2.body]);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2026-02');
      check('month filter: 2026-02 lists only Feb 2026 invoices',
        r.body.invoices.length === 3 && r.body.invoices.every((i) => String(i.period_month).slice(0, 10) === '2026-02-01'), r.body);
      r = await hrsOwner.fetch('/api/invoices/months');
      check('invoice months list is newest first with counts',
        r.status === 200 && r.body.months[0].month === '2026-05' && r.body.months.some((m) => m.month === '2026-01' && m.count === 1) &&
        r.body.months.every((m, k, a) => k === 0 || a[k - 1].month > m.month), r.body);
      r = await makeJar().fetch('/api/invoices/months');
      check('invoice months without a login returns 401', r.status === 401, r);

      // An explicit year in the heading wins over the Year box.
      const nov = IH.resolveHourColumns([IH.parseHoursHeader("Hours/Nov'25")], 2026);
      check('explicit-year heading Hours/Nov\'25 is Nov 2025 hours (Dec 2025 invoice) even with Year 2026',
        nov[0].key === '2025-11' && nov[0].invoiceKey === '2025-12', nov);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [{ name: 'Ivo Hours', client: 'Acme', hours: { [nov[0].key]: 150 } }], apply: true }) });
      check('explicit-year column creates the Dec 2025 invoice', r.status === 201 && r.body.created === 1, r.body);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2025-12');
      check('Dec 2025 invoice (Nov 2025 hours) issued 2025-12-01 for 150 x 80',
        r.body.invoices.length === 1 && String(r.body.invoices[0].issue_date).slice(0, 10) === '2025-12-01' && Number(r.body.invoices[0].amount) === 12000, r.body);

      // An hours month after the current month is never invoiced, whatever the browser sends;
      // the current month's hours are fine (they go on next month's invoice).
      const nowNY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
      const nyY = Number(nowNY.find((x) => x.type === 'year').value), nyM = Number(nowNY.find((x) => x.type === 'month').value);
      const thisKey = nyY + '-' + String(nyM).padStart(2, '0');
      const nextKey = IH.invoiceMonthKey(thisKey);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [{ name: 'Ivo Hours', client: 'Acme', hours: { [nextKey]: 100 } }], apply: true }) });
      check('future hours month (' + nextKey + ') is skipped with reason "month is in the future", nothing created',
        r.status === 201 && r.body.created === 0 && r.body.summary.skippedFuture === 1 &&
        r.body.unmatched.some((u) => u.hoursMonth === nextKey && u.reason === 'month is in the future'), r.body);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=' + IH.invoiceMonthKey(nextKey) + '&includeInactive=1');
      check('no invoice exists for the future hours month', r.body.invoices.length === 0, r.body);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [{ name: 'Ivo Hours', client: 'Acme', hours: { 12: 100 } }], year: 2099 }) });
      check('old payload shape: a future hours month is skipped too',
        r.status === 200 && r.body.summary.willCreate === 0 && r.body.unmatched.some((u) => u.hoursMonth === '2099-12' && u.reason === 'month is in the future'), r.body);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [{ name: 'Ivo Hours', client: 'Acme', hours: { [thisKey]: 10 } }] }) });
      check('the current hours month (' + thisKey + ') is allowed -> ' + nextKey + ' invoice',
        r.status === 200 && r.body.willCreate.some((w) => w.hoursMonth === thisKey && w.periodMonth === nextKey), r.body);
      // A lone Dec column with no rollover and no year is NOT moved to the year before.
      const loneDec = IH.resolveHourColumns([IH.parseHoursHeader('Hours/Dec')], 2026);
      check('lone Hours/Dec with Year 2026 stays Dec 2026 hours (so it is future in Oct 2026)',
        loneDec[0].key === '2026-12' && IH.isFutureKey('2026-12', '2026-10'), loneDec);

      // Old payload shape (hours-month number + body.year) still works.
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [{ name: 'Ivo Hours', client: 'Acme', hours: { 5: 100 } }], year: 2025, apply: true }) });
      check('old payload shape: May 2025 hours create the Jun 2025 invoice', r.status === 201 && r.body.created === 1, r.body);
      r = await hrsOwner.fetch('/api/invoices?periodMonth=2025-06');
      check('old-shape invoice is Jun 2025, issued 2025-06-01',
        r.body.invoices.length === 1 && String(r.body.invoices[0].issue_date).slice(0, 10) === '2025-06-01' && Number(r.body.invoices[0].hours) === 100, r.body);
      r = await hrsOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [{ name: 'Ivo Hours', client: 'Acme', hours: { 5: 100 } }] }) });
      check('old payload shape without a year returns 400', r.status === 400, r);

      // 33f. Sam's real W2 Payroll layout: one sheet per month ("December 2025" ...,
      // "Hours/December 2025"), read sheet by sheet and combined per consultant + client
      // (synthetic fixture with the same structure). Expect Jan 2026.. invoices, no Dec 2026.
      const w2Owner = makeJar();
      r = await w2Owner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'W2 Sheets Co', name: 'W2 Owner', email: 'w2@w2sheets.test', password: 'w2sheetspass1' }) });
      check('w2 multi-sheet test org signup returns 201', r.status === 201, r);
      await w2Owner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'w2m.xlsx', data: { kpis: {}, records: [
        hrsRec('Asha Test', 'Acme Health', 'HCL', 66.5), hrsRec('Dev Sample', 'University of Test', 'ROSE', 40), hrsRec('Mo Example', 'State of Test', 'IRG', 74),
      ] } }) });
      const w2fx = require('./fixtures/w2-payroll-synthetic.json');
      const w2res = IH.resolveHoursImport(IH.parseHoursSheets(w2fx.sheets), 2026);
      r = await w2Owner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: w2res.rows }) });
      const w2Months = [...new Set(r.body.willCreate.map((w) => w.periodMonth))].sort();
      check('multi-sheet preview: invoice months Jan..Apr 2026 (11 invoices), nothing unmatched, no Dec 2026',
        r.status === 200 && r.body.summary.willCreate === 11 && r.body.unmatched.length === 0 && w2Months.join(',') === '2026-01,2026-02,2026-03,2026-04' &&
        !JSON.stringify(r.body).includes('2026-12'), r.body);
      check('multi-sheet preview: Asha Dec 2025 168 h -> Jan 2026 invoice; Jan 2026 160 h -> Feb 2026; Mar 2026 (sheet-name year) 176 h -> Apr 2026',
        r.body.willCreate.some((w) => w.consultant === 'Asha Test' && w.hoursMonth === '2025-12' && w.periodMonth === '2026-01' && w.hours === 168 && w.amount === 11172) &&
        r.body.willCreate.some((w) => w.consultant === 'Asha Test' && w.hoursMonth === '2026-01' && w.periodMonth === '2026-02' && w.hours === 160) &&
        r.body.willCreate.some((w) => w.consultant === 'Asha Test' && w.hoursMonth === '2026-03' && w.periodMonth === '2026-04' && w.hours === 176), r.body.willCreate);
      r = await w2Owner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: w2res.rows, apply: true }) });
      check('multi-sheet apply creates 11 invoices', r.status === 201 && r.body.created === 11, r.body);
      r = await w2Owner.fetch('/api/invoices?periodMonth=2026-01');
      check('Jan 2026 invoice month holds the Dec 2025 hours for all 3 consultants, issued 2026-01-01',
        r.body.invoices.length === 3 && r.body.invoices.every((i) => String(i.issue_date).slice(0, 10) === '2026-01-01') &&
        r.body.invoices.map((i) => i.consultant_name + ':' + Number(i.hours)).sort().join(',') === 'Asha Test:168,Dev Sample:120,Mo Example:176', r.body);
      r = await w2Owner.fetch('/api/invoices/months');
      check('w2 org invoice months are Apr, Mar, Feb, Jan 2026 only (no Dec 2026)',
        r.body.months.map((m) => m.month).join(',') === '2026-04,2026-03,2026-02,2026-01', r.body);

      // 33g. Client invoices list: all months by default (grouped by invoice month with
      // totals), or a chosen set of months via ?months=; totals follow the filters.
      r = await w2Owner.fetch('/api/invoices');
      check('list with no month filter returns every month (11 invoices), each row has period_key',
        r.status === 200 && r.body.invoices.length === 11 && r.body.invoices.every((i) => /^\d{4}-\d{2}$/.test(i.period_key)), r.body);
      check('totals over everything: 11 invoices, 1744 h, $103,676.00; per month newest first',
        r.body.totals.count === 11 && r.body.totals.hours === 1744 && r.body.totals.amount === 103676 &&
        r.body.totals.byMonth.map((m) => m.month + ':' + m.count + ':' + m.amount).join(',') === '2026-04:2:18744,2026-03:3:27376,2026-02:3:28560,2026-01:3:28996', r.body.totals);
      r = await w2Owner.fetch('/api/invoices?months=2026-01,2026-03');
      check('months=2026-01,2026-03 returns only those two months (6 invoices), newest month first',
        r.status === 200 && r.body.invoices.length === 6 && r.body.invoices.every((i) => ['2026-01', '2026-03'].includes(i.period_key)) &&
        r.body.invoices[0].period_key === '2026-03', r.body);
      check('totals recalculated for the chosen months: 6 invoices, 920 h, $56,372.00',
        r.body.totals.count === 6 && r.body.totals.hours === 920 && r.body.totals.amount === 56372 && r.body.totals.byMonth.length === 2, r.body.totals);
      const janInv = r.body.invoices.find((i) => i.period_key === '2026-01' && i.consultant_name === 'Dev Sample');
      await w2Owner.fetch('/api/invoices/' + janInv.id, { method: 'PATCH', body: JSON.stringify({ paymentStatus: 'unpaid' }) });
      r = await w2Owner.fetch('/api/invoices?months=2026-01,2026-03&paymentStatus=unpaid');
      check('totals respect the payment filter: 1 unpaid invoice, 120 h, $4,800.00',
        r.status === 200 && r.body.invoices.length === 1 && r.body.totals.count === 1 && r.body.totals.hours === 120 && r.body.totals.amount === 4800, r.body);
      r = await w2Owner.fetch('/api/invoices?months=2026-02');
      check('a single month via months= works (3 invoices)', r.body.invoices.length === 3 && r.body.totals.count === 3, r.body);
      r = await w2Owner.fetch('/api/invoices?periodMonth=2026-02');
      check('periodMonth= still works (backward compatible)', r.status === 200 && r.body.invoices.length === 3 && r.body.totals.amount === 28560, r.body);
      r = await w2Owner.fetch('/api/invoices?months=2026-13');
      const rBad = await w2Owner.fetch('/api/invoices?months=Jan');
      check('bad months value returns 400', r.status === 400 && rBad.status === 400, [r, rBad]);
      r = await otherOrgUser.fetch('/api/invoices?months=2026-01,2026-02');
      check('months filter stays scoped to the caller’s org', r.status === 200 && !r.body.invoices.some((i) => i.consultant_name === 'Asha Test'), r.body);

      // 33h. Import hours: a Client-column text that doesn't match a pairing can be
      // merged into an existing pairing (saved as another name, so later imports
      // match too) or added as a new pairing. Nothing is invoiced until Apply.
      const fixOwner = makeJar();
      r = await fixOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Fix Pairing Co', name: 'Fix Owner', email: 'fix@fixpairing.test', password: 'fixpairingpass1' }) });
      check('fix-pairing test org signup returns 201', r.status === 201, r);
      await fixOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'fx.xlsx', data: { kpis: {}, records: [
        hrsRec('Mo Example', 'State of Test', 'IRG', 74), hrsRec('Asha Test', 'Acme Health', 'HCL', 66.5),
        hrsRec('Jun Sample', 'Beta', 'Rocket', 90), hrsRec('Jun Sample', 'Beta', 'Orbit', 95),
      ] } }) });
      r = await fixOwner.fetch('/api/directory/consultants');
      const fxCons = Object.fromEntries(r.body.consultants.map((c) => [c.name, c]));
      const moIrg = fxCons['Mo Example'].assignments.find((a) => a.program_name === 'IRG');
      const junRocket = fxCons['Jun Sample'].assignments.find((a) => a.program_name === 'Rocket');
      const fixRows = [
        { name: 'Mo Example ', client: 'International Resource Group/State of Test', hours: { '2026-09': 168 } },
        { name: 'Asha Test', client: 'NewProg/ New Client', hours: { '2026-08': 100 } },
        { name: 'Jun Sample', client: 'Beta', hours: { '2026-08': 50 } },
        { name: 'Nobody Known', client: 'Acme Health', hours: { '2026-08': 10 } },
      ];
      const fixPreview = () => fixOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: fixRows }) });
      r = await fixPreview();
      const moMiss = r.body.unmatched.find((u) => u.row === 1);
      check('unmatched client text for a known consultant is fixable: consultant, their pairings and how the text splits',
        r.status === 200 && r.body.summary.willCreate === 0 && moMiss && moMiss.fixable === true && moMiss.reasonCode === 'no_pairing' &&
        moMiss.consultantId === fxCons['Mo Example'].id && moMiss.pairings.some((x) => x.assignmentId === moIrg.id && x.program === 'IRG' && x.billing === 74) &&
        moMiss.parsedClient === 'State of Test' && moMiss.parsedProgram === 'International Resource Group', r.body.unmatched);
      check('ambiguous client text is fixable too; unknown consultant is not',
        r.body.unmatched.some((u) => u.row === 3 && u.reasonCode === 'ambiguous' && u.fixable && u.pairings.length === 2) &&
        r.body.unmatched.some((u) => u.row === 4 && !u.fixable && /not found/.test(u.reason)), r.body.unmatched);

      // Merge into existing: the text becomes another name for State of Test / IRG.
      r = await fixOwner.fetch('/api/directory/client-aliases', { method: 'POST', body: JSON.stringify({ aliasText: 'International Resource Group/State of Test', assignmentId: moIrg.id }) });
      check('merge saves the text as another name for the client/program', r.status === 201 && r.body.alias.client_name === 'State of Test' && r.body.alias.program_name === 'IRG', r.body);
      r = await fixPreview();
      check('after merge the row moves into the preview: Sep 2026 hours -> Oct 2026 invoice on IRG at $74 (nothing created yet)',
        r.body.willCreate.some((w) => w.consultant === 'Mo Example' && w.program === 'IRG' && w.periodMonth === '2026-10' && w.hoursMonth === '2026-09' && w.rate === 74 && w.amount === 12432) &&
        !r.body.unmatched.some((u) => u.row === 1), r.body);
      r = await fixOwner.fetch('/api/invoices?includeInactive=1');
      check('merge/preview created no invoices', r.body.invoices.length === 0, r.body);
      r = await fixOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [{ name: 'Mo Example', client: 'international resource group / state of test', hours: { '2026-08': 160 } }] }) });
      check('the saved name matches later imports too (case / spacing ignored)', r.body.willCreate.length === 1 && r.body.willCreate[0].program === 'IRG', r.body);
      r = await fixOwner.fetch('/api/directory/client-aliases');
      check('saved client name matches are listed', r.status === 200 && r.body.aliases.length === 1 && r.body.aliases[0].alias_text === 'International Resource Group/State of Test', r.body);

      // Ambiguous text merged into one of the two programs.
      r = await fixOwner.fetch('/api/directory/client-aliases', { method: 'POST', body: JSON.stringify({ aliasText: 'Beta', assignmentId: junRocket.id }) });
      r = await fixPreview();
      check('ambiguous "Beta" merged into Beta / Rocket now matches Rocket', r.body.willCreate.some((w) => w.consultant === 'Jun Sample' && w.program === 'Rocket' && w.rate === 90), r.body);

      // Add new: a pairing created from the Client text (Program/Client split like the Margin file).
      r = await fixOwner.fetch('/api/directory/consultants/' + fxCons['Asha Test'].id + '/assignments/from-text', { method: 'POST', body: JSON.stringify({ clientText: 'NewProg/ New Client', billing: 55 }) });
      check('add new creates the pairing: client New Client, program NewProg, $55, manual',
        r.status === 201 && r.body.existed === false && r.body.assignment.client_name === 'New Client' && r.body.assignment.program_name === 'NewProg' &&
        Number(r.body.assignment.billing) === 55 && r.body.assignment.source === 'manual' && r.body.clientCreated === true, r.body);
      r = await fixOwner.fetch('/api/directory/consultants/' + fxCons['Asha Test'].id + '/assignments/from-text', { method: 'POST', body: JSON.stringify({ clientText: 'NewProg/New Client', billing: 99 }) });
      check('adding the same pairing again returns it unchanged (no duplicate, billing kept)', r.status === 200 && r.body.existed === true && Number(r.body.assignment.billing) === 55, r.body);
      r = await fixPreview();
      check('after add the row is in the preview: Aug 2026 hours -> Sep 2026 invoice on New Client / NewProg at $55; only the unknown consultant left',
        r.body.willCreate.some((w) => w.consultant === 'Asha Test' && w.client === 'New Client' && w.program === 'NewProg' && w.periodMonth === '2026-09' && w.amount === 5500) &&
        r.body.summary.willCreate === 3 && r.body.unmatched.length === 1 && r.body.unmatched[0].row === 4, r.body);
      r = await fixOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: fixRows, apply: true }) });
      check('Apply creates the 3 invoices', r.status === 201 && r.body.created === 3, r.body);

      // Validation and scoping.
      r = await fixOwner.fetch('/api/directory/consultants/' + fxCons['Asha Test'].id + '/assignments/from-text', { method: 'POST', body: JSON.stringify({ clientText: '  ', billing: 10 }) });
      const rBill = await fixOwner.fetch('/api/directory/consultants/' + fxCons['Asha Test'].id + '/assignments/from-text', { method: 'POST', body: JSON.stringify({ clientText: 'X', billing: 'abc' }) });
      check('add new: blank client text or bad billing returns 400', r.status === 400 && rBill.status === 400, [r, rBill]);
      r = await otherOrgUser.fetch('/api/directory/client-aliases', { method: 'POST', body: JSON.stringify({ aliasText: 'Steal', assignmentId: moIrg.id }) });
      const rOtherAdd = await otherOrgUser.fetch('/api/directory/consultants/' + fxCons['Asha Test'].id + '/assignments/from-text', { method: 'POST', body: JSON.stringify({ clientText: 'X/Y', billing: 1 }) });
      check('another org cannot merge into or add to this org’s pairings', r.status === 404 && rOtherAdd.status === 404, [r, rOtherAdd]);
      r = await makeJar().fetch('/api/directory/client-aliases');
      check('client name matches without a login returns 401', r.status === 401, r);
      r = await fixOwner.fetch('/api/directory/client-aliases');
      const ircAlias = r.body.aliases.find((a) => /International Resource Group/.test(a.alias_text));
      r = await fixOwner.fetch('/api/directory/client-aliases/' + ircAlias.id, { method: 'DELETE' });
      const rAfterDel = await fixOwner.fetch('/api/invoices/import-hours', { method: 'POST', body: JSON.stringify({ rows: [fixRows[0]] }) });
      check('removing a saved match makes that text unmatched again (fixable)', r.status === 200 && rAfterDel.body.unmatched.length === 1 && rAfterDel.body.unmatched[0].fixable, rAfterDel.body);

      // 33e. Import history: the multi-year hours workbook (one flat row per consultant / client / month); billed one month in arrears.
      const hxOwner = makeJar();
      r = await hxOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'History Import Co', name: 'Hrs Owner', email: 'hx@historyimport.test', password: 'historyimportpass1' }) });
      check('hours-import test org signup returns 201', r.status === 201, r);
      const hxRec = (name, client, program, billing) => ({ name, client, program, clientDetail: client, cost: 50, billing, margin: 10, status: 'Active', employmentType: 'W2 (direct)', subvendorText: 'W2' });
      await hxOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'h.xlsx', data: { kpis: {}, records: [
        hxRec('Hana Hours', 'State of RI', 'IRG', 100), hxRec('Ivo Hours', 'Acme', 'Acme', 80), hxRec('Jun Hours', 'Beta', 'Rocket', 90), hxRec('Jun Hours', 'Beta', 'Orbit', 95),
      ] } }) });
      const hxr = (name, client, year, month, hours, extra) => Object.assign({ sheet: year + '-' + month, name, client, year, month, hours, paymentTerms: 'W2' }, extra || {});
      const hxRows = [
        hxr('Hana Hours', 'IRG/State of RI', 2026, 1, 160),
        hxr('Hana Hours', 'IRG/State of RI', 2026, 2, 152),
        hxr('HANA HOURS', 'State of RI', 2026, 3, 168),
        hxr('Ivo Hours', 'Acme', 2026, 1, 100),
        hxr('Ivo Hours', 'Acme', 2026, 2, 0),
        hxr('Nobody Known', 'Acme', 2025, 11, 10, { paymentTerms: 'Garni Software' }),
        hxr('Jun Hours', 'Beta', 2026, 1, 50),
        hxr('Jun Hours', 'Rocket/Beta', 2026, 1, 40),
        hxr('Ivo Hours', 'Wrong Client', 2026, 1, 5, { paymentTerms: 'Shyam 1099' }),
        hxr('Mia Text', 'Acme', 2026, 1, null, { hoursNote: 'no timesheets' }),
        hxr('Abdul Hours-2', 'Acme', 2026, 1, 20),
        hxr('Abdul Hours-1', 'Beta/Cobalt', 2026, 1, 30),
        // Start / left dates: January is before the start date, March after the left date.
        hxr('Eve Dates', 'Dateco', 2026, 1, 10, { startDate: '2026-02-01', leftDate: '2026-02-15' }),
        hxr('Eve Dates', 'Dateco', 2026, 2, 20, { startDate: '2026-02-01', leftDate: '2026-02-15' }),
        hxr('Eve Dates', 'Dateco', 2026, 3, 30, { startDate: '2026-02-01', leftDate: '2026-02-15' }),
        // The same consultant and client twice in one month is a conflict, never summed or guessed.
        hxr('Twin Row', 'Acme', 2026, 1, 10), hxr('Twin Row', 'Acme', 2026, 1, 12),
      ];
      const hxBody = (extra, rows) => JSON.stringify(Object.assign({ rows: rows || hxRows, netTerms: 'NET30', paymentStatus: 'unpaid', timesheetSubmitted: 'yes' }, extra || {}));
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody() });
      check('preview creates nothing but lists the plan', r.status === 200 && r.body.applied === false && r.body.summary.willCreate === 10, r.body.summary);
      check('preview: hours x Directory billing rate (160 x 100 = 16000); client-only name matches; 0 hours ignored',
        r.body.willCreate.some((w) => w.consultant === 'Hana Hours' && w.periodMonth === '2026-02' && w.hoursMonth === '2026-01' && w.amount === 16000) &&
        r.body.willCreate.some((w) => w.consultant === 'Hana Hours' && w.periodMonth === '2026-04' && w.hours === 168) &&
        !r.body.willCreate.some((w) => w.consultant === 'Ivo Hours' && w.hoursMonth === '2026-02'), r.body.willCreate);
      check('ambiguous client, text hours, out-of-range dates and same-month duplicates are reported, not guessed',
        r.body.issues.some((u) => u.name === 'Jun Hours' && u.client === 'Beta' && /more than one vendor/.test(u.reason)) &&
        r.body.issues.some((u) => u.name === 'Mia Text' && u.kind === 'hours-text') &&
        r.body.issues.some((u) => u.name === 'Eve Dates' && /before Start Date/.test(u.reason)) &&
        r.body.issues.some((u) => u.name === 'Eve Dates' && /after Date-if-left/.test(u.reason)) &&
        r.body.issues.filter((u) => u.name === 'Twin Row' && u.kind === 'conflict').length === 2 &&
        !r.body.willCreate.some((w) => w.consultant === 'Twin Row'), r.body.issues);
      check('preview counts what would be added to Directory',
        r.body.summary.newConsultants === 3 && r.body.summary.newClients >= 3 && r.body.summary.noRate === 5, r.body.summary);
      check('"-1 / -2" name suffixes are treated as the same person', r.body.willCreate.filter((w) => w.consultant === 'Abdul Hours').length === 2, r.body.willCreate);
      check('Payment Terms: W2, 1099 (even "Shyam 1099") and subvendor text are tagged',
        r.body.willCreate.find((w) => w.consultant === 'Hana Hours').category === 'W2' &&
        r.body.willCreate.find((w) => w.consultant === 'Ivo Hours' && w.client === 'Wrong Client').category === '1099' &&
        r.body.willCreate.find((w) => w.consultant === 'Nobody Known').category === 'Subvendor', r.body.willCreate);
      r = await hxOwner.fetch('/api/invoices/history?year=2026');
      check('preview wrote no invoices', r.body.total === 0, r.body.summary);
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ apply: true }) });
      check('apply creates the 10 invoices', r.status === 201 && r.body.done.created === 10, r.body);
      r = await hxOwner.fetch('/api/invoices/history?year=2026&month=2&pageSize=200');
      const hxHanaFeb = r.body.invoices.find((i) => i.consultant_name === 'Hana Hours');
      check('invoice (Jan hours → Feb invoice): billed to program IRG, unpaid, tagged W2, issued the 1st, NET30 due, INV-202602-#####',
        !!hxHanaFeb && hxHanaFeb.program_name === 'IRG' && hxHanaFeb.payment_status === 'unpaid' && hxHanaFeb.payment_category === 'W2' &&
        String(hxHanaFeb.due_date).slice(0, 10) === '2026-03-03' && String(hxHanaFeb.issue_date).slice(0, 10) === '2026-02-01' && Number(hxHanaFeb.amount) === 16000 && /^INV-202602-\d{5}$/.test(hxHanaFeb.invoice_number), hxHanaFeb);
      const hxWrongInv = r.body.invoices.find((i) => i.client_name === 'Wrong Client');
      check('a pairing with no Directory rate still gets its invoice, flagged: no rate, $0',
        !!hxWrongInv && hxWrongInv.rate === null && Number(hxWrongInv.amount) === 0 && /no billing rate/.test(hxWrongInv.notes) && hxWrongInv.payment_category === '1099', hxWrongInv);
      r = await hxOwner.fetch('/api/directory/consultants');
      const hxEve = (r.body.consultants || []).find((c) => c.name === 'Eve Dates');
      const hxEveAssign = hxEve && (hxEve.assignments || [])[0];
      check('new consultants get no status; a new pairing with a left date is marked left',
        !!hxEve && hxEve.status === null && !!hxEveAssign && hxEveAssign.status === 'left' && String(hxEveAssign.left_date).slice(0, 10) === '2026-02-15', hxEve);
      r = await hxOwner.fetch('/api/invoices/history?year=2025');
      check('multi-year: the Nov 2025 hours land on a Dec 2025 invoice', r.body.total === 1 && r.body.years.length === 2 && r.body.months[0].month === 12, r.body.summary);
      r = await hxOwner.fetch('/api/invoices/history?year=2026&month=2&q=hana');
      check('history search by consultant', r.body.total === 1, r.body.summary);
      r = await hxOwner.fetch('/api/invoices/history?category=1099');
      check('history filter by Paid-via category', r.body.total === 1, r.body.summary);
      r = await hxOwner.fetch('/api/invoices/history?year=2026&sort=amount&dir=desc&pageSize=10&page=1');
      check('history sorts by amount and pages', r.body.invoices[0].consultant_name === 'Hana Hours' && Number(r.body.invoices[0].amount) === 16800 && r.body.pageSize === 10, r.body.invoices[0]);
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ apply: true }) });
      check('re-uploading the same file creates nothing (existing months left untouched)',
        r.status === 201 && r.body.done.created === 0 && r.body.summary.skippedExisting === 10, r.body.summary);
      r = await hxOwner.fetch('/api/directory/consultants');
      check('re-upload adds no duplicate consultants', (r.body.consultants || []).filter((c) => c.name === 'Hana Hours').length === 1 && (r.body.consultants || []).length === 6, (r.body.consultants || []).length);
      // An invoice generated at 0 hours is filled in from the file; one with hours is never changed.
      r = await hxOwner.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-05' }) });
      check('generating May creates 0-hour placeholders', r.status === 201 && r.body.created.length >= 1 && r.body.created.every((i) => Number(i.hours) === 0), r.body);
      const mayRows = [hxr('Ivo Hours', 'Acme', 2026, 4, 120)];
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ apply: true }, mayRows) });
      check('the 0-hour May invoice (April hours) is filled in (120 x 80 = 9600), not duplicated', r.status === 201 && r.body.done.created === 0 && r.body.done.filled === 1, r.body);
      r = await hxOwner.fetch('/api/invoices/history?year=2026&month=5&q=ivo');
      check('May invoice now has the file’s hours and amount', r.body.total === 1 && Number(r.body.invoices[0].hours) === 120 && Number(r.body.invoices[0].amount) === 9600 && r.body.invoices[0].payment_category === 'W2', r.body.invoices);
      mayRows[0].hours = 999;
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ apply: true }, mayRows) });
      check('an invoice that already has hours is left untouched', r.body.done.created === 0 && r.body.done.filled === 0 && r.body.summary.skippedExisting === 1, r.body.summary);
      // Dates can be switched off, and subvendors are only created on request.
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ enforceDates: false }, hxRows.filter((x) => x.name === 'Eve Dates')) });
      check('with date limits off, Eve’s January and March hours are planned too', r.body.summary.willCreate === 2 && r.body.summary.skippedExisting === 1, r.body.summary);
      const hxSubRows = [hxr('Sub Person', 'Acme', 2026, 5, 100, { paymentTerms: 'Garni Software' })];
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({}, hxSubRows) });
      check('an unknown subvendor is listed, not created, by default', r.body.summary.subvendorInvoices === 0 && r.body.notes.unrecognizedTerms[0].text === 'Garni Software', r.body);
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ apply: true, createSubvendors: true }, hxSubRows) });
      check('with "add subvendors" on, the subvendor and its subvendor invoice are created', r.status === 201 && r.body.done.subvendorCreated === 1, r.body);
      r = await hxOwner.fetch('/api/subvendor-invoices?periodMonth=2026-05');
      check('the subvendor invoice shows in Subvendor payments (hours from the file, no rate yet)',
        r.body.invoices.length === 1 && r.body.invoices[0].subvendor_name === 'Garni Software' && Number(r.body.invoices[0].hours) === 100 && r.body.invoices[0].rate_source === 'hours_file', r.body.invoices);
      const futureRows = [hxr('Future Fred', 'Acme', 2099, 1, 10)];
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({}, futureRows) });
      check('hours of a future month are held back and listed', r.body.summary.willCreate === 0 && r.body.issues.some((u) => u.kind === 'future'), r.body.summary);
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ arrears: false }, [hxr('Hana Hours', 'IRG/State of RI', 2026, 7, 100)]) });
      check('with arrears off the invoice month is the hours month', r.body.willCreate.length === 1 && r.body.willCreate[0].periodMonth === '2026-07' && r.body.willCreate[0].hoursMonth === '2026-07', r.body.willCreate);
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({}, [hxr('Hana Hours', 'IRG/State of RI', 2026, 7, 100)]) });
      check('by default July hours go on the August invoice', r.body.willCreate.length === 1 && r.body.willCreate[0].periodMonth === '2026-08' && r.body.willCreate[0].hoursMonth === '2026-07', r.body.willCreate);
      // Bulk paid, fill rates, CSV.
      r = await hxOwner.fetch('/api/invoices/bulk-status', { method: 'POST', body: JSON.stringify({ paymentStatus: 'paid' }) });
      check('bulk status without a year is refused', r.status === 400, r);
      r = await hxOwner.fetch('/api/invoices/bulk-status', { method: 'POST', body: JSON.stringify({ year: 2025, paymentStatus: 'paid' }) });
      check('bulk: mark 2025 paid touches only 2025', r.status === 200 && r.body.updated === 1, r);
      r = await hxOwner.fetch('/api/invoices/history?paymentStatus=paid');
      check('only the 2025 invoice is paid', r.body.total === 1, r.body.summary);
      await hxOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({ fileName: 'h2.xlsx', data: { kpis: {}, records: [hxRec('Ivo Hours', 'Wrong Client', null, 70)] } }) });
      r = await hxOwner.fetch('/api/invoices/fill-rates', { method: 'POST' });
      check('fill-rates gives the no-rate invoice the Directory rate', r.status === 200 && r.body.updated === 1, r);
      r = await hxOwner.fetch('/api/invoices/history?year=2026&month=2&q=wrong');
      check('…and recomputes its amount (5 h x $70)', r.body.invoices[0] && Number(r.body.invoices[0].rate) === 70 && Number(r.body.invoices[0].amount) === 350, r.body.invoices);
      r = await otherOrgUser.fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody({ apply: true }) });
      check('another org’s import creates records only in its own org', r.status === 201, r.body && r.body.summary);
      r = await hxOwner.fetch('/api/invoices/history');
      const hxTotalAfter = r.body.total;
      check('…and this org’s invoices are unchanged by it', hxTotalAfter === 15, hxTotalAfter);
      r = await hxOwner.fetch('/api/invoices/import-workbook', { method: 'POST', body: JSON.stringify({ rows: 'nope' }) });
      check('bad rows returns 400', r.status === 400, r);
      r = await makeJar().fetch('/api/invoices/import-workbook', { method: 'POST', body: hxBody() });
      check('import without a login returns 401', r.status === 401, r);
      r = await makeJar().fetch('/api/invoices/history');
      check('history without a login returns 401', r.status === 401, r);

      // Deploy check: public, read-only, no data.
      r = await makeJar().fetch('/api/version');
      check('/api/version is public and reports fingerprint + schema flags only',
        r.status === 200 && r.body.schema && r.body.schema.ok === true && r.body.fingerprint && /^[0-9a-f]{16}$/.test(r.body.fingerprint.server.overall) &&
        !JSON.stringify(r.body).match(/password|secret|@/i), r.body);

      // 34. Fin-Module "Subvendor payments": months already paid are read
      // read-only from the latest Ledger upload; December 2026 onwards can be
      // generated from the Ledger rate (else the Margin cost rate). Own org.
      const svOwner = makeJar();
      r = await svOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Subvendor Test Co', name: 'Sv Owner', email: 'sv@svtest.test', password: 'subvendorpassword1' }) });
      check('subvendor-payments test org signup returns 201', r.status === 201, r);

      // month = the SHEET (when it was paid); period + year = the hours month.
      const svLedger = (fileName, extraSam) => ({
        fileName,
        data: {
          kpis: {},
          consultants: [
            { name: 'Sam Sub', placements: [
              { subvendor: 'Vendor One', period: 'Oct', year: '2025', name: 'Sam Sub', amount: 8000, rate: 50, hours: 160, month: 'January', clientTag: 'HCL', paidDate: '2026-02-05T00:00:00.000Z' },
              { subvendor: 'Vendor One', period: 'Nov', year: '2025', name: 'Sam Sub', amount: 8800, rate: 55, hours: 160, month: 'February', clientTag: 'HCL' },
              { subvendor: 'Vendor One', period: 'Nov bal.', year: '2025', name: 'Sam Sub', amount: 500, month: 'March', clientTag: 'HCL' },
              { subvendor: 'Vendor One', period: 'Jan', year: '2026', name: 'Sam Sub', amount: 99, rate: 61, hours: 2, month: 'March', clientTag: 'HCL', unpaid: true },
            ].concat(extraSam || []) },
            { name: 'Uma Unset', placements: [
              { subvendor: 'Vendor Two', period: 'Dec + bal Nov', year: '2025', name: 'Uma Unset', amount: 9000, rate: 60, hours: 150, month: 'March', clientTag: 'Non-HCL' },
              { subvendor: 'Vendor Two', period: null, year: '2025', name: 'Uma Unset', amount: 3000, month: 'March', clientTag: 'Non-HCL' },
            ] },
            { name: 'Tina Left', placements: [
              { subvendor: 'Vendor One', period: 'Jan', name: 'Tina Left', amount: 100, rate: 40, hours: 2, month: 'Left', clientTag: 'HCL', unpaid: true },
            ] },
          ],
        },
      });
      r = await svOwner.fetch('/api/ledger', { method: 'POST', body: JSON.stringify(svLedger('2026 Sub Vendor Payments.xlsx')) });
      check('subvendor ledger upload returns 201', r.status === 201, r);

      // Margin: Sam active (Vendor One, cost 45 -- must NOT override his Ledger rate),
      // Tina left, Max only on Margin (Vendor Three, cost 70), Uma not on Margin at all.
      r = await svOwner.fetch('/api/margin', { method: 'POST', body: JSON.stringify({
        fileName: 'SvMargin.xlsx',
        data: { kpis: {}, records: [
          { name: 'Sam Sub', client: 'Acme', program: 'Rocket', clientDetail: 'Acme', cost: 45, billing: 100, status: 'Active', employmentType: 'Subvendor', subvendorText: 'Vendor One' },
          { name: 'Tina Left', client: 'Acme', program: 'Rocket', clientDetail: 'Acme', cost: 40, billing: 90, status: 'Left', employmentType: 'Subvendor', subvendorText: 'Vendor One' },
          { name: 'Max Margin', client: 'Acme', program: 'Rocket', clientDetail: 'Acme', cost: 70, billing: 110, status: 'Active', employmentType: 'Subvendor', subvendorText: 'Vendor Three' },
        ] },
      }) });
      check('subvendor margin upload returns 201', r.status === 201, r);

      r = await svOwner.fetch('/api/subvendor-invoices');
      check('paid history = 4 file rows (hours months; the red-Amount row, the Left sheet and the no-month row are left out)',
        r.status === 200 && r.body.invoices.length === 4 && r.body.invoices.every((i) => i.kind === 'paid' && i.status === 'paid'), r.body);
      const samOct = r.body.invoices.find((i) => i.consultant_name === 'Sam Sub' && i.period_month === '2025-10-01');
      check('invoice month = hours month from the label + Year (not the sheet); sheet shown as paid-in',
        !!samOct && samOct.subvendor_name === 'Vendor One' && samOct.rate === 50 && samOct.hours === 160 && samOct.amount === 8000 && samOct.paid_date === '2026-02-05' && samOct.paid_in === 'January', samOct);
      check('two file rows for the same hours month stay as two lines (Nov + Nov bal.)',
        r.body.invoices.filter((i) => i.consultant_name === 'Sam Sub' && i.period_month === '2025-11-01').length === 2, r.body.invoices);
      check('the red (unpaid) Amount row is not added', !r.body.invoices.some((i) => i.period_month === '2026-01-01'), r.body.invoices);
      const umaDec = r.body.invoices.find((i) => i.consultant_name === 'Uma Unset');
      check('"Dec + bal Nov" with Year 2025 is Dec 2025 and flagged multi-month', !!umaDec && umaDec.period_month === '2025-12-01' && umaDec.multi_month === true && umaDec.paid_in === 'March', umaDec);
      check('a row with no month in its label is listed as unreadable, not invoiced',
        r.body.unreadable.length === 1 && r.body.unreadable[0].consultant === 'Uma Unset' && r.body.unreadable[0].amount === 3000, r.body.unreadable);
      check('response names the Ledger file and lists subvendors for the filter',
        r.body.ledgerFile && r.body.ledgerFile.file_name === '2026 Sub Vendor Payments.xlsx' && r.body.subvendors.length === 2, r.body);
      check('generation opens the month after the active consultant\u2019s last hours month (Nov 2025 -> Dec 2025)', r.body.generationStart === '2025-12', r.body.generationStart);

      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=2025-11');
      check('period filter narrows to that hours month', r.body.invoices.length === 2 && r.body.invoices.every((i) => i.consultant_name === 'Sam Sub'), r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=bogus');
      check('bad period filter returns 400', r.status === 400, r);

      // Per consultant: Sam's last hours month is Nov 2025, so Nov 2025 is skipped for him.
      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2025-11' }) });
      check('a month already on the file is skipped for that consultant only (Max, not on the file, is generated)',
        r.status === 201 && r.body.created.length === 1 && r.body.skipped.some((s) => s.consultant.startsWith('Sam Sub') && /through Nov 2025/.test(s.reason)), r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?kind=generated');
      r = await svOwner.fetch('/api/subvendor-invoices/' + r.body.invoices[0].id, { method: 'DELETE' });
      check('(cleanup) the probe invoice is deleted', r.status === 200, r);
      r = await makeJar().fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-12' }) });
      check('generating without a login returns 401', r.status === 401, r);
      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: 'nope' }) });
      check('generating with a bad month returns 400', r.status === 400, r);
      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-12', netTerms: 'SOON' }) });
      check('generating with bad net terms returns 400', r.status === 400, r);

      // Dec 2026: 23 weekdays - Christmas (Fri) = 22 days x 8 = 176 hours.
      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-12' }) });
      check('generate Dec 2026 returns 201 with 2 invoices (active only)', r.status === 201 && r.body.created.length === 2 && r.body.defaultHours === 176, r.body);
      check('inactive and not-set pairings are skipped and counted',
        r.body.skippedInactive === 2 && r.body.skipped.some((s) => s.consultant.startsWith('Uma Unset') && s.reason === 'consultant status not set') &&
        r.body.skipped.some((s) => s.consultant.startsWith('Tina Left') && s.reason === 'consultant is inactive'), r.body.skipped);

      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=2026-12');
      const samDec = r.body.invoices.find((i) => i.consultant_name === 'Sam Sub');
      const maxDec = r.body.invoices.find((i) => i.consultant_name === 'Max Margin');
      check('Sam is generated at his latest Ledger rate ($55, not Margin’s $45): 55 x 176',
        !!samDec && samDec.kind === 'generated' && samDec.status === 'unpaid' && samDec.rate === 55 && samDec.hours === 176 && samDec.amount === 9680 && samDec.rate_source === 'ledger', samDec);
      check('Max has no Ledger rate, so the Margin cost rate is used: 70 x 176',
        !!maxDec && maxDec.rate === 70 && maxDec.amount === 12320 && maxDec.rate_source === 'margin' && maxDec.subvendor_name === 'Vendor Three', maxDec);
      check('generated invoice defaults: month-end issue date, NET30 due',
        samDec.issue_date === '2026-12-31' && samDec.due_date === '2027-01-30' && samDec.net_terms === 'NET30' && /^SVI-202612-\d{5}$/.test(samDec.invoice_number), samDec);

      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-12' }) });
      check('re-generating the same month creates nothing (idempotent)',
        r.status === 201 && r.body.created.length === 0 && r.body.skipped.some((s) => s.reason === 'already generated for this month'), r.body);

      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-12', includeInactive: true }) });
      check('includeInactive also generates the inactive and not-set pairings', r.status === 201 && r.body.created.length === 2, r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?kind=generated');
      check('kind filter lists only generated invoices (4)', r.body.invoices.length === 4 && r.body.invoices.every((i) => i.kind === 'generated'), r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?kind=paid');
      check('kind filter lists only paid invoices (4)', r.body.invoices.length === 4, r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?kind=weird');
      check('bad kind filter returns 400', r.status === 400, r);

      // Generated invoices are editable like client invoices.
      r = await svOwner.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({ hours: 100 }) });
      check('entering hours recalculates amount = rate x hours (55 x 100)', r.status === 200 && Number(r.body.invoice.hours) === 100 && Number(r.body.invoice.amount) === 5500, r.body);
      r = await svOwner.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({ hours: 90, amount: 5000 }) });
      check('an explicit amount wins over the hours-derived figure', r.status === 200 && Number(r.body.invoice.hours) === 90 && Number(r.body.invoice.amount) === 5000, r.body);
      r = await svOwner.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({
        paymentStatus: 'paid', timesheetSubmitted: 'yes', netTerms: 'NET45', dueDate: '2027-02-14', notes: 'Wired',
      }) });
      check('paid / timesheet / NET terms / due date / notes all patch',
        r.status === 200 && r.body.invoice.payment_status === 'paid' && r.body.invoice.timesheet_submitted === 'yes' &&
        r.body.invoice.net_terms === 'NET45' && r.body.invoice.notes === 'Wired', r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=2026-12&kind=generated');
      const samEdited = r.body.invoices.find((i) => i.consultant_name === 'Sam Sub');
      check('edits persist and show in the list (status follows payment)',
        samEdited.status === 'paid' && samEdited.timesheet_submitted === 'yes' && samEdited.amount === 5000 && samEdited.due_date === '2027-02-14' && samEdited.notes === 'Wired', samEdited);
      r = await svOwner.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({ hours: 'abc' }) });
      check('patching hours with garbage returns 400', r.status === 400, r);
      r = await svOwner.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({ paymentStatus: 'overdue' }) });
      check('patching an invalid paymentStatus returns 400', r.status === 400, r);
      r = await svOwner.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({ netTerms: 'LATER' }) });
      check('patching invalid net terms returns 400', r.status === 400, r);
      r = await otherOrgUser.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({ paymentStatus: 'paid' }) });
      check('cross-tenant subvendor invoice PATCH returns 404', r.status === 404, r);
      r = await otherOrgUser.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'DELETE' });
      check('cross-tenant subvendor invoice DELETE returns 404', r.status === 404, r);
      r = await svOwner.fetch('/api/subvendor-invoices/999999', { method: 'PATCH', body: JSON.stringify({ notes: 'x' }) });
      check('patching an unknown subvendor invoice returns 404', r.status === 404, r);
      // Put Sam's December invoice back to its plain generated values for later checks.
      r = await svOwner.fetch('/api/subvendor-invoices/' + samDec.id, { method: 'PATCH', body: JSON.stringify({ hours: 176, paymentStatus: 'unpaid' }) });
      check('hours edit back to the default recalculates again', r.status === 200 && Number(r.body.invoice.amount) === 9680, r.body);

      r = await otherOrgUser.fetch('/api/subvendor-invoices');
      check('cross-tenant: another org sees none of these subvendor invoices',
        r.status === 200 && !r.body.invoices.some((i) => i.consultant_name === 'Sam Sub' || i.consultant_name === 'Max Margin'), r.body);

      // When the real December payment lands on a newer Ledger file, it
      // replaces Sam's generated invoice, and generating skips him.
      r = await svOwner.fetch('/api/ledger', { method: 'POST', body: JSON.stringify(svLedger('2026 Sub Vendor Payments v2.xlsx', [
        { subvendor: 'Vendor One', period: 'Dec', year: '2026', name: 'Sam Sub', amount: 9500, rate: 56, hours: 170, month: 'April', clientTag: 'HCL' },
      ])) });
      check('newer ledger upload with a December payment returns 201', r.status === 201, r);
      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=2026-12');
      const samRows = r.body.invoices.filter((i) => i.consultant_name === 'Sam Sub');
      check('the real December payment replaces the generated invoice (one Sam row, now paid)',
        samRows.length === 1 && samRows[0].kind === 'paid' && samRows[0].amount === 9500, samRows);
      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-12' }) });
      check('December is now on the payments file for Sam, so he is skipped',
        r.status === 201 && r.body.skipped.some((s) => s.consultant.startsWith('Sam Sub') && /through Dec 2026/.test(s.reason)), r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?kind=paid');
      check('generation window moved to the month after the new last month', r.body.generationStart === '2027-01', r.body.generationStart);

      // Jan 2027: 21 weekdays - New Year's Day (Fri) - MLK Day = 19 days x 8 = 152h.
      // Sam is now at his newest Ledger rate ($56, from the Dec payment).
      r = await svOwner.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2027-01' }) });
      check('generate Jan 2027 creates Sam and Max at 152 hours', r.status === 201 && r.body.created.length === 2 && r.body.defaultHours === 152, r.body);
      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=2027-01');
      const samJan27 = r.body.invoices.find((i) => i.consultant_name === 'Sam Sub');
      check('Jan 2027 uses Sam\u2019s newest Ledger rate: 56 x 152', !!samJan27 && samJan27.rate === 56 && samJan27.amount === 8512, samJan27);
      r = await svOwner.fetch('/api/subvendor-invoices/' + samJan27.id, { method: 'DELETE' });
      check('deleting a generated subvendor invoice returns ok', r.status === 200 && r.body.ok === true, r);
      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=2027-01');
      check('deleted subvendor invoice is gone from the list', r.body.invoices.length === 1 && r.body.invoices[0].consultant_name === 'Max Margin', r.body);
      r = await svOwner.fetch('/api/subvendor-invoices/' + samJan27.id, { method: 'DELETE' });
      check('deleting it again returns 404', r.status === 404, r);

      // 34b. Supplier payments are fully editable (rate, supplier, month, dates), payments-file rows can be
      // copied for editing (and reverted), and payments can be added by hand.
      r = await svOwner.fetch('/api/subvendor-invoices?kind=paid');
      const paidRow = r.body.invoices.find((i) => i.subvendor_id && i.consultant_id);
      check('there is a payments-file row to edit', !!paidRow, r.body.invoices.slice(0, 2));
      r = await svOwner.fetch('/api/subvendor-invoices/from-ledger', { method: 'POST', body: JSON.stringify({ subvendorId: paidRow.subvendor_id, consultantId: paidRow.consultant_id, periodMonth: paidRow.period_month.slice(0, 7) }) });
      check('Edit makes an editable copy of a payments-file row', (r.status === 201 || r.status === 200) && r.body.id > 0, r);
      const ovId = r.body.id;
      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=' + paidRow.period_month.slice(0, 7));
      const ovRows = r.body.invoices.filter((i) => i.subvendor_id === paidRow.subvendor_id && i.consultant_id === paidRow.consultant_id);
      check('the copy replaces the file row (one row, editable, marked as an edited copy)', ovRows.length === 1 && ovRows[0].kind === 'generated' && ovRows[0].overrides_ledger === true && ovRows[0].status === 'paid' && Number(ovRows[0].amount) === Number(paidRow.amount), ovRows);
      r = await svOwner.fetch('/api/subvendor-invoices/' + ovId, { method: 'PATCH', body: JSON.stringify({ rate: 70 }) });
      check('changing the rate re-prices the hours', r.status === 200 && Number(r.body.invoice.rate) === 70 && (r.body.invoice.hours === null || Number(r.body.invoice.amount) === Math.round(70 * Number(r.body.invoice.hours) * 100) / 100), r.body);
      r = await svOwner.fetch('/api/subvendor-invoices/' + ovId, { method: 'PATCH', body: JSON.stringify({ issueDate: '2026-02-01', dueDate: '2026-03-15', paidDate: '2026-03-10', notes: 'Corrected by finance', invoiceNumber: 'SVI-EDIT-1' }) });
      check('dates, notes and invoice number can be edited', r.status === 200 && String(r.body.invoice.invoice_number) === 'SVI-EDIT-1' && String(r.body.invoice.paid_date).slice(0, 10) === '2026-03-10' || (r.status === 200 && /2026-03-10/.test(JSON.stringify(r.body.invoice.paid_date))), r.body);
      r = await svOwner.fetch('/api/subvendor-invoices/' + ovId, { method: 'PATCH', body: JSON.stringify({ rate: 'abc' }) });
      check('a non-numeric rate is rejected', r.status === 400, r);
      r = await svOwner.fetch('/api/subvendor-invoices/' + ovId, { method: 'PATCH', body: JSON.stringify({ subvendorId: 999999 }) });
      check('an unknown supplier is rejected', r.status === 400, r);
      r = await svOwner.fetch('/api/subvendor-invoices/' + ovId, { method: 'DELETE' });
      check('reverting (deleting) the copy returns ok', r.status === 200, r);
      r = await svOwner.fetch('/api/subvendor-invoices?kind=paid&periodMonth=' + paidRow.period_month.slice(0, 7));
      check('the payments-file row is back after reverting', r.body.invoices.some((i) => i.subvendor_id === paidRow.subvendor_id && i.consultant_id === paidRow.consultant_id), r.body.invoices.length);

      r = await svOwner.fetch('/api/directory/subvendors'); const dirSubs = r.body.subvendors;
      r = await svOwner.fetch('/api/directory/consultants'); const dirCons = r.body.consultants;
      r = await svOwner.fetch('/api/subvendor-invoices', { method: 'POST', body: JSON.stringify({ subvendorId: dirSubs[0].id, consultantId: dirCons[0].id, periodMonth: '2031-05', rate: 40, hours: 10, netTerms: 'NET45', paymentStatus: 'paid' }) });
      check('adding a supplier payment by hand returns 201', r.status === 201 && r.body.id > 0, r);
      const manId = r.body.id;
      r = await svOwner.fetch('/api/subvendor-invoices?periodMonth=2031-05');
      const manRow = r.body.invoices.find((i) => i.id === manId);
      check('the manual payment is priced (40 x 10 = 400), paid and marked as added by hand', !!manRow && Number(manRow.amount) === 400 && manRow.status === 'paid' && manRow.rate_source === 'manual' && !!manRow.paid_date && manRow.net_terms === 'NET45', manRow);
      r = await svOwner.fetch('/api/subvendor-invoices', { method: 'POST', body: JSON.stringify({ subvendorId: dirSubs[0].id, consultantId: dirCons[0].id, periodMonth: '2031-05', rate: 41 }) });
      check('adding the same supplier/consultant/month twice returns 409', r.status === 409, r);
      r = await svOwner.fetch('/api/subvendor-invoices', { method: 'POST', body: JSON.stringify({ subvendorId: dirSubs[0].id, consultantId: dirCons[0].id, periodMonth: '2031-06' }) });
      check('a payment needs a rate', r.status === 400, r);
      r = await svOwner.fetch('/api/subvendor-invoices/' + manId, { method: 'PATCH', body: JSON.stringify({ periodMonth: '2031-07', subvendorId: dirSubs[dirSubs.length - 1].id }) });
      check('month and supplier of a payment can be changed', r.status === 200 && String(r.body.invoice.period_month).startsWith('2031-07') || (r.status === 200 && /2031-07/.test(JSON.stringify(r.body.invoice.period_month))), r.body);
      const svOther = makeJar(); await svOther.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Sv Other Co', name: 'Sv Other', email: 'svo@svtest.test', password: 'svotherpassword1' }) });
      r = await svOther.fetch('/api/subvendor-invoices/' + manId, { method: 'PATCH', body: JSON.stringify({ rate: 1 }) });
      check('another organisation cannot edit it (404)', r.status === 404, r);

      // 35. Record profiles (Consultant / Client / Vendor forms): CRM fields,
      // encrypted SSN / tax ID / bank numbers shown as last 4 only, org isolation.
      const pfOwner = makeJar();
      r = await pfOwner.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Profile Co', name: 'Pf Owner', email: 'pf@pftest.test', password: 'profilepassword1' }) });
      check('profile test org signup returns 201', r.status === 201, r);
      const pfOther = makeJar();
      r = await pfOther.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Profile Other Co', name: 'Pf Other', email: 'pfo@pftest.test', password: 'profilepassword2' }) });

      r = await pfOwner.fetch('/api/profiles/schema');
      check('schema lists the three forms and says encryption is configured', r.status === 200 && r.body.spec.consultants && r.body.spec.clients && r.body.spec.programs && r.body.spec.programs.singular === 'Vendor' && r.body.encryptionConfigured === true && r.body.canEditSecrets === true, r.body);
      const allKeys = (e) => r.body.spec[e].sections.flatMap((x) => x.fields.map((f2) => f2.key));
      check('consultant form has the SSN and bank secret fields', ['ssn', 'bank_routing', 'bank_account'].every((k) => allKeys('consultants').includes(k)), allKeys('consultants'));

      r = await pfOwner.fetch('/api/profiles/clients', { method: 'POST', body: JSON.stringify({ values: { name: 'Acme Health', industry: 'Healthcare', payment_terms: 'Net 30', email: 'ap@acme.test', billing_email: 'bill@acme.test', contact_name: 'Dana Lee' }, secrets: { tax_id: '12-3456789' } }) });
      check('creating a client returns 201 with an id', r.status === 201 && r.body.id > 0, r);
      const pfClient = r.body.id;
      r = await pfOwner.fetch('/api/profiles/clients', { method: 'POST', body: JSON.stringify({ values: { name: 'acme health' } }) });
      check('creating a client with an existing name (any case) returns 409', r.status === 409, r);
      r = await pfOwner.fetch('/api/profiles/clients', { method: 'POST', body: JSON.stringify({ values: { name: 'Bad Co', industry: 'Basket weaving' } }) });
      check('an option outside the list is rejected with 400', r.status === 400 && /Industry/.test(r.body.error), r);
      r = await pfOwner.fetch('/api/profiles/clients', { method: 'POST', body: JSON.stringify({ values: { name: 'Bad Co', billing_email: 'not-an-email' } }) });
      check('a bad email is rejected with 400', r.status === 400, r);
      r = await pfOwner.fetch('/api/profiles/clients', { method: 'POST', body: JSON.stringify({ values: {} }) });
      check('name is required', r.status === 400, r);

      r = await pfOwner.fetch('/api/profiles/clients/' + pfClient);
      check('client profile returns the saved fields and core email', r.status === 200 && r.body.values.industry === 'Healthcare' && r.body.values.email === 'ap@acme.test' && r.body.values.contact_name === 'Dana Lee', r.body);
      check('tax ID comes back as last 4 only', r.body.secrets.tax_id.set === true && r.body.secrets.tax_id.last4 === '6789' && r.body.secrets.tax_id.masked === '****6789', r.body.secrets);
      check('the full tax ID never appears in the response', !JSON.stringify(r.body).includes('123456789') && !JSON.stringify(r.body).includes('12-3456789'), r.body);

      r = await pfOwner.fetch('/api/profiles/programs', { method: 'POST', body: JSON.stringify({ values: { name: 'Prime Staffing', client_id: String(pfClient), payment_terms: 'Net 45', contact_name: 'Raj Rao' }, secrets: { bank_routing: '021000021', bank_account: '000123456789' } }) });
      check('creating a vendor under the client returns 201', r.status === 201, r);
      const pfSub = r.body.id;
      r = await pfOwner.fetch('/api/profiles/programs', { method: 'POST', body: JSON.stringify({ values: { name: 'Prime Staffing', client_id: String(pfClient) } }) });
      check('a duplicate vendor under the same client returns 409', r.status === 409, r);
      r = await pfOwner.fetch('/api/profiles/programs', { method: 'POST', body: JSON.stringify({ values: { name: 'No Client' } }) });
      check('a vendor needs a client', r.status === 400, r);
      r = await pfOwner.fetch('/api/profiles/programs/' + pfSub);
      check('vendor bank numbers are masked to last 4', r.body.secrets.bank_routing.last4 === '0021' && r.body.secrets.bank_account.last4 === '6789' && !JSON.stringify(r.body).includes('000123456789'), r.body.secrets);
      r = await pfOwner.fetch('/api/directory/programs');
      check('the vendor shows in the existing Directory list (same table)', r.body.programs.some((p) => p.id === pfSub && p.client_name === 'Acme Health'), r.body);

      r = await pfOwner.fetch('/api/profiles/consultants', { method: 'POST', body: JSON.stringify({ values: { name: 'Priya Nair', worker_type: 'W2', work_authorization: 'H-1B', date_of_birth: '1990-04-12', phone: '555-010-2000', pay_rate: '55.5', i9_verified: 'true' }, secrets: { ssn: '123-45-6789', bank_account: '9876543210' } }) });
      check('creating a consultant returns 201', r.status === 201, r);
      const pfCons = r.body.id;
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons);
      check('SSN is returned as ***-**-6789 only', r.body.secrets.ssn.masked === '***-**-6789' && r.body.secrets.ssn.last4 === '6789' && !JSON.stringify(r.body).includes('123456789') && !JSON.stringify(r.body).includes('123-45-6789'), r.body.secrets);
      check('consultant values, bool and number round-trip', r.body.values.worker_type === 'W2' && r.body.values.i9_verified === true && r.body.values.pay_rate === '55.5' && r.body.values.date_of_birth === '1990-04-12' && r.body.values.phone === '555-010-2000', r.body.values);
      r = await pfOwner.fetch('/api/profiles/consultants', { method: 'POST', body: JSON.stringify({ values: { name: 'Bad Ssn' }, secrets: { ssn: '12345' } }) });
      check('an invalid SSN is rejected and nothing is created', r.status === 400, r);
      r = await pfOwner.fetch('/api/directory/consultants');
      check('rejected create left no consultant behind', !r.body.consultants.some((c) => c.name === 'Bad Ssn'), r.body);

      // The database holds ciphertext, never the number.
      const [secRows] = await dbConn.query(`SELECT cipher, last4 FROM record_secrets WHERE entity = 'consultants' AND record_id = ? AND field = 'ssn'`, [pfCons]);
      check('SSN is stored encrypted (v1: AES-GCM), not in plain text', secRows.length === 1 && /^v1:/.test(secRows[0].cipher) && !secRows[0].cipher.includes('123456789') && secRows[0].last4 === '6789', secRows);
      const [profRows] = await dbConn.query(`SELECT data FROM record_profiles WHERE entity = 'consultants' AND record_id = ?`, [pfCons]);
      check('the profile JSON does not contain the SSN or account number', !profRows[0].data.includes('6789') && !profRows[0].data.includes('9876543210'), profRows);
      const cryptoMod = require('../src/crypto');
      check('ciphertext decrypts back to the original with the key', cryptoMod.decrypt(secRows[0].cipher) === '123456789');
      const [c1] = await dbConn.query(`SELECT cipher FROM record_secrets WHERE entity = 'consultants' AND record_id = ? AND field = 'bank_account'`, [pfCons]);
      check('two encryptions of the same value differ (random IV)', cryptoMod.encrypt('123456789') !== cryptoMod.encrypt('123456789') && c1.length === 1);
      const savedKey = process.env.FIELD_ENCRYPTION_KEY;
      delete process.env.FIELD_ENCRYPTION_KEY;
      let noKeyThrew = false;
      try { cryptoMod.encrypt('x'); } catch (e) { noKeyThrew = e.code === 'NO_KEY'; }
      process.env.FIELD_ENCRYPTION_KEY = savedKey;
      check('with no key the crypto module refuses to encrypt (fails closed)', noKeyThrew === true && cryptoMod.isConfigured() === true);

      // Editing
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons, { method: 'PATCH', body: JSON.stringify({ values: { job_title: 'Data Engineer', name: 'Changed Name', email: 'priya@pftest.test', status: 'active' } }) });
      check('PATCH saves fields', r.status === 200, r);
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons);
      check('PATCH updated profile + core fields but did not rename', r.body.values.job_title === 'Data Engineer' && r.body.values.email === 'priya@pftest.test' && r.body.name === 'Priya Nair' && r.body.values.worker_type === 'W2' && r.body.secrets.ssn.last4 === '6789', r.body);
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons, { method: 'PATCH', body: JSON.stringify({ values: {}, secrets: { ssn: '987-65-4321' } }) });
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons);
      check('replacing the SSN changes the last 4', r.body.secrets.ssn.last4 === '4321', r.body.secrets);
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons, { method: 'PATCH', body: JSON.stringify({ values: {}, secrets: { ssn: null } }) });
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons);
      check('removing the SSN clears it', r.body.secrets.ssn.set === false, r.body.secrets);
      check('the change log records field names but never secret values', r.body.notes.some((n) => n.kind === 'log' && /ssn \(encrypted\)/.test(n.body)) && !r.body.notes.some((n) => /4321|6789/.test(n.body)), r.body.notes);
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons + '/notes', { method: 'POST', body: JSON.stringify({ body: 'Called about onboarding.' }) });
      check('adding a note returns 201', r.status === 201, r);
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons);
      check('the note appears with the author', r.body.notes.some((n) => n.kind === 'note' && n.body === 'Called about onboarding.' && n.userName === 'Pf Owner'), r.body.notes);

      // Other orgs see nothing
      r = await pfOther.fetch('/api/profiles/consultants/' + pfCons);
      check('another organisation gets 404 for the record', r.status === 404, r);
      r = await pfOther.fetch('/api/profiles/consultants/' + pfCons, { method: 'PATCH', body: JSON.stringify({ values: { job_title: 'Hacked' } }) });
      check('another organisation cannot edit it', r.status === 404, r);
      r = await pfOther.fetch('/api/profiles/programs', { method: 'POST', body: JSON.stringify({ values: { name: 'X', client_id: String(pfClient) } }) });
      check('another organisation cannot create a vendor under this client', r.status === 400, r);
      const anon = makeJar();
      r = await anon.fetch('/api/profiles/consultants/' + pfCons);
      check('profile API needs sign-in', r.status === 401 || r.status === 403, r);
      r = await pfOwner.fetch('/api/profiles/widgets/1');
      check('unknown record type returns 404', r.status === 404, r);

      // Merge carries the profile over
      r = await pfOwner.fetch('/api/profiles/consultants', { method: 'POST', body: JSON.stringify({ values: { name: 'Priya Nairr', city: 'Edison' }, secrets: { bank_account: '5550001111' } }) });
      const pfDup = r.body.id;
      await dbConn.query(`INSERT INTO directory_duplicate_candidates (organization_id, table_name, record_id, matched_record_id, similarity, status) SELECT organization_id, 'consultants', ?, ?, 0.95, 'open' FROM consultants WHERE id = ?`, [pfDup, pfCons, pfCons]);
      const [fl] = await dbConn.query(`SELECT id FROM directory_duplicate_candidates WHERE table_name = 'consultants' AND record_id = ?`, [pfDup]);
      r = await pfOwner.fetch('/api/directory/duplicates/' + fl[0].id + '/merge', { method: 'POST', body: JSON.stringify({ keep: 'matched' }) });
      check('merging two consultants succeeds', r.status === 200, r);
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons);
      check('the survivor gained the removed record’s blank fields', r.body.values.city === 'Edison' && r.body.values.job_title === 'Data Engineer', r.body.values);
      const [orph] = await dbConn.query(`SELECT COUNT(*) AS n FROM record_profiles WHERE entity = 'consultants' AND record_id = ?`, [pfDup]);
      check('no profile rows are left on the removed record', orph[0].n === 0, orph);

      // Client page links
      r = await pfOwner.fetch('/api/profiles/clients/' + pfClient);
      check('the client profile lists its vendors', r.body.related.subVendors.some((x) => x.id === pfSub), r.body.related);

      // Every field the form can write maps to a real column
      const [clientCols] = await dbConn.query(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'clients'`);
      const specAll = require('../src/routes/profileFields');
      const coreMissing = [];
      for (const ent of ['consultants', 'clients', 'programs']) {
        const [cols] = await dbConn.query(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, [ent]);
        const names = cols.map((x) => x.c);
        specAll.fieldsOf(ent).filter((x) => x.core).forEach((x) => { if (!names.includes(x.key)) coreMissing.push(ent + '.' + x.key); });
      }
      check('every "core" form field is a real column in its table', coreMissing.length === 0 && clientCols.length > 0, coreMissing);

      // 36. Fillable forms: W-9 (vendors), W-4 and I-9 (consultants).
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons);
      check('consultant has W-4, I-9 and W-9 (for 1099) forms listed, none started', r.status === 200 && r.body.forms.map((x) => x.form).sort().join() === 'banking,i9,w4,w9' && r.body.forms.every((x) => x.status === 'not started'), r.body);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub);
      check('vendor has only a W-9', r.body.forms.length === 1 && r.body.forms[0].form === 'w9', r.body);
      r = await pfOwner.fetch('/api/forms/clients/' + pfClient);
      check('client has no forms', r.status === 200 && r.body.forms.length === 0, r.body);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w4');
      check('a W-4 does not apply to a vendor (404)', r.status === 404, r);

      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9');
      check('W-9 is pre-filled from the directory (name, no saved row yet)', r.status === 200 && r.body.values.name === 'Prime Staffing' && r.body.prefilled.includes('name') && r.body.status === 'not started', r.body);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Raj Rao', consent: true }) });
      check('signing an incomplete W-9 is refused and lists what is missing', r.status === 400 && /Federal tax classification/.test(r.body.error), r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9', { method: 'PUT', body: JSON.stringify({ values: { name: 'Prime Staffing LLC', tax_class: 'Limited liability company', llc_class: 'S', address: '1 Main St', city: 'Edison', state: 'NJ', zip: '08817', tin_type: 'Employer identification number', cert1: true, cert3: true, cert4: true }, secrets: { tin: '98-7654321' } }) });
      check('W-9 draft saves', r.status === 200, r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9');
      check('W-9 TIN shows last 4 only and never the full number', r.body.secrets.tin.masked === '****4321' && !JSON.stringify(r.body).includes('987654321') && !JSON.stringify(r.body).includes('98-7654321') && r.body.status === 'draft', r.body.secrets);
      const [w9s] = await dbConn.query(`SELECT cipher FROM record_secrets WHERE entity = 'programs' AND record_id = ? AND field = 'w9.tin'`, [pfSub]);
      check('W-9 TIN is encrypted in the database', w9s.length === 1 && /^v1:/.test(w9s[0].cipher) && !w9s[0].cipher.includes('987654321'), w9s);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Raj Rao', consent: false }) });
      check('signing needs the e-sign consent box', r.status === 400, r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Raj Rao', consent: true }) });
      check('signing the complete W-9 succeeds and the form is complete', r.status === 200 && r.body.status === 'complete' && r.body.signature.name === 'Raj Rao', r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9', { method: 'PUT', body: JSON.stringify({ values: { city: 'Newark' } }) });
      check('a signed W-9 cannot be edited', r.status === 400 && /signed/.test(r.body.error), r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9', { method: 'PUT', body: JSON.stringify({ values: {}, secrets: { tin: '111223333' } }) });
      check('a signed W-9 TIN cannot be replaced', r.status === 400, r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Raj Rao', consent: true }) });
      check('signing twice returns 409', r.status === 409, r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9/reopen', { method: 'POST', body: JSON.stringify({ signature: 'payee', reason: '' }) });
      check('reopening needs a reason', r.status === 400, r);
      r = await pfOwner.fetch('/api/forms/programs/' + pfSub + '/w9/reopen', { method: 'POST', body: JSON.stringify({ signature: 'payee', reason: 'Address changed' }) });
      check('owner can reopen with a reason', r.status === 200, r);
      r = await pfOwner.fetch('/api/profiles/programs/' + pfSub);
      check('signing and reopening are in the activity log', r.body.notes.some((n) => /signed electronically by "Raj Rao"/.test(n.body)) && r.body.notes.some((n) => /reopened.*Address changed/.test(n.body)), r.body.notes);

      // W-4
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4');
      check('W-4 pre-fills first/last name from the consultant', r.body.values.first_name === 'Priya' && r.body.values.last_name === 'Nair', r.body.values);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4', { method: 'PUT', body: JSON.stringify({ values: { filing_status: 'Head of household', address: '5 Oak Ave', city: 'Iselin', state: 'NJ', zip: '08830', first_name: 'Priya', last_name: 'Nair', qualifying_children: '2', step3_total: '4000', employee_attest: true }, secrets: { ssn: '123-45-6789' } }) });
      check('W-4 saves', r.status === 200, r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4/sign', { method: 'POST', body: JSON.stringify({ signature: 'employer', typedName: 'Pf Owner', consent: true }) });
      check('employer cannot sign the W-4 before the employee', r.status === 409, r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4/sign', { method: 'POST', body: JSON.stringify({ signature: 'employee', typedName: 'Priya Nair', consent: true }) });
      check('employee signs the W-4', r.status === 200 && r.body.status === 'partly signed', r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4/sign', { method: 'POST', body: JSON.stringify({ signature: 'employer', typedName: 'Pf Owner', consent: true }) });
      check('employer section needs its own required fields', r.status === 400 && /Employer/.test(r.body.error), r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4', { method: 'PUT', body: JSON.stringify({ values: { employer_name: 'Profile Co', employer_address: '9 Biz Rd, Edison NJ', first_date_employment: '2026-10-01' } }) });
      check('employer section can still be edited after the employee signs', r.status === 200, r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4/sign', { method: 'POST', body: JSON.stringify({ signature: 'employer', typedName: 'Pf Owner', consent: true }) });
      check('employer signs and the W-4 is complete', r.status === 200 && r.body.status === 'complete', r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/w4/reopen', { method: 'POST', body: JSON.stringify({ signature: 'employee', reason: 'Wrong filing status' }) });
      check('reopening the employee signature also clears the employer sign-off', r.status === 200 && r.body.removed.includes('employer'), r);

      // I-9
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9', { method: 'PUT', body: JSON.stringify({ values: { last_name: 'Nair', first_name: 'Priya', address: '5 Oak Ave', city: 'Iselin', state: 'NJ', zip: '08830', dob: '1990-04-12', citizenship: 'A noncitizen authorized to work', employee_attest: true }, secrets: { auth_a_number: 'A-123456789' } }) });
      check('I-9 Section 1 saves', r.status === 200, r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9/sign', { method: 'POST', body: JSON.stringify({ signature: 'employee', typedName: 'Priya Nair', consent: true }) });
      check('I-9 needs the work-authorization expiry for a noncitizen authorized to work', r.status === 400 && /Authorized to work until/.test(r.body.error), r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9', { method: 'PUT', body: JSON.stringify({ values: { work_until: '2028-09-30' } }) });
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9/sign', { method: 'POST', body: JSON.stringify({ signature: 'employee', typedName: 'Priya Nair', consent: true }) });
      check('I-9 Section 1 signs', r.status === 200, r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9', { method: 'PUT', body: JSON.stringify({ values: { first_day: '2026-10-01', doc_route: 'One List B and one List C document', b_title: 'Driver’s license', b_authority: 'NJ MVC', c_title: 'Social Security card', c_authority: 'SSA', docs_in_person: true, employer_attest: true, employer_title: 'HR', employer_business: 'Profile Co', employer_address: '9 Biz Rd' }, secrets: { b_number: 'D1234-56789-01234', c_number: '123456789' } }) });
      check('I-9 Section 2 saves with List B + C and encrypted document numbers', r.status === 200, r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9');
      check('I-9 shows A-Number and document numbers as last 4 only', r.body.secrets.auth_a_number.masked === '****6789' && r.body.secrets.b_number.last4 === '1234' && !JSON.stringify(r.body).includes('D1234-56789-01234') && !JSON.stringify(r.body).includes('A-123456789'), r.body.secrets);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9', { method: 'PUT', body: JSON.stringify({ values: { first_name: 'Changed' } }) });
      check('I-9 Section 1 is locked after the employee signs', r.status === 400, r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9/sign', { method: 'POST', body: JSON.stringify({ signature: 'employer', typedName: 'Pf Owner', consent: true }) });
      check('I-9 Section 2 signs and the I-9 is complete (Section 3 is optional)', r.status === 200 && r.body.status === 'complete', r);
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9', { method: 'PUT', body: JSON.stringify({ values: { city: 'x' } }) });
      r = await pfOwner.fetch('/api/forms/consultants/' + pfCons + '/i9', { method: 'PUT', body: JSON.stringify({ values: { dob: '12/04/1990' } }) });
      check('an invalid date is rejected', r.status === 400, r);

      r = await pfOther.fetch('/api/forms/consultants/' + pfCons + '/i9');
      check('another organisation cannot read the I-9 (404)', r.status === 404, r);
      r = await pfOther.fetch('/api/forms/consultants/' + pfCons + '/i9/sign', { method: 'POST', body: JSON.stringify({ signature: 'reverify', typedName: 'X Y', consent: true }) });
      check('another organisation cannot sign it', r.status === 404, r);
      r = await anon.fetch('/api/forms/consultants/' + pfCons + '/i9');
      check('forms API needs sign-in', r.status === 401 || r.status === 403, r);

      // forms follow a merged record
      r = await pfOwner.fetch('/api/profiles/consultants', { method: 'POST', body: JSON.stringify({ values: { name: 'Form Keeper' } }) });
      const fkKeep = r.body.id;
      r = await pfOwner.fetch('/api/profiles/consultants', { method: 'POST', body: JSON.stringify({ values: { name: 'Form Keepr' } }) });
      const fkLose = r.body.id;
      await pfOwner.fetch('/api/forms/consultants/' + fkLose + '/w4', { method: 'PUT', body: JSON.stringify({ values: { first_name: 'Form', last_name: 'Keepr' } }) });
      await dbConn.query(`INSERT INTO directory_duplicate_candidates (organization_id, table_name, record_id, matched_record_id, similarity, status) SELECT organization_id, 'consultants', ?, ?, 0.95, 'open' FROM consultants WHERE id = ?`, [fkLose, fkKeep, fkKeep]);
      const [fl2] = await dbConn.query(`SELECT id FROM directory_duplicate_candidates WHERE table_name = 'consultants' AND record_id = ?`, [fkLose]);
      r = await pfOwner.fetch('/api/directory/duplicates/' + fl2[0].id + '/merge', { method: 'POST', body: JSON.stringify({ keep: 'matched' }) });
      r = await pfOwner.fetch('/api/forms/consultants/' + fkKeep + '/w4');
      check('a W-4 draft moves to the surviving record on merge', r.status === 200 && r.body.values.last_name === 'Keepr' && r.body.status === 'draft', r.body);

      // 37. Supplier companies get the same profile form.
      r = await pfOwner.fetch('/api/profiles/schema');
      check('schema includes supplier companies and vendors are labelled Vendor', !!r.body.spec.subvendors && r.body.spec.subvendors.singular === 'Supplier company' && r.body.spec.programs.singular === 'Vendor' && r.body.spec.programs.plural === 'Vendors', r.body.spec && Object.keys(r.body.spec));
      r = await pfOwner.fetch('/api/profiles/subvendors', { method: 'POST', body: JSON.stringify({ values: { name: 'Zenith Staffing', supplier_type: 'Staffing agency', payment_terms: 'Net 30', contact_name: 'Meera Shah', email: 'ap@zenith.test', w9_on_file: 'true' }, secrets: { tax_id: '45-6789012', bank_routing: '011000015', bank_account: '55501234' } }) });
      check('creating a supplier company returns 201', r.status === 201, r);
      const sup = r.body.id;
      r = await pfOwner.fetch('/api/profiles/subvendors', { method: 'POST', body: JSON.stringify({ values: { name: 'zenith staffing' } }) });
      check('duplicate supplier company name returns 409', r.status === 409, r);
      r = await pfOwner.fetch('/api/profiles/subvendors/' + sup);
      check('supplier profile returns fields and last-4 secrets only', r.body.values.supplier_type === 'Staffing agency' && r.body.values.w9_on_file === true && r.body.secrets.tax_id.masked === '****9012' && r.body.secrets.bank_account.last4 === '1234' && !JSON.stringify(r.body).includes('456789012') && !JSON.stringify(r.body).includes('55501234'), r.body);
      r = await pfOwner.fetch('/api/directory/subvendors');
      check('the supplier company shows in the Directory list', r.body.subvendors.some((x) => x.id === sup && x.email === 'ap@zenith.test'), r.body);
      r = await pfOwner.fetch('/api/profiles/consultants/' + pfCons, { method: 'PATCH', body: JSON.stringify({ values: { supplier_id: String(sup) } }) });
      r = await pfOwner.fetch('/api/profiles/subvendors/' + sup);
      check('the supplier profile lists consultants linked to it', r.body.related.supplierConsultants.some((x) => x.id === pfCons), r.body.related);
      r = await pfOther.fetch('/api/profiles/subvendors/' + sup);
      check('another organisation cannot see the supplier profile', r.status === 404, r);
      r = await pfOwner.fetch('/api/forms/subvendors/' + sup);
      check('supplier companies get the W-9 form (their own company W-9)', r.status === 200 && r.body.forms.map((x) => x.form).sort().join() === 'banking,w9', r.body);
      const [secRow] = await dbConn.query(`SELECT cipher FROM record_secrets WHERE entity = 'subvendors' AND record_id = ? AND field = 'tax_id'`, [sup]);
      check('supplier tax ID is encrypted in the database', secRow.length === 1 && /^v1:/.test(secRow[0].cipher), secRow);

      // 38. Onboarding: recruiter sends a placement to HR; HR approves, edits, works the W2/C2C/1099 checklist.
      r = await pfOwner.fetch('/api/auth/me');
      const obInvite = r.body.user.organization.inviteCode;
      const obRec = makeJar(); const obRec2 = makeJar();
      r = await obRec.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: obInvite, name: 'Rita Recruiter', email: 'rita@onb.test', password: 'recruiterpass123' }) });
      check('recruiter joins the organisation', r.status === 201, r);
      r = await obRec2.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: obInvite, name: 'Ron Recruiter', email: 'ron@onb.test', password: 'recruiterpass123' }) });
      const obEmail = [
        'PLACEMENT INFORMATION', '', 'Consultant Name:', '', 'Avinash Agnihotri', '', 'Consultant Contact Number:', '', '347 267 1449', '',
        'Consultant Email:', '', 'avinash.agnihotri04@gamil.com', '', 'Technical Skill', '', 'DB2 LUW DBA', '', 'Status (W2/C2C/1099):', '', 'C2C', '',
        'Project Start Date:', '', '10/14/2026', '', 'Project Duration:', '', '12 months', '', 'End Client:', '', 'CDW / OCC', '',
        'Project Location (State and City):', '', 'Remote', '', 'Bill Rate:', '', '$90/hr', '', 'Pay To (Consultant/Vendor)', '', 'Pay Rate:', '', '$75/hr', '',
        'Recruiter Name:', '', 'Asheet Kumar Singh', '', 'H1B Filing Required:', '', 'No', '', 'Candidate Employer Details', '', 'Accurate Software Consulting LLC', '',
        'avinash.agnihotri04@gmail.com', '', '347 267 1449'].join('\n');
      r = await obRec.fetch('/api/onboarding/parse-email', { method: 'POST', body: JSON.stringify({ text: obEmail }) });
      check('the placement e-mail is read into fields', r.status === 200 && r.body.fields.consultant_name === 'Avinash Agnihotri' && r.body.worker_type === 'C2C' && r.body.fields.start_date === '2026-10-14'
        && r.body.fields.bill_rate === 90 && r.body.fields.pay_rate === 75 && r.body.fields.end_client === 'CDW / OCC' && r.body.fields.employer_name === 'Accurate Software Consulting LLC', r.body);
      r = await obRec.fetch('/api/onboarding/parse-email', { method: 'POST', body: JSON.stringify({ text: 'hello there' }) });
      check('text with no placement fields is refused', r.status === 422, r);
      const obF = (await obRec.fetch('/api/onboarding/parse-email', { method: 'POST', body: JSON.stringify({ text: obEmail }) })).body.fields; delete obF.worker_type;

      r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'bogus', data: obF }) });
      check('an unknown worker type is refused', r.status === 400, r);
      r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: Object.assign({}, obF, { email: 'not-an-email' }) }) });
      check('a bad email address is refused', r.status === 400 && r.body.errors[0].key === 'email', r.body);
      r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: obF }) });
      check('recruiter saves a draft', r.status === 201 && r.body.status === 'draft' && r.body.margin === null && r.body.data.bill_rate === undefined, r.body);
      const obId = r.body.id;
      check('the e-mail typo (gamil.com) is flagged', r.body.warnings.some((w) => w.key === 'email' && /gmail/.test(w.message)), r.body.warnings);
      r = await obRec.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'submitted' }) });
      check('sending without the required fields is refused and names them (invoicing method)', r.status === 422 && /Invoicing/.test(r.body.error), r.body);
      r = await obRec.fetch('/api/onboarding/' + obId, { method: 'PUT', body: JSON.stringify({ data: { invoicing_method: 'QuickBooks', email: 'avinash.agnihotri04@gmail.com' } }) });
      check('recruiter fixes the details', r.status === 200 && r.body.data.invoicing_method === 'QuickBooks' && !r.body.warnings.some((w) => w.key === 'email'), r.body);
      r = await obRec.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'submitted' }) });
      check('recruiter sends it to HR for approval', r.status === 200 && r.body.status === 'submitted', r.body);

      r = await obRec2.fetch('/api/onboarding/' + obId);
      check('another recruiter cannot see it', r.status === 404, r);
      r = await obRec2.fetch('/api/onboarding?status=all');
      check('another recruiter’s list is empty', r.status === 200 && r.body.onboardings.length === 0, r.body);
      r = await obRec.fetch('/api/onboarding/me');
      check('recruiter is not an HR admin', r.body.isHr === false, r.body);
      r = await pfOwner.fetch('/api/onboarding/me');
      check('owner is an HR admin and sees one pending request', r.body.isHr === true && r.body.pending === 1, r.body);
      r = await pfOwner.fetch('/api/onboarding?status=submitted');
      check('HR sees the request waiting for approval', r.body.onboardings.length === 1 && r.body.onboardings[0].consultantName === 'Avinash Agnihotri', r.body);

      r = await obRec.fetch('/api/onboarding/' + obId, { method: 'PUT', body: JSON.stringify({ data: { recruiter: 'Someone Else' } }) });
      check('recruiter cannot change a request that is with HR', r.status === 403, r);
      r = await obRec.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'nda', done: true }) });
      check('recruiter cannot work the checklist', r.status === 403, r);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'nda', done: true }) });
      check('HR must approve before the checklist opens', r.status === 409, r);
      r = await pfOwner.fetch('/api/onboarding/' + obId, { method: 'PUT', body: JSON.stringify({ data: { bill_rate: 95, location: 'Remote (NY)' } }) });
      check('HR can change any detail', r.status === 200 && r.body.data.bill_rate === 95 && r.body.log[0].text.indexOf('Edited by HR') === 0, r.body);

      r = await pfOwner.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'draft' }) });
      check('sending back needs a reason', r.status === 422, r);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'draft', reason: 'Please add the invoice recipient.' }) });
      check('HR sends it back to the recruiter', r.status === 200 && r.body.status === 'draft' && /recruiter/.test(r.body.log[0].text), r.body);
      r = await obRec.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'submitted' }) });
      check('recruiter re-sends it', r.body.status === 'submitted', r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'in_progress' }) });
      check('HR approves and starts onboarding', r.status === 200 && r.body.status === 'in_progress' && /Approved/.test(r.body.log[0].text), r.body);
      const clKeys = r.body.checklist.map((c) => c.key);
      check('C2C checklist: company W-9, vendor agreement, insurance; no W-4, no invoicing set-up', !clKeys.includes('invoicing_setup') && clKeys.includes('company_w9') && clKeys.includes('vendor_agreement') && clKeys.includes('coi') && !clKeys.includes('w4') && !clKeys.includes('h1b_petition'), clKeys);

      r = await pfOwner.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'complete' }) });
      check('cannot complete with open checklist items', r.status === 422 && /still open/.test(r.body.error), r.body);
      r = await obRec.fetch('/api/onboarding/' + obId + '/create-records', { method: 'POST', body: JSON.stringify({}) });
      check('recruiter cannot create directory records', r.status === 403, r);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/create-records', { method: 'POST', body: JSON.stringify({}) });
      check('HR creates the directory records', r.status === 200 && r.body.consultantId && r.body.supplierId && r.body.checklist.find((c) => c.key === 'directory_records').done === true, r.body);
      const [[asg]] = await dbConn.query(`SELECT a.billing, c.name AS client, p.name AS program FROM consultant_assignments a JOIN clients c ON c.id = a.client_id LEFT JOIN programs p ON p.id = a.program_id WHERE a.consultant_id = ?`, [r.body.consultantId]);
      check('billing pairing: client OCC, vendor CDW, bill rate 95', asg && asg.client === 'OCC' && asg.program === 'CDW' && Number(asg.billing) === 95, asg);
      r = await pfOwner.fetch('/api/profiles/consultants/' + (await pfOwner.fetch('/api/onboarding/' + obId)).body.consultantId);
      check('consultant profile carries worker type Corp-to-Corp and the supplier company', r.body.values.worker_type === 'Corp-to-Corp' && !!r.body.values.supplier_id && r.body.values.hire_date === '2026-10-14', r.body.values);
      const supId = (await pfOwner.fetch('/api/onboarding/' + obId)).body.supplierId;
      r = await pfOwner.fetch('/api/directory/subvendors');
      check('the consultant’s company is a supplier company', r.body.subvendors.some((x) => x.id === supId && x.name === 'Accurate Software Consulting LLC'), r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/create-records', { method: 'POST', body: JSON.stringify({}) });
      check('creating the records again links, never duplicates', r.status === 200 && (await dbConn.query(`SELECT COUNT(*) n FROM consultants WHERE organization_id = (SELECT organization_id FROM onboardings WHERE id = ?) AND name = 'Avinash Agnihotri'`, [obId]))[0][0].n === 1, r.body);
      r = await pfOwner.fetch('/api/forms/subvendors/' + supId);
      check('the company’s W-9 shows as not started on the checklist', (await pfOwner.fetch('/api/onboarding/' + obId)).body.checklist.find((c) => c.key === 'company_w9').form.status === 'not started', r.body);

      // ---- checklist items: uploads, Yes/No answers, the banking form, optional items
      let ob = (await pfOwner.fetch('/api/onboarding/' + obId)).body;
      const item = (key) => ob.checklist.find((c) => c.key === key);
      check('vendor agreement / COI / work auth / NDA take a required upload', ['vendor_agreement', 'coi', 'employer_work_auth', 'nda'].every((k) => item(k).upload === 'required') && item('vendor_agreement').label === 'Vendor agreement' && item('vendor_agreement').future === 'fillable-pdf', ob.checklist);
      check('background check: Yes/No with an optional upload; rate and timesheet are Yes/No', item('background_check').answer === 'yesno' && item('background_check').upload === 'optional' && item('rate_confirmation').answer === 'yesno' && item('timesheet_access').answer === 'yesno', ob.checklist);
      check('client paperwork/badge is optional and not counted', item('client_docs').optional === true && ob.progress.total === ob.checklist.filter((c) => !c.optional && !c.na).length, ob.progress);
      check('remittance links to the ACH / Wire banking form', item('remittance').form && item('remittance').form.form === 'banking' && item('remittance').form.entity === 'subvendors', item('remittance'));
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'coi', done: true }) });
      check('an upload item cannot be ticked by hand', r.status === 400, r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'remittance', done: true }) });
      check('the banking item cannot be ticked by hand', r.status === 400, r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'rate_confirmation', done: true }) });
      check('a Yes/No item needs an answer, not a tick', r.status === 400, r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'rate_confirmation', answer: 'Maybe' }) });
      check('only Yes or No is accepted', r.status === 400, r.body);
      for (const [k, v] of [['rate_confirmation', 'Yes'], ['timesheet_access', 'Yes'], ['background_check', 'No']]) {
        r = await pfOwner.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: k, answer: v }) });
      }
      check('Yes/No answers are saved and count as done', r.status === 200 && r.body.checklist.find((c) => c.key === 'background_check').value === 'No' && r.body.checklist.find((c) => c.key === 'rate_confirmation').done === true && /answered No/.test(r.body.log[0].text), r.body.log && r.body.log[0]);

      // uploads
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), require('crypto').randomBytes(2000), Buffer.from('\n%%EOF')]);
      const up = (who, key, name, buf, extra) => who.fetch('/api/onboarding/' + obId + '/documents', { method: 'POST', body: JSON.stringify(Object.assign({ itemKey: key, filename: name, contentBase64: buf.toString('base64') }, extra || {})) });
      r = await up(obRec, 'coi', 'coi.pdf', pdf);
      check('a recruiter cannot upload checklist documents', r.status === 403, r.body);
      r = await up(pfOwner, 'coi', 'coi.exe', pdf);
      check('an .exe is refused', r.status === 415, r.body);
      r = await up(pfOwner, 'coi', 'fake.pdf', Buffer.from('hello, not a pdf'));
      check('a file that is not really a PDF is refused', r.status === 415, r.body);
      r = await up(pfOwner, 'coi', 'big.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)]));
      check('a file over 10 MB is refused', r.status === 413, r.body);
      r = await up(pfOwner, 'rate_confirmation', 'x.pdf', pdf);
      check('an item without uploads refuses a document', r.status === 404, r.body);
      r = await up(pfOwner, 'coi', 'COI 2027.pdf', pdf);
      check('HR uploads the certificate of insurance', r.status === 201 && r.body.checklist.find((c) => c.key === 'coi').done === true && r.body.checklist.find((c) => c.key === 'coi').documents[0].filename === 'COI 2027.pdf' && /document uploaded/.test(r.body.log[0].text), r.body.log && r.body.log[0]);
      let docId = r.body.documentId;
      const [[stored]] = await dbConn.query('SELECT content, size FROM onboarding_documents WHERE id = ?', [docId]);
      check('the stored file is encrypted (not the plain PDF)', stored.size === pdf.length && !Buffer.from(stored.content).includes(Buffer.from('%PDF-')), stored.size);
      let dl = await pfOwner.raw('/api/onboarding/' + obId + '/documents/' + docId + '?download=1');
      check('HR downloads the original bytes', dl.status === 200 && dl.buf.equals(pdf) && dl.headers.get('content-type') === 'application/pdf' && /attachment/.test(dl.headers.get('content-disposition')), dl.status);
      dl = await obRec.raw('/api/onboarding/' + obId + '/documents/' + docId);
      check('the recruiter who created the request can view it', dl.status === 200 && dl.buf.equals(pdf), dl.status);
      dl = await obRec2.raw('/api/onboarding/' + obId + '/documents/' + docId);
      check('another recruiter cannot view it', dl.status === 404, dl.status);
      dl = await pfOther.raw('/api/onboarding/' + obId + '/documents/' + docId);
      check('another organisation cannot view it', dl.status === 404, dl.status);
      r = await up(pfOwner, 'coi', 'coi-v2.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]));
      check('a second upload needs Replace', r.status === 409, r.body);
      r = await up(pfOwner, 'coi', 'coi-v2.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]), { replace: true });
      const coiDocs = r.body.checklist.find((c) => c.key === 'coi').documents;
      check('Replace swaps the document', r.status === 201 && coiDocs.length === 1 && coiDocs[0].filename === 'coi-v2.png' && /replaced/.test(r.body.log[0].text), coiDocs);
      docId = coiDocs[0].id;
      r = await obRec.fetch('/api/onboarding/' + obId + '/documents/' + docId, { method: 'DELETE' });
      check('a recruiter cannot delete a document', r.status === 403, r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/documents/' + docId, { method: 'DELETE' });
      check('HR deletes it and the item reopens', r.status === 200 && r.body.checklist.find((c) => c.key === 'coi').done === false && /document deleted/.test(r.body.log[0].text), r.body.log && r.body.log[0]);
      const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
      for (const [k, n, b] of [['coi', 'coi.pdf', pdf], ['vendor_agreement', 'Vendor Agreement.docx', docx], ['employer_work_auth', 'auth.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)])], ['nda', 'nda.pdf', pdf], ['background_check', 'report.pdf', pdf]]) r = await up(pfOwner, k, n, b);
      check('all required documents uploaded (and the optional background report)', r.status === 201 && ['coi', 'vendor_agreement', 'employer_work_auth', 'nda'].every((k) => r.body.checklist.find((c) => c.key === k).done), r.body.checklist);

      r = await pfOwner.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'complete' }) });
      check('still blocked until the banking form is signed (and the W-9)', r.status === 422 && /Company banking/.test(r.body.error) && !/Client onboarding paperwork/.test(r.body.error), r.body);

      // the ACH / Wire banking authorization form on the supplier company
      const bankUrl = '/api/forms/subvendors/' + supId + '/banking';
      r = await pfOwner.fetch(bankUrl);
      check('banking form opens, prefilled with the company name', r.status === 200 && r.body.spec.title === 'ACH / Wire banking authorization' && r.body.values.ach_holder === 'Accurate Software Consulting LLC', r.body.values);
      r = await pfOwner.fetch(bankUrl, { method: 'PUT', body: JSON.stringify({ values: { method: 'Wire', bank_name: 'First Bank', wire_beneficiary: 'Accurate Software Consulting LLC', wire_bank_address: '1 Main St, NY', payee_attest: true }, secrets: { wire_account: 'GB29 NWBK 6016 1331 9268 19' } }) });
      check('wire details saved', r.status === 200, r.body);
      r = await pfOwner.fetch(bankUrl + '/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Pat Payee', consent: true }) });
      check('wire needs an ABA or SWIFT before signing', r.status === 400 && /SWIFT/.test(r.body.error), r.body);
      r = await pfOwner.fetch(bankUrl, { method: 'PUT', body: JSON.stringify({ secrets: { wire_swift: 'bad!' } }) });
      check('a malformed SWIFT is refused', r.status === 400, r.body);
      r = await pfOwner.fetch(bankUrl, { method: 'PUT', body: JSON.stringify({ values: { method: 'ACH', ach_type: 'Checking', ach_holder: 'Accurate Software Consulting LLC' }, secrets: { ach_routing: '021000021', ach_account: '123456789012', wire_swift: 'NWBKGB2L' } }) });
      check('ACH details saved', r.status === 200, r.body);
      r = await pfOwner.fetch(bankUrl);
      check('bank numbers come back as last 4 only', r.body.secrets.ach_account.set && r.body.secrets.ach_account.last4 === '9012' && r.body.secrets.ach_routing.masked === '****0021' && !JSON.stringify(r.body).includes('123456789012') && !JSON.stringify(r.body).includes('021000021'), r.body.secrets);
      const [bankSec] = await dbConn.query(`SELECT field, cipher FROM record_secrets WHERE entity = 'subvendors' AND record_id = ? AND field LIKE 'banking.%'`, [supId]);
      check('bank numbers are encrypted at rest', bankSec.length === 4 && bankSec.every((x) => /^v1:/.test(x.cipher) && !x.cipher.includes('123456789012')), bankSec.map((x) => x.field));
      r = await pfOwner.fetch(bankUrl + '/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Pat Payee', consent: true }) });
      check('the payee signs the banking form', r.status === 200 && r.body.status === 'complete', r.body);
      r = await pfOwner.fetch(bankUrl, { method: 'PUT', body: JSON.stringify({ values: { bank_name: 'Other' } }) });
      check('a signed banking form is locked', r.status === 400 && /signed section/.test(r.body.error), r.body);
      ob = (await pfOwner.fetch('/api/onboarding/' + obId)).body;
      check('the banking checklist item ticks itself once signed', item('remittance').done === true && item('remittance').form.status === 'complete', item('remittance'));
      // W-9 by hand (paper copy on file)
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'company_w9', done: true, note: 'paper copy' }) });
      ob = r.body;
      check('only the optional item is still open', ob.checklist.filter((c) => !c.done && !c.na).map((c) => c.key).join() === 'client_docs', ob.checklist.filter((c) => !c.done).map((c) => c.key));
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'complete' }) });
      check('HR completes the onboarding with the optional item still open', r.status === 200 && r.body.status === 'complete' && r.body.progress.done === r.body.progress.total && r.body.checklist.find((c) => c.key === 'client_docs').done === false, r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId, { method: 'PUT', body: JSON.stringify({ data: { recruiter: 'x' } }) });
      check('a completed onboarding is locked until reopened', r.status === 409, r);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/status', { method: 'POST', body: JSON.stringify({ status: 'in_progress' }) });
      check('HR can reopen it', r.body.status === 'in_progress', r.body);
      r = await pfOwner.fetch('/api/onboarding/' + obId + '/email');
      check('the placement can be exported as the usual e-mail text', r.status === 200 && /PLACEMENT INFORMATION/.test(r.body.text) && /Status \(W2\/C2C\/1099\):\nC2C/.test(r.body.text) && /\$95\/hr/.test(r.body.text), r.body);

      // ---- requesting paperwork from the supplier through a secure link
      {
        const anon = async (pth, opts = {}) => {
          const res = await fetch(BASE + pth, Object.assign({}, opts, { headers: { 'Content-Type': 'application/json' } }));
          let body = null; try { body = await res.json(); } catch (e) { /* none */ }
          return { status: res.status, body, headers: res.headers };
        };
        const vdata = Object.assign({}, obF, { consultant_name: 'Vera Vendor', email: 'vera@vendorix.test', employer_name: 'Vendorix LLC', employer_email: 'ap@vendorix.test', employer_contact: 'Alex AP', invoicing_method: 'QuickBooks' });
        r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: vdata }) });
        const vId = r.body.id;
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: ['w9'] }) });
        check('a link cannot be created before the onboarding is started', r.status === 409, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/status', { method: 'POST', body: JSON.stringify({ status: 'in_progress' }) });
        if (r.status !== 200) check('the supplier-request onboarding starts', false, r.body);
        r = await obRec.fetch('/api/onboarding/' + vId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: ['w9'] }) });
        check('a recruiter cannot request from the supplier', r.status === 403, r.body);
        r = await obRec.fetch('/api/onboarding/' + vId + '/vendor-requests');
        check('a recruiter cannot list supplier requests', r.status === 403, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: [] }) });
        check('at least one item must be ticked', r.status === 400, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: ['w9', 'banking', 'coi', 'vendor_agreement', 'ssn'], message: 'Please send by Friday.', days: 7 }) });
        check('HR creates a link for the four items (unknown items ignored)', r.status === 201 && r.body.request.items.length === 4 && /^\/vendor\.html\?t=[a-f0-9]{64}$/.test(r.body.path) && r.body.supplierEmail === 'ap@vendorix.test', r.body);
        const tok = r.body.path.split('=')[1];
        const [[hr1]] = await dbConn.query('SELECT token_hash, items FROM vendor_requests WHERE onboarding_id = ?', [vId]);
        check('only a hash of the link is stored', hr1.token_hash.length === 64 && hr1.token_hash !== tok, hr1.token_hash);
        const vSup = (await pfOwner.fetch('/api/onboarding/' + vId)).body.supplierId;
        check('the supplier company was created and linked', !!vSup, vSup);
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/vendor-requests');
        check('HR sees the request with nothing received yet', r.body.requests.length === 1 && r.body.requests[0].items.every((i) => !i.done) && !JSON.stringify(r.body).includes(tok), r.body);

        const P = '/api/vendor-portal/' + tok;
        r = await anon('/api/vendor-portal/' + 'a'.repeat(64));
        check('a wrong link is refused', r.status === 404, r.body);
        r = await anon(P);
        check('the supplier opens the link with no login', r.status === 200 && r.body.company === 'Vendorix LLC' && r.body.request.items.length === 4 && /no-store/.test(r.headers.get('cache-control')) && /noindex/.test(r.headers.get('x-robots-tag')), r.body);
        r = await anon('/api/forms/subvendors/' + vSup + '/w9');
        check('the normal forms API still needs a login', r.status === 401, r.body);
        r = await anon(P + '/forms/i9');
        check('a form that was not requested is refused', r.status === 404, r.body);
        r = await anon(P + '/forms/w9');
        check('the W-9 opens for the supplier, prefilled with the company name', r.status === 200 && r.body.values.name === 'Vendorix LLC', r.body);
        r = await anon(P + '/forms/w9/reopen', { method: 'POST', body: JSON.stringify({ signature: 'payee', reason: 'x y z' }) });
        check('the supplier cannot reopen a signed form', r.status === 403, r.body);
        r = await anon(P + '/forms/w9', { method: 'PUT', body: JSON.stringify({ values: { name: 'Vendorix LLC', tax_class: 'Limited liability company', llc_class: 'S', address: '5 Elm St', city: 'Austin', state: 'TX', zip: '78701', tin_type: 'Employer identification number', cert1: true, cert3: true, cert4: true }, secrets: { tin: '12-3456789' } }) });
        check('the supplier can enter their own tax ID', r.status === 200, r.body);
        r = await anon(P + '/forms/banking', { method: 'PUT', body: JSON.stringify({ values: { method: 'ACH', bank_name: 'JPMorgan Chase', ach_type: 'Checking', ach_holder: 'Vendorix LLC', payee_attest: true }, secrets: { ach_routing: '021000021', ach_account: '998877665544' } }) });
        check('the supplier can enter bank details', r.status === 200, r.body);
        r = await anon(P + '/forms/banking');
        check('bank numbers come back masked', r.body.secrets.ach_account.masked && r.body.secrets.ach_account.last4 === '5544' && !JSON.stringify(r.body).includes('998877665544'), r.body.secrets);
        r = await anon(P + '/bank-lookup/021000021');
        check('the routing number identifies the bank', r.status === 200 && r.body.valid === true && /CHASE/.test(r.body.bank.name), r.body);
        r = await anon(P + '/bank-lookup/123456789');
        check('a routing number with a bad check digit is flagged', r.body.valid === false && /check digit/.test(r.body.reason), r.body);
        r = await anon(P + '/bank-lookup/12ab');
        check('a short routing number is flagged', r.body.valid === false, r.body);
        r = await anon('/api/forms/bank-lookup/021000021');
        check('the in-app lookup needs a login', r.status === 401, r.body);
        r = await pfOwner.fetch('/api/forms/bank-lookup/026009593');
        check('HR can look up a bank by routing number', r.body.valid === true && /BANK OF AMERICA/.test(r.body.bank.name), r.body);
        r = await anon(P + '/forms/banking/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Alex AP', consent: true }) });
        check('the supplier signs the banking form', r.status === 200 && r.body.status === 'complete', r.body);
        r = await anon(P + '/submit', { method: 'POST', body: '{}' });
        check('cannot finish while items are missing', r.status === 409 && /Certificate of insurance/.test(r.body.error), r.body);
        const pdf2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), require('crypto').randomBytes(500), Buffer.from('\n%%EOF')]);
        const upv = (item, name, buf) => anon(P + '/documents', { method: 'POST', body: JSON.stringify({ item, filename: name, contentBase64: buf.toString('base64') }) });
        r = await upv('coi', 'coi.exe', pdf2);
        check('the supplier cannot upload an .exe', r.status === 415, r.body);
        r = await upv('nda', 'nda.pdf', pdf2);
        check('the supplier cannot upload something that was not requested', r.status === 404, r.body);
        r = await upv('coi', 'COI.pdf', pdf2);
        check('the supplier uploads the certificate', r.status === 201, r.body);
        r = await upv('vendor_agreement', 'Agreement.pdf', pdf2);
        check('the supplier uploads the agreement', r.status === 201, r.body);
        const vOb = (await pfOwner.fetch('/api/onboarding/' + vId)).body;
        const vi = (k) => vOb.checklist.find((c) => c.key === k);
        check('the checklist shows the uploads and the signed banking form', vi('coi').done && vi('coi').documents[0].uploadedBy === 'Supplier (secure link)' && vi('vendor_agreement').done && vi('remittance').done, vOb.checklist.map((c) => [c.key, c.done]));
        check('the W-9 is still waiting for the supplier’s signature', vi('company_w9').form.status === 'draft', vi('company_w9').form);
        r = await anon(P + '/forms/w9/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Alex AP', consent: true }) });
        check('the supplier signs the W-9', r.status === 200 && r.body.status === 'complete', r.body);
        r = await anon(P + '/submit', { method: 'POST', body: '{}' });
        check('the supplier marks everything done', r.status === 200, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + vId);
        check('the activity log records what the supplier did', r.body.log.some((l) => /uploaded by the supplier/.test(l.text)) && r.body.log.some((l) => /marked everything requested/.test(l.text)), r.body.log.map((l) => l.text));
        const [[tinRow]] = await dbConn.query(`SELECT cipher FROM record_secrets WHERE entity = 'subvendors' AND record_id = ? AND field = 'w9.tin'`, [vSup]);
        check('the supplier’s tax ID is encrypted at rest', tinRow && /^v1:/.test(tinRow.cipher) && !tinRow.cipher.includes('3456789'), tinRow);
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/vendor-requests');
        check('HR sees four of four received', r.body.requests[0].items.every((i) => i.done) && r.body.requests[0].submittedAt, r.body.requests[0]);
        const rid = r.body.requests[0].id;
        r = await obRec.fetch('/api/onboarding/' + vId + '/vendor-requests/' + rid, { method: 'DELETE' });
        check('a recruiter cannot cancel a link', r.status === 403, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/vendor-requests/' + rid, { method: 'DELETE' });
        check('HR cancels the link', r.status === 200, r.body);
        r = await anon(P);
        check('a cancelled link stops working', r.status === 410, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + vId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: ['coi'], days: 1 }) });
        const tok2 = r.body.path.split('=')[1];
        await dbConn.query('UPDATE vendor_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?', [r.body.request.id]);
        r = await anon('/api/vendor-portal/' + tok2);
        check('an expired link stops working', r.status === 410, r.body);
        r = await pfOther.fetch('/api/onboarding/' + vId + '/vendor-requests');
        check('another organisation cannot see the requests', r.status === 404, r.body);
      }

      // ---- new vendors: HR is prompted at approval time and sends an onboarding link
      {
        const anon2 = async (pth, opts = {}) => {
          const res = await fetch(BASE + pth, Object.assign({}, opts, { headers: { 'Content-Type': 'application/json' } }));
          let body = null; try { body = await res.json(); } catch (e) { /* none */ }
          return { status: res.status, body };
        };
        const nd = Object.assign({}, obF, { consultant_name: 'Nora Newvendor', email: 'nora@brandnew.test', employer_name: 'Brandnew Tech Inc.', employer_email: 'old@brandnew.test', invoicing_method: 'QuickBooks' });
        r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: nd }) });
        const nId = r.body.id;
        await obRec.fetch('/api/onboarding/' + nId + '/status', { method: 'POST', body: JSON.stringify({ status: 'submitted' }) });
        r = await pfOwner.fetch('/api/onboarding/' + nId);
        check('HR sees the vendor flagged as new, with the suggested items and email', r.body.vendorCheck && r.body.vendorCheck.state === 'new' && r.body.vendorCheck.email === 'old@brandnew.test' && r.body.vendorCheck.suggest.length === 5, r.body.vendorCheck);
        r = await obRec.fetch('/api/onboarding/' + nId);
        check('the recruiter sees nothing about it', r.status === 200 && r.body.vendorCheck === undefined, r.body.vendorCheck);
        r = await pfOwner.fetch('/api/onboarding?status=submitted');
        check('the pending list flags the new vendor for HR', r.body.onboardings.find((o) => o.id === nId).newVendor === true, r.body.onboardings);
        r = await obRec.fetch('/api/onboarding?status=all');
        check('the recruiter’s list carries no vendor flag', r.body.onboardings.every((o) => !o.newVendor), r.body.onboardings);
        r = await pfOwner.fetch('/api/onboarding/' + nId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: ['company', 'w9'], email: 'not-an-email' }) });
        check('a bad email is refused', r.status === 400, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + nId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: ['company', 'w9', 'banking', 'coi', 'vendor_agreement'], email: 'ap@brandnew.test', days: 14 }) });
        check('HR sends the link while the request is still pending approval, to an edited email', r.status === 201 && r.body.supplierEmail === 'ap@brandnew.test', r.body);
        const nTok = r.body.path.split('=')[1], NP = '/api/vendor-portal/' + nTok;
        r = await pfOwner.fetch('/api/onboarding/' + nId);
        check('the edited email is remembered on the request', r.body.data.employer_email === 'ap@brandnew.test' && r.body.status === 'submitted', r.body.data.employer_email);
        const [[nSup]] = await dbConn.query(`SELECT id, status FROM subvendors WHERE name = 'Brandnew Tech Inc.'`);
        check('the vendor is in the Directory but inactive until they finish', nSup && nSup.status === 'inactive', nSup);
        r = await pfOwner.fetch('/api/onboarding/' + nId);
        check('the banner now shows the vendor as incomplete', r.body.vendorCheck.state === 'incomplete' && r.body.vendorCheck.missing.includes('company'), r.body.vendorCheck);
        r = await anon2(NP + '/company', { method: 'PUT', body: JSON.stringify({ values: { contact_name: 'Bo Brandnew' } }) });
        check('company details need contact and address', r.status === 400, r.body);
        r = await anon2(NP + '/company', { method: 'PUT', body: JSON.stringify({ values: { contact_name: 'Bo Brandnew', email: 'ap@brandnew.test', phone: '555-0100', street: '9 Oak Ave', city: 'Dallas', state: 'TX', postal_code: '75001', payment_terms: 'Net 30' } }) });
        check('the vendor gives their company details', r.status === 200, r.body);
        r = await anon2(NP + '/company');
        check('the details read back', r.body.values.city === 'Dallas' && r.body.values.street === '9 Oak Ave' && r.body.values.payment_terms === 'Net 30', r.body);
        r = await pfOwner.fetch('/api/profiles/subvendors/' + nSup.id);
        check('the Directory profile carries the contact and payment terms', r.body.values.contact_name === 'Bo Brandnew' && r.body.values.payment_terms === 'Net 30', r.body.values);
        r = await anon2(NP + '/submit', { method: 'POST', body: '{}' });
        check('the vendor cannot finish with items outstanding', r.status === 409 && /Form W-9/.test(r.body.error), r.body);
        const pdf3 = Buffer.concat([Buffer.from('%PDF-1.4\n'), require('crypto').randomBytes(300), Buffer.from('\n%%EOF')]);
        await anon2(NP + '/forms/w9', { method: 'PUT', body: JSON.stringify({ values: { name: 'Brandnew Tech Inc.', tax_class: 'C corporation', address: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75001', tin_type: 'Employer identification number', cert1: true, cert3: true, cert4: true }, secrets: { tin: '98-7654321' } }) });
        await anon2(NP + '/forms/w9/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Bo Brandnew', consent: true }) });
        await anon2(NP + '/forms/banking', { method: 'PUT', body: JSON.stringify({ values: { method: 'ACH', bank_name: 'Bank of America', ach_type: 'Savings', ach_holder: 'Brandnew Tech Inc.', payee_attest: true }, secrets: { ach_routing: '026009593', ach_account: '1122334455' } }) });
        await anon2(NP + '/forms/banking/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Bo Brandnew', consent: true }) });
        for (const [item, nm] of [['coi', 'coi.pdf'], ['vendor_agreement', 'agr.pdf']]) await anon2(NP + '/documents', { method: 'POST', body: JSON.stringify({ item, filename: nm, contentBase64: pdf3.toString('base64') }) });
        r = await anon2(NP + '/submit', { method: 'POST', body: '{}' });
        check('the vendor finishes everything', r.status === 200, r.body);
        const [[nSup2]] = await dbConn.query('SELECT status, address FROM subvendors WHERE id = ?', [nSup.id]);
        check('the vendor becomes an active supplier company with its address', nSup2.status === 'active' && /Dallas/.test(nSup2.address), nSup2);
        r = await pfOwner.fetch('/api/onboarding/' + nId);
        check('the banner clears once the vendor is complete', r.body.vendorCheck.state === 'ready', r.body.vendorCheck);
        r = await pfOwner.fetch('/api/onboarding?status=submitted');
        check('the pending list no longer flags it', r.body.onboardings.find((o) => o.id === nId).newVendor === false, r.body.onboardings);

        // a known company written differently is recognised; one missing paperwork is flagged
        const kd = Object.assign({}, obF, { consultant_name: 'Kay Known', email: 'kay@v.test', employer_name: 'Vendorix, L.L.C.', invoicing_method: 'QuickBooks' });
        r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: kd }) });
        const kId = r.body.id;
        r = await pfOwner.fetch('/api/onboarding/' + kId);
        check('"Vendorix, L.L.C." is recognised as the existing Vendorix LLC, but missing company details', r.body.vendorCheck.state === 'incomplete' && r.body.vendorCheck.supplierName === 'Vendorix LLC' && r.body.vendorCheck.missing.join() === 'company', r.body.vendorCheck);
      }

      // ---- vendor named only in "Pay to", and adding a vendor straight to the Directory
      {
        const pd = Object.assign({}, obF, { consultant_name: 'Pat Payto', email: 'pat@v.test', pay_to: 'ABc Corp', invoicing_method: 'QuickBooks' });
        delete pd.employer_name;
        r = await pfOwner.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: pd }) });
        const pId = r.body.id;
        check('saving shows the new vendor straight away, even when it is only in "Pay to"', r.status === 201 && r.body.vendorCheck && r.body.vendorCheck.state === 'new' && r.body.vendorCheck.name === 'ABc Corp', r.body.vendorCheck);
        r = await obRec.fetch('/api/onboarding/' + pId + '/add-vendor', { method: 'POST', body: '{}' });
        check('a recruiter cannot add the vendor', r.status === 403, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + pId + '/add-vendor', { method: 'POST', body: JSON.stringify({ email: 'bad' }) });
        check('add-vendor refuses a bad email', r.status === 400, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + pId + '/add-vendor', { method: 'POST', body: JSON.stringify({ email: 'ap@abc.test' }) });
        check('HR adds the vendor to the Directory in one click', r.status === 201 && r.body.supplierId && r.body.vendorCheck.state === 'incomplete', r.body.vendorCheck);
        r = await pfOwner.fetch('/api/directory/subvendors');
        check('ABc Corp is now a supplier company with the email', r.body.subvendors.some((x) => x.name === 'ABc Corp' && x.email === 'ap@abc.test'), r.body.subvendors.map((x) => x.name));
        r = await pfOwner.fetch('/api/onboarding/' + pId + '/add-vendor', { method: 'POST', body: '{}' });
        check('adding again links, never duplicates', r.status === 200 && (await dbConn.query(`SELECT COUNT(*) n FROM subvendors WHERE name = 'ABc Corp'`))[0][0].n === 1, r.body);
      }

      // W2 and 1099 get their own checklists
      r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'W2', data: { consultant_name: 'Wendy Wtwo', h1b_filing_required: 'Yes', start_date: '2026-11-02', end_client: 'Acme', bill_rate: 80, pay_rate: 55, recruiter: 'Rita', invoicing_method: 'Client portal', job_title: 'QA Lead', work_state: 'NJ' } }) });
      const w2Id = r.body.id;
      const w2 = (await pfOwner.fetch('/api/onboarding/' + w2Id)).body.checklist.map((c) => c.key);
      check('W2 checklist: W-4, I-9, direct deposit, benefits, H-1B petition', ['w4', 'i9', 'direct_deposit', 'benefits', 'h1b_petition', 'offer_letter'].every((k) => w2.includes(k)) && !w2.includes('company_w9'), w2);
      r = await obRec.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: '1099', data: { consultant_name: 'Ned Ninetynine', h1b_filing_required: 'No', start_date: '2026-11-02', end_client: 'Beta', bill_rate: 70, pay_rate: 60, recruiter: 'Rita', invoicing_method: 'QuickBooks' } }) });
      const t99 = (await pfOwner.fetch('/api/onboarding/' + r.body.id)).body.checklist.map((c) => c.key);
      check('1099 checklist: contractor agreement, W-9, I-9; no W-4', ['contractor_agreement', 'w9', 'i9'].every((k) => t99.includes(k)) && !t99.includes('w4'), t99);
      r = await obRec.fetch('/api/onboarding/' + r.body.id, { method: 'DELETE' });
      check('recruiter can delete their own draft', r.status === 200, r);
      r = await obRec.fetch('/api/onboarding/' + w2Id + '/status', { method: 'POST', body: JSON.stringify({ status: 'in_progress' }) });
      check('recruiter cannot start onboarding themselves', r.status === 403, r);

      // owner chooses HR admins
      r = await obRec.fetch('/api/onboarding/people');
      check('recruiter cannot list people', r.status === 403, r);
      const ritaId = (await pfOwner.fetch('/api/onboarding/people')).body.people.find((p) => p.email === 'rita@onb.test').id;
      r = await obRec.fetch('/api/onboarding/people/' + ritaId, { method: 'PUT', body: JSON.stringify({ role: 'hr' }) });
      check('a recruiter cannot make themselves HR', r.status === 403, r);
      r = await pfOwner.fetch('/api/onboarding/people/' + ritaId, { method: 'PUT', body: JSON.stringify({ role: 'hr' }) });
      check('the owner makes Rita an HR admin', r.status === 200, r);
      // ---- HR admins may enter bank numbers (banking form only); W2 / 1099 bank items use the banking form
      {
        const consId = (await pfOwner.fetch('/api/onboarding/' + obId)).body.consultantId;
        const [[o]] = await dbConn.query('SELECT organization_id FROM onboardings WHERE id = ?', [obId]);
        r = await obRec.fetch('/api/forms/schema');
        check('schema: HR may type bank numbers, SSNs and tax IDs', r.body.canEditSecretsFor.banking === true && r.body.canEditSecretsFor.w9 === true && r.body.canEditSecrets === true, r.body.canEditSecretsFor);
        r = await obRec.fetch('/api/forms/consultants/' + consId + '/w9', { method: 'PUT', body: JSON.stringify({ secrets: { tin: '123456789' } }) });
        check('HR can enter a tax ID', r.status === 200, r.body);
        r = await obRec2.fetch('/api/forms/consultants/' + consId + '/banking', { method: 'PUT', body: JSON.stringify({ secrets: { ach_account: '55554444' } }) });
        check('a recruiter cannot open the banking form at all', r.status === 403, r.body);
        // a W2 and a 1099 onboarding for this consultant, one with an old manual tick
        const mk = async (type, cl) => (await dbConn.query(`INSERT INTO onboardings (organization_id, worker_type, status, consultant_name, consultant_id, data, checklist, log) VALUES (?, ?, 'in_progress', 'Avinash Agnihotri', ?, ?, ?, '[]')`,
          [o.organization_id, type, consId, JSON.stringify({ consultant_name: 'Avinash Agnihotri', h1b_filing_required: 'No' }), JSON.stringify(cl)]))[0].insertId;
        const w2b = await mk('W2', { direct_deposit: { done: true, by: 'Old HR' } });
        const t99b = await mk('1099', {});
        let g = (await pfOwner.fetch('/api/onboarding/' + w2b)).body.checklist.find((c) => c.key === 'direct_deposit');
        check('W2 direct deposit links to the consultant banking form; old tick still counts, tagged', g.form && g.form.form === 'banking' && g.form.entity === 'consultants' && g.form.recordId === consId && g.done === true && g.legacyDone === true && g.formOnly === true, g);
        g = (await pfOwner.fetch('/api/onboarding/' + t99b)).body.checklist.find((c) => c.key === 'payment_details');
        check('1099 payment details links to the banking form and is open', g.form && g.form.form === 'banking' && g.done === false, g);
        r = await pfOwner.fetch('/api/onboarding/' + t99b + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'payment_details', done: true }) });
        check('1099 payment details cannot be ticked by hand', r.status === 400, r.body);
        // upload the completed document instead of filling a form (1099 / C2C only)
        const pdfB64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
        g = (await pfOwner.fetch('/api/onboarding/' + t99b)).body.checklist.find((c) => c.key === 'w9');
        check('1099 W-9 offers an upload instead and is open', g.upload === 'instead' && g.done === false && g.viaUpload === false, g);
        r = await pfOwner.fetch('/api/onboarding/' + t99b + '/documents', { method: 'POST', body: JSON.stringify({ itemKey: 'w9', filename: 'signed-w9.pdf', contentBase64: pdfB64 }) });
        check('HR uploads a completed W-9 instead of filling it in', r.status === 201, r.body);
        g = (await pfOwner.fetch('/api/onboarding/' + t99b)).body.checklist.find((c) => c.key === 'w9');
        check('the W-9 item is done via the upload', g.done === true && g.viaUpload === true && g.documents.length === 1, g);
        r = await pfOwner.fetch('/api/onboarding/' + t99b + '/documents', { method: 'POST', body: JSON.stringify({ itemKey: 'i9', filename: 'i9.pdf', contentBase64: pdfB64 }) });
        g = (await pfOwner.fetch('/api/onboarding/' + t99b)).body.checklist.find((c) => c.key === 'i9');
        check('an I-9 can be uploaded instead too', r.status === 201 && g.done === true, r.body);
        r = await pfOwner.fetch('/api/onboarding/' + w2b + '/documents', { method: 'POST', body: JSON.stringify({ itemKey: 'i9', filename: 'i9.pdf', contentBase64: pdfB64 }) });
        check('W-2 forms are not uploadable (only C2C and 1099)', r.status === 404, r.body);
        r = await obRec2.fetch('/api/onboarding/' + t99b + '/documents', { method: 'POST', body: JSON.stringify({ itemKey: 'w9', filename: 'x.pdf', contentBase64: pdfB64, replace: true }) });
        check('a recruiter cannot upload', r.status === 403, r.status);
        const bu = '/api/forms/consultants/' + consId + '/banking';
        r = await obRec.fetch(bu, { method: 'PUT', body: JSON.stringify({ values: { method: 'ACH', bank_name: 'Chase', ach_holder: 'Avinash Agnihotri', ach_type: 'Savings', payee_attest: true }, secrets: { ach_routing: '021000021', ach_account: '9876543210' } }) });
        check('an HR admin enters bank numbers on the banking form', r.status === 200, r.body);
        r = await obRec.fetch(bu);
        check('HR reads back last 4 only', r.body.secrets.ach_account.last4 === '3210' && !JSON.stringify(r.body).includes('9876543210'), r.body.secrets);
        r = await obRec.fetch(bu, { method: 'PUT', body: JSON.stringify({ secrets: { ach_account: '1111222233' } }) });
        check('an HR admin can update a bank number', r.status === 200 && (await obRec.fetch(bu)).body.secrets.ach_account.last4 === '2233', r.body);
        r = await obRec.fetch(bu + '/sign', { method: 'POST', body: JSON.stringify({ signature: 'payee', typedName: 'Avinash Agnihotri', consent: true }) });
        check('the consultant banking form is signed', r.status === 200 && r.body.status === 'complete', r.body);
        g = (await pfOwner.fetch('/api/onboarding/' + t99b)).body.checklist.find((c) => c.key === 'payment_details');
        check('1099 payment details ticks itself once signed', g.done === true && g.autoDone === true && !g.legacyDone, g);
        g = (await pfOwner.fetch('/api/onboarding/' + w2b)).body.checklist.find((c) => c.key === 'direct_deposit');
        check('W2 direct deposit is now done by the form (no longer tagged)', g.done === true && g.autoDone === true && g.legacyDone === false, g);
        // recruiters never see the banking form or its details
        const ronR = makeJar();
        await pfOwner.fetch('/api/onboarding/people', { method: 'POST', body: JSON.stringify({ name: 'Bea Recruiter', email: 'bea@pftest.test', password: 'beapassword123', role: 'recruiter' }) });
        await ronR.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'bea@pftest.test', password: 'beapassword123' }) });
        r = await ronR.fetch(bu);
        check('a recruiter is refused the banking form (403)', r.status === 403 && !JSON.stringify(r.body).includes('3210') && !JSON.stringify(r.body).includes('2233'), r);
        r = await ronR.fetch('/api/forms/consultants/' + consId);
        check('a recruiter cannot list the forms (403)', r.status === 403, r.status);
        r = await ronR.fetch('/api/forms/schema');
        check('a recruiter cannot read the forms schema (403)', r.status === 403, r.status);
        r = await ronR.fetch(bu, { method: 'PUT', body: JSON.stringify({ secrets: { ach_account: '1234567' } }) });
        check('a recruiter cannot write bank numbers (403)', r.status === 403, r.status);
        const [[bea]] = await dbConn.query(`SELECT id FROM users WHERE email = 'bea@pftest.test'`);
        await dbConn.query('UPDATE onboardings SET created_by_id = ? WHERE id = ?', [bea.id, t99b]);
        r = await ronR.fetch('/api/onboarding/' + t99b);
        g = r.body.checklist.find((c) => c.key === 'payment_details');
        check('the recruiter’s own request hides the banking form (no link, status or record)', r.status === 200 && !g.form && !JSON.stringify(r.body).includes('"banking"'), g);
        await dbConn.query('DELETE FROM onboardings WHERE id IN (?, ?)', [w2b, t99b]);
      }
      r = await obRec.fetch('/api/onboarding?status=all');
      check('an HR admin sees every request', r.body.onboardings.length >= 2, r.body);
      r = await obRec2.fetch('/api/onboarding/me');
      check('the other recruiter is still a recruiter', r.body.isHr === false, r.body);
      r = await obRec2.fetch('/api/onboarding', { method: 'GET' });
      r = await pfOther.fetch('/api/onboarding/' + obId);
      check('another organisation cannot see the onboarding', r.status === 404, r);

      // ---- old checklist JSON still loads (renamed key mapped, removed item hidden but kept)
      {
        const [[o]] = await dbConn.query('SELECT organization_id FROM onboardings WHERE id = ?', [obId]);
        const old = { subcontract: { done: true, note: 'signed 2025', by: 'Old HR' }, invoicing_setup: { done: true, note: 'QB' }, rate_confirmation: { done: true }, coi: { done: true }, remittance: { done: true } };
        const [ins] = await dbConn.query(`INSERT INTO onboardings (organization_id, worker_type, status, consultant_name, data, checklist, log) VALUES (?, 'C2C', 'in_progress', 'Legacy Larry', ?, ?, '[]')`,
          [o.organization_id, JSON.stringify({ consultant_name: 'Legacy Larry', h1b_filing_required: 'No' }), JSON.stringify(old)]);
        r = await pfOwner.fetch('/api/onboarding/' + ins.insertId);
        const g = (k) => r.body.checklist.find((c) => c.key === k);
        check('old checklist: subcontract shows as the Vendor agreement with its note', r.status === 200 && g('vendor_agreement').done === true && g('vendor_agreement').note === 'signed 2025' && g('vendor_agreement').legacyDone === true, r.body.checklist && g('vendor_agreement'));
        check('old checklist: invoicing set-up is gone, ticked rate confirmation reads as Yes, ticked COI/remittance still count', !g('invoicing_setup') && g('rate_confirmation').value === 'Yes' && g('coi').done && g('remittance').done, r.body.checklist);
        r = await pfOwner.fetch('/api/onboarding/' + ins.insertId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'timesheet_access', answer: 'Yes' }) });
        const [[after]] = await dbConn.query('SELECT checklist FROM onboardings WHERE id = ?', [ins.insertId]);
        const a = JSON.parse(after.checklist);
        check('saving an old checklist keeps every stored value (removed item preserved, renamed key moved)', a.invoicing_setup && a.invoicing_setup.note === 'QB' && a.vendor_agreement && a.vendor_agreement.note === 'signed 2025' && !a.subcontract && a.timesheet_access.answer === 'Yes', a);
        r = await pfOwner.fetch('/api/onboarding/' + ins.insertId + '/checklist', { method: 'POST', body: JSON.stringify({ key: 'invoicing_setup', done: true }) });
        check('the removed item can no longer be changed', r.status === 404, r.body);
      }

      // ---- personal invites: one email, one role, one use
      {
        r = await obRec2.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'x@inv.test', role: 'recruiter' }) });
        check('a recruiter cannot send invites', r.status === 403, r.body);
        r = await pfOwner.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'not-an-email', role: 'recruiter' }) });
        check('an invalid email is refused', r.status === 400, r.body);
        r = await pfOwner.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'Hannah@Inv.test', name: 'Hannah HR', role: 'hr' }) });
        check('the owner invites Hannah as an HR admin and gets a link', r.status === 201 && r.body.role === 'hr' && r.body.email === 'hannah@inv.test' && /\/signup\.html\?code=[0-9a-f]{24}&email=hannah%40inv\.test$/.test(r.body.link) && r.body.emailSending === true && r.body.emailSent === true, r.body);
        const hCode = r.body.code;
        r = await pfOwner.fetch('/api/onboarding/invites');
        const hi = r.body.personal.find((x) => x.email === 'hannah@inv.test');
        check('the invite is listed as pending with its link', hi && hi.status === 'pending' && hi.role === 'hr' && hi.name === 'Hannah HR' && !!hi.link, r.body.personal);
        const wrong = makeJar();
        r = await wrong.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: hCode, name: 'Mallory', email: 'mallory@inv.test', password: 'password1234' }) });
        check('the invite does not work for a different email', r.status === 403, r.body);
        const hannah = makeJar();
        r = await hannah.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: hCode, name: 'Hannah HR', email: 'HANNAH@inv.test', password: 'password1234' }) });
        check('Hannah signs up and gets the HR admin role', r.status === 201 && r.body.user.role === 'hr', r.body);
        const again = makeJar();
        r = await again.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: hCode, name: 'Hannah Two', email: 'hannah@inv.test', password: 'password1234' }) });
        check('the invite works only once', r.status === 410 || r.status === 409, r.body);
        r = await pfOwner.fetch('/api/onboarding/invites');
        check('the invite now shows as used, by Hannah', r.body.personal.find((x) => x.email === 'hannah@inv.test').status === 'used' && r.body.personal.find((x) => x.email === 'hannah@inv.test').usedBy === 'Hannah HR' && !r.body.personal.find((x) => x.email === 'hannah@inv.test').link, r.body.personal);
        r = await hannah.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'otto@inv.test', role: 'hr' }) });
        check('an HR admin cannot invite another HR admin', r.status === 403, r.body);
        r = await hannah.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'rex@inv.test', role: 'recruiter' }) });
        check('an HR admin can invite a recruiter', r.status === 201 && r.body.role === 'recruiter', r.body);
        const rexCode = r.body.code;
        const rexId = (await hannah.fetch('/api/onboarding/invites')).body.personal.find((x) => x.email === 'rex@inv.test').id;
        r = await pfOwner.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'rita@onb.test', role: 'member' }) });
        check('inviting an email that already has a login is refused', r.status === 409, r.body);
        r = await hannah.fetch('/api/onboarding/invites/' + rexId, { method: 'DELETE' });
        check('the invite is revoked', r.status === 200, r.body);
        const rex = makeJar();
        r = await rex.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: rexCode, name: 'Rex', email: 'rex@inv.test', password: 'password1234' }) });
        check('a revoked invite cannot be used', r.status === 404, r.body);
        r = await pfOwner.fetch('/api/onboarding/invites');
        check('the revoked invite is listed as revoked', r.body.personal.find((x) => x.id === rexId).status === 'revoked', r.body.personal);
        r = await pfOwner.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'tm@inv.test', role: 'member' }) });
        const tm = makeJar();
        r = await tm.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: r.body.code, name: 'Tina Team', email: 'tm@inv.test', password: 'password1234' }) });
        check('a Team member invite gives the member role', r.status === 201 && r.body.user.role === 'member', r.body);
      }

      // 39. A recruiter-only login: Onboarding module and nothing else.
      r = await pfOwner.fetch('/api/onboarding/people', { method: 'POST', body: JSON.stringify({ name: 'Ron Recruiter', email: 'ron@pftest.test', password: 'ronpassword123', role: 'recruiter' }) });
      check('the owner adds a recruiter login', r.status === 201, r);
      r = await pfOwner.fetch('/api/onboarding/people', { method: 'POST', body: JSON.stringify({ name: 'Ron Again', email: 'RON@pftest.test', password: 'ronpassword123', role: 'recruiter' }) });
      check('a duplicate email is refused', r.status === 409, r);
      r = await pfOwner.fetch('/api/onboarding/people', { method: 'POST', body: JSON.stringify({ name: 'Bad', email: 'bad@pftest.test', password: 'short', role: 'recruiter' }) });
      check('a short password is refused', r.status === 400, r);
      const ron = makeJar();
      r = await ron.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'ron@pftest.test', password: 'ronpassword123' }) });
      check('the recruiter can sign in', r.status === 200 && r.body.user.role === 'recruiter', r.body);
      r = await ron.fetch('/api/auth/me');
      check('the recruiter session endpoint works', r.status === 200 && r.body.user.role === 'recruiter', r.body);
      r = await ron.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'W2', data: { consultant_name: 'Wanda W2' } }) });
      check('the recruiter can start an onboarding request', r.status === 201, r);
      const ronId = r.body.id;
      r = await ron.fetch('/api/onboarding?status=all');
      check('the recruiter sees only their own request', r.status === 200 && r.body.onboardings.length === 1 && r.body.onboardings[0].id === ronId, r.body);
      for (const path of ['/api/directory/consultants', '/api/invoices', '/api/subvendor-invoices', '/api/ledger', '/api/margin', '/api/profiles/schema', '/api/forms/schema', '/api/directory/clients']) {
        r = await ron.fetch(path);
        check('the recruiter is blocked from ' + path, r.status === 403, r.status);
      }
      r = await ron.fetch('/api/onboarding/people');
      check('the recruiter cannot list people', r.status === 403, r);
      r = await ron.fetch('/api/onboarding/' + ronId + '/create-records', { method: 'POST', body: '{}' });
      check('the recruiter cannot create directory records', r.status === 403, r);
      // role-specific invite codes
      r = await ron.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ role: 'recruiter' }) });
      check('a non-owner cannot create invite codes', r.status === 403, r);
      r = await pfOwner.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ role: 'owner' }) });
      check('an invite code cannot grant owner', r.status === 400, r);
      r = await pfOwner.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ role: 'recruiter' }) });
      check('the owner creates a Recruiter invite code', r.status === 201 && /^[0-9a-f]{12}$/.test(r.body.code), r);
      const recCode = r.body.code;
      const viaCode = makeJar();
      r = await viaCode.fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: recCode, name: 'Via Code', email: 'viacode@pftest.test', password: 'viacodepassword1' }) });
      check('joining with a Recruiter code makes a recruiter', r.status === 201 && r.body.user.role === 'recruiter', r.body);
      r = await viaCode.fetch('/api/directory/consultants');
      check('that recruiter is blocked from the Directory', r.status === 403, r.status);
      r = await pfOwner.fetch('/api/onboarding/invites');
      const invId = r.body.invites.find((i) => i.code === recCode).id;
      r = await pfOwner.fetch('/api/onboarding/invites/' + invId, { method: 'DELETE' });
      r = await makeJar().fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: recCode, name: 'Late One', email: 'late@pftest.test', password: 'latepassword123' }) });
      check('a revoked invite code stops working', r.status === 404, r);
      r = await makeJar().fetch('/api/auth/join', { method: 'POST', body: JSON.stringify({ inviteCode: (await pfOwner.fetch('/api/auth/me')).body.user.organization.inviteCode, name: 'Old Code', email: 'oldcode@pftest.test', password: 'oldcodepassword1' }) });
      check('the original company code still gives a Team member', r.status === 201 && r.body.user.role === 'member', r.body);
      // money is for HR only: a recruiter can enter it but never reads it back
      r = await ron.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: { consultant_name: 'Money Test', bill_rate: 123, pay_rate: 77, final_cost: 80, end_client: 'Acme / Rocket', recruiter: 'Ron', start_date: '2026-11-01', h1b_filing_required: 'No', invoicing_method: 'QuickBooks', employer_name: 'Money Co' } }) });
      const monId = r.body.id;
      check('the create response does not echo the rates', r.status === 201 && r.body.data.bill_rate === undefined && r.body.data.pay_rate === undefined && r.body.data.final_cost === undefined && r.body.margin === null, r.body);
      check('the recruiter is told which values were entered', r.body.hiddenFields && r.body.hiddenFields.bill_rate === true && r.body.hiddenFields.pay_rate === true, r.body.hiddenFields);
      r = await ron.fetch('/api/onboarding/' + monId);
      check('a recruiter reading it back sees no rates or margin', r.body.data.bill_rate === undefined && r.body.data.pay_rate === undefined && r.body.data.final_cost === undefined && r.body.margin === null && !JSON.stringify(r.body).includes('123'), r.body);
      r = await ron.fetch('/api/onboarding/' + monId + '/email');
      check('the e-mail text for a recruiter leaves the rates out', !/123|77|80/.test(r.body.text.replace(/Project Start Date:\n[^\n]*/, '')), r.body.text);
      r = await ron.fetch('/api/onboarding/' + monId, { method: 'PUT', body: JSON.stringify({ data: { bill_rate: '', pay_rate: '', final_cost: '', technical_skill: 'DB2' } }) });
      check('saving blanks from a recruiter does not clear the rates', r.status === 200 && r.body.hiddenFields.bill_rate === true, r.body);
      r = await pfOwner.fetch('/api/onboarding/' + monId);
      check('HR still sees the real bill rate, pay rate, final cost and margin', r.body.data.bill_rate === 123 && r.body.data.pay_rate === 77 && r.body.data.final_cost === 80 && r.body.margin && r.body.margin.perHour === 43, r.body.margin);
      r = await ron.fetch('/api/onboarding/' + monId + '/status', { method: 'POST', body: JSON.stringify({ status: 'submitted' }) });
      check('a recruiter can submit without re-entering rates already saved', r.status === 200, r);
      r = await pfOwner.fetch('/api/onboarding/' + monId + '/status', { method: 'POST', body: JSON.stringify({ status: 'draft', reason: 'check the rate' }) });
      r = await ron.fetch('/api/onboarding/' + monId, { method: 'PUT', body: JSON.stringify({ data: { bill_rate: 130 } }) });
      r = await pfOwner.fetch('/api/onboarding/' + monId);
      check('a recruiter can replace the bill rate (write-only)', r.body.data.bill_rate === 130 && r.body.data.pay_rate === 77, r.body.data);
      check('the activity log never contains the rate values', !/\b(123|130)\b/.test(JSON.stringify(r.body.log)), r.body.log);
      r = await pfOwner.fetch('/api/onboarding?status=all');
      check('the list never carries rates', !/bill_rate|pay_rate|margin/i.test(JSON.stringify(r.body)), 'list');

      r = await pfOwner.fetch('/api/onboarding/people');
      const ronRow = r.body.people.find((p) => p.email === 'ron@pftest.test');
      check('the owner sees the recruiter role', ronRow && ronRow.role === 'recruiter', r.body);
      r = await pfOwner.fetch('/api/onboarding/people/' + ronRow.id, { method: 'PUT', body: JSON.stringify({ role: 'member' }) });
      r = await ron.fetch('/api/directory/consultants');
      check('a team member (not recruiter) regains full access', r.status === 200, r.status);

      // 45. Independent of files: placements entered in the app drive supplier payments, one line per project.
      const indJar = makeJar();
      r = await indJar.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'No Files Co', name: 'Ind Owner', email: 'ind@indtest.test', password: 'independentpass1' }) });
      check('no-files org signup returns 201', r.status === 201, r);
      for (const [client, bill, pay] of [['RCA', 240, 210], ['IBM', 210, 200], ['Cisco', 260, 250]]) {
        r = await indJar.fetch('/api/roster', { method: 'POST', body: JSON.stringify({ name: 'Rob Rosales', client, vendor: 'CDW', employmentType: 'Subvendor', supplier: 'Rosales Consulting LLC', billing: bill, cost: pay }) });
        if (r.status !== 201) check('placement ' + client + ' created', false, r.body);
      }
      r = await indJar.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-11' }) });
      check('supplier payments generate with no Ledger or Margin file: one line per project', r.status === 201 && r.body.created.length === 3, r.body);
      r = await indJar.fetch('/api/subvendor-invoices?periodMonth=2026-11');
      const robLines = (r.body.invoices || []).filter((i) => i.consultant_name === 'Rob Rosales');
      check('each project line uses that placement’s own pay rate', robLines.length === 3 && [200, 210, 250].every((x) => robLines.some((i) => i.rate === x)) && robLines.every((i) => i.rate_source === 'placement' && i.project), robLines);
      r = await indJar.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-11' }) });
      check('re-running supplier generation does not duplicate lines', r.status === 201 && r.body.created.length === 0, r.body);
      r = await indJar.fetch('/api/subvendor-invoices', { method: 'POST', body: JSON.stringify({ consultantName: 'Sue Typed', subvendorName: 'Typed Supplies Inc', periodMonth: '2026-10', rate: 100, hours: 10, paymentStatus: 'paid' }) });
      check('supplier payment can be added by typing names (consultant and supplier created)', r.status === 201, r.body);
      r = await indJar.fetch('/api/subvendor-invoices?periodMonth=2026-10');
      check('the typed payment is listed as paid, $1000', (r.body.invoices || []).some((i) => i.consultant_name === 'Sue Typed' && i.amount === 1000 && i.payment_status === 'paid'), r.body);
      r = await indJar.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-11' }) });
      check('client invoices generate with no file: one per project at its billing rate', r.status === 201 && r.body.created.length === 3 && [210, 240, 260].every((x) => r.body.created.some((i) => Number(i.rate) === x)), r.body);
      const rcaRec = (await indJar.fetch('/api/roster')).body.records.find((x) => x.client === 'RCA');
      await indJar.fetch('/api/roster/' + rcaRec.id, { method: 'PATCH', body: JSON.stringify({ status: 'Left', leftDate: '2026-11-30' }) });
      r = await indJar.fetch('/api/subvendor-invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-12' }) });
      check('a placement marked Left stops being generated', r.status === 201 && r.body.created.length === 2, r.body);

      // 46. Same consultant, different vendor on each project (and one client reached through two vendors).
      const mvJar = makeJar();
      r = await mvJar.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Many Vendors Co', name: 'Mv Owner', email: 'mv@mvtest.test', password: 'manyvendorspass1' }) });
      check('many-vendors org signup returns 201', r.status === 201, r);
      for (const [client, vendor, bill] of [['Delta', 'Insight', 100], ['Epsilon', 'Softchoice', 110], ['Delta', 'SHI', 120], ['Zeta', '', 130]]) {
        r = await mvJar.fetch('/api/roster', { method: 'POST', body: JSON.stringify({ name: 'Rob Rosales', client, vendor, billing: bill, cost: 80 }) });
        if (r.status !== 201) check('placement ' + client + '/' + vendor + ' created', false, r.body);
      }
      r = await mvJar.fetch('/api/roster');
      const mvRows = r.body.records.filter((x) => x.name === 'Rob Rosales');
      check('one consultant holds four placements with different vendors (and one with none)',
        mvRows.length === 4 && new Set(mvRows.map((x) => x.consultantId)).size === 1 && ['Insight', 'Softchoice', 'SHI', '(unspecified)'].every((v) => mvRows.some((x) => x.program === v)), mvRows.map((x) => x.client + '/' + x.program));
      r = await mvJar.fetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ periodMonth: '2026-09' }) });
      check('each project invoices to its own vendor (client when it has none)',
        r.status === 201 && r.body.created.length === 4 && ['Insight', 'Softchoice', 'SHI', 'Zeta'].every((n) => r.body.created.some((i) => i.bill_to_name === n)), r.body.created && r.body.created.map((i) => i.bill_to_name));

      // ---- "Alef Data" / "Alef Data Integration Ltd": found, flagged and merged without losing anything
      {
        const adJar = makeJar();
        await adJar.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Alef Co', name: 'Al Owner', email: 'al@alef.test', password: 'alefpassword123' }) });
        const mk = async (values, secrets) => (await adJar.fetch('/api/profiles/subvendors', { method: 'POST', body: JSON.stringify({ values, secrets }) })).body;
        const aShort = await mk({ name: 'Alef Data', contact_name: 'Dana Short', payment_terms: 'Net 30' }, { tax_id: '11-2223333' });
        const aLong = await mk({ name: 'Alef Data Integration Ltd', email: 'ap@alef.test', phone: '555-0199', city: 'Leeds' });
        const idS = aShort.id || (aShort.record && aShort.record.id), idL = aLong.id || (aLong.record && aLong.record.id);
        check('both spellings exist as separate supplier companies', !!idS && !!idL && idS !== idL, [aShort, aLong]);
        const dup = require('../src/routes/directoryDedup');
        check('"Alef Data" is recognised as the start of "Alef Data Integration Ltd"', dup.similarity('Alef Data', 'Alef Data Integration Ltd') >= dup.SIMILARITY_THRESHOLD, dup.similarity('Alef Data', 'Alef Data Integration Ltd'));
        check('Acme Corp and Acme, Inc. count as the same name', dup.similarity('Acme Corp', 'Acme, Inc.') >= dup.SIMILARITY_THRESHOLD);
        check('unrelated companies are not flagged', dup.similarity('Insight', 'Softchoice') < dup.SIMILARITY_THRESHOLD && dup.similarity('Delta', 'Delta Dental of California') < 0.95);
        r = await adJar.fetch('/api/directory/duplicates/scan', { method: 'POST', body: JSON.stringify({ table: 'subvendors' }) });
        check('scanning finds the existing pair', r.status === 200, r.body);
        r = await adJar.fetch('/api/directory/duplicates?table=subvendors');
        const flag = r.body.duplicates.find((d) => [d.record_name, d.matched_name].includes('Alef Data') && [d.record_name, d.matched_name].includes('Alef Data Integration Ltd'));
        check('the pair is listed as a possible duplicate', !!flag, r.body.duplicates);
        r = await adJar.fetch('/api/directory/duplicates/scan', { method: 'POST', body: JSON.stringify({ table: 'subvendors' }) });
        check('scanning again does not repeat the flag', r.body.opened === 0, r.body);
        // things hanging off the short name that must survive the merge
        const [[orgRow]] = await dbConn.query(`SELECT organization_id FROM subvendors WHERE id = ?`, [idS]);
        const org = orgRow.organization_id;
        await adJar.fetch('/api/profiles/subvendors/' + idS + '/notes', { method: 'POST', body: JSON.stringify({ body: 'Prefers invoices by the 5th.' }) });
        const [cres] = await dbConn.query(`INSERT INTO consultants (organization_id, name, status) VALUES (?, 'Cal Consultant', 'active')`, [org]);
        const [clres] = await dbConn.query(`INSERT INTO clients (organization_id, name, status) VALUES (?, 'Alef Client', 'active')`, [org]);
        await dbConn.query(`INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, supplier_id) VALUES (?, ?, ?, ?)`, [org, cres.insertId, clres.insertId, idS]);
        await adJar.fetch('/api/profiles/consultants/' + cres.insertId, { method: 'PATCH', body: JSON.stringify({ values: { supplier_id: String(idS) } }) });
        await dbConn.query(`INSERT INTO record_forms (organization_id, entity, record_id, form_type, data, signatures) VALUES (?, 'subvendors', ?, 'w9', '{"name":"Alef Data"}', '{"payee":{"name":"Dana Short","at":"2026-10-01T00:00:00Z","by":"x"}}')`, [org, idS]);
        r = await adJar.fetch('/api/directory/duplicates/' + flag.flag_id + '/merge', { method: 'POST', body: JSON.stringify({ keep: flag.record_name === 'Alef Data Integration Ltd' ? 'record' : 'matched' }) });
        check('merging keeping the full name succeeds', r.status === 200 && r.body.kept.name === 'Alef Data Integration Ltd' && r.body.removedId === idS, r.body);
        r = await adJar.fetch('/api/directory/subvendors');
        check('only one of them is left', r.body.subvendors.filter((x) => /^Alef Data/.test(x.name)).length === 1, r.body.subvendors.map((x) => x.name));
        r = await adJar.fetch('/api/profiles/subvendors/' + idL);
        check('profile details from both are combined', r.body.values.contact_name === 'Dana Short' && r.body.values.payment_terms === 'Net 30' && r.body.values.city === 'Leeds', r.body.values);
        check('the tax ID moved across (last 4 only shown)', r.body.secrets.tax_id && r.body.secrets.tax_id.last4 === '3333', r.body.secrets);
        check('notes moved across and the merge is logged', JSON.stringify(r.body.notes).includes('Prefers invoices') && JSON.stringify(r.body.notes).includes('Merged the duplicate record'), r.body.notes);
        check('the consultant linked to the old supplier now points at the survivor', r.body.related.supplierConsultants.some((x) => x.id === cres.insertId), r.body.related);
        const [[asgS]] = await dbConn.query('SELECT supplier_id FROM consultant_assignments WHERE consultant_id = ?', [cres.insertId]);
        check('the placement’s supplier moved to the survivor', asgS.supplier_id === idL, asgS);
        const [[wf]] = await dbConn.query(`SELECT COUNT(*) n FROM record_forms WHERE entity = 'subvendors' AND record_id = ? AND form_type = 'w9'`, [idL]);
        check('the signed W-9 moved across', wf.n === 1, wf);
        // onboarding: a request naming the short spelling is offered the existing record
        const adRec = makeJar();
        const ob2 = Object.assign({}, obF, { consultant_name: 'Sam Similar', email: 'sam@x.test', employer_name: 'Alef Data', invoicing_method: 'QuickBooks' });
        r = await adJar.fetch('/api/onboarding', { method: 'POST', body: JSON.stringify({ workerType: 'C2C', data: ob2 }) });
        check('a near-identical vendor on a new request is offered the existing record', r.status === 201 && r.body.vendorCheck.state === 'similar' && r.body.vendorCheck.candidates[0].id === idL, r.body.vendorCheck);
        const sId = r.body.id;
        r = await adJar.fetch('/api/onboarding/' + sId + '/add-vendor', { method: 'POST', body: JSON.stringify({ useSupplierId: idL }) });
        check('HR links the request to the existing supplier instead of creating another', r.status === 200 && r.body.supplierId === idL && (await dbConn.query(`SELECT COUNT(*) n FROM subvendors WHERE organization_id = ? AND name LIKE 'Alef Data%'`, [org]))[0][0].n === 1, r.body);
      }

      // ---- Vendors directory: Name and Client the wrong way round -> Swap
      {
        const swJar = makeJar();
        await swJar.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Swap Co', name: 'Sw Owner', email: 'sw@swap.test', password: 'swappassword123' }) });
        const [[org]] = await dbConn.query(`SELECT organization_id o FROM users WHERE email = 'sw@swap.test'`);
        const oid = org.o;
        const [c1] = await dbConn.query(`INSERT INTO clients (organization_id, name, status) VALUES (?, 'CDW Swap', 'active')`, [oid]);
        const [p1] = await dbConn.query(`INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, 'OCC Swap', 'active')`, [oid, c1.insertId]);
        const [k1] = await dbConn.query(`INSERT INTO consultants (organization_id, name, status) VALUES (?, 'Swap Person', 'active')`, [oid]);
        await dbConn.query(`INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing) VALUES (?, ?, ?, ?, 100)`, [oid, k1.insertId, c1.insertId, p1.insertId]);
        r = await swJar.fetch('/api/directory/programs/swap', { method: 'POST', body: JSON.stringify({ ids: [p1.insertId] }) });
        check('swap reports one vendor row swapped', r.status === 200 && r.body.swapped.length === 1 && !r.body.skipped.length, r.body);
        r = await swJar.fetch('/api/directory/programs');
        const sw = r.body.programs.find((x) => x.name === 'CDW Swap');
        check('Name now holds the old client and Client holds the old name', !!sw && sw.client_name === 'OCC Swap' && r.body.programs.length === 1, r.body.programs);
        const [[asg]] = await dbConn.query('SELECT program_id, client_id FROM consultant_assignments WHERE consultant_id = ?', [k1.insertId]);
        check('the placement moved with it', asg.program_id === sw.id, asg);
        r = await swJar.fetch('/api/directory/programs/swap', { method: 'POST', body: JSON.stringify({ ids: [p1.insertId] }) });
        check('swapping a stale id again changes nothing', r.status === 200 && r.body.swapped.length === 0, r.body);
      }

      // ---- Vendor record: rename "Menya/Orbit Inc/State of OH" to "Menya" and move to the right client
      {
        const rnJar = makeJar();
        await rnJar.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Rename Co', name: 'Rn Owner', email: 'rn@rename.test', password: 'renamepassword123' }) });
        const [[orw]] = await dbConn.query(`SELECT organization_id o FROM users WHERE email = 'rn@rename.test'`);
        const oid = orw.o;
        const [ca] = await dbConn.query(`INSERT INTO clients (organization_id, name, status) VALUES (?, 'Wrong Client', 'active')`, [oid]);
        const [cb] = await dbConn.query(`INSERT INTO clients (organization_id, name, status) VALUES (?, 'State of OH', 'active')`, [oid]);
        const [pr] = await dbConn.query(`INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, 'Menya/Orbit Inc/State of OH', 'active')`, [oid, ca.insertId]);
        const [cn] = await dbConn.query(`INSERT INTO consultants (organization_id, name, status) VALUES (?, 'Rn Person', 'active')`, [oid]);
        await dbConn.query(`INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing) VALUES (?, ?, ?, ?, 90)`, [oid, cn.insertId, ca.insertId, pr.insertId]);
        r = await rnJar.fetch('/api/profiles/programs/' + pr.insertId, { method: 'PATCH', body: JSON.stringify({ values: { name: 'Menya', client_id: cb.insertId } }) });
        check('vendor name and client can be edited', r.status === 200, r.body);
        const [[pp]] = await dbConn.query('SELECT name, client_id FROM programs WHERE id = ?', [pr.insertId]);
        check('the vendor is now "Menya" under State of OH', pp.name === 'Menya' && pp.client_id === cb.insertId, pp);
        const [[aa]] = await dbConn.query('SELECT client_id, program_id FROM consultant_assignments WHERE consultant_id = ?', [cn.insertId]);
        check('its placement moved to the new client', aa.client_id === cb.insertId && aa.program_id === pr.insertId, aa);
        const [[al]] = await dbConn.query('SELECT client_id, program_id FROM client_text_aliases WHERE organization_id = ?', [oid]);
        check('the old long text still resolves to it', al && al.program_id === pr.insertId && al.client_id === cb.insertId, al);
        const [pr2] = await dbConn.query(`INSERT INTO programs (organization_id, client_id, name, status) VALUES (?, ?, 'Other', 'active')`, [oid, cb.insertId]);
        r = await rnJar.fetch('/api/profiles/programs/' + pr2.insertId, { method: 'PATCH', body: JSON.stringify({ values: { name: 'menya' } }) });
        check('renaming onto an existing vendor of that client is refused clearly', r.status === 409, r.body);
      }

      // ---- secure links emailed straight to the consultant and the supplier
      {
        const emJar = makeJar();
        await emJar.fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ orgName: 'Mail Co', name: 'Em Owner', email: 'em@mailco.test', password: 'emailpassword123' }) });
        const [[mo]] = await dbConn.query(`SELECT organization_id o FROM users WHERE email = 'em@mailco.test'`);
        const mkOb = async (type, data) => (await dbConn.query(`INSERT INTO onboardings (organization_id, worker_type, status, consultant_name, data, checklist, log) VALUES (?, ?, 'in_progress', ?, ?, '{}', '[]')`,
          [mo.o, type, data.consultant_name, JSON.stringify(data)]))[0].insertId;
        const anon2 = async (pth, opts = {}) => { const res = await fetch(BASE + pth, Object.assign({}, opts, { headers: { 'Content-Type': 'application/json' } })); let body = null; try { body = await res.json(); } catch (e) { /* none */ } return { status: res.status, body }; };
        r = await emJar.fetch('/api/onboarding/schema');
        check('the app knows email sending is set up', r.body.emailConfigured === true, r.body.emailConfigured);
        r = await emJar.fetch('/api/onboarding/email-test', { method: 'POST', body: '{}' });
        check('a test email is delivered to the signed-in user', r.status === 200 && mailbox.some((m) => m.to.includes('em@mailco.test') && /test/i.test(m.subject)), r.body);
        const cId = await mkOb('1099', { consultant_name: 'Cora Contractor', email: 'cora@contractor.test', h1b_filing_required: 'No' });
        r = await emJar.fetch('/api/onboarding/' + cId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ party: 'consultant', items: ['c_details', 'c_w9', 'c_i9', 'c_nda', 'w9', 'coi'], days: 7 }) });
        check('HR invites the consultant (supplier-only items ignored)', r.status === 201 && r.body.party === 'consultant' && r.body.request.items.map((i) => i.key).join() === 'c_details,c_w9,c_i9,c_nda', r.body);
        check('the link was emailed to the consultant', r.body.email.sent === true && r.body.email.to === 'cora@contractor.test', r.body.email);
        const em1 = mailbox.find((m) => m.to.includes('cora@contractor.test'));
        const ctok = em1 && (/vendor\.html\?t=([a-f0-9]{64})/.exec(em1.text) || [])[1];
        check('the email carries the private link and the list', !!ctok && /Personal details/.test(em1.text) && /Form I-9/.test(em1.text), em1 && em1.text);
        check('it shows the HR user as sender, replies go to them, and they get a copy', /Em Owner/.test(em1.from) && /onboarding@mentour\.test/.test(em1.from) && /em@mailco\.test/.test(em1.replyTo) && /em@mailco\.test/.test(em1.rcpt), em1);
        const CP = '/api/vendor-portal/' + ctok;
        r = await anon2(CP);
        check('the consultant opens the link and sees their own page', r.status === 200 && r.body.party === 'consultant' && r.body.company === 'Cora Contractor', r.body);
        r = await anon2(CP + '/company');
        check('the supplier company page is not available on a consultant link', r.status === 404, r.status);
        r = await anon2(CP + '/details', { method: 'PUT', body: JSON.stringify({ values: { email: 'cora@contractor.test', phone: '555-0101', street: '1 Main St', city: 'Columbus', state: 'OH', postal_code: '43004' } }) });
        check('the consultant saves their details', r.status === 200, r.body);
        const [[cc]] = await dbConn.query(`SELECT c.email, c.address FROM consultants c JOIN onboardings o ON o.consultant_id = c.id WHERE o.id = ?`, [cId]);
        check('they are on the consultant record', cc.email === 'cora@contractor.test' && /1 Main St/.test(cc.address), cc);
        r = await anon2(CP + '/forms/i9');
        check('the consultant can open their I-9', r.status === 200 && r.body.spec.sections.some((x) => x.signKey === 'employee'), r.status);
        r = await anon2(CP + '/forms/i9', { method: 'PUT', body: JSON.stringify({ values: { employer_title: 'Boss' } }) });
        check('they cannot fill the employer part of the I-9', r.status === 403, r.body);
        r = await anon2(CP + '/forms/i9/sign', { method: 'POST', body: JSON.stringify({ signature: 'employer', typedName: 'Cora Contractor', consent: true }) });
        check('they cannot sign as the employer', r.status === 403, r.body);
        r = await anon2(CP + '/forms/banking');
        check('forms that were not requested stay closed', r.status === 404, r.status);
        r = await anon2(CP + '/submit', { method: 'POST', body: '{}' });
        check('they cannot finish while items remain', r.status === 409, r.body);
        r = await emJar.fetch('/api/onboarding/' + cId + '/vendor-requests');
        check('HR sees the details item received', r.body.requests[0].items.find((i) => i.key === 'c_details').done === true && r.body.requests[0].items.find((i) => i.key === 'c_w9').done === false, r.body.requests[0].items);
        const tId = await mkOb('1099', { consultant_name: 'Tim NoEmail' });
        r = await emJar.fetch('/api/onboarding/' + tId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ party: 'consultant', items: ['c_details'] }) });
        check('without an email address the link is created and shown for copying', r.status === 201 && r.body.email.attempted === false && /^\/vendor\.html\?t=/.test(r.body.path), r.body.email);
        r = await emJar.fetch('/api/onboarding/' + tId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ party: 'consultant', items: ['c_details'], email: 'tim@x.test' }) });
        check('typing an email on the form sends it there', r.status === 201 && r.body.email.sent === true && mailbox.some((m) => m.to.includes('tim@x.test')), r.body.email);
        const sId = await mkOb('C2C', { consultant_name: 'Sue Supplier', employer_name: 'Suetech LLC', employer_email: 'ap@suetech.test', employer_contact: 'Pat AP' });
        r = await emJar.fetch('/api/onboarding/' + sId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ items: ['w9', 'coi'] }) });
        check('the supplier link is emailed to the supplier', r.status === 201 && r.body.email.sent === true && mailbox.some((m) => m.to.includes('ap@suetech.test') && /Hello Pat AP/.test(m.text)), r.body.email);
        r = await emJar.fetch('/api/onboarding/' + sId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ party: 'consultant', items: ['c_nda'], email: 'sue@suetech.test' }) });
        check('a C2C consultant can also get their own link (details and NDA only)', r.status === 201 && r.body.request.items.length === 1, r.body);
        r = await emJar.fetch('/api/onboarding/' + sId + '/vendor-requests', { method: 'POST', body: JSON.stringify({ party: 'consultant', items: ['c_w9'] }) });
        check('1099-only items are refused for a C2C consultant', r.status === 400, r.body);
        r = await emJar.fetch('/api/onboarding/invites', { method: 'POST', body: JSON.stringify({ email: 'newhire@mailco.test', name: 'New Hire', role: 'recruiter' }) });
        check('a personal invite is emailed too', r.status === 201 && r.body.emailSent === true && mailbox.some((m) => m.to.includes('newhire@mailco.test') && /signup\.html/.test(m.text)), r.body);
      }
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
    try { smtp.close(); } catch (e) { /* ignore */ }
    await sleep(300);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main();
