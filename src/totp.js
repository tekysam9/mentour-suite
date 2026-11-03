// Two-step sign-in with an authenticator app (RFC 6238 time-based codes, 6 digits, 30 seconds, SHA-1: what Google
// Authenticator, Microsoft Authenticator, 1Password and Authy all use). No third-party code: node's crypto only.
const crypto = require('crypto');
const fieldCrypto = require('./crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) { let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); let out = ''; for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function unbase32(str) { let bits = ''; for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }

function newSecret() { return base32(crypto.randomBytes(20)); }

function hotp(secretB32, counter) {
  const key = unbase32(secretB32);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// Returns the time step the code belongs to (so a used code can be refused again), or null. Allows one step of clock drift each way.
function verify(secretB32, code, lastStep, now) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor((now || Date.now()) / 30000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    const a = Buffer.from(hotp(secretB32, s)); const b = Buffer.from(c);
    if (a.length === b.length && crypto.timingSafeEqual(a, b) && (lastStep === null || lastStep === undefined || s > Number(lastStep))) return s;
  }
  return null;
}

function otpauthUri(secret, account, issuer) {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + account) + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
}

// The secret is stored encrypted (FIELD_ENCRYPTION_KEY when set, otherwise a key derived from SESSION_SECRET).
function derivedKey() { return Buffer.from(crypto.hkdfSync('sha256', String(process.env.SESSION_SECRET || 'dev'), Buffer.alloc(0), 'mentour-totp-v1', 32)); }
function seal(plain) {
  if (fieldCrypto.isConfigured()) return fieldCrypto.encrypt(plain);
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['d1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function open(stored) {
  if (String(stored).startsWith('d1:')) {
    const [, iv, tag, ct] = String(stored).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
  return fieldCrypto.decrypt(stored);
}

function newRecoveryCodes(n = 8) { return Array.from({ length: n }, () => { const h = crypto.randomBytes(5).toString('hex'); return h.slice(0, 5) + '-' + h.slice(5); }); }
function hashCode(code) { return crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-f0-9]/g, '')).digest('hex'); }

module.exports = { newSecret, verify, otpauthUri, seal, open, newRecoveryCodes, hashCode, hotp, base32, unbase32 };
