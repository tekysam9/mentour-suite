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
    const pages = ['/login.html', '/signup.html', '/index.html', '/ledger.html', '/margin.html', '/shared.css'];
    for (const p of pages) {
      const r = await fetch(BASE + p);
      check('GET ' + p + ' -> 200', r.status === 200, r.status);
    }

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
