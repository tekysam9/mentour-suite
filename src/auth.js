const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const pool = require('./db');

const sessionStore = new MySQLStore({}, pool);

const sessionMiddleware = session({
  key: 'mentour_sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
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
  sessionMiddleware,
  hashPassword,
  comparePassword,
  generateInviteCode,
  requireAuth,
  validateSignupInput,
};
