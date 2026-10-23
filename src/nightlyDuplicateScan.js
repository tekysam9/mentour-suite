// Nightly duplicate check, run inside the app (no cron or extra service).
// Every night it looks through the whole Directory of every organization for
// names that look like the same thing and flags new pairs, so they appear
// in the Directory's "possible duplicates" review. It only flags: nothing
// is merged or changed, and pairs a person already dismissed stay dismissed.
//
// Env: DUP_SCAN_ENABLED=false to turn off; DUP_SCAN_HOUR=0-23 (server local
// time, default 2); DUP_SCAN_ON_START=true to also run once at startup.

const pool = require('./db');
const { scanDuplicates, TABLES } = require('./routes/directoryDedup');

const state = { lastRunAt: null, lastOpened: null, lastError: null, running: false };

async function runOnce() {
  if (state.running) return state;
  state.running = true;
  try {
    const [orgs] = await pool.query('SELECT id FROM organizations');
    let opened = 0;
    for (const o of orgs) {
      for (const t of TABLES) {
        try { opened += await scanDuplicates(pool, o.id, t); }
        catch (err) { console.error(`[duplicate scan] org ${o.id} ${t}:`, err.message); state.lastError = err.message; }
      }
    }
    state.lastRunAt = new Date().toISOString();
    state.lastOpened = opened;
    console.log(`[duplicate scan] ${orgs.length} organization(s) checked, ${opened} new possible duplicate(s) flagged.`);
  } catch (err) {
    state.lastError = err.message;
    console.error('[duplicate scan] failed:', err.message);
  } finally {
    state.running = false;
  }
  return state;
}

function msUntilNext(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function start() {
  if (String(process.env.DUP_SCAN_ENABLED || 'true').toLowerCase() === 'false') return;
  const h = parseInt(process.env.DUP_SCAN_HOUR, 10);
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 2;
  const schedule = () => {
    // setTimeout caps near 24.8 days; a day is always safe.
    const t = setTimeout(async () => { await runOnce(); schedule(); }, msUntilNext(hour));
    if (t.unref) t.unref();
  };
  schedule();
  if (String(process.env.DUP_SCAN_ON_START || '').toLowerCase() === 'true') setTimeout(runOnce, 15000).unref();
  console.log(`Nightly duplicate scan scheduled for ${String(hour).padStart(2, '0')}:00 server time.`);
}

module.exports = { start, runOnce, msUntilNext, state };
