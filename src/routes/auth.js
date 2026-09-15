const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const {
  hashPassword,
  comparePassword,
  generateInviteCode,
  requireAuth,
  validateSignupInput,
} = require('../auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    organization: { id: row.organization_id, name: row.organization_name, inviteCode: row.invite_code },
  };
}

// Create a brand-new organization + its first (owner) user.
router.post('/signup', authLimiter, async (req, res, next) => {
  const { orgName, name, email, password } = req.body || {};
  const validationError = validateSignupInput({ email, password, name });
  if (validationError) return res.status(400).json({ error: validationError });
  if (!orgName || !String(orgName).trim()) return res.status(400).json({ error: 'Enter a company name.' });

  const conn = await pool.getConnection();
  try {
    const [existing] = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [String(email).toLowerCase()]);
    if (existing.length) return res.status(409).json({ error: 'An account with that email already exists.' });

    await conn.beginTransaction();
    const inviteCode = generateInviteCode();
    const [orgResult] = await conn.query('INSERT INTO organizations (name, invite_code) VALUES (?, ?)', [String(orgName).trim(), inviteCode]);
    const organizationId = orgResult.insertId;

    const passwordHash = await hashPassword(password);
    const [userResult] = await conn.query(
      'INSERT INTO users (organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)',
      [organizationId, String(email).toLowerCase(), passwordHash, String(name).trim(), 'owner']
    );
    await conn.commit();

    req.session.userId = userResult.insertId;
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS organization_name, o.invite_code
       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?`,
      [userResult.insertId]
    );
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Join an existing organization using its invite code.
router.post('/join', authLimiter, async (req, res, next) => {
  const { inviteCode, name, email, password } = req.body || {};
  const validationError = validateSignupInput({ email, password, name });
  if (validationError) return res.status(400).json({ error: validationError });
  if (!inviteCode || !String(inviteCode).trim()) return res.status(400).json({ error: 'Enter the invite code.' });

  try {
    const [orgs] = await pool.query('SELECT id FROM organizations WHERE invite_code = ? LIMIT 1', [String(inviteCode).trim()]);
    if (!orgs.length) return res.status(404).json({ error: 'That invite code was not found.' });

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [String(email).toLowerCase()]);
    if (existing.length) return res.status(409).json({ error: 'An account with that email already exists.' });

    const passwordHash = await hashPassword(password);
    const [userResult] = await pool.query(
      'INSERT INTO users (organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)',
      [orgs[0].id, String(email).toLowerCase(), passwordHash, String(name).trim(), 'member']
    );

    req.session.userId = userResult.insertId;
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS organization_name, o.invite_code
       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?`,
      [userResult.insertId]
    );
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.organization_id, o.name AS organization_name, o.invite_code
       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.email = ? LIMIT 1`,
      [String(email).toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Incorrect email or password.' });

    const match = await comparePassword(password, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password.' });

    req.session.userId = rows[0].id;
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mentour_sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      organization: { id: req.user.organization_id, name: req.user.organization_name, inviteCode: req.user.invite_code },
    },
  });
});

module.exports = router;
