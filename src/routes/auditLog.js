// Read-only view of the activity log, for the account owner and HR admins only.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { isHrUser } = require('../placementRules');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => isHrUser(req.user) ? next() : res.status(403).json({ error: 'Only the account owner or an HR admin can open the activity log.' }));

// ?limit=100 (max 500), ?before=<id> to page back, ?event=change|login|login_failed|..., ?q=text (name, email, path)
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const where = ['organization_id = ?']; const params = [req.user.organization_id];
    if (/^\d+$/.test(String(req.query.before || ''))) { where.push('id < ?'); params.push(Number(req.query.before)); }
    if (req.query.event && /^[a-z_0-9]{1,40}$/.test(String(req.query.event))) { where.push('event = ?'); params.push(String(req.query.event)); }
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) { where.push('(user_name LIKE ? OR user_email LIKE ? OR path LIKE ? OR detail LIKE ?)'); const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%'; params.push(like, like, like, like); }
    const [rows] = await pool.query('SELECT id, user_id, user_name, user_email, event, method, path, status, detail, ip, created_at FROM audit_log WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ' + (limit + 1), params);
    const more = rows.length > limit; if (more) rows.pop();
    res.json({ entries: rows.map((r) => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch (e) { d = null; } return Object.assign({}, r, { detail: d }); }), next: more ? rows[rows.length - 1].id : null });
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return res.json({ entries: [], next: null, schemaMissing: true });
    next(err);
  }
});

module.exports = router;
