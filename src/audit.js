// Activity log. Best effort and never in the way: a logging problem must not stop a payment from being saved.
// Records who did what and when. Request bodies are NOT stored, only a short whitelist of non-secret fields
// (amounts, dates, status) so a change can be understood. Passwords, tokens and personal IDs are never kept.
const pool = require('./db');

const FIELD_WHITELIST = ['amount', 'rate', 'hours', 'paidDate', 'paid_date', 'paymentStatus', 'payment_status', 'periodMonth', 'period_month',
  'status', 'endDate', 'left_date', 'netTerms', 'net_terms', 'invoiceNumber', 'invoice_number', 'name', 'role', 'fileName', 'kind'];

function clip(v, n) { return String(v).length > n ? String(v).slice(0, n) + '…' : String(v); }

async function record(e) {
  try {
    await pool.query(
      'INSERT INTO audit_log (organization_id, user_id, user_name, user_email, event, method, path, status, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [e.organizationId || null, e.userId || null, e.userName ? clip(e.userName, 250) : null, e.userEmail ? clip(e.userEmail, 250) : null, e.event, e.method || null,
        e.path ? clip(e.path, 250) : null, e.status || null, e.detail ? JSON.stringify(e.detail).slice(0, 4000) : null, e.ip ? clip(e.ip, 60) : null]);
  } catch (err) {
    if (err && err.code !== 'ER_NO_SUCH_TABLE') console.error('audit log write failed:', err.message);
  }
}

function fromReq(req, event, extra) {
  const u = req.user || {};
  return Object.assign({ organizationId: u.organization_id, userId: u.id, userName: u.name, userEmail: u.email, event, ip: req.ip }, extra || {});
}

// Every successful change (POST/PUT/PATCH/DELETE) by a signed-in person is recorded, after the response is sent.
function auditWrites(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400 || !req.user) return;
      const p = (req.originalUrl || '').split('?')[0];
      if (/^\/api\/auth\//.test(p)) return; // sign-in events are logged by the auth routes
      // previews (body.apply === false) change nothing, except on a route that is itself called /apply: never skip those
      if (req.body && req.body.apply === false && !/\/apply$/.test(p)) return;
      if (/\/preview$/.test(p)) return;
      const detail = {};
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
      if (b) {
        const fields = {};
        for (const k of FIELD_WHITELIST) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'object') fields[k] = clip(b[k], 120);
        if (Object.keys(fields).length) detail.fields = fields;
        detail.keys = Object.keys(b).filter((k) => !/pass|token|secret|ssn|tax|account|routing|code/i.test(k)).slice(0, 25);
      }
      if (res.locals && res.locals.auditNote) detail.note = String(res.locals.auditNote).slice(0, 500);
      record(fromReq(req, 'change', { method: req.method, path: p, status: res.statusCode, detail }));
    } catch (e) { /* never let logging break a request */ }
  });
  next();
}

module.exports = { record, fromReq, auditWrites };
