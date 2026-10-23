// Sends the app's own emails (supplier onboarding links, personal invites).
// Configured with environment variables; when they are missing nothing is
// sent and the pages fall back to a ready-made draft in the person's own mail
// program, exactly as before.
//
//   SMTP_HOST   e.g. smtp.hostinger.com
//   SMTP_PORT   465 (SSL) or 587 (STARTTLS); default 465
//   SMTP_USER   the mailbox login, e.g. onboarding@yourdomain.com
//   SMTP_PASS   its password
//   SMTP_FROM   "Mentour Suite <onboarding@yourdomain.com>" (default: SMTP_USER)
//   SMTP_SECURE true/false (default: true for port 465)

const nodemailer = require('nodemailer');

let cached = null;
function configured() { return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }
function from() { return process.env.SMTP_FROM || process.env.SMTP_USER; }

function transport() {
  if (cached) return cached;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE !== undefined ? String(process.env.SMTP_SECURE).toLowerCase() === 'true' : port === 465;
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    tls: process.env.SMTP_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  return cached;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Returns { sent: true } or { sent: false, error } -- never throws, so a mail problem never fails the save.
async function send({ to, subject, text, replyTo }) {
  if (!configured()) return { sent: false, error: 'Email sending is not set up on the server (SMTP settings missing).' };
  try {
    const html = '<div style="font:15px/1.5 Arial,sans-serif;color:#1d2733">' + esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>') + '</div>';
    const info = await transport().sendMail({ from: from(), to, subject, text, html, replyTo: replyTo || undefined });
    const rejected = (info.rejected || []).length;
    if (rejected) return { sent: false, error: 'The mail server rejected the address ' + (info.rejected || []).join(', ') + '.' };
    return { sent: true, id: info.messageId };
  } catch (err) {
    cached = null;
    const code = err && err.responseCode;
    let msg = 'The mail server could not send it' + (err && err.message ? ' (' + String(err.message).slice(0, 160) + ')' : '') + '.';
    if (err && err.code === 'EAUTH') msg = 'The mail server refused the SMTP login. Check SMTP_USER and SMTP_PASS.';
    else if (err && (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || err.code === 'EDNS')) msg = 'Could not reach the mail server. Check SMTP_HOST and SMTP_PORT.';
    else if (code && code >= 500) msg = 'The mail server refused the message (' + code + ').';
    return { sent: false, error: msg };
  }
}

module.exports = { configured, send };
