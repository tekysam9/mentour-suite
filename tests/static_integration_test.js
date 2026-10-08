require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; console.log('FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe' });
  let out = '';
  server.stdout.on('data', (d) => out += d.toString());
  server.stderr.on('data', (d) => out += d.toString());

  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { const r = await fetch(BASE + '/login.html'); if (r.status === 200) { ready = true; break; } } catch (e) {}
  }
  if (!ready) { console.log('Server never came up:\n' + out); server.kill(); process.exit(1); }

  try {
    const pages = ['/login.html', '/signup.html', '/index.html', '/ledger.html', '/margin.html', '/directory.html', '/invoices.html', '/shared.css'];
    for (const p of pages) {
      const r = await fetch(BASE + p);
      check('GET ' + p + ' -> 200', r.status === 200, r.status);
    }

    // Import hours: month + year for each "Hours/<month>" column (public/import-hours.js).
    const ihRes = await fetch(BASE + '/import-hours.js');
    check('GET /import-hours.js -> 200', ihRes.status === 200, ihRes.status);
    const invHtml = await (await fetch(BASE + '/invoices.html')).text();
    check('invoices.html loads /import-hours.js', invHtml.includes('<script src="/import-hours.js"></script>'));
    const IH = require('../public/import-hours.js');
    const resolve = (heads, y) => IH.resolveHourColumns(heads.map(IH.parseHoursHeader), y).map((c) => c.label).join(', ');
    const w2 = ['Hours/Dec', 'Hours/Jan', 'Hours/Feb', 'Hours/Mar', 'Hours/Apr', 'Hours/May', 'Hours/Jun', 'Hours/Jul', 'Hours/Aug', 'Hours/Sep'];
    check('column-order rollover: Dec, Jan..Sep with Year 2026 -> Dec 2025, Jan 2026..Sep 2026',
      resolve(w2, 2026) === 'Dec 2025, Jan 2026, Feb 2026, Mar 2026, Apr 2026, May 2026, Jun 2026, Jul 2026, Aug 2026, Sep 2026', resolve(w2, 2026));
    check('no rollover: Jan..Mar all use the Year box', resolve(['Hours/Jan', 'Hours/Feb', 'Hours/Mar'], 2025) === 'Jan 2025, Feb 2025, Mar 2025');
    check('two rollovers: Nov, Dec, Jan, Jun, Jan with Year 2026 -> last run is 2026',
      resolve(['Hours/Nov', 'Hours/Dec', 'Hours/Jan', 'Hours/Jun', 'Hours/Jan'], 2026) === 'Nov 2024, Dec 2024, Jan 2025, Jun 2025, Jan 2026');
    check('explicit years in headings: Hours/Dec 2025, Hours/Dec-25, Hours/Dec\'25, Hours/Dec’25',
      ['Hours/Dec 2025', 'Hours/Dec-25', "Hours/Dec'25", 'Hours/Dec’25'].every((h) => { const p = IH.parseHoursHeader(h); return p && p.month === 12 && p.year === 2025; }));
    check('explicit year anchors the columns without one: Hours/Dec 2025, Hours/Jan (Year box 2030) -> Dec 2025, Jan 2026',
      resolve(['Hours/Dec 2025', 'Hours/Jan'], 2030) === 'Dec 2025, Jan 2026');
    check('header words: Hours/December, Hours/Sept ok; Hours/Marching and Hours/Total rejected',
      IH.parseHoursHeader('Hours/December').month === 12 && IH.parseHoursHeader('Hours/Sept').month === 9 &&
      IH.parseHoursHeader('Hours/Marching') === null && IH.parseHoursHeader('Hours/Total') === null);
    check('arrears mapping: Dec 2025 hours -> Jan 2026 invoice; Jan 2026 invoice is for Dec 2025 hours; Sep -> Oct',
      IH.invoiceMonthKey('2025-12') === '2026-01' && IH.hoursMonthKey('2026-01') === '2025-12' && IH.invoiceMonthKey('2026-09') === '2026-10' &&
      IH.resolveHourColumns(w2.map(IH.parseHoursHeader), 2026).map((c) => c.invoiceLabel).join(', ') === 'Jan 2026, Feb 2026, Mar 2026, Apr 2026, May 2026, Jun 2026, Jul 2026, Aug 2026, Sep 2026, Oct 2026');
    check('invoices.html table has Invoice month + Hours for columns and a month picker',
      invHtml.includes('<th>Invoice month</th>') && invHtml.includes('>Hours for</th>') && invHtml.includes('id="filter-period"') && invHtml.includes('/api/invoices/months'));
    check('lone Hours/Dec, Year 2026 -> Dec 2026 (not guessed back to 2025); in the future during Oct 2026',
      resolve(['Hours/Dec'], 2026) === 'Dec 2026' && IH.isFutureKey('2026-12', '2026-10') && !IH.isFutureKey('2026-10', '2026-10') && !IH.isFutureKey('2025-12', '2026-10'));

    // "/" should serve index.html (express.static default)
    const rootRes = await fetch(BASE + '/');
    check('GET / -> 200 (serves index.html)', rootRes.status === 200);

    // unknown page -> 404
    const missing = await fetch(BASE + '/does-not-exist.html');
    check('GET /does-not-exist.html -> 404', missing.status === 404);

    // API routes still work alongside static serving
    const meRes = await fetch(BASE + '/api/auth/me');
    check('GET /api/auth/me (no session) -> 401', meRes.status === 401);

    console.log('\n' + '='.repeat(50));
    console.log(`RESULTS: ${pass} passed, ${fail} failed`);
    console.log('='.repeat(50));
  } catch (err) {
    console.error('ERROR:', err);
    fail++;
  } finally {
    server.kill();
    await sleep(300);
  }
  process.exit(fail > 0 ? 1 : 0);
}
main();
