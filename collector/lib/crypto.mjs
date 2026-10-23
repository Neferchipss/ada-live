// Envelope encryption shared with the page (docs/app.js decrypts the same format).
// PBKDF2-SHA256 -> AES-256-GCM over gzipped JSON. Tag is appended to the ciphertext,
// which is what WebCrypto expects.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ITERATIONS = 600_000;

export function deriveKey(password, saltB64) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltB64, 'base64'), ITERATIONS, 32, 'sha256');
}

export function newSalt() {
  return crypto.randomBytes(16).toString('base64');
}

export function seal(obj, key, saltB64) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iter: ITERATIONS,
    salt: saltB64,
    iv: iv.toString('base64'),
    gz: true,
    ct: ct.toString('base64'),
  };
}

export function open(env, key) {
  const raw = Buffer.from(env.ct, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(body), d.final()]);
  return JSON.parse((env.gz ? zlib.gunzipSync(plain) : plain).toString());
}
