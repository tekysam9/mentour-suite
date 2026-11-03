const express = require('express');
const rateLimit = require('express-rate-limit');
const audit = require('../audit');
const totp = require('../totp');
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
  limit: Number(process.env.AUTH_RATE_LIMIT) || 20, // tests raise this; production keeps 20 attempts / 15 min
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
// A fresh session id at every sign-in, so an id set before login can never be reused afterwards (session fixation).
function startSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

router.post('/signup', authLimiter, async (req, res, next) => {
  // Set ALLOW_SIGNUP=false in the hosting environment once the owner account exists: nobody can then create a new company
  // from the sign-up form (people can still join with the invite code).
  if (String(process.env.ALLOW_SIGNUP || '').toLowerCase() === 'false') return res.status(403).json({ error: 'Creating a new company is turned off. Ask the account owner for an invite code to join.' });
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

    await startSession(req, userResult.insertId);
    audit.record({ event: 'signup', userId: userResult.insertId, userEmail: String(email).toLowerCase().slice(0, 200), userName: String(name).slice(0, 200), ip: req.ip, detail: { createdCompany: String(orgName).slice(0, 120) } });
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
    // A role-specific code (created by the owner) wins; the original organization code still gives a Team member.
    let joinRole = 'member';
    let orgs = [];
    let personal = null;
    const lower = String(email).toLowerCase();
    try {
      const [ic] = await pool.query('SELECT id, organization_id AS org, role, email, used_at FROM invite_codes WHERE code = ? AND revoked = 0 LIMIT 1', [String(inviteCode).trim()]);
      if (ic.length) {
        if (ic[0].email) {
          if (ic[0].used_at) return res.status(410).json({ error: 'That invite has already been used. Ask for a new one.' });
          if (ic[0].email.toLowerCase() !== lower) return res.status(403).json({ error: 'This invite was sent to a different email address. Sign up with the address it was sent to.' });
          personal = ic[0];
        }
        orgs = [{ id: ic[0].org }]; joinRole = ic[0].role;
      }
    } catch (e) {
      if (e && e.code === 'ER_BAD_FIELD_ERROR') { // schema not re-run yet: role codes still work
        const [ic] = await pool.query('SELECT organization_id AS id, role FROM invite_codes WHERE code = ? AND revoked = 0 LIMIT 1', [String(inviteCode).trim()]);
        if (ic.length) { orgs = [{ id: ic[0].id }]; joinRole = ic[0].role; }
      } else if (!(e && e.code === 'ER_NO_SUCH_TABLE')) throw e;
    }
    if (!orgs.length) [orgs] = await pool.query('SELECT id FROM organizations WHERE invite_code = ? LIMIT 1', [String(inviteCode).trim()]);
    if (!orgs.length) return res.status(404).json({ error: 'That invite code was not found.' });

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [lower]);
    if (existing.length) return res.status(409).json({ error: 'An account with that email already exists.' });

    const passwordHash = await hashPassword(password);
    let userResult;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (personal) { // claim the invite first, so two sign-ups racing on one code cannot both win
        const [u] = await conn.query('UPDATE invite_codes SET used_at = NOW() WHERE id = ? AND used_at IS NULL AND revoked = 0', [personal.id]);
        if (!u.affectedRows) { await conn.rollback(); return res.status(410).json({ error: 'That invite has already been used. Ask for a new one.' }); }
      }
      [userResult] = await conn.query(
        'INSERT INTO users (organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)',
        [orgs[0].id, lower, passwordHash, String(name).trim(), joinRole]
      );
      if (personal) await conn.query('UPDATE invite_codes SET used_by_user_id = ? WHERE id = ?', [userResult.insertId, personal.id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    await startSession(req, userResult.insertId);
    audit.record({ event: 'join', userId: userResult.insertId, userEmail: String(email).toLowerCase().slice(0, 200), userName: String(name).slice(0, 200), ip: req.ip });
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
      `SELECT u.*, o.name AS organization_name, o.invite_code
       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.email = ? LIMIT 1`,
      [String(email).toLowerCase()]
    );
    if (!rows.length) { audit.record({ event: 'login_failed', ip: req.ip, userEmail: String(email).slice(0, 200), detail: { why: 'no such account' } }); return res.status(401).json({ error: 'Incorrect email or password.' }); }

    const match = await comparePassword(password, rows[0].password_hash);
    if (!match) { audit.record({ event: 'login_failed', organizationId: rows[0].organization_id, userId: rows[0].id, userName: rows[0].name, userEmail: rows[0].email, ip: req.ip, detail: { why: 'wrong password' } }); return res.status(401).json({ error: 'Incorrect email or password.' }); }

    if (rows[0].totp_enabled) {
      // Password was right but this person uses an authenticator app: no sign-in yet, only a short-lived "second step pending" mark.
      await new Promise((ok, bad) => req.session.regenerate((e) => (e ? bad(e) : ok())));
      req.session.pending2fa = { userId: rows[0].id, at: Date.now(), tries: 0 };
      await new Promise((ok, bad) => req.session.save((e) => (e ? bad(e) : ok())));
      return res.json({ needsTwoFactor: true });
    }
    await startSession(req, rows[0].id);
    audit.record({ event: 'login', organizationId: rows[0].organization_id, userId: rows[0].id, userName: rows[0].name, userEmail: rows[0].email, ip: req.ip });
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

async function twoFactorRow(userId) {
  try { const [r] = await pool.query('SELECT totp_enabled, totp_secret, totp_recovery, totp_last_step FROM users WHERE id = ? LIMIT 1', [userId]); return r[0] || null; }
  catch (e) { if (e && e.code === 'ER_BAD_FIELD_ERROR') return null; throw e; }
}
const NO_COLUMNS = 'Two-step sign-in is not set up on the database yet. Run db/schema.sql once, then try again.';
function schemaOk(row, res) { if (row === null) { res.status(503).json({ error: NO_COLUMNS }); return false; } return true; }

// Second step of sign-in: the 6-digit code from the authenticator app, or one of the saved recovery codes.
router.post('/2fa/verify', authLimiter, async (req, res, next) => {
  try {
    const pend = req.session && req.session.pending2fa;
    if (!pend || Date.now() - pend.at > 5 * 60 * 1000) return res.status(401).json({ error: 'That sign-in expired. Enter your email and password again.', expired: true });
    const row = await twoFactorRow(pend.userId);
    if (!row || !row.totp_enabled) return res.status(401).json({ error: 'Sign in again.', expired: true });
    const [[u]] = await pool.query('SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS organization_name, o.invite_code FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?', [pend.userId]);
    const code = String((req.body && req.body.code) || '').trim();
    let ok = false; let recovery = false;
    if (/^\d{6}$/.test(code.replace(/\s+/g, ''))) {
      let secret = null; try { secret = totp.open(row.totp_secret); } catch (e) { secret = null; }
      const step = secret ? totp.verify(secret, code, row.totp_last_step) : null;
      if (step !== null) { ok = true; await pool.query('UPDATE users SET totp_last_step = ? WHERE id = ?', [step, u.id]); }
    } else if (code) {
      let list = []; try { list = JSON.parse(row.totp_recovery || '[]'); } catch (e) { list = []; }
      const h = totp.hashCode(code); const i = list.indexOf(h);
      if (i !== -1) { ok = true; recovery = true; list.splice(i, 1); await pool.query('UPDATE users SET totp_recovery = ? WHERE id = ?', [JSON.stringify(list), u.id]); }
    }
    if (!ok) {
      pend.tries += 1;
      audit.record({ event: '2fa_failed', organizationId: u.organization_id, userId: u.id, userName: u.name, userEmail: u.email, ip: req.ip });
      if (pend.tries >= 5) { delete req.session.pending2fa; return res.status(401).json({ error: 'Too many wrong codes. Enter your email and password again.', expired: true }); }
      return res.status(401).json({ error: 'That code is not right. Check the code in your authenticator app and try again.' });
    }
    await startSession(req, u.id);
    audit.record({ event: recovery ? '2fa_recovery_used' : 'login', organizationId: u.organization_id, userId: u.id, userName: u.name, userEmail: u.email, ip: req.ip });
    res.json({ user: publicUser(u), recoveryUsed: recovery });
  } catch (err) { next(err); }
});

router.get('/2fa/status', requireAuth, async (req, res, next) => {
  try {
    const row = await twoFactorRow(req.user.id);
    let remaining = 0; try { remaining = row && row.totp_recovery ? JSON.parse(row.totp_recovery).length : 0; } catch (e) { remaining = 0; }
    res.json({ available: row !== null, enabled: !!(row && row.totp_enabled), recoveryCodesLeft: remaining });
  } catch (err) { next(err); }
});

// Step 1 of turning it on: make a secret and show it (as text and a QR code). Nothing is switched on until a code from the app is confirmed.
router.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const row = await twoFactorRow(req.user.id);
    if (!schemaOk(row, res)) return;
    if (row.totp_enabled) return res.status(409).json({ error: 'Two-step sign-in is already on. Turn it off first to set it up again.' });
    const secret = totp.newSecret();
    req.session.totpSetup = { secret, at: Date.now() };
    res.json({ secret, otpauth: totp.otpauthUri(secret, req.user.email, 'Mentour Suite') });
  } catch (err) { next(err); }
});

