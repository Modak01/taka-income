const crypto = require('crypto');

function key() {
  const raw = process.env.PAYOUT_ENCRYPTION_KEY || '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    if (process.env.NODE_ENV === 'production') throw new Error('PAYOUT_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    // Local development only; never use this fallback in production.
    return crypto.createHash('sha256').update('local-only-not-for-production').digest();
  }
  return buf;
}

function encryptPayoutDetails(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptPayoutDetails(value) {
  // Backward compatibility for pre-encryption demo rows only. Migrate/remove these before production.
  if (!String(value).startsWith('enc:v1:')) return value;
  const parts = String(value).split(':');
  if (parts.length !== 5) throw new Error('Invalid encrypted payout details format');
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const ciphertext = Buffer.from(parts[4], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encryptPayoutDetails, decryptPayoutDetails };
