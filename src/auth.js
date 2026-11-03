const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const pool = require('./db');

const sessionStore = new MySQLStore({}, pool);

// Signed out after SESSION_IDLE_MINUTES without activity (default 2 hours) and in any case after SESSION_MAX_HOURS (default 12).
const IDLE_MINUTES = Math.max(5, Number(process.env.SESSION_IDLE_MINUTES) || 120);
const MAX_HOURS = Math.max(1, Number(process.env.SESSION_MAX_HOURS) || 12);
// Set REQUIRE_2FA=true: owner and HR logins must use two-step sign-in. Until they turn it on they can only reach the Security page.
const REQUIRE_2FA = /^(1|true|yes|owner_hr)$/i.test(String(process.env.REQUIRE_2FA || ''));

const sessionMiddleware = session({
  key: 'mentour_sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true, // every request pushes the idle timeout forward
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: IDLE_MINUTES * 60 * 1000, // signed out after this long without using the app
  },
});

function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function generateInviteCode() {
  return crypto.randomBytes(6).toString('hex'); // 12 chars
}

// Loads the current user (and their organization) onto req.user.
// Responds 401 if there's no valid session.
async function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS organization_name, o.invite_code
       FROM users u JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = ? LIMIT 1`,
      [req.session.userId]
    );
    if (!rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not signed in.' });
    }
    req.user = rows[0];
    // Absolute session length. A session from before this rule existed starts counting now.
    if (!req.session.startedAt) req.session.startedAt = Date.now();
    if (Date.now() - req.session.startedAt > MAX_HOURS * 3600 * 1000) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Your session ended. Please sign in again.', expired: true });
    }
    // Enforced two-step for owner/HR (only when REQUIRE_2FA is on). If the database has no two-step columns yet, nobody is locked out.
    if (REQUIRE_2FA && (req.user.role === 'owner' || req.user.role === 'hr') && !req.session.twoFactorOk) {
      let on = null;
      try { const [t] = await pool.query('SELECT totp_enabled FROM users WHERE id = ?', [req.user.id]); on = !!(t[0] && t[0].totp_enabled); } catch (e) { on = null; }
      if (on === true) req.session.twoFactorOk = true;
      else if (on === false && !/^\/api\/auth(\/|$)/.test(req.baseUrl || '')) {
        return res.status(403).json({ error: 'Your organization requires two-step sign-in for owner and HR logins. Turn it on under Settings → Security.', twoFactorRequired: true });
      }
    }
    // A recruiter login is limited to the Onboarding module (and its own session endpoints).
    if (req.user.role === 'recruiter' && !/^\/api\/(onboarding|auth)(\/|$)/.test(req.baseUrl || '')) {
      return res.status(403).json({ error: 'Your login is limited to the Onboarding module.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateSignupInput({ email, password, name }) {
  if (!email || !EMAIL_RE.test(String(email))) return 'Enter a valid email address.';
  if (!password || String(password).length < 8) return 'Password must be at least 8 characters.';
  if (!name || !String(name).trim()) return 'Enter your name.';
  return null;
}

module.exports = {
  REQUIRE_2FA,
  sessionMiddleware,
  hashPassword,
  comparePassword,
  generateInviteCode,
  requireAuth,
  validateSignupInput,
};
