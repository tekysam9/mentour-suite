// Emails the person (and, for a lockout, the account owner) when something security-relevant happens to their login.
// Uses the company mailbox (SMTP_* settings). Best effort and silent: no mailbox, or a mail error, never affects a sign-in.
// SECURITY_ALERTS=off turns it off. The same kind of alert for the same person is sent at most once every 30 minutes.
const pool = require('./db');
const mailer = require('./mailer');

const last = new Map();
const MESSAGES = {
  lockout: { subject: 'Your account was temporarily locked', body: (u, ip) => 'There were many failed sign-in attempts for ' + u.email + ', so the account is locked for a short time.\nLatest attempt came from IP address ' + (ip || 'unknown') + '.\n\nIf this was you, wait and try again. If not, someone may be guessing your password: sign in later, change your password, and turn on two-step sign-in under Settings → Security.' },
  login_after_failures: { subject: 'Sign-in after several failed attempts', body: (u, ip) => 'Your account ' + u.email + ' was just signed in to from IP address ' + (ip || 'unknown') + ', after several wrong passwords or codes.\n\nIf that was you, no action is needed. If not, change your password now, turn on two-step sign-in, and use Settings → Security → Sign out of all devices.' },
  twofactor_on: { subject: 'Two-step sign-in turned on', body: (u, ip) => 'Two-step sign-in was turned on for ' + u.email + ' (from IP address ' + (ip || 'unknown') + '). If this was not you, change your password and contact the account owner.' },
  twofactor_off: { subject: 'Two-step sign-in turned OFF', body: (u, ip) => 'Two-step sign-in was turned off for ' + u.email + ' (from IP address ' + (ip || 'unknown') + ').\n\nIf this was not you, change your password immediately and use Settings → Security → Sign out of all devices.' },
  recovery_used: { subject: 'A recovery code was used to sign in', body: (u, ip) => 'A one-time recovery code was used to sign in to ' + u.email + ' (from IP address ' + (ip || 'unknown') + ').\n\nIf this was not you, change your password immediately and use Settings → Security → Sign out of all devices.' },
  password_changed: { subject: 'Your password was changed', body: (u, ip) => 'The password for ' + u.email + ' was changed (from IP address ' + (ip || 'unknown') + '). Other devices were signed out.\n\nIf this was not you, contact the account owner right away.' },
};

async function notify(kind, user, ip, alsoOwner) {
  try {
    if (/^(0|false|off|no)$/i.test(String(process.env.SECURITY_ALERTS || ''))) return;
    if (!mailer.sharedConfigured() || !user || !user.email || !MESSAGES[kind]) return;
    const key = kind + ':' + String(user.email).toLowerCase();
    const now = Date.now();
    if (last.has(key) && now - last.get(key) < 30 * 60 * 1000) return;
    last.set(key, now);
    const m = MESSAGES[kind];
    const when = new Date().toUTCString();
    const text = 'Mentour Suite security notice (' + when + ')\n\n' + m.body(user, ip).replace(/\\\n/g, '\n') + '\n\nThis message was sent automatically. Do not reply with passwords or codes.';
    const to = [String(user.email)];
    if (alsoOwner && user.organization_id) {
      try { const [o] = await pool.query("SELECT email FROM users WHERE organization_id = ? AND role = 'owner' AND email <> ?", [user.organization_id, user.email]); o.forEach((r) => to.push(r.email)); } catch (e) { /* ignore */ }
    }
    for (const addr of to) await mailer.send({ to: addr, subject: '[Mentour Suite security] ' + m.subject, text });
  } catch (e) { /* never in the way */ }
}

module.exports = { notify, _last: last };