// Step 2: the person types the code the app now shows. Right code = switched on, and 8 one-time recovery codes are shown once.
router.post('/2fa/enable', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const row = await twoFactorRow(req.user.id);
    if (!schemaOk(row, res)) return;
    const setup = req.session.totpSetup;
    if (!setup || Date.now() - setup.at > 15 * 60 * 1000) return res.status(400).json({ error: 'Start again: the setup took too long.', expired: true });
    const step = totp.verify(setup.secret, (req.body || {}).code, null);
    if (step === null) return res.status(400).json({ error: 'That code is not right. Wait for a new code in the app and try again.' });
    const codes = totp.newRecoveryCodes(8);
    await pool.query('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_recovery = ?, totp_last_step = ? WHERE id = ?', [totp.seal(setup.secret), JSON.stringify(codes.map(totp.hashCode)), step, req.user.id]);
    delete req.session.totpSetup;
    audit.record(audit.fromReq(req, '2fa_enabled'));
    res.json({ enabled: true, recoveryCodes: codes });
  } catch (err) {
    if (err && err.code === 'NO_KEY') return res.status(503).json({ error: 'The server needs FIELD_ENCRYPTION_KEY set before it can store this securely.' });
    next(err);
  }
});

// Turning it off needs the password AND a current code (or recovery code), so a borrowed signed-in screen can't remove it.
router.post('/2fa/disable', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const row = await twoFactorRow(req.user.id);
    if (!schemaOk(row, res)) return;
    if (!row.totp_enabled) return res.json({ enabled: false });
    const { password, code } = req.body || {};
    const [[pw]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!password || !(await comparePassword(String(password), pw.password_hash))) return res.status(400).json({ error: 'Your password is not right.' });
    let ok = false; const c = String(code || '').trim();
    if (/^\d{6}$/.test(c)) { let secret = null; try { secret = totp.open(row.totp_secret); } catch (e) { secret = null; } ok = !!(secret && totp.verify(secret, c, row.totp_last_step) !== null); }
    else if (c) { let list = []; try { list = JSON.parse(row.totp_recovery || '[]'); } catch (e) { list = []; } ok = list.indexOf(totp.hashCode(c)) !== -1; }
    if (!ok) return res.status(400).json({ error: 'That code is not right.' });
    await pool.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE id = ?', [req.user.id]);
    audit.record(audit.fromReq(req, '2fa_disabled'));
    res.json({ enabled: false });
  } catch (err) { next(err); }
});

// Owner only: a teammate lost their phone and recovery codes. Switches their two-step off so they can sign in and set it up again.
router.post('/2fa/reset', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can reset someone\u2019s two-step sign-in.' });
    const id = Number((req.body || {}).userId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Choose a person.' });
    if (id === req.user.id) return res.status(400).json({ error: 'Use "turn off" on the Security page for your own login.' });
    const row = await twoFactorRow(id); if (!schemaOk(row, res)) return;
    const [r] = await pool.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE id = ? AND organization_id = ?', [id, req.user.organization_id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'That person was not found.' });
    audit.record(audit.fromReq(req, '2fa_reset', { detail: { forUserId: id } }));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  let twoFactor = false;
  try { const row = await twoFactorRow(req.user.id); twoFactor = !!(row && row.totp_enabled); } catch (e) { /* ignore */ }
  res.json({
    twoFactor,
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
