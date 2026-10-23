// "My email": each HR user connects their own mailbox so onboarding emails are sent from their
// registered address. The password is encrypted and never sent back to the browser.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const mailer = require('../mailer');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => (req.user.role === 'owner' || req.user.role === 'hr') ? next() : res.status(403).json({ error: 'Only the owner or an HR admin can set up email.' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const missing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146);
const SCHEMA_MSG = 'Saving email settings needs the latest database update — re-run db/schema.sql, then try again.';

function view(s) {
  return s ? { host: s.host, port: s.port, security: s.security, smtpUser: s.smtp_user, fromEmail: s.from_email, hasPassword: !!s.pass_cipher, updatedAt: s.updated_at } : null;
}

router.get('/', async (req, res, next) => {
  try {
    res.json({ settings: view(await mailer.settingsFor(req.user.id)), sharedConfigured: mailer.sharedConfigured(), defaultEmail: req.user.email, encryptionReady: mailer.cryptoReady() });
  } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const host = String(b.host || '').trim().toLowerCase();
    const port = Number(b.port);
    const security = String(b.security || '');
    const smtpUser = String(b.smtpUser || '').trim().slice(0, 255);
    const fromEmail = String(b.fromEmail || req.user.email).trim().slice(0, 255);
    const allowed = process.env.ALLOW_PRIVATE_SMTP === 'true' ? ['ssl', 'starttls', 'none'] : ['ssl', 'starttls'];
    if (!host) return res.status(400).json({ error: 'Enter the mail server (for example smtp.gmail.com).' });
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Enter a valid port (465 or 587).' });
    if (!allowed.includes(security)) return res.status(400).json({ error: 'Choose SSL or STARTTLS.' });
    if (!smtpUser) return res.status(400).json({ error: 'Enter the username (usually your full email address).' });
    if (!EMAIL_RE.test(fromEmail)) return res.status(400).json({ error: 'Enter a valid “from” email address.' });
    const bad = await mailer.checkHost(host);
    if (bad) return res.status(400).json({ error: bad });
    if (!mailer.cryptoReady()) return res.status(503).json({ error: 'The server has no encryption key yet (FIELD_ENCRYPTION_KEY), so the password cannot be stored. Set it first (see README-DEPLOY.md).' });
    const old = await mailer.settingsFor(req.user.id);
    const password = String(b.password || '');
    if (!password && !old) return res.status(400).json({ error: 'Enter the password (an app password for Gmail, iCloud, Outlook and Yahoo).' });
    const cipher = password ? mailer.encrypt(password) : old.pass_cipher;
    await pool.query(
      `INSERT INTO user_mail_settings (user_id, organization_id, host, port, security, smtp_user, pass_cipher, from_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE host = VALUES(host), port = VALUES(port), security = VALUES(security), smtp_user = VALUES(smtp_user), pass_cipher = VALUES(pass_cipher), from_email = VALUES(from_email)`,
      [req.user.id, req.user.organization_id, host, port, security, smtpUser, cipher, fromEmail]);
    res.json({ settings: view(await mailer.settingsFor(req.user.id)) });
  } catch (err) { if (missing(err)) return res.status(503).json({ error: SCHEMA_MSG }); next(err); }
});

router.delete('/', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM user_mail_settings WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { if (missing(err)) return res.json({ ok: true }); next(err); }
});

// Sends a test message to the user's own address using their own mailbox only.
router.post('/test', async (req, res, next) => {
  try {
    const s = await mailer.settingsFor(req.user.id);
    if (!s) return res.status(400).json({ error: 'Save your mailbox settings first.' });
    const r = await mailer.send({ to: req.user.email, subject: 'Mentour Suite test email', text: 'This is a test from Mentour Suite. If you can read this, your mailbox is connected and onboarding emails will be sent from your address.', sender: { id: req.user.id, name: req.user.name, email: req.user.email } });
    if (!r.sent) return res.status(502).json({ error: r.error });
    if (r.via !== 'personal') return res.status(502).json({ error: r.note || 'Your own mailbox did not send it; the company mailbox did instead.' });
    res.json({ ok: true, to: req.user.email });
  } catch (err) { next(err); }
});

module.exports = router;
