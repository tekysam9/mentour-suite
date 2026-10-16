// Field-level encryption for sensitive profile values (SSN, tax IDs, bank
// routing/account numbers). AES-256-GCM with a random IV per value; stored as
// "v1:<iv>:<tag>:<ciphertext>" (base64). The key comes from the environment
// variable FIELD_ENCRYPTION_KEY (32 bytes, base64 or 64 hex characters) and is
// never stored in the database. Without a valid key, writing a secret is
// refused (fail closed) -- nothing is ever stored in plain text.
const crypto = require('crypto');

function loadKey() {
  const raw = (process.env.FIELD_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try { buf = Buffer.from(raw, 'base64'); } catch (e) { buf = null; }
  }
  return buf && buf.length === 32 ? buf : null;
}

function isConfigured() { return !!loadKey(); }

function encrypt(plain) {
  const key = loadKey();
  if (!key) {
    const e = new Error('FIELD_ENCRYPTION_KEY is not set (or is not 32 bytes).');
    e.code = 'NO_KEY';
    throw e;
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(stored) {
  const key = loadKey();
  if (!key) {
    const e = new Error('FIELD_ENCRYPTION_KEY is not set (or is not 32 bytes).');
    e.code = 'NO_KEY';
    throw e;
  }
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Unknown ciphertext version.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// Binary files (onboarding documents): raw iv(12) | tag(16) | ciphertext, so a 10 MB file stays ~10 MB.
function needKey() {
  const key = loadKey();
  if (!key) { const e = new Error('FIELD_ENCRYPTION_KEY is not set (or is not 32 bytes).'); e.code = 'NO_KEY'; throw e; }
  return key;
}
function encryptBuffer(buf) {
  const key = needKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function decryptBuffer(stored) {
  const key = needKey();
  const b = Buffer.from(stored);
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

module.exports = { encrypt, decrypt, isConfigured, encryptBuffer, decryptBuffer };
