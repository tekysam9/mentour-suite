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

    // Multi-sheet workbook (Sam's W2 Payroll layout: one sheet per month, "Hours/December 2025").
    const fx = require('./fixtures/w2-payroll-synthetic.json');
    const mp = IH.parseHoursSheets(fx.sheets);
    const mr = IH.resolveHoursImport(mp, 2026, '2026-10');
    check('multi-sheet: every sheet with an hours table is read; a sheet without one is listed as skipped',
      mp.sheets.length === 4 && mp.skippedSheets.join() === 'Notes', { sheets: mp.sheets.map((x) => x.name), skipped: mp.skippedSheets });
    check('multi-sheet columns: Dec 2025 -> Jan 2026, Jan 2026 -> Feb 2026, Feb 2026 -> Mar 2026, Mar 2026 (year from sheet name) -> Apr 2026',
      mr.columns.map((c) => c.sheet + ':' + c.label + '>' + c.invoiceLabel + ':' + c.source).join('|') ===
        'December 2025:Dec 2025>Jan 2026:heading|January 2026:Jan 2026>Feb 2026:heading|February 2026:Feb 2026>Mar 2026:heading|March 2026:Mar 2026>Apr 2026:sheet' && mr.allYearsKnown,
      mr.columns);
    check('Hours/December 2025 keeps its year (full month name + space + 4-digit year)',
      JSON.stringify(IH.parseHoursHeader('Hours/December 2025')) === '{"month":12,"year":2025}');
    const asha = mr.rows.find((r) => r.name === 'Asha Test');
    check('rows combined per consultant + client across sheets, keyed by hours month (trailing spaces / "ROSE/ X" vs "ROSE/X" merged)',
      mr.rows.length === 3 && JSON.stringify(asha.hours) === '{"2025-12":168,"2026-01":160,"2026-02":160,"2026-03":176}' &&
      Object.keys(mr.rows.find((r) => r.name === 'Dev Sample').hours).length === 4, mr.rows);
    check('pay batch tables below the hours table are not read as hours; no Dec 2026 anywhere',
      !mr.rows.some((r) => Object.values(r.hours).some((h) => h > 400)) && !JSON.stringify(mr).includes('2026-12') && mr.skipped.length === 0, mr);
    check('row sources name the sheet and Excel row', /^December 2025 row 2, January 2026 row 2/.test(mr.rowSources[0]), mr.rowSources);
    // The same hours month twice for one consultant + client (two sheets) is skipped and listed, not guessed.
    const dupSheets = fx.sheets.slice(0, 2).concat([{ name: 'Dec 2025 corrected', grid: [['Name', 'Hours/Dec 2025', 'Client'], ['Asha Test', 170, 'HCL/Acme Health'], ['Other Person', 10, 'X']] }]);
    const dr = IH.resolveHoursImport(IH.parseHoursSheets(dupSheets), 2026, '2026-10');
    const dAsha = dr.rows.find((r) => r.name === 'Asha Test');
    check('same month on two sheets for one consultant/client: skipped and listed; other months and people kept',
      !('2025-12' in dAsha.hours) && dAsha.hours['2026-01'] === 160 && dr.rows.find((r) => r.name === 'Other Person').hours['2025-12'] === 10 &&
      dr.skipped.length === 1 && dr.skipped[0].hoursMonth === '2025-12' && dr.skipped[0].invoiceMonth === '2026-01' && /more than once/.test(dr.skipped[0].reason), dr);
    // No year in heading or sheet name -> column order + Hours year (within the sheet); future months held back.
    const ordr = IH.resolveHoursImport(IH.parseHoursSheets([{ name: 'Sheet1', grid: [['Name', 'Client', 'Hours/Dec', 'Hours/Jan', 'Hours/Nov'], ['A B', 'C', 1, 2, 3]] }]), 2026, '2026-10');
    check('no year anywhere: Dec, Jan, Nov with Hours year 2026 -> Dec 2025, Jan 2026, Nov 2026 (future: held back, listed)',
      ordr.columns.map((c) => c.label + ':' + c.source + (c.future ? ':future' : '')).join('|') === 'Dec 2025:order|Jan 2026:order|Nov 2026:order:future' &&
      !ordr.allYearsKnown && JSON.stringify(ordr.rows[0].hours) === '{"2025-12":1,"2026-01":2}' &&
      ordr.skipped.length === 1 && ordr.skipped[0].reason === 'month is in the future' && ordr.skipped[0].hoursMonth === '2026-11', ordr);
    check('sheet names: "December 2025", "Dec-25" parse; "Sheet1", "Notes" do not',
      JSON.stringify(IH.parseSheetName('December 2025')) === '{"month":12,"year":2025}' && IH.parseSheetName('Dec-25').year === 2025 &&
      IH.parseSheetName('Sheet1') === null && IH.parseSheetName('Notes') === null);
    check('invoices.html reads every sheet via ImportHours.parseHoursSheets', invHtml.includes('ImportHours.parseHoursSheets(wb.SheetNames.map('));

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
