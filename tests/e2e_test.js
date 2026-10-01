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
