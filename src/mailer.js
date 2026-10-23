// Sends the app's own emails (supplier / consultant onboarding links, personal invites).
//
// Each HR user can connect their OWN mailbox (Gmail, Outlook, iCloud, Yahoo, Hostinger or any SMTP
// server) under "My email"; their emails then go out from their registered address. If they have not,
// the company mailbox from the server settings is used (SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM)
// with their name on it and replies going to them. With neither, nothing is sent and the pages offer
// a draft for the person's own mail program.

const dns = require('dns').promises;
const net = require('net');
const nodemailer = require('nodemailer');
const pool = require('./db');
const { encrypt, decrypt, isConfigured: cryptoReady } = require('./crypto');

const sharedConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const configured = sharedConfigured; // kept for older callers: "is the company mailbox set up?"

// ---- shared (company) mailbox
let sharedCache = null;
function sharedFrom() { return process.env.SMTP_FROM || process.env.SMTP_USER; }
function sharedAddress() { const f = sharedFrom(); const m = /<([^>]+)>/.exec(f); return (m ? m[1] : f).trim(); }
function sharedTransport() {
  if (sharedCache) return sharedCache;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE !== undefined ? String(process.env.SMTP_SECURE).toLowerCase() === 'true' : port === 465;
  sharedCache = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    tls: process.env.SMTP_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  return sharedCache;
}

// ---- a user's own mailbox
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
function privateAddress(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((re) => re.test(ip));
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || /^::ffff:/.test(x) && privateAddress(x.replace(/^::ffff:/, ''));
}
// Users type their own server name; refuse anything that points inside our network.
async function checkHost(host) {
  if (process.env.ALLOW_PRIVATE_SMTP === 'true') return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.length > 253) return 'That mail server name does not look right.';
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return 'That mail server address is not allowed. Use your provider’s public SMTP server.';
  } catch (e) { return 'Could not find that mail server. Check the server name.'; }
  return null;
}
const userCache = new Map();
async function settingsFor(userId) {
  if (!userId) return null;
  try {
    const [r] = await pool.query('SELECT * FROM user_mail_settings WHERE user_id = ?', [userId]);
    return r[0] || null;
  } catch (e) { if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return null; throw e; }
}
function userTransport(s) {
  const key = s.user_id + ':' + require('crypto').createHash('sha1').update([s.host, s.port, s.security, s.smtp_user, s.pass_cipher].join('|')).digest('hex');
  if (userCache.has(key)) return userCache.get(key);
  const t = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.security === 'ssl', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none',
    auth: { user: s.smtp_user, pass: decrypt(s.pass_cipher) },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  for (const k of userCache.keys()) if (k.startsWith(s.user_id + ':')) userCache.delete(k);
  userCache.set(key, t);
  return t;
}

// Can this user's emails be sent from the server (their own mailbox, or the company one)?
async function available(user) {
  if (sharedConfigured()) return true;
  try { return !!(user && await settingsFor(user.id)); } catch (e) { return false; }
}

const cleanName = (n) => String(n || '').replace(/["<>\r\n]/g, '').trim().slice(0, 80);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function explain(err) {
  const code = err && err.responseCode;
  const text = String((err && (err.response || err.message)) || '');
  if (err && err.code === 'EAUTH') {
    if (/application-specific|app password|AppPassword|534|5\.7\.9|Application/i.test(text)) return 'The mail provider wants an app password, not your normal password. Create one in your account’s security settings and enter it here.';
    return 'The mail server refused the login. Check the username and password (many providers need an app password).';
  }
  if (err && ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(err.code)) return 'Could not reach the mail server. Check the server name, port and security setting.';
  if (/5\.7\.1|relay|not allowed|SendAsDenied/i.test(text)) return 'The mail server refused to send as that address. The “from” address must be the mailbox you log in with.';
  if (code && code >= 500) return 'The mail server refused the message (' + code + ').';
  return 'The mail server could not send it' + (err && err.message ? ' (' + String(err.message).slice(0, 160) + ')' : '') + '.';
}

// Never throws, so a mail problem never fails the save.
// sender = the signed-in user { id, name, email }.
async function send({ to, subject, text, sender }) {
  const mine = sender && sender.id ? await settingsFor(sender.id) : null;
  if (!mine && !sharedConfigured()) return { sent: false, error: 'Email sending is not set up. Connect your mailbox under “My email”, or ask the owner to set up the company mailbox.' };
  const html = '<div style="font:15px/1.5 Arial,sans-serif;color:#1d2733">' + esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>') + '</div>';
  const copy = sender && sender.email && sender.email.toLowerCase() !== String(to).toLowerCase() ? sender.email : undefined;
  let personalError = null;
  if (mine) {
    try {
      const bad = await checkHost(mine.host);
      if (bad) throw Object.assign(new Error(bad), { friendly: bad });
      const info = await userTransport(mine).sendMail({
        from: { name: cleanName(sender.name || sender.email), address: mine.from_email || sender.email }, to, subject, text, html, bcc: copy,
      });
      if ((info.rejected || []).length) return { sent: false, error: 'The mail server rejected the address ' + info.rejected.join(', ') + '.', via: 'personal' };
      return { sent: true, id: info.messageId, via: 'personal' };
    } catch (err) {
      personalError = err.friendly || explain(err);
      if (!sharedConfigured()) return { sent: false, error: 'Your mailbox could not send it: ' + personalError, via: 'personal' };
    }
  }
  try {
    const who = sender && cleanName(sender.name || sender.email);
    const info = await sharedTransport().sendMail({
      from: who ? { name: who + ' (via Mentour Suite)', address: sharedAddress() } : sharedFrom(),
      to, subject, text, html, replyTo: (sender && sender.email) || undefined, bcc: copy,
    });
    if ((info.rejected || []).length) return { sent: false, error: 'The mail server rejected the address ' + info.rejected.join(', ') + '.', via: 'shared' };
    return { sent: true, id: info.messageId, via: 'shared', note: personalError ? 'Your own mailbox failed (' + personalError + '), so the company mailbox sent it.' : undefined };
  } catch (err) {
    sharedCache = null;
    return { sent: false, error: explain(err), via: 'shared' };
  }
}

module.exports = { configured, sharedConfigured, available, send, settingsFor, checkHost, encrypt, cryptoReady, explain };
